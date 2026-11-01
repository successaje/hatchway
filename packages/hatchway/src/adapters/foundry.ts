import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { HatchwayError } from "../core/errors.js";

const execFileAsync = promisify(execFile);

/** forge options that select a different signer; Hatchway is the signer. */
const CONFLICTING_SIGNERS = new Set([
  "--private-key",
  "--private-keys",
  "--mnemonic",
  "--mnemonics",
  "--mnemonic-passphrase",
  "--mnemonic-passphrases",
  "--mnemonic-derivation-path",
  "--mnemonic-derivation-paths",
  "--mnemonic-index",
  "--mnemonic-indexes",
  "--keystore",
  "--keystores",
  "--account",
  "--accounts",
  "--password",
  "--password-file",
  "--ledger",
  "-l",
  "--trezor",
  "-t",
  "--aws",
  "--gcp",
  "--turnkey",
  "--browser",
  "--interactive",
  "--interactives",
  "-i",
]);

const UNSUPPORTED = new Map([
  [
    "--multi",
    "Multi-chain broadcasting (--multi) is not supported: only the primary --rpc-url is routed through your wallet.",
  ],
  ["--debug", "The script debugger cannot be combined with wallet signing."],
]);

const RPC_FLAGS = new Set(["--rpc-url", "-r", "--fork-url", "-f"]);

export interface ForgeInvocation {
  /** Arguments after `forge script`, as the user gave them. */
  args: string[];
  /** Best-effort script path, for display and artifact lookup. */
  script: string | undefined;
  rpc: string | undefined;
  sender: string | undefined;
  root: string | undefined;
  broadcast: boolean;
  hasSlow: boolean;
  hasRpcTimeout: boolean;
}

function flagValue(
  args: readonly string[],
  index: number,
): { name: string; value: string | undefined; consumed: number } {
  const token = args[index]!;
  const eq = token.indexOf("=");
  if (token.startsWith("--") && eq !== -1)
    return { name: token.slice(0, eq), value: token.slice(eq + 1), consumed: 0 };
  return { name: token, value: args[index + 1], consumed: 1 };
}

export function parseForgeArgs(input: readonly string[]): ForgeInvocation {
  // Accept both `hatchway forge script/Deploy.s.sol` and `hatchway forge script script/Deploy.s.sol`.
  const args = input[0] === "script" ? input.slice(1) : [...input];
  const result: ForgeInvocation = {
    args,
    script: undefined,
    rpc: undefined,
    sender: undefined,
    root: undefined,
    broadcast: false,
    hasSlow: false,
    hasRpcTimeout: false,
  };
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    const base = token.split("=")[0]!;
    if (CONFLICTING_SIGNERS.has(base)) {
      throw new HatchwayError(
        "UNSUPPORTED_SIGNER",
        `${base} selects a different signer. Hatchway signs with your browser wallet, so remove it.`,
      );
    }
    const unsupported = UNSUPPORTED.get(base);
    if (unsupported) throw new HatchwayError("UNSUPPORTED_SIGNER", unsupported);
    if (RPC_FLAGS.has(base)) {
      const { value, consumed } = flagValue(args, i);
      result.rpc = value;
      i += consumed;
    } else if (base === "--sender") {
      const { value, consumed } = flagValue(args, i);
      result.sender = value;
      i += consumed;
    } else if (base === "--root") {
      const { value, consumed } = flagValue(args, i);
      result.root = value;
      i += consumed;
    } else if (base === "--broadcast") result.broadcast = true;
    else if (base === "--slow") result.hasSlow = true;
    else if (base === "--rpc-timeout") result.hasRpcTimeout = true;
    else if (
      !token.startsWith("-") &&
      result.script === undefined &&
      (token.endsWith(".sol") || token.includes(".sol:"))
    ) {
      result.script = token;
    }
  }
  if (result.script === undefined) result.script = args.find((a) => !a.startsWith("-"));
  return result;
}

/**
 * Rewrites forge's arguments so it sends through the bridge:
 *  - `--rpc-url` points at the local bridge (the original endpoint stays upstream),
 *  - `--unlocked --sender <wallet>` makes forge use eth_sendTransaction,
 *  - `--slow` sends one transaction at a time, matching one wallet approval at a time and
 *    giving each approval its own RPC timeout window.
 */
