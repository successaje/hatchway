import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { HatchwayError } from "../core/errors.js";

export interface SpawnOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Called for each line of stdout/stderr. */
  onLine: (line: string, stream: "stdout" | "stderr") => void;
  /** Message for ENOENT, e.g. "Foundry is not installed". */
  notFound: { message: string; hint: string };
}

export interface RunningTool {
  child: ChildProcess;
  /** Resolves with the exit code (signals map to 128 + n). */
  exited: Promise<number>;
  /** Asks the tool to stop, escalating to SIGKILL if it does not. */
  stop: () => Promise<void>;
}

const SIGNAL_NUMBERS: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15, SIGKILL: 9 };

/**
 * Runs a tool with piped output (so lines can be interleaved with Hatchway's own status)
 * and an inherited stdin (so interactive prompts still work). The child is always cleaned
 * up: if Hatchway exits, the tool is terminated rather than orphaned.
 */
export function runTool(command: string, args: readonly string[], options: SpawnOptions): RunningTool {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ["inherit", "pipe", "pipe"],
    windowsHide: true,
  });

  for (const [stream, name] of [
    [child.stdout, "stdout"],
    [child.stderr, "stderr"],
  ] as const) {
    if (!stream) continue;
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    lines.on("line", (line) => options.onLine(line, name));
  }

  const exited = new Promise<number>((resolve, reject) => {
    child.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        reject(new HatchwayError("TOOL_NOT_FOUND", options.notFound.message, { hint: options.notFound.hint }));
      } else {
        reject(new HatchwayError("TOOL_FAILED", `Could not start ${command}: ${error.message}`));
      }
    });
    child.once("close", (code, signal) => {
      resolve(code ?? 128 + (signal ? (SIGNAL_NUMBERS[signal] ?? 1) : 1));
    });
  });
  exited.catch(() => undefined);

  const killOnExit = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  };
  process.once("exit", killOnExit);
  void exited.finally(() => process.off("exit", killOnExit)).catch(() => undefined);

  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 3_000);
    await exited.catch(() => undefined);
    clearTimeout(timer);
  };

  return { child, exited, stop };
}
