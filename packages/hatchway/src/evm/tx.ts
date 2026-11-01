import { getAddress, isAddress, toHex, type Address, type Hex } from "viem";
import { HatchwayError } from "../core/errors.js";
import type { WalletTransaction } from "../core/protocol.js";
import { canonicalJson, sha256Hex } from "../core/secrets.js";

/**
 * A transaction request after validation. Amounts are bigints; `to` is undefined for
 * contract creation. This is the single representation the rest of Hatchway reasons about.
 */
export interface CanonicalTransaction {
  from: Address;
  to?: Address;
  value: bigint;
  data: Hex;
  gas?: bigint;
  nonce?: number;
  gasPrice?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  chainId?: number;
}

const MAX_UINT256 = 2n ** 256n - 1n;

const KNOWN_FIELDS = new Set([
  "from",
  "to",
  "value",
  "data",
  "input",
  "gas",
  "gasLimit",
  "nonce",
  "gasPrice",
  "maxFeePerGas",
  "maxPriorityFeePerGas",
  "chainId",
  "type",
  "accessList",
]);

const UNSUPPORTED_FIELDS: Record<string, string> = {
  authorizationList: "EIP-7702 authorization lists are not supported; wallets do not accept them via eth_sendTransaction",
  blobVersionedHashes: "EIP-4844 blob transactions are not supported",
  maxFeePerBlobGas: "EIP-4844 blob transactions are not supported",
  blobs: "EIP-4844 blob transactions are not supported",
  sidecar: "EIP-4844 blob transactions are not supported",
};

function invalid(message: string): HatchwayError {
  return new HatchwayError("INVALID_TRANSACTION", message);
}

function parseQuantity(field: string, value: unknown): bigint | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw invalid(`transaction field "${field}" must be a 0x-prefixed hex quantity`);
  }
  const parsed = BigInt(value);
  if (parsed > MAX_UINT256) throw invalid(`transaction field "${field}" is out of range`);
  return parsed;
}

function parseAddress(field: string, value: unknown): Address {
  if (typeof value !== "string" || !isAddress(value, { strict: false })) {
    throw invalid(`transaction field "${field}" must be a 20-byte address`);
  }
  return getAddress(value);
}

function parseData(value: unknown): Hex {
  if (value === undefined || value === null) return "0x";
  if (typeof value !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(value)) {
    throw invalid('transaction field "data" must be 0x-prefixed, even-length hex');
  }
  return value.toLowerCase() as Hex;
}

/** Validates an `eth_sendTransaction` parameter object from an untrusted caller. */
export function normalizeTransaction(raw: unknown): CanonicalTransaction {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw invalid("eth_sendTransaction expects a transaction object");
  }
  const input = raw as Record<string, unknown>;

  for (const key of Object.keys(input)) {
    const unsupported = UNSUPPORTED_FIELDS[key];
    if (unsupported && input[key] !== undefined && input[key] !== null) {
      throw new HatchwayError("UNSUPPORTED_TRANSACTION", unsupported);
    }
    if (!KNOWN_FIELDS.has(key) && !(key in UNSUPPORTED_FIELDS)) {
      throw invalid(`unsupported transaction field "${key}"`);
    }
  }

  const type = input.type;
  if (type !== undefined && type !== null) {
    const typeValue = parseQuantity("type", type);
    if (typeValue === 3n) throw new HatchwayError("UNSUPPORTED_TRANSACTION", UNSUPPORTED_FIELDS.blobs!);
    if (typeValue === 4n) {
      throw new HatchwayError("UNSUPPORTED_TRANSACTION", UNSUPPORTED_FIELDS.authorizationList!);
    }
    if (typeValue !== undefined && typeValue > 2n) {
      throw new HatchwayError("UNSUPPORTED_TRANSACTION", `transaction type ${type} is not supported`);
    }
  }

  if (Array.isArray(input.accessList) && input.accessList.length > 0) {
    throw new HatchwayError(
      "UNSUPPORTED_TRANSACTION",
      "transactions with a non-empty access list are not supported",
    );
  }

  if (input.data !== undefined && input.input !== undefined && input.data !== input.input) {
    throw invalid('transaction has both "data" and "input" with different values');
  }

  const from = parseAddress("from", input.from);
  const to =
    input.to === undefined || input.to === null || input.to === "" ? undefined : parseAddress("to", input.to);
  const data = parseData(input.data ?? input.input);
  const value = parseQuantity("value", input.value) ?? 0n;
  const gas = parseQuantity("gas", input.gas ?? input.gasLimit);
  const nonceValue = parseQuantity("nonce", input.nonce);
  if (nonceValue !== undefined && nonceValue > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw invalid('transaction field "nonce" is out of range');
  }
  const gasPrice = parseQuantity("gasPrice", input.gasPrice);
  const maxFeePerGas = parseQuantity("maxFeePerGas", input.maxFeePerGas);
  const maxPriorityFeePerGas = parseQuantity("maxPriorityFeePerGas", input.maxPriorityFeePerGas);
  const chainIdValue = parseQuantity("chainId", input.chainId);

  if (gasPrice !== undefined && (maxFeePerGas !== undefined || maxPriorityFeePerGas !== undefined)) {
    throw invalid("transaction cannot set both gasPrice and EIP-1559 fee fields");
  }
  if (
    maxFeePerGas !== undefined &&
    maxPriorityFeePerGas !== undefined &&
    maxPriorityFeePerGas > maxFeePerGas
  ) {
    throw invalid("maxPriorityFeePerGas cannot exceed maxFeePerGas");
  }
  if (to === undefined && data === "0x") {
    throw invalid("contract creation transaction has no bytecode");
  }

  const tx: CanonicalTransaction = { from, value, data };
  if (to !== undefined) tx.to = to;
  if (gas !== undefined) tx.gas = gas;
  if (nonceValue !== undefined) tx.nonce = Number(nonceValue);
  if (gasPrice !== undefined) tx.gasPrice = gasPrice;
  if (maxFeePerGas !== undefined) tx.maxFeePerGas = maxFeePerGas;
  if (maxPriorityFeePerGas !== undefined) tx.maxPriorityFeePerGas = maxPriorityFeePerGas;
  if (chainIdValue !== undefined) tx.chainId = Number(chainIdValue);
  return tx;
}

