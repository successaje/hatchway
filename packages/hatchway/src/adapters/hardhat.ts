import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { HatchwayError } from "../core/errors.js";

const CONFIG_NAMES = ["hardhat.config.ts", "hardhat.config.mts", "hardhat.config.cts", "hardhat.config.js", "hardhat.config.mjs", "hardhat.config.cjs"];

export interface HardhatProject {
  root: string;
  configPath: string;
  /** Absolute path of Hardhat's CLI entry point, run with the current Node binary. */
  cliPath: string;
  version: string;
}

export function findHardhatConfig(start: string): { root: string; configPath: string } | undefined {
  let dir = resolve(start);
  for (;;) {
    for (const name of CONFIG_NAMES) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return { root: dir, configPath: candidate };
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function locateHardhat(start: string): HardhatProject {
  const found = findHardhatConfig(start);
  if (!found) {
    throw new HatchwayError("PROJECT_NOT_FOUND", "No Hardhat project found (no hardhat.config.* in this directory or its parents).");
  }
  const require = createRequire(join(found.root, "package.json"));
  let pkgPath: string;
  try {
    pkgPath = require.resolve("hardhat/package.json");
  } catch {
    throw new HatchwayError("TOOL_NOT_FOUND", "Hardhat is not installed in this project.", { hint: "Run `npm install --save-dev hardhat`." });
  }
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string; bin?: string | Record<string, string> };
  const major = Number(pkg.version.split(".")[0]);
  if (major < 3) {
    throw new HatchwayError("UNSUPPORTED_SIGNER", `Hardhat ${pkg.version} is not supported by \`hatchway hardhat\` (Hardhat 3 is required).`, {
      hint: "With Hardhat 2, run `hatchway connect --rpc-url <url>` and point a network's url at the printed local RPC endpoint.",
    });
  }
  const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.hardhat;
  if (!bin) throw new HatchwayError("TOOL_NOT_FOUND", "Could not find Hardhat's command-line entry point.");
  return { ...found, cliPath: join(dirname(pkgPath), bin), version: pkg.version };
}

/** Heuristic check that the config imports the plugin; used for a helpful warning only. */
export function configMentionsPlugin(configPath: string): boolean {
  try {
    return readFileSync(configPath, "utf8").includes("hatchway/hardhat");
  } catch {
    return false;
  }
}

/** The network the Hardhat command will use, from --network or HARDHAT_NETWORK. */
export function selectedNetwork(args: readonly string[], env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    if (token === "--network") return args[i + 1];
    if (token.startsWith("--network=")) return token.slice("--network=".length);
  }
  return env.HARDHAT_NETWORK;
}

export const PLUGIN_SNIPPET = `import hatchway from "hatchway/hardhat";

export default defineConfig({
  plugins: [hatchway /* , ...your other plugins */],
  // ...
});`;
