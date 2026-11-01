import { getAddress, isAddress } from "viem";
import { findFoundryRoot } from "../../adapters/foundry.js";
import { findHardhatConfig } from "../../adapters/hardhat.js";
import { ExitCode, HatchwayError } from "../../core/errors.js";
import { parseOptions, SESSION_OPTIONS } from "../args.js";
import { HELP } from "../help.js";
import type { Reporter } from "../output.js";
import { transactionRecords } from "../results.js";
import { onInterrupt, startSession, waitForWallet } from "../session-runner.js";

const CONNECT_OPTIONS = {
  ...SESSION_OPTIONS,
  "rpc-url": { type: "string" },
  from: { type: "string" },
} as const;

/**
 * Connects a wallet and keeps a local JSON-RPC endpoint open until Ctrl+C. Any tool that
 * sends eth_sendTransaction (cast --unlocked, Hardhat 2, scripts) can use it.
 */
export async function connectCommand(
  argv: string[],
  reporterFor: (json: boolean, debug: boolean, color?: boolean) => Reporter,
): Promise<number> {
  const { options, rest } = parseOptions(argv, CONNECT_OPTIONS);
  const reporter = reporterFor(
    options.json === true,
    options.debug === true,
    options.color as boolean | undefined,
  );
  if (options.help || rest.length > 0) {
    reporter.line(HELP.connect);
    return options.help ? ExitCode.Success : ExitCode.Usage;
  }
  const rpcUrl = (options["rpc-url"] as string | undefined) ?? process.env.ETH_RPC_URL;
  if (!rpcUrl) {
    throw new HatchwayError("USAGE", "No RPC endpoint given.", {
      hint: "Pass --rpc-url <url> (e.g. http://127.0.0.1:8545 for Anvil) or set ETH_RPC_URL.",
    });
  }
  const from = options.from as string | undefined;
  if (from !== undefined && !isAddress(from, { strict: false }))
    throw new HatchwayError("USAGE", `--from ${from} is not a valid address.`);

  reporter.header("connect");
  const projectRoot = findFoundryRoot(process.cwd()) ?? findHardhatConfig(process.cwd())?.root;
  const bridge = await startSession({
    reporter,
    purpose: { kind: "connect", title: "Wallet session for local tools" },
    options,
    upstream: { url: rpcUrl },
    projectRoot,
    expectedAddress: from ? getAddress(from) : undefined,
  });

  let stopped = false;
  const release = onInterrupt(() => {
    stopped = true;
    reporter.line();
    reporter.step("Ending the session…");
    void bridge.close("completed", "Ended from the terminal.");
  });
  try {
    const { address } = await waitForWallet(bridge, reporter);
    const chain = bridge.session.chain!;
    reporter.ok(reporter.c.bold("Ready."));
    reporter.line();
    reporter.line(
      `  Local RPC endpoint ${reporter.c.dim("(keep it private: it can request signatures from your wallet)")}`,
    );
    // Printed on purpose: this is the whole point of `connect`. It only lives as long as this process.
    process.stdout.write(options.json ? "" : `  ${bridge.rpcUrl}\n`);
    reporter.line();
    reporter.note(
      "Every transaction sent to it is shown in the browser and approved in your wallet. Examples:",
    );
    reporter.note(
      `cast send --unlocked --from ${address} --rpc-url <endpoint> <to> "fn(uint256)" 1`,
    );
    reporter.note(
      `forge script <script> --unlocked --sender ${address} --rpc-url <endpoint> --broadcast --slow`,
    );
    reporter.line();
    reporter.step("Press Ctrl+C to end the session.");
    reporter.event(
      { event: "ready", rpcUrl: bridge.rpcUrl, address, chainId: chain.id },
      { revealSecrets: true },
    );
    await bridge.session.endedPromise;
  } catch (error) {
    if (!stopped) throw error;
  } finally {
    release();
  }

  const reason = bridge.session.endedReason;
  if (!stopped && bridge.session.state !== "completed") {
    const error = bridge.session.endError();
    reporter.error(error);
    await bridge.close();
    return error.exitCode;
  }
  reporter.event({
    event: "result",
    ok: true,
    exitCode: 0,
    transactions: transactionRecords(bridge),
    ...(reason ? { reason } : {}),
  });
  await bridge.close();
  return ExitCode.Success;
}
