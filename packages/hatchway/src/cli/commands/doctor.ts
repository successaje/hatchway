import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { findFoundryRoot, forgeVersion } from "../../adapters/foundry.js";
import { configMentionsPlugin, findHardhatConfig, locateHardhat } from "../../adapters/hardhat.js";
import { ExitCode } from "../../core/errors.js";
import { chainName } from "../../evm/chains.js";
import { UpstreamRpc } from "../../evm/rpc.js";
import { UiAssets } from "../../server/assets.js";
import { canOpenBrowser, detectRemoteContext } from "../../util/environment.js";
import { parseOptions } from "../args.js";
import { HELP } from "../help.js";
import type { Reporter } from "../output.js";
import { VERSION } from "../version.js";

const execFileAsync = promisify(execFile);

interface Check {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

export async function doctorCommand(argv: string[], reporterFor: (json: boolean, debug: boolean, color?: boolean) => Reporter): Promise<number> {
  const { options } = parseOptions(argv, {
    json: { type: "boolean" },
    debug: { type: "boolean" },
    color: { type: "boolean" },
    help: { type: "boolean", short: "h" },
    "rpc-url": { type: "string" },
  });
  const reporter = reporterFor(options.json === true, options.debug === true, options.color as boolean | undefined);
  if (options.help) {
    reporter.line(HELP.doctor);
    return ExitCode.Success;
  }
  reporter.header("doctor");
  const checks: Check[] = [];
  const add = (check: Check) => {
    checks.push(check);
    const text = `${check.name.padEnd(18)} ${reporter.c.dim(check.detail)}`;
    if (check.status === "ok") reporter.ok(text);
    else if (check.status === "warn") reporter.warn(text);
    else reporter.fail(text);
  };

  add({ name: "Hatchway", status: "ok", detail: VERSION });
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  add({ name: "Node.js", status: nodeMajor >= 22 ? "ok" : "fail", detail: `${process.versions.node}${nodeMajor >= 22 ? "" : " (22 or newer is required)"}` });

  const ui = UiAssets.defaultDirectory();
  add({ name: "Signing page", status: existsSync(join(ui, "index.html")) ? "ok" : "fail", detail: existsSync(join(ui, "index.html")) ? "bundled" : `missing at ${ui}` });

  add(await loopbackCheck());

  const remote = detectRemoteContext();
  if (remote) {
    add({ name: "Browser", status: "warn", detail: `running in ${remote.description}: forward the session port to open the link locally` });
  } else {
    add({ name: "Browser", status: canOpenBrowser() ? "ok" : "warn", detail: canOpenBrowser() ? "can open links automatically" : "links will be printed for you to open" });
  }

  const forge = await forgeVersion();
  if (forge) {
    const unlocked = await supportsUnlocked();
    add({ name: "Foundry", status: unlocked ? "ok" : "warn", detail: `forge ${forge}${unlocked ? "" : " (no --unlocked support; update with foundryup)"}` });
  } else {
    add({ name: "Foundry", status: "warn", detail: "forge not found (needed for `hatchway forge`)" });
  }

  const foundryRoot = findFoundryRoot(process.cwd());
  const hardhatConfig = findHardhatConfig(process.cwd());
  if (foundryRoot) add({ name: "Foundry project", status: "ok", detail: foundryRoot });
  if (hardhatConfig) {
    try {
      const project = locateHardhat(process.cwd());
      add({ name: "Hardhat project", status: "ok", detail: `Hardhat ${project.version} at ${project.root}` });
      const plugin = configMentionsPlugin(project.configPath);
      add({ name: "Hardhat plugin", status: plugin ? "ok" : "warn", detail: plugin ? "hatchway/hardhat is loaded" : 'add `import hatchway from "hatchway/hardhat"` to plugins' });
    } catch (error) {
      add({ name: "Hardhat project", status: "warn", detail: error instanceof Error ? error.message : String(error) });
    }
  }
  if (!foundryRoot && !hardhatConfig) add({ name: "Project", status: "warn", detail: "no Foundry or Hardhat project in this directory" });

  const rpcUrl = (options["rpc-url"] as string | undefined) ?? process.env.ETH_RPC_URL;
  if (rpcUrl) add(await rpcCheck(rpcUrl));

  const failed = checks.filter((c) => c.status === "fail").length;
  reporter.line();
  reporter.event({ event: "result", ok: failed === 0, checks });
  return failed === 0 ? ExitCode.Success : ExitCode.Failure;
}

async function loopbackCheck(): Promise<Check> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", (error) => resolve({ name: "Loopback server", status: "fail", detail: `cannot listen on 127.0.0.1 (${error.message})` }));
    server.listen(0, "127.0.0.1", () => {
      server.close(() => resolve({ name: "Loopback server", status: "ok", detail: "can listen on 127.0.0.1" }));
    });
  });
}

async function supportsUnlocked(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("forge", ["script", "--help"], { maxBuffer: 4 * 1024 * 1024 });
    return stdout.includes("--unlocked");
  } catch {
    return false;
  }
}

async function rpcCheck(url: string): Promise<Check> {
  let rpc: UpstreamRpc;
  try {
    rpc = new UpstreamRpc(url, { timeoutMs: 8_000 });
  } catch (error) {
    return { name: "RPC endpoint", status: "fail", detail: error instanceof Error ? error.message : String(error) };
  }
  const started = Date.now();
  try {
    const chainId = await rpc.chainId();
    const block = await rpc.client.getBlockNumber();
    return { name: "RPC endpoint", status: "ok", detail: `${rpc.display} → ${chainName(chainId)} (${chainId}), block ${block}, ${Date.now() - started} ms` };
  } catch (error) {
    return { name: "RPC endpoint", status: "fail", detail: error instanceof Error ? error.message : String(error) };
  }
}
