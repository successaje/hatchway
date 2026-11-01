import {
  decodeErrorResult,
  getContractAddress,
  toHex,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import type { DecodedArg, Notice, TransactionReview } from "../core/protocol.js";
import { decodeCall, decodeConstructorArgs, decodedArg, type ArtifactIndex } from "./artifacts.js";
import {
  chainName,
  getChain,
  hasNonstandardDeployment,
  isLocalChain,
  nativeSymbol,
} from "./chains.js";
import { formatAmount } from "./format.js";
import { RpcResponseError, type UpstreamRpc } from "./rpc.js";
import type { CanonicalTransaction } from "./tx.js";

/** Arachnid's deterministic deployment proxy, used by forge for `new C{salt: s}()`. */
export const CREATE2_DEPLOYER: Address = "0x4e59b44847b379578588920cA78FbF26c0B4956C";

export interface KnownContract {
  name: string;
  abi?: Abi;
}

export interface ReviewContext {
  rpc: UpstreamRpc;
  chainId: number;
  artifacts: ArtifactIndex;
  /** Contracts deployed earlier in this session, keyed by lowercase address. */
  known: Map<string, KnownContract>;
  /** Nonce the wallet is expected to use, for address prediction when the request has none. */
  expectedNonce?: number | undefined;
  /** Caller supplied title (e.g. from `hatchway deploy`). */
  title?: string | undefined;
}

const SENSITIVE_FUNCTIONS: Record<string, (args: DecodedArg[]) => Notice> = {
  approve: (args) => ({
    level: "warning",
    message: `Grants a token allowance of ${args[1]?.value ?? "?"} to ${args[0]?.value ?? "?"}.`,
  }),
  increaseAllowance: (args) => ({
    level: "warning",
    message: `Increases a token allowance for ${args[0]?.value ?? "?"}.`,
  }),
  setApprovalForAll: (args) => ({
    level: "warning",
    message: `${args[1]?.value === "true" ? "Grants" : "Revokes"} operator approval for all tokens to ${args[0]?.value ?? "?"}.`,
  }),
  transferOwnership: (args) => ({
    level: "warning",
    message: `Transfers contract ownership to ${args[0]?.value ?? "?"}.`,
  }),
  renounceOwnership: () => ({
    level: "danger",
    message: "Renounces ownership. The contract will have no owner afterwards.",
  }),
  upgradeTo: (args) => ({
    level: "warning",
    message: `Upgrades the proxy implementation to ${args[0]?.value ?? "?"}.`,
  }),
  upgradeToAndCall: (args) => ({
    level: "warning",
    message: `Upgrades the proxy implementation to ${args[0]?.value ?? "?"} and calls it.`,
  }),
  grantRole: (args) => ({
    level: "warning",
    message: `Grants a role to ${args[1]?.value ?? "?"}.`,
  }),
};

const ERROR_STRING = "0x08c379a0";
const PANIC = "0x4e487b71";

export async function buildTransactionReview(
  tx: CanonicalTransaction,
  ctx: ReviewContext,
): Promise<TransactionReview> {
  const symbol = nativeSymbol(ctx.chainId);
  const notices: Notice[] = [];
  const review: TransactionReview = {
    action: "call",
    title: "Contract call",
    from: tx.from,
    value: tx.value.toString(),
    valueDisplay: formatAmount(tx.value, symbol),
    dataSize: (tx.data.length - 2) / 2,
    dataPreview: tx.data.length > 74 ? `${tx.data.slice(0, 74)}…` : tx.data,
    simulation: { status: "unavailable" },
    notices,
  };
  if (tx.to) review.to = tx.to;
  if (tx.nonce !== undefined) review.nonce = tx.nonce;
  const nonce = tx.nonce ?? ctx.expectedNonce;

  // ---- What does this transaction do? ----------------------------------------------
  if (!tx.to) {
    review.action = "deploy";
    const match = ctx.artifacts.matchCreation(tx.data);
    if (match) {
      review.contractName = match.entry.name;
      review.contractSource = "artifact";
      if (match.entry.sourcePath) review.sourcePath = match.entry.sourcePath;
      const args = decodeConstructorArgs(match.entry.abi, match.argsData);
      if (args) review.constructorArgs = args;
      else notices.push({ level: "info", message: "Constructor arguments could not be decoded." });
    } else {
      notices.push({
        level: "info",
        message: "Bytecode does not match a compiled artifact in this project.",
      });
    }
    if (nonce !== undefined)
      review.predictedAddress = getContractAddress({ from: tx.from, nonce: BigInt(nonce) });
    review.title = `Deploy ${review.contractName ?? "contract"}`;
  } else if (
    tx.to.toLowerCase() === CREATE2_DEPLOYER.toLowerCase() &&
    tx.data.length >= 2 + 64 + 2
  ) {
    review.action = "deploy_create2";
    const salt = `0x${tx.data.slice(2, 66)}` as Hex;
    const initCode = `0x${tx.data.slice(66)}` as Hex;
    review.toLabel = "Deterministic deployment proxy (CREATE2)";
    review.predictedAddress = getContractAddress({
      opcode: "CREATE2",
      from: CREATE2_DEPLOYER,
      salt,
      bytecode: initCode,
    });
    const match = ctx.artifacts.matchCreation(initCode);
    if (match) {
      review.contractName = match.entry.name;
      review.contractSource = "artifact";
      if (match.entry.sourcePath) review.sourcePath = match.entry.sourcePath;
      const args = decodeConstructorArgs(match.entry.abi, match.argsData);
      if (args) review.constructorArgs = args;
    }
    review.args = [decodedArg("salt", "bytes32", salt)];
    review.title = `Deploy ${review.contractName ?? "contract"} with CREATE2`;
  } else if (tx.data === "0x") {
    review.action = "transfer";
    review.title = `Send ${review.valueDisplay}`;
  } else {
    review.action = "call";
    const known = ctx.known.get(tx.to.toLowerCase());
    let decoded = known?.abi ? decodeCall(known.abi, tx.data) : undefined;
    if (known) {
      review.contractName = known.name;
      review.contractSource = "session";
      review.toLabel = `${known.name} (deployed in this session)`;
    }
    if (!decoded) {
      const candidates = ctx.artifacts.functionsForSelector(tx.data.slice(0, 10));
      for (const candidate of candidates) {
        decoded = decodeCall([candidate.fn], tx.data);
        if (decoded) {
          const names = new Set(candidates.map((c) => c.entry.name));
          const implementation = names.size === 1 ? candidate.entry.name : undefined;
          if (known && implementation && implementation !== known.name) {
            // The target was deployed in this session but does not have this function itself:
            // typically a proxy forwarding to an implementation.
            review.contractName = implementation;
            review.contractSource = "selector";
            notices.push({
              level: "info",
              message: `Called through ${known.name}; decoded with ${implementation}'s ABI.`,
            });
          } else {
            if (!known && implementation) {
              review.contractName = implementation;
              review.contractSource = "selector";
            }
            notices.push({
              level: "info",
              message: "Decoded by matching the function selector against project ABIs.",
            });
          }
          break;
        }
      }
    }
    if (decoded) {
      review.functionSignature = decoded.signature;
      review.args = decoded.args;
      review.title = review.contractName
        ? `${review.contractName}.${decoded.functionName}`
        : `Call ${decoded.functionName}`;
      const sensitive = SENSITIVE_FUNCTIONS[decoded.functionName];
      if (sensitive) notices.push(sensitive(decoded.args));
    } else {
      review.title = review.contractName ? `Call ${review.contractName}` : "Contract call";
      notices.push({
        level: "info",
        message: "Calldata could not be decoded with the project's ABIs.",
      });
    }
  }
  if (ctx.title) review.title = ctx.title;

  // ---- Network context: fees, simulation, balance, code ------------------------------
  const callParams: Record<string, string> = {
    from: tx.from,
    data: tx.data,
    value: toHex(tx.value),
  };
  if (tx.to) callParams.to = tx.to;
  if (tx.gas !== undefined) callParams.gas = toHex(tx.gas);

  const [gasResult, blockResult, priorityResult, balanceResult, codeResult, simResult] =
    await Promise.allSettled([
      tx.gas !== undefined
        ? Promise.resolve(tx.gas)
        : ctx.rpc.client.estimateGas({
            account: tx.from,
            to: tx.to,
            data: tx.data,
            value: tx.value,
          }),
      ctx.rpc.client.getBlock({ blockTag: "latest" }),
      tx.maxPriorityFeePerGas !== undefined || tx.gasPrice !== undefined
        ? Promise.resolve(tx.maxPriorityFeePerGas ?? 0n)
        : ctx.rpc.client.estimateMaxPriorityFeePerGas(),
      ctx.rpc.client.getBalance({ address: tx.from }),
      tx.to && review.action === "call"
        ? ctx.rpc.client.getCode({ address: tx.to })
        : Promise.resolve(undefined),
      ctx.rpc.request("eth_call", [callParams, "latest"]),
    ]);

  const gas = gasResult.status === "fulfilled" ? gasResult.value : undefined;
  if (gas !== undefined) review.gasLimit = gas.toString();
  const baseFee =
    blockResult.status === "fulfilled" ? (blockResult.value.baseFeePerGas ?? undefined) : undefined;
  const priority = priorityResult.status === "fulfilled" ? priorityResult.value : undefined;

  if (gas !== undefined) {
    let perGasExpected: bigint | undefined;
    let perGasMax: bigint | undefined;
    if (tx.gasPrice !== undefined) {
      perGasExpected = perGasMax = tx.gasPrice;
    } else if (baseFee !== undefined) {
      const tip = priority ?? 0n;
      perGasMax = tx.maxFeePerGas ?? baseFee * 2n + tip;
      perGasExpected = baseFee + tip < perGasMax ? baseFee + tip : perGasMax;
    } else if (tx.maxFeePerGas !== undefined) {
      perGasExpected = perGasMax = tx.maxFeePerGas;
    }
    if (perGasExpected !== undefined) {
      const estimated = gas * perGasExpected;
      review.fee = {
        estimated: estimated.toString(),
        estimatedDisplay: formatAmount(estimated, symbol),
        source: tx.maxFeePerGas !== undefined || tx.gasPrice !== undefined ? "request" : "network",
      };
      if (perGasMax !== undefined && perGasMax !== perGasExpected) {
        review.fee.max = (gas * perGasMax).toString();
        review.fee.maxDisplay = formatAmount(gas * perGasMax, symbol);
      }
    }
  }

  if (simResult.status === "fulfilled") {
    review.simulation = { status: "passed" };
  } else {
    review.simulation = {
      status: "failed",
      message: describeRevert(simResult.reason, ctx.artifacts),
    };
  }

  if (codeResult.status === "fulfilled" && review.action === "call" && codeResult.value === "0x") {
    notices.push({ level: "warning", message: "The destination address has no contract code." });
  }

  if (balanceResult.status === "fulfilled") {
    const maxCost = tx.value + BigInt(review.fee?.max ?? review.fee?.estimated ?? "0");
    if (balanceResult.value < maxCost) {
      notices.push({
        level: "danger",
        message: `Wallet balance (${formatAmount(balanceResult.value, symbol)}) may not cover the value plus fees.`,
      });
    }
  }

  // ---- Generic warnings ----------------------------------------------------------------
  if (tx.value > 0n && review.action !== "transfer") {
    notices.push({
      level: "warning",
      message: `Sends ${review.valueDisplay} along with the ${review.action === "call" ? "call" : "deployment"}.`,
    });
  }
  const chain = getChain(ctx.chainId);
  if (!isLocalChain(ctx.chainId) && chain && !chain.testnet) {
    notices.push({
      level: "warning",
      message: `${chainName(ctx.chainId)} is a production network. This transaction spends real funds.`,
    });
  }
  if (hasNonstandardDeployment(ctx.chainId) && review.action !== "call") {
    notices.push({
      level: "warning",
      message:
        "This chain uses non-standard contract deployment; the predicted address may be wrong.",
    });
  }
  return review;
}

/** Turns an `eth_call` failure into a short reason, decoding custom errors from project ABIs. */
export function describeRevert(error: unknown, artifacts: ArtifactIndex): string {
  if (!(error instanceof RpcResponseError)) {
    return error instanceof Error ? error.message.split("\n")[0]! : "Simulation failed.";
  }
  const data = extractRevertData(error.data);
  if (data && data.length >= 10) {
    const selector = data.slice(0, 10).toLowerCase();
    if (selector === ERROR_STRING || selector === PANIC) {
      try {
        const decoded = decodeErrorResult({ data: data as Hex });
        return `Reverted: ${decoded.errorName}(${(decoded.args ?? []).map(String).join(", ")})`;
      } catch {
        // fall through to the generic message
      }
    }
    for (const entry of artifacts.entries) {
      try {
        const decoded = decodeErrorResult({ abi: entry.abi, data: data as Hex });
        return `Reverted: ${decoded.errorName}(${(decoded.args ?? []).map(String).join(", ")})`;
      } catch {
        continue;
      }
    }
    return `Reverted with data ${data.length > 20 ? `${data.slice(0, 20)}…` : data}`;
  }
  return error.message;
}

function extractRevertData(data: unknown): string | undefined {
  if (typeof data === "string" && data.startsWith("0x")) return data;
  if (data && typeof data === "object" && "data" in data)
    return extractRevertData((data as { data: unknown }).data);
  return undefined;
}