/** The exact object handed to the wallet. Always pins the chain id. */
export function toWalletTransaction(tx: CanonicalTransaction, chainId: number): WalletTransaction {
  const out: WalletTransaction = {
    from: tx.from,
    value: toHex(tx.value),
    data: tx.data,
    chainId: toHex(chainId),
  };
  if (tx.to !== undefined) out.to = tx.to;
  if (tx.gas !== undefined) out.gas = toHex(tx.gas);
  if (tx.nonce !== undefined) out.nonce = toHex(tx.nonce);
  if (tx.gasPrice !== undefined) out.gasPrice = toHex(tx.gasPrice);
  if (tx.maxFeePerGas !== undefined) out.maxFeePerGas = toHex(tx.maxFeePerGas);
  if (tx.maxPriorityFeePerGas !== undefined) out.maxPriorityFeePerGas = toHex(tx.maxPriorityFeePerGas);
  return out;
}

export function hashPayload(payload: unknown): string {
  return sha256Hex(canonicalJson(payload));
}

/**
 * Identity used to recognise retries of the same request (forge retries timed-out and
 * rejected sends up to four times). Only nonce-pinned transactions are deduplicated: two
 * identical calls without a nonce are legitimately distinct transactions.
 */
export function dedupeKey(tx: CanonicalTransaction): string | undefined {
  if (tx.nonce === undefined) return undefined;
  return canonicalJson({
    from: tx.from.toLowerCase(),
    to: tx.to?.toLowerCase(),
    value: tx.value.toString(),
    data: tx.data,
    nonce: tx.nonce,
  });
}

export interface BroadcastTransaction {
  from: string;
  to: string | null;
  input: string;
  value: bigint;
  nonce: number;
  chainId?: number | undefined;
}

/**
 * Compares the transaction the wallet actually broadcast with the one that was approved.
 * Gas and fee fields may legitimately change (wallets let users edit them); everything
 * that determines what the transaction does may not.
 */
export function findIntegrityMismatches(
  expected: CanonicalTransaction,
  expectedChainId: number,
  actual: BroadcastTransaction,
): string[] {
  const problems: string[] = [];
  if (actual.from.toLowerCase() !== expected.from.toLowerCase()) {
    problems.push(`sender is ${actual.from}, expected ${expected.from}`);
  }
  const actualTo = actual.to ? actual.to.toLowerCase() : undefined;
  if (actualTo !== expected.to?.toLowerCase()) {
    problems.push(`destination is ${actual.to ?? "contract creation"}, expected ${expected.to ?? "contract creation"}`);
  }
  if (actual.input.toLowerCase() !== expected.data.toLowerCase()) {
    problems.push("calldata differs from the approved request");
  }
  if (actual.value !== expected.value) {
    problems.push(`value is ${actual.value} wei, expected ${expected.value} wei`);
  }
  if (expected.nonce !== undefined && actual.nonce !== expected.nonce) {
    problems.push(`nonce is ${actual.nonce}, expected ${expected.nonce}`);
  }
  if (actual.chainId !== undefined && actual.chainId !== expectedChainId) {
    problems.push(`chain id is ${actual.chainId}, expected ${expectedChainId}`);
  }
  return problems;
}
