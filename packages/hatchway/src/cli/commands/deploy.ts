import { existsSync, readFileSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import {
  encodeAbiParameters,
  encodeDeployData,
  getAddress,
  isAddress,
  type Abi,
  type Hex,
} from "viem";
import { findFoundryRoot, foundryMissing, resolveForgeRpc } from "../../adapters/foundry.js";
import { findHardhatConfig, locateHardhat } from "../../adapters/hardhat.js";
import { runTool, type RunningTool } from "../../adapters/process.js";
import { ExitCode, HatchwayError } from "../../core/errors.js";
import { ArtifactIndex, type ArtifactEntry } from "../../evm/artifacts.js";
import { normalizeTransaction } from "../../evm/tx.js";
import { urlSecrets } from "../../util/redact.js";
import { parseOptions, SESSION_OPTIONS } from "../args.js";
import { coerceArg, parseValue } from "../coerce.js";
import { HELP } from "../help.js";
import type { Reporter } from "../output.js";
import { printSummary, transactionRecords, writeRunRecord } from "../results.js";
import { onInterrupt, startSession, waitForWallet } from "../session-runner.js";

const DEPLOY_OPTIONS = {
  ...SESSION_OPTIONS,
  "rpc-url": { type: "string" },
  value: { type: "string" },
  from: { type: "string" },
  build: { type: "boolean" },
  root: { type: "string" },
  verify: { type: "boolean" },
  verifier: { type: "string" },
  "verifier-url": { type: "string" },
} as const;

type Framework = "foundry" | "hardhat";

/** Where and how to verify the deployed contract's source, when --verify is given. */
interface VerifyOptions {
  verifier: string | undefined;
  verifierUrl: string | undefined;
}

export async function deployCommand(
  argv: string[],
  reporterFor: (json: boolean, debug: boolean, color?: boolean) => Reporter,
): Promise<number> {
  const argsIndex = argv.indexOf("--args");
  const own = argsIndex === -1 ? argv : argv.slice(0, argsIndex);
  const constructorInputs = argsIndex === -1 ? [] : argv.slice(argsIndex + 1);
  const { options, rest } = parseOptions(own, DEPLOY_OPTIONS);
  const reporter = reporterFor(
    options.json === true,
    options.debug === true,
    options.color as boolean | undefined,
  );
  if (options.help || rest.length !== 1) {
    reporter.line(HELP.deploy);
    return options.help ? ExitCode.Success : ExitCode.Usage;
  }
  const target = rest[0]!;

  const rpcOption = options["rpc-url"] as string | undefined;
  if (!rpcOption && !process.env.ETH_RPC_URL)
    throw new HatchwayError("USAGE", "No RPC endpoint given.", {
      hint: "Pass --rpc-url <url> or set ETH_RPC_URL.",
    });
  const from = options.from as string | undefined;
  if (from !== undefined && !isAddress(from, { strict: false }))
    throw new HatchwayError("USAGE", `--from ${from} is not a valid address.`);
  const value = typeof options.value === "string" ? parseValue(options.value) : 0n;
  const verify = verifyOptions(options);
  if (verify?.verifierUrl) reporter.addSecrets(urlSecrets(verify.verifierUrl));

  const start = resolve((options.root as string | undefined) ?? process.cwd());
  const { root, framework } = detectProject(start, target);
  if (verify && framework !== "foundry") throw cannotVerify(framework);
  // In a Foundry project, --rpc-url also accepts foundry.toml's rpc_endpoints aliases, as forge does.
  const rpcUrl =
    framework === "foundry"
      ? await resolveForgeRpc(rpcOption, root)
      : (rpcOption ?? process.env.ETH_RPC_URL!);

  reporter.header(`deploy ${target}`);
  if (framework && options.build !== false) await build(framework, root, reporter);

  const entry = await resolveArtifact(target, root);
  if (entry.bytecode.length === 0)
    throw new HatchwayError(
      "USAGE",
      `${entry.name} has no bytecode (is it abstract or an interface?).`,
    );
  if (entry.bytecode.includes("__$")) {
    throw new HatchwayError(
      "USAGE",
      `${entry.name} needs linked libraries, which \`hatchway deploy\` does not link.`,
      {
        hint: "Deploy it from a forge script or Hardhat Ignition module through Hatchway instead.",
      },
    );
  }
  const { data, constructorArgs } = encodeConstructor(entry, constructorInputs);
  reporter.field("Contract", `${entry.name} ${reporter.c.dim(entry.sourcePath ?? "")}`);
  if (framework)
    reporter.field(
      "Project",
      `${relative(process.cwd(), root) || basename(root)} ${reporter.c.dim(`(${framework === "foundry" ? "Foundry" : "Hardhat"})`)}`,
    );

  const bridge = await startSession({
    reporter,
    purpose: {
      kind: "deploy",
      title: `deploy ${entry.name}`,
      project: relative(process.cwd(), root) || basename(root),
    },
    options,
    upstream: { url: rpcUrl },
    projectRoot: root,
    expectedAddress: from ? getAddress(from) : undefined,
  });

  const startedAt = new Date();
  const release = onInterrupt(() => {
    reporter.warn("Interrupted. Closing the session…");
    void bridge.close("cancelled", "Stopped from the terminal.");
  });

  let error: HatchwayError | undefined;
  let deployedAt: string | undefined;
  try {
    const { address } = await waitForWallet(bridge, reporter);
    const tx = normalizeTransaction({ from: address, data, value: `0x${value.toString(16)}` });
    const request = bridge.engine.enqueueTransaction(tx, {
      title: `Deploy ${entry.name}`,
      contractName: entry.name,
    });
    await request.completion.promise;
    await request.settled.promise;
    if (request.state !== "confirmed") throw request.replayError();
    deployedAt = request.result?.contractAddress;
  } catch (caught) {
    error = asHatchwayError(caught);
  } finally {
    release();
  }

  if (!error) {
    reporter.ok(reporter.c.bold("Deployment successful"));
    reporter.line();
  }
  let verification: { ok: boolean; verifier?: string } | undefined;
  if (!error && verify && deployedAt && bridge.session.chain) {
    verification = verify.verifier ? { ok: false, verifier: verify.verifier } : { ok: false };
    try {
      await verifySource({
        root,
        entry,
        address: deployedAt,
        chainId: bridge.session.chain.id,
        constructorArgs,
        options: verify,
        reporter,
      });
      verification.ok = true;
    } catch (caught) {
      error = asHatchwayError(caught);
    }
    reporter.event({
      event: "verification",
      contract: entry.name,
      address: deployedAt,
      chainId: bridge.session.chain.id,
      ...verification,
    });
  }
  if (error) {
    reporter.error(error);
    reporter.line();
  }
  printSummary(bridge, reporter);
  const record = await writeRunRecord({
    bridge,
    command: ["hatchway", "deploy", ...argv],
    startedAt,
    status: error ? "failed" : "success",
    projectRoot: root,
    extra: { framework: framework ?? "artifact", ...(verification ? { verification } : {}) },
  });
  if (record) reporter.field("Run record", record);
  reporter.line();
  const exitCode = error ? error.exitCode : ExitCode.Success;
  reporter.event({
    event: "result",
    ok: !error,
    exitCode,
    chainId: bridge.session.chain?.id,
    wallet: bridge.session.wallet?.address,
    transactions: transactionRecords(bridge),
    ...(verification ? { verification } : {}),
    ...(record ? { runRecord: record } : {}),
    ...(error ? { error: { code: error.code, message: error.message } } : {}),
  });
  await bridge.close(error ? "failed" : "completed", error?.message);
  return exitCode;
}

function asHatchwayError(caught: unknown): HatchwayError {
  return caught instanceof HatchwayError
    ? caught
    : new HatchwayError("INTERNAL", String(caught), { cause: caught });
}

function verifyOptions(options: Record<string, unknown>): VerifyOptions | undefined {
  const verifier = options.verifier as string | undefined;
  const verifierUrl = options["verifier-url"] as string | undefined;
  if (options.verify !== true) {
    if (verifier !== undefined || verifierUrl !== undefined)
      throw new HatchwayError("USAGE", "--verifier and --verifier-url only apply with --verify.");
    return undefined;
  }
  return { verifier, verifierUrl };
}

/** Explains, before anything is deployed, why --verify cannot be used for this target. */
function cannotVerify(framework: Framework | undefined): HatchwayError {
  if (framework === "hardhat")
    return new HatchwayError("USAGE", "--verify works with Foundry projects.", {
      hint: "For Hardhat, use the hardhat-verify plugin: deploy with `hatchway hardhat ignition deploy <module> --network <name> --verify`, or run `npx hardhat verify --network <name> <address> <args…>` after this deployment.",
    });
  return new HatchwayError("USAGE", "--verify needs the contract's sources.", {
    hint: "Run it in the Foundry project that compiled the contract, not with an artifact file.",
  });
}

/**
 * Submits the deployed contract's source with `forge verify-contract`, which builds the
 * standard JSON input from the project and talks to the verifier (Sourcify unless
 * --verifier says otherwise). API keys come from forge's own sources: ETHERSCAN_API_KEY,
 * VERIFIER_API_KEY or `[etherscan]` in foundry.toml, never Hatchway's command line.
 */
async function verifySource(input: {
  root: string;
  entry: ArtifactEntry;
  address: string;
  chainId: number;
  constructorArgs: Hex;
  options: VerifyOptions;
  reporter: Reporter;
}): Promise<void> {
  const { root, entry, address, chainId, constructorArgs, options, reporter } = input;
  const args = [
    "verify-contract",
    address,
    entry.sourcePath ? `${entry.sourcePath}:${entry.name}` : entry.name,
    "--chain",
    String(chainId),
    "--watch",
  ];
  if (constructorArgs !== "0x") args.push("--constructor-args", constructorArgs);
  if (options.verifier) args.push("--verifier", options.verifier);
  if (options.verifierUrl) args.push("--verifier-url", options.verifierUrl);

  reporter.step(`Verifying ${entry.name}'s source…`);
  let tool: RunningTool | undefined;
  let interrupted = false;
  const release = onInterrupt(() => {
    interrupted = true;
    reporter.warn("Interrupted. Stopping verification…");
    void tool?.stop();
  });
  try {
    tool = runTool("forge", [...args, "--root", root], {
      cwd: root,
      onLine: (line) => reporter.tool("forge", line),
      notFound: { message: foundryMissing().message, hint: foundryMissing().hint ?? "" },
    });
    const code = await tool.exited;
    if (interrupted)
      throw new HatchwayError("INTERRUPTED", `${entry.name} is deployed but not verified.`);
    if (code !== 0) {
      throw new HatchwayError(
        "VERIFICATION_FAILED",
        `${entry.name} is deployed, but verification failed.`,
        {
          hint: `See forge's output above. To retry without deploying again, run this in the project: forge ${args.map(shellArg).join(" ")}`,
        },
      );
    }
  } finally {
    release();
  }
  reporter.ok("Source verified.");
  reporter.line();
}

function shellArg(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
}

function detectProject(
  start: string,
  target: string,
): { root: string; framework: Framework | undefined } {
  if (target.endsWith(".json") && existsSync(resolve(start, target)))
    return { root: start, framework: undefined };
  const foundry = findFoundryRoot(start);
  const hardhat = findHardhatConfig(start);
  if (foundry && (!hardhat || foundry.length >= hardhat.root.length))
    return { root: foundry, framework: "foundry" };
  if (hardhat) return { root: hardhat.root, framework: "hardhat" };
  throw new HatchwayError("PROJECT_NOT_FOUND", "No Foundry or Hardhat project found here.", {
    hint: "Run inside your project, pass --root <dir>, or give a path to a compiled artifact JSON file.",
  });
}

async function build(framework: Framework, root: string, reporter: Reporter): Promise<void> {
  reporter.step("Compiling contracts…");
  const tool =
    framework === "foundry"
      ? runTool("forge", ["build"], {
          cwd: root,
          onLine: (line) => reporter.tool("forge", line),
          notFound: { message: foundryMissing().message, hint: foundryMissing().hint ?? "" },
        })
      : runTool(process.execPath, [locateHardhat(root).cliPath, "build"], {
          cwd: root,
          onLine: (line) => reporter.tool("hardhat", line),
          notFound: {
            message: "Could not start Hardhat.",
            hint: "Reinstall the project's dependencies.",
          },
        });
  const code = await tool.exited;
  if (code !== 0)
    throw new HatchwayError("TOOL_FAILED", "Compilation failed.", {
      hint: "Fix the compiler errors above and try again.",
    });
  reporter.ok("Compilation successful.");
  reporter.line();
}

async function resolveArtifact(target: string, root: string): Promise<ArtifactEntry> {
  if (target.endsWith(".json")) {
    const path = resolve(root, target);
    const json = JSON.parse(readFileSync(path, "utf8")) as {
      abi?: Abi;
      bytecode?: string | { object?: string };
      contractName?: string;
    };
    const bytecode = typeof json.bytecode === "string" ? json.bytecode : json.bytecode?.object;
    if (!json.abi || !bytecode)
      throw new HatchwayError(
        "ARTIFACT_NOT_FOUND",
        `${target} is not a compiled contract artifact.`,
      );
    return {
      name: json.contractName ?? target.replace(/^.*\//, "").replace(/\.json$/, ""),
      abi: json.abi,
      bytecode: bytecode.replace(/^0x/, "").toLowerCase(),
      sourcePath: target,
    };
  }
  const index = await ArtifactIndex.load(root);
  const matches = index.findByName(target).filter((e) => e.bytecode.length > 0);
  const unique = [...new Map(matches.map((m) => [`${m.sourcePath}:${m.name}`, m])).values()];
  if (unique.length === 0) {
    throw new HatchwayError(
      "ARTIFACT_NOT_FOUND",
      `No compiled contract named "${target}" was found.`,
      {
        hint: "Check the name, or build the project first (forge build / npx hardhat build).",
      },
    );
  }
  if (unique.length > 1) {
    throw new HatchwayError(
      "USAGE",
      `"${target}" matches several contracts: ${unique.map((m) => `${m.sourcePath}:${m.name}`).join(", ")}.`,
      {
        hint: "Use the full form <source path>:<ContractName>.",
      },
    );
  }
  return unique[0]!;
}

function encodeConstructor(
  entry: ArtifactEntry,
  inputs: string[],
): { data: Hex; constructorArgs: Hex } {
  const ctor = entry.abi.find((item) => item.type === "constructor");
  const params = ctor && "inputs" in ctor ? ctor.inputs : [];
  if (params.length !== inputs.length) {
    const expected =
      params.map((p) => `${p.type}${p.name ? ` ${p.name}` : ""}`).join(", ") || "none";
    throw new HatchwayError(
      "USAGE",
      `${entry.name} takes ${params.length} constructor argument(s) (${expected}), got ${inputs.length}.`,
      {
        hint:
          params.length > 0
            ? 'Pass them after --args, e.g. --args "My Token" MTK 1000000'
            : undefined,
      },
    );
  }
  const args = params.map((param, i) => coerceArg(param, inputs[i]));
  return {
    data: encodeDeployData({ abi: entry.abi, bytecode: `0x${entry.bytecode}`, args }),
    constructorArgs: params.length > 0 ? encodeAbiParameters(params, args) : "0x",
  };
}
