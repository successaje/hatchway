import type { NetworkHooks } from "hardhat/types/hooks";
import type { NetworkConnection } from "hardhat/types/network";
import type { JsonRpcRequest, JsonRpcResponse } from "hardhat/types/providers";

/** Methods answered by the browser wallet instead of the network. */
const WALLET_METHODS = new Set([
  "eth_accounts",
  "eth_requestAccounts",
  "eth_sendTransaction",
  "personal_sign",
  "eth_sign",
  "eth_signTypedData",
  "eth_signTypedData_v3",
  "eth_signTypedData_v4",
  "eth_signTransaction",
]);

/** Set by the `hatchway hardhat` command; the plugin does nothing without it. */
export const BRIDGE_ENV = "HATCHWAY_BRIDGE_URL";

const attached = new WeakMap<object, Promise<void>>();

let nextId = 1;

async function callBridge(url: string, method: string, params: unknown, id: JsonRpcRequest["id"]): Promise<JsonRpcResponse> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
  } catch {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: 4900, message: "The Hatchway session is not reachable. Was `hatchway hardhat` stopped?" },
    };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  if (body && typeof body === "object" && "jsonrpc" in body) return body as JsonRpcResponse;
  const message = body && typeof body === "object" && "message" in body ? String((body as { message: unknown }).message) : `HTTP ${response.status}`;
  return { jsonrpc: "2.0", id, error: { code: 4900, message: `Hatchway session refused the request: ${message}` } };
}

function errorResponse(id: JsonRpcRequest["id"], message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code: 4200, message } };
}

async function attach(bridge: string, connection: NetworkConnection<string>): Promise<void> {
  const config = connection.networkConfig;
  if (config.type !== "http") return;
  const url = await config.url.get();
  const result = await callBridge(
    bridge,
    "hatchway_attach",
    [{ url, headers: config.httpHeaders, network: connection.networkName, ...(config.chainId ? { chainId: config.chainId } : {}) }],
    `attach-${nextId++}`,
  );
  if ("error" in result && result.error) throw new Error(`Hatchway: ${result.error.message}`);
}

export default async (): Promise<Partial<NetworkHooks>> => ({
  async onRequest(context, networkConnection, jsonRpcRequest, next) {
    const bridge = process.env[BRIDGE_ENV];
    if (!bridge || !WALLET_METHODS.has(jsonRpcRequest.method)) {
      return next(context, networkConnection, jsonRpcRequest);
    }
    if (networkConnection.networkConfig.type !== "http") {
      return errorResponse(
        jsonRpcRequest.id,
        `Hatchway needs an HTTP network your wallet can reach, but "${networkConnection.networkName}" is Hardhat's in-process network. ` +
          "Pass --network (e.g. --network localhost with `npx hardhat node` running, or a testnet).",
      );
    }
    let ready = attached.get(networkConnection);
    if (!ready) {
      ready = attach(bridge, networkConnection);
      attached.set(networkConnection, ready);
    }
    try {
      await ready;
    } catch (error) {
      return errorResponse(jsonRpcRequest.id, error instanceof Error ? error.message : String(error));
    }
    return callBridge(bridge, jsonRpcRequest.method, jsonRpcRequest.params ?? [], jsonRpcRequest.id);
  },
});
