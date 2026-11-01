import { createPublicClient, custom, type PublicClient } from "viem";
import { HatchwayError } from "../core/errors.js";
import { redactUrl, scrubSecrets } from "../util/redact.js";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number | null;
  method: string;
  params?: unknown;
}

export type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: string | number | null; result: unknown }
  | { jsonrpc: "2.0"; id: string | number | null; error: { code: number; message: string; data?: unknown } };

/** A JSON-RPC error returned by the node (as opposed to a transport failure). */
export class RpcResponseError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "RpcResponseError";
    this.code = code;
    this.data = data;
  }
}

export interface UpstreamOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
}

/**
 * Client for the developer's own RPC endpoint. Secrets in the URL or headers never appear
 * in error messages: use `display` when showing the endpoint.
 */
export class UpstreamRpc {
  readonly url: string;
  readonly display: string;
  readonly client: PublicClient;
  readonly #headers: Record<string, string>;
  readonly #timeoutMs: number;
  #nextId = 1;

  constructor(url: string, options: UpstreamOptions = {}) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new HatchwayError("USAGE", "The RPC URL is not a valid URL.");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new HatchwayError("USAGE", `Unsupported RPC URL scheme "${parsed.protocol}"`, {
        hint: "Hatchway proxies HTTP(S) endpoints. Use the http(s) URL of your node or provider.",
      });
    }
    this.url = url;
    this.display = redactUrl(url);
    this.#headers = options.headers ?? {};
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.client = createPublicClient({
      transport: custom({ request: ({ method, params }) => this.request(method, params) }, { retryCount: 0 }),
    });
  }

  get secrets(): string[] {
    return [this.url, ...Object.values(this.#headers)];
  }

  async request<T = unknown>(method: string, params: unknown = []): Promise<T> {
    const body: JsonRpcRequest = { jsonrpc: "2.0", id: this.#nextId++, method, params };
    const text = await this.#post(JSON.stringify(body));
    let parsed: JsonRpcResponse;
    try {
      parsed = JSON.parse(text) as JsonRpcResponse;
    } catch {
      throw new HatchwayError("RPC_ERROR", `The RPC endpoint returned a non-JSON response to ${method}.`);
    }
    if ("error" in parsed && parsed.error) {
      throw new RpcResponseError(parsed.error.code, parsed.error.message, parsed.error.data);
    }
    return (parsed as { result: T }).result;
  }

  /** Forwards a raw JSON-RPC body and returns the raw response body. */
  async forward(body: string): Promise<string> {
    return this.#post(body);
  }

  async #post(body: string): Promise<string> {
    let response: Response;
    try {
      response = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", ...this.#headers },
        body,
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new HatchwayError("RPC_UNREACHABLE", `RPC endpoint could not be reached (${this.display}).`, {
        hint: "Check the URL and that the node is running. For a local node, start `anvil` first.",
        details: { reason: scrubSecrets(reason, this.secrets) },
      });
    }
    const text = await response.text();
    if (!response.ok && !text.trimStart().startsWith("{") && !text.trimStart().startsWith("[")) {
      throw new HatchwayError("RPC_ERROR", `RPC endpoint responded with HTTP ${response.status} (${this.display}).`, {
        hint: response.status === 401 || response.status === 403 ? "The endpoint rejected the credentials." : undefined,
      });
    }
    return text;
  }

  async chainId(): Promise<number> {
    const hex = await this.request<string>("eth_chainId");
    return Number(BigInt(hex));
  }
}

/** Builds an EIP-1193 style error message for display, trimming node noise. */
export function describeRpcError(error: unknown): string {
  if (error instanceof RpcResponseError) return error.message;
  if (error instanceof Error) return error.message.split("\n")[0] ?? error.message;
  return String(error);
}
