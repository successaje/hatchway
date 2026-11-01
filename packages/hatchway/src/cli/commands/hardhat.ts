import { basename, relative } from "node:path";
import {
  configMentionsPlugin,
  locateHardhat,
  PLUGIN_SNIPPET,
  selectedNetwork,
} from "../../adapters/hardhat.js";
import { runTool, type RunningTool } from "../../adapters/process.js";
import { ExitCode, HatchwayError } from "../../core/errors.js";
import { BRIDGE_ENV } from "../../hardhat/network-hooks.js";
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
import { onInterrupt, startSession } from "../session-runner.js";

export async function hardhatCommand(
  argv: string[],
  reporterFor: (json: boolean, debug: boolean, color?: boolean) => Reporter,
): Promise<number> {
  const { options, rest } = parseOptions(argv, SESSION_OPTIONS, { stopAtPositional: true });
  const reporter = reporterFor(
    options.json === true,
    options.debug === true,
    options.color as boolean | undefined,
  );
  if (options.help || rest.length === 0) {
    reporter.line(HELP.hardhat);
    return options.help ? ExitCode.Success : ExitCode.Usage;
  }

  const project = locateHardhat(process.cwd());
  const network = selectedNetwork(rest);
  if (!network) {
    throw new HatchwayError("USAGE", "Choose a network with --network.", {
      hint: "Your wallet signs on a real network: e.g. --network localhost (with `npx hardhat node` or anvil running) or a testnet from your config.",
    });
  }
  const projectLabel = relative(process.cwd(), project.root) || basename(project.root);
  const title = `hardhat ${rest.join(" ")}`;
  reporter.header(title);
  reporter.field("Project", `${projectLabel} ${reporter.c.dim(`(Hardhat ${project.version})`)}`);
  reporter.field("Network", network);
  if (!configMentionsPlugin(project.configPath)) {
    reporter.warn(
      `${relative(process.cwd(), project.configPath)} does not seem to load the Hatchway plugin. Add it:`,
    );
    for (const line of PLUGIN_SNIPPET.split("\n")) reporter.note(line);
  }

  const bridge = await startSession({
    reporter,
    purpose: { kind: "hardhat", title, project: projectLabel },
    options,
    projectRoot: project.root,
  });

  const startedAt = new Date();
  let tool: RunningTool | undefined;
  let interrupted = false;
  const release = onInterrupt(() => {
    interrupted = true;
    reporter.warn("Interrupted. Stopping Hardhat and closing the session…");
    void tool?.stop();
    void bridge.close("cancelled", "Stopped from the terminal.");
  });

  let error: HatchwayError | undefined;
  try {
    reporter.step("Running Hardhat… (connect your wallet in the browser meanwhile)");
    reporter.line();
    tool = runTool(process.execPath, [project.cliPath, ...rest], {
      cwd: process.cwd(),
      env: { ...process.env, [BRIDGE_ENV]: bridge.rpcUrl },
      onLine: (line) => reporter.tool("hardhat", line),
      notFound: {
        message: "Node.js could not start Hardhat.",
        hint: "Reinstall the project's dependencies.",
      },
    });
    const code = await tool.exited;
    reporter.line();
    error = interrupted
      ? new HatchwayError("INTERRUPTED", "Stopped from the terminal.")
      : firstFailure(bridge);
    if (!error && code !== 0) {
      error = new HatchwayError("TOOL_FAILED", `Hardhat exited with code ${code}.`, {
        hint: "See Hardhat's output above for the reason.",
      });
    }
  } catch (caught) {
    error =
      caught instanceof HatchwayError
        ? caught
        : new HatchwayError("INTERNAL", String(caught), { cause: caught });
  } finally {
    release();
  }

  await settleSubmitted(bridge, bridge.session.chain?.local ? 10_000 : 60_000);
  const sentAny = bridge.session.requests.some((r) => r.result?.hash || r.state === "signed");
  if (!error) {
    reporter.ok(
      reporter.c.bold(
        sentAny ? "Deployment successful" : "Hardhat finished; nothing needed your wallet",
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
    command: ["hatchway", "hardhat", ...rest],
    startedAt,
    status: error ? "failed" : "success",
    projectRoot: project.root,
    extra: { framework: "hardhat", hardhatVersion: project.version, network },
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
    ...(record ? { runRecord: record } : {}),
    ...(error ? { error: { code: error.code, message: error.message } } : {}),
  });
  await bridge.close(error ? (interrupted ? "cancelled" : "failed") : "completed", error?.message);
  return exitCode;
}