export function buildForgeArgs(
  invocation: ForgeInvocation,
  bridgeRpcUrl: string,
  sender: string,
): string[] {
  const out: string[] = [];
  const args = invocation.args;
  let replacedRpc = false;
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    const base = token.split("=")[0]!;
    if (RPC_FLAGS.has(base) || base === "--sender" || base === "--unlocked") {
      if (RPC_FLAGS.has(base) && !replacedRpc) {
        out.push("--rpc-url", bridgeRpcUrl);
        replacedRpc = true;
      }
      if (base !== "--unlocked" && !token.includes("=")) i += 1;
      continue;
    }
    out.push(token);
  }
  if (!replacedRpc) out.push("--rpc-url", bridgeRpcUrl);
  out.push("--unlocked", "--sender", sender);
  if (!invocation.hasSlow) out.push("--slow");
  return out;
}

export function findFoundryRoot(start: string): string | undefined {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, "foundry.toml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

interface ForgeConfig {
  eth_rpc_url?: string | null;
  rpc_endpoints?: Record<string, string | { endpoint?: string; url?: string }>;
}

async function forgeConfig(root: string): Promise<ForgeConfig> {
  try {
    const { stdout } = await execFileAsync("forge", ["config", "--json"], {
      cwd: root,
      maxBuffer: 16 * 1024 * 1024,
    });
    return JSON.parse(stdout) as ForgeConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw foundryMissing();
    return {};
  }
}

function interpolateEnv(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
    const resolved = env[name];
    if (resolved === undefined) {
      throw new HatchwayError(
        "USAGE",
        `foundry.toml references \${${name}}, but it is not set in the environment.`,
      );
    }
    return resolved;
  });
}

const URL_PATTERN = /^(https?|wss?):\/\//i;

/** Resolves the endpoint forge would use: a URL, a foundry.toml alias, ETH_RPC_URL, or config. */
export async function resolveForgeRpc(
  value: string | undefined,
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  if (value && URL_PATTERN.test(value)) return value;
  if (value) {
    const config = await forgeConfig(root);
    const entry = config.rpc_endpoints?.[value];
    const raw = typeof entry === "string" ? entry : (entry?.endpoint ?? entry?.url);
    if (!raw) {
      throw new HatchwayError(
        "USAGE",
        `"${value}" is not a URL or an rpc_endpoints alias in foundry.toml.`,
      );
    }
    return interpolateEnv(raw, env);
  }
  if (env.ETH_RPC_URL) return env.ETH_RPC_URL;
  const config = await forgeConfig(root);
  if (config.eth_rpc_url) return interpolateEnv(config.eth_rpc_url, env);
  throw new HatchwayError("USAGE", "No RPC endpoint given.", {
    hint: "Pass --rpc-url <url-or-alias> (for a local Anvil node: --rpc-url http://127.0.0.1:8545).",
  });
}

export function foundryMissing(): HatchwayError {
  return new HatchwayError(
    "TOOL_NOT_FOUND",
    "Foundry is not installed (forge was not found on PATH).",
    {
      hint: "Install it with `curl -L https://foundry.paradigm.xyz | bash && foundryup`, then open a new terminal.",
    },
  );
}

export async function forgeVersion(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("forge", ["--version"]);
    return stdout
      .split("\n")[0]
      ?.replace(/^forge\s+(Version:\s*)?/i, "")
      .trim();
  } catch {
    return undefined;
  }
}

/** Finds the broadcast file forge wrote for this run, if any. */
export async function findBroadcastFile(
  root: string,
  script: string | undefined,
  chainId: number,
  since: number,
): Promise<string | undefined> {
  if (!script) return undefined;
  const file = basename(script.split(":")[0]!);
  const dir = join(root, "broadcast", file, String(chainId));
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return undefined;
  }
  const latest = names
    .filter((n) => n.endsWith("-latest.json"))
    .map((n) => join(dir, n))
    .filter((p) => statSync(p).mtimeMs >= since - 1_000)
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return latest[0];
}
