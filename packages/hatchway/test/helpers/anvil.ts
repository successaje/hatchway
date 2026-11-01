import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { createPublicClient, http, type PublicClient } from "viem";

/** Anvil's default unlocked development accounts (public test keys; never hold real funds). */
export const ANVIL_ACCOUNTS = [
  "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
] as const;

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

export interface Anvil {
  url: string;
  port: number;
  client: PublicClient;
  process: ChildProcess;
  stop: () => Promise<void>;
}

export async function startAnvil(
  options: { chainId?: number; blockTime?: number } = {},
): Promise<Anvil> {
  const port = await freePort();
  const args = ["--port", String(port), "--host", "127.0.0.1", "--silent"];
  if (options.chainId) args.push("--chain-id", String(options.chainId));
  if (options.blockTime) args.push("--block-time", String(options.blockTime));
  const child = spawn("anvil", args, { stdio: "ignore" });
  const url = `http://127.0.0.1:${port}`;
  const client = createPublicClient({ transport: http(url, { retryCount: 0 }) });
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      await client.getChainId();
      break;
    } catch {
      if (Date.now() > deadline) {
        child.kill("SIGKILL");
        throw new Error("anvil did not start");
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return {
    url,
    port,
    client,
    process: child,
    stop: async () => {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await new Promise((r) => child.once("exit", r));
    },
  };
}

/** Raw JSON-RPC call (used for anvil_* and wallet methods viem does not expose). */
export async function rpc<T = unknown>(
  url: string,
  method: string,
  params: unknown[] = [],
): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await response.json()) as { result?: T; error?: { code: number; message: string } };
  if (body.error) throw Object.assign(new Error(body.error.message), { code: body.error.code });
  return body.result as T;
}
