import { getAddress, isAddress, type Address } from "viem";
import type { ApprovalEngine } from "../core/engine.js";
import { HatchwayError, toHatchwayError } from "../core/errors.js";
import { normalizeTransaction } from "../evm/tx.js";
import {
  RpcResponseError,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type UpstreamRpc,
} from "../evm/rpc.js";

export interface AttachParams {
  url: string;
  headers?: Record<string, string>;
  chainId?: number;
  network?: string;
}

export interface RpcHandlerOptions {
  engine: ApprovalEngine;
  upstream: () => UpstreamRpc | undefined;
  /** Hardhat plugin handshake: binds the session to the network the script connected to. */
  attach: (params: AttachParams) => Promise<{ chainId: number }>;
}

const BLOCKED: Record<string, string> = {
  eth_sign:
    "eth_sign is disabled: it signs arbitrary hashes and is a common phishing vector. Use personal_sign or eth_signTypedData_v4.",
  eth_signTransaction:
    "eth_signTransaction is not supported: browser wallets sign and broadcast in one step. Send with eth_sendTransaction (forge: --unlocked).",
  eth_sendRawTransaction:
    "Hatchway only relays transactions approved in your wallet, and this one was signed somewhere else (for example --private-key or vm.startBroadcast(privateKey)). Remove the local signer.",
  eth_signTypedData: "Use eth_signTypedData_v4.",
  eth_signTypedData_v3: "Use eth_signTypedData_v4.",
};

const MAX_BATCH = 100;

/**
 * Methods forwarded to the developer's RPC: an allow-list of read namespaces. Anything that
 * sends or signs (eth_sendRawTransaction and its many variants, personal_ methods, anvil_ and hardhat_
 * account tricks) is refused, so nothing reaches the chain without a wallet approval. Matching
 * is case-sensitive on purpose: nodes accept "ETH_SENDRAWTRANSACTION", the allow-list does not.
 */
export function isForwardable(method: string): boolean {
  if (/send|sign|submit/i.test(method)) return false;
  return (
    /^(eth|net|web3)_[A-Za-z0-9]+$/.test(method) ||
    /^(debug_trace|trace_)[A-Za-z0-9_]*$/.test(method)
  );
}

/**
 * The JSON-RPC endpoint that forge, Hardhat or any other tool talks to. Signing methods are
 * routed to the browser wallet; everything else is forwarded to the developer's RPC.
 */
export class RpcHandler {
  readonly #options: RpcHandlerOptions;

  constructor(options: RpcHandlerOptions) {
    this.#options = options;
  }

