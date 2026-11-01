import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

export const BIN = fileURLToPath(new URL("../../dist/bin.js", import.meta.url));
export const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
export const FOUNDRY_EXAMPLE = fileURLToPath(new URL("../../../../examples/foundry", import.meta.url));
export const HARDHAT_EXAMPLE = fileURLToPath(new URL("../../../../examples/hardhat-basic", import.meta.url));

export type CliEvent = { event: string } & Record<string, unknown>;

export interface CliRun {
  child: ChildProcess;
  events: CliEvent[];
  stderr: () => string;
  /** Resolves with the session URL from the first `session` event. */
  sessionUrl: Promise<string>;
  exited: Promise<number>;
  result: () => CliEvent | undefined;
  waitForEvent: (name: string, predicate?: (e: CliEvent) => boolean, timeoutMs?: number) => Promise<CliEvent>;
}

/** Runs the built CLI in --json mode and collects its NDJSON events. */
export function runCli(args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv }): CliRun {
  const child = spawn(process.execPath, [BIN, ...args], {
    cwd: options.cwd,
    env: { ...process.env, CI: "1", NO_COLOR: "1", ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const events: CliEvent[] = [];
  let stderr = "";
  let buffer = "";
  const listeners = new Set<() => void>();
  let resolveUrl!: (url: string) => void;
  const sessionUrl = new Promise<string>((resolve) => (resolveUrl = resolve));

  child.stdout!.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
      if (!line) continue;
      try {
        const event = JSON.parse(line) as CliEvent;
        events.push(event);
        if (event.event === "session" && typeof event.url === "string") resolveUrl(event.url);
        for (const listener of listeners) listener();
      } catch {
        stderr += `[non-json stdout] ${line}\n`;
      }
    }
  });
  child.stderr!.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exited = new Promise<number>((resolve) => child.once("close", (code) => resolve(code ?? -1)));

  return {
    child,
    events,
    stderr: () => stderr,
    sessionUrl,
    exited,
    result: () => events.find((e) => e.event === "result"),
    waitForEvent: (name, predicate = () => true, timeoutMs = 30_000) =>
      new Promise((resolve, reject) => {
        const check = () => {
          const found = events.find((e) => e.event === name && predicate(e));
          if (found) {
            listeners.delete(check);
            clearTimeout(timer);
            resolve(found);
          }
        };
        const timer = setTimeout(() => {
          listeners.delete(check);
          reject(new Error(`timed out waiting for ${name}; stderr:\n${stderr}`));
        }, timeoutMs);
        listeners.add(check);
        check();
      }),
  };
}
