import { relative } from "node:path";
import { getAddress, isAddress } from "viem";
import {
  buildForgeArgs,
  findBroadcastFile,
  findFoundryRoot,
  foundryMissing,
  forgeVersion,
  parseForgeArgs,
  resolveForgeRpc,
} from "../../adapters/foundry.js";
import { runTool, type RunningTool } from "../../adapters/process.js";
import { ExitCode, HatchwayError } from "../../core/errors.js";
import { parseOptions, SESSION_OPTIONS } from "../args.js";
import { HELP } from "../help.js";
import type { Reporter } from "../output.js";
import {
  firstFailure,
  printSummary,
  settleSubmitted,
  transactionRecords,
  writeRunRecord,
} from "../results.js";
import { onInterrupt, sessionTimeoutMs, startSession, waitForWallet } from "../session-runner.js";

export async function forgeCommand(
  argv: string[],
  reporterFor: (json: boolean, debug: boolean, color?: boolean) => Reporter,
): Promise<number> {
  const { options, rest } = parseOptions(argv, SESSION_OPTIONS, { stopAtPositional: true });
  const reporter = reporterFor(
    options.json === true,
    options.debug === true,
    options.color as boolean | undefined,
  );
  if (options.help || rest.length === 0 || (rest.length === 1 && rest[0] === "script")) {
    reporter.line(HELP.forge);
    return options.help ? ExitCode.Success : ExitCode.Usage;
  }

  const invocation = parseForgeArgs(rest);
  const root = findFoundryRoot(invocation.root ?? process.cwd());
  if (!root) {
    throw new HatchwayError(
      "PROJECT_NOT_FOUND",
      "No Foundry project found (no foundry.toml in this directory or its parents).",
    );
  }
  const version = await forgeVersion();
  if (!version) throw foundryMissing();
  if (invocation.sender && !isAddress(invocation.sender, { strict: false })) {
    throw new HatchwayError("USAGE", `--sender ${invocation.sender} is not a valid address.`);
  }
  const upstreamUrl = await resolveForgeRpc(invocation.rpc, root);
  const project = relative(process.cwd(), root) || ".";
  const title = `forge script ${invocation.script ?? ""}`.trim();

  reporter.header(title);
  reporter.field("Project", `${project} ${reporter.c.dim(`(Foundry ${version.split(" ")[0]})`)}`);

  const bridge = await startSession({
    reporter,
    purpose: { kind: "forge", title, project },
    options,
    upstream: { url: upstreamUrl },
    projectRoot: root,
    expectedAddress: invocation.sender ? getAddress(invocation.sender) : undefined,
  });
  if (!invocation.broadcast) {
    reporter.note(
      "No --broadcast: forge will simulate only. Your wallet is used for the sender address; nothing is sent.",
    );
  }

  const startedAt = new Date();
  let tool: RunningTool | undefined;
  let interrupted = false;
  const release = onInterrupt(() => {
    interrupted = true;
    reporter.warn("Interrupted. Stopping forge and closing the session…");
    void tool?.stop();
    void bridge.close("cancelled", "Stopped from the terminal.");
  });

  let exitCode: number;
  let error: HatchwayError | undefined;
  try {
    const { address } = await waitForWallet(bridge, reporter);
    reporter.step("Running forge script…");
    reporter.line();

    const env = { ...process.env };
    // Newer forge versions honour this for unlocked sends; it must outlast a human approval.
    if (!invocation.hasRpcTimeout && !env.ETH_RPC_TIMEOUT)
      env.ETH_RPC_TIMEOUT = String(Math.ceil(sessionTimeoutMs(options) / 1000));
    tool = runTool("forge", ["script", ...buildForgeArgs(invocation, bridge.rpcUrl, address)], {
      cwd: process.cwd(),
      env,
      onLine: (line) => reporter.tool("forge", line),
      notFound: { message: foundryMissing().message, hint: foundryMissing().hint ?? "" },
    });
    const code = await tool.exited;
    reporter.line();

    error = interrupted
      ? new HatchwayError("INTERRUPTED", "Stopped from the terminal.")
      : firstFailure(bridge);
    if (!error && code !== 0) {
      error = new HatchwayError("TOOL_FAILED", `forge script exited with code ${code}.`, {
        hint: "See forge's output above for the reason.",
      });
    }
    exitCode = error ? error.exitCode : ExitCode.Success;
  } catch (caught) {
    error =
      caught instanceof HatchwayError
        ? caught
        : new HatchwayError("INTERNAL", String(caught), { cause: caught });
    if (interrupted) error = new HatchwayError("INTERRUPTED", "Stopped from the terminal.");
    exitCode = error.exitCode;
  } finally {
    release();
  }

  await settleSubmitted(bridge, bridge.session.chain?.local ? 10_000 : 60_000);
  const chainId = bridge.session.chain?.id;
  const broadcastFile =
    chainId !== undefined
      ? await findBroadcastFile(root, invocation.script, chainId, startedAt.getTime())
      : undefined;
  const sentAny = bridge.session.requests.some((r) => r.result?.hash);

  if (!error) {
    reporter.ok(
      reporter.c.bold(
        sentAny
          ? "Deployment successful"
          : invocation.broadcast
            ? "Script finished; no transactions were needed"
            : "Simulation finished",
      ),
    );
    reporter.line();
  } else {
    reporter.error(error);
    reporter.line();
  }
  printSummary(bridge, reporter);
  const record = await writeRunRecord({
    bridge,
    command: `hatchway forge ${rest.join(" ")}`,
    startedAt,
    status: error ? "failed" : "success",
    projectRoot: root,
    extra: {
      framework: "foundry",
      forgeVersion: version,
      ...(broadcastFile ? { broadcastFile: relative(root, broadcastFile) } : {}),
    },
  });
  if (broadcastFile) reporter.field("Forge log", relative(process.cwd(), broadcastFile));
  if (record) reporter.field("Run record", record);
  reporter.line();

  reporter.event({
    event: "result",
    ok: !error,
    exitCode,
    chainId,
    wallet: bridge.session.wallet?.address,
    transactions: transactionRecords(bridge),
    ...(broadcastFile ? { broadcastFile } : {}),
    ...(record ? { runRecord: record } : {}),
    ...(error ? { error: { code: error.code, message: error.message } } : {}),
  });
  await bridge.close(error ? (interrupted ? "cancelled" : "failed") : "completed", error?.message);
  return exitCode;
}