  async handle(body: string, signal: AbortSignal): Promise<string> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return JSON.stringify(errorResponse(null, -32700, "Parse error"));
    }
    if (Array.isArray(parsed)) {
      if (parsed.length === 0) return JSON.stringify(errorResponse(null, -32600, "Empty batch"));
      if (parsed.length > MAX_BATCH) {
        return JSON.stringify(
          errorResponse(null, -32600, `Batches are limited to ${MAX_BATCH} requests`),
        );
      }
      const responses = await Promise.all(parsed.map((item) => this.#handleOne(item, signal)));
      return JSON.stringify(responses);
    }
    return JSON.stringify(await this.#handleOne(parsed, signal));
  }

  async #handleOne(raw: unknown, signal: AbortSignal): Promise<JsonRpcResponse> {
    if (
      raw === null ||
      typeof raw !== "object" ||
      typeof (raw as JsonRpcRequest).method !== "string"
    ) {
      return errorResponse(null, -32600, "Invalid request");
    }
    const request = raw as JsonRpcRequest;
    const id = request.id ?? null;
    try {
      const result = await this.#dispatch(request, signal);
      if (result instanceof Forwarded) return result.response(id);
      return { jsonrpc: "2.0", id, result };
    } catch (error) {
      if (error instanceof RpcResponseError)
        return errorResponse(id, error.code, error.message, error.data);
      const hatchway = toHatchwayError(error);
      return errorResponse(id, hatchway.rpcCode, hatchway.message, { hatchway: hatchway.code });
    }
  }

  async #dispatch(request: JsonRpcRequest, signal: AbortSignal): Promise<unknown> {
    const { engine } = this.#options;
    const session = engine.session;
    const params = Array.isArray(request.params) ? (request.params as unknown[]) : [];

    if (BLOCKED[request.method])
      throw new HatchwayError("UNSUPPORTED_SIGNER", BLOCKED[request.method]!);

    switch (request.method) {
      case "hatchway_attach":
        return this.#options.attach(parseAttach(params[0]));

      case "eth_accounts":
      case "eth_requestAccounts": {
        const wallet = await session.waitForWallet();
        return [wallet.address];
      }

      case "eth_sendTransaction": {
        await session.waitForWallet();
        const tx = normalizeTransaction(params[0]);
        const approval = engine.enqueueTransaction(tx);
        return awaitRequest(engine, approval, signal);
      }

      case "personal_sign": {
        await session.waitForWallet();
        const [message, address] = params;
        if (typeof message !== "string")
          throw new HatchwayError("INVALID_TRANSACTION", "personal_sign expects a message.");
        const approval = engine.enqueueSignature("personal_sign", parseSigner(address), message);
        return awaitRequest(engine, approval, signal);
      }

      case "eth_signTypedData_v4": {
        await session.waitForWallet();
        const [address, typed] = params;
        const payload = typeof typed === "string" ? typed : JSON.stringify(typed);
        const approval = engine.enqueueSignature(
          "eth_signTypedData_v4",
          parseSigner(address),
          payload,
        );
        return awaitRequest(engine, approval, signal);
      }

      default:
        if (request.method.startsWith("wallet_")) {
          throw new HatchwayError(
            "UNSUPPORTED_SIGNER",
            `${request.method} is not available through Hatchway; manage your wallet in the browser.`,
          );
        }
        if (!isForwardable(request.method)) {
          throw new HatchwayError(
            "UNSUPPORTED_SIGNER",
            `${request.method} is not forwarded: Hatchway only relays read methods, and every transaction must be approved in your wallet.`,
          );
        }
        return this.#forward(request);
    }
  }

  async #forward(request: JsonRpcRequest): Promise<Forwarded> {
    const upstream = this.#options.upstream();
    if (!upstream) {
      throw new HatchwayError(
        "RPC_UNREACHABLE",
        "No upstream RPC endpoint is attached to this session yet.",
      );
    }
    const text = await upstream.forward(JSON.stringify({ ...request, jsonrpc: "2.0" }));
    return new Forwarded(text);
  }
}

class Forwarded {
  constructor(readonly text: string) {}

  response(id: JsonRpcRequest["id"]): JsonRpcResponse {
    try {
      const parsed = JSON.parse(this.text) as JsonRpcResponse;
      return { ...parsed, id };
    } catch {
      return errorResponse(id, -32603, "Upstream returned an invalid response");
    }
  }
}

/**
 * Waits for a request's answer. A retry of a request that already finished gets the same
 * answer (never a new prompt), and nobody receives a transaction hash before the broadcast
 * has been verified: `completion` only resolves after the integrity checks.
 */
export async function awaitRequest(
  engine: Pick<ApprovalEngine, "attachCaller">,
  approval: ReturnType<ApprovalEngine["enqueueTransaction"]>,
  signal: AbortSignal,
): Promise<string> {
  if (approval.isTerminal) return approval.completion.promise;
  const release = engine.attachCaller(approval);
  signal.addEventListener("abort", release, { once: true });
  try {
    return await approval.completion.promise;
  } finally {
    signal.removeEventListener("abort", release);
    release();
  }
}

function parseSigner(value: unknown): Address {
  if (typeof value !== "string" || !isAddress(value, { strict: false })) {
    throw new HatchwayError("INVALID_TRANSACTION", "Signing request is missing a valid address.");
  }
  return getAddress(value);
}

function parseAttach(value: unknown): AttachParams {
  if (value === null || typeof value !== "object")
    throw new HatchwayError("USAGE", "hatchway_attach expects an object.");
  const input = value as Record<string, unknown>;
  if (typeof input.url !== "string")
    throw new HatchwayError("USAGE", "hatchway_attach requires a url.");
  const params: AttachParams = { url: input.url };
  if (input.headers && typeof input.headers === "object") {
    params.headers = Object.fromEntries(
      Object.entries(input.headers as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  }
  if (typeof input.chainId === "number") params.chainId = input.chainId;
  if (typeof input.network === "string") params.network = input.network;
  return params;
}

function errorResponse(
  id: JsonRpcRequest["id"],
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: data === undefined ? { code, message } : { code, message, data },
  };
}
