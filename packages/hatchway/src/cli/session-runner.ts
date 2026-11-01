import type { Address } from "viem";
import { Bridge, DEFAULTS } from "../bridge.js";
import { HatchwayError } from "../core/errors.js";
import type { DecodedArg, SessionPurpose } from "../core/protocol.js";
import type { ApprovalRequest } from "../core/request.js";
import { shortHex } from "../evm/format.js";
import { canOpenBrowser, detectRemoteContext, openInBrowser } from "../util/environment.js";
import { parseDuration } from "../evm/format.js";
import type { ParsedOptions } from "./args.js";
import { clean, type Reporter } from "./output.js";

export interface SessionRunOptions {
  reporter: Reporter;
  purpose: SessionPurpose;
  options: ParsedOptions;
  upstream?: { url: string; headers?: Record<string, string> } | undefined;
  projectRoot?: string | undefined;
  expectedAddress?: Address | undefined;
}

export function sessionTimeoutMs(options: ParsedOptions): number {
  const raw = options["session-timeout"];
  if (typeof raw !== "string") return DEFAULTS.ttlMs;
  const ms = parseDuration(raw);
  if (ms === undefined || ms < 60_000) {
    throw new HatchwayError(
      "USAGE",
      "--session-timeout must be a duration of at least 1m (e.g. 30m, 2h).",
    );
  }
  return ms;
}

function parsePort(value: string | boolean | undefined): number {
  if (value === undefined || typeof value === "boolean") return 0;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new HatchwayError("USAGE", "--port must be between 1 and 65535.");
  return port;
}

/** Starts a bridge, prints the session link, and mirrors session events to the terminal. */
export async function startSession(run: SessionRunOptions): Promise<Bridge> {
  const { reporter, options } = run;
  const ttlMs = sessionTimeoutMs(options);
  const bridge = await Bridge.start({
    purpose: run.purpose,
    port: parsePort(options.port),
    ttlMs,
    expectedAddress: run.expectedAddress,
    upstream: run.upstream,
    projectRoot: run.projectRoot,
  });
  // Re-read on every line: a Hardhat script attaches its endpoint after the session starts.
  reporter.addSecretSource(() => bridge.secrets);

  const chain = bridge.session.chain;
  if (chain && bridge.upstream) {
    reporter.field(
      "Network",
      `${chain.name} ${reporter.c.dim(`· chain ${chain.id} · ${bridge.upstream.display}`)}`,
    );
  }
  if (run.expectedAddress) reporter.field("Account", run.expectedAddress);
  reporter.line();

  const url = bridge.sessionUrl;
  reporter.event({
    event: "session",
    url,
    port: bridge.port,
    expiresAt: new Date(bridge.session.expiresAt).toISOString(),
  });
  reporter.line(`  Open this link in the browser where your wallet is installed:`);
  reporter.line(`  ${reporter.c.cyan(reporter.c.underline(url))}`);

  const remote = detectRemoteContext();
  if (remote) {
    reporter.line();
    reporter.warn(
      `You are in ${remote.description}; this link points at this machine's loopback address.`,
    );
    reporter.note(
      `Forward the port from the computer with your browser, then open the link there:`,
    );
    reporter.note(`ssh -N -L ${bridge.port}:127.0.0.1:${bridge.port} <user>@<this-host>`);
    if (options.port === undefined)
      reporter.note("Tip: pass --port <n> to keep the same port across runs.");
  } else if (options.open !== false && canOpenBrowser()) {
    const opened = await openInBrowser(url);
    if (!opened) reporter.note("Could not open a browser automatically; copy the link above.");
  }
  reporter.line();
  wireEvents(bridge, reporter);
  return bridge;
}

function wireEvents(bridge: Bridge, reporter: Reporter): void {
  const { session } = bridge;
  let reconnectTimer: NodeJS.Timeout | undefined;
  let everAttached = false;

  session.on("event", (event) => {
    switch (event.type) {
      case "browser_attached":
        if (reconnectTimer) clearTimeout(reconnectTimer);
        if (!everAttached) reporter.step("Browser connected. Waiting for your wallet…");
        else reporter.ok("Browser reconnected.");
        everAttached = true;
        break;
      case "browser_detached":
        reconnectTimer = setTimeout(() => {
          if (session.ended || session.hasBrowser) return;
          const url = bridge.newSessionUrl();
          reporter.warn("The browser tab disconnected. To continue, reopen the session:");
          reporter.line(`    ${reporter.c.cyan(url)}`);
          reporter.event({ event: "session", url, port: bridge.port, reconnect: true });
        }, 8_000);
        reconnectTimer.unref();
        break;
      case "wallet_connected": {
        const w = event.wallet;
        reporter.ok(`Wallet connected ${reporter.c.dim(`· ${clean(w.name)}`)}`);
        reporter.field("Address", w.address);
        reporter.line();
        reporter.event({ event: "wallet", address: w.address, chainId: w.chainId, wallet: w.name });
        break;
      }
      case "wallet_issue":
        reporter.warn(clean(event.detail));
        reporter.event({ event: "wallet_issue", issue: event.issue, message: event.detail });
        break;
      case "wallet_issue_resolved":
        reporter.ok("Wallet is ready.");
        break;
      case "request_review":
        describeReview(event.request, reporter);
        break;
      case "request_in_wallet":
        reporter.note(`Waiting for approval in ${clean(session.wallet?.name ?? "your wallet")}…`);
        break;
      case "request_submitted": {
        const hash = event.request.result?.hash ?? "";
        reporter.ok(`Submitted ${reporter.c.dim(hash)}`);
        reporter.event({ event: "submitted", index: event.request.index, hash });
        break;
      }
      case "request_abandoned":
        reporter.warn(
          `The calling tool stopped waiting for request ${event.request.index}, but it is still open in your wallet.`,
        );
        reporter.note(
          "Reject it in the wallet unless you want it sent anyway; the tool will not see the result.",
        );
        break;
      case "request_late_broadcast":
        reporter.fail(
          `Request ${event.request.index} was not approved here, but your wallet broadcast it anyway: ${event.request.lateBroadcastHash}`,
        );
        reporter.note("The calling tool was told it was rejected. Remaining requests are stopped.");
        reporter.event({
          event: "late_broadcast",
          index: event.request.index,
          hash: event.request.lateBroadcastHash,
        });
        break;
      case "request_finished":
        describeFinished(event.request, reporter);
        break;
      default:
        break;
    }
  });
}

/** Shows text held in fixed-size bytes the way Solidity writes it: bytes32("token"). */
function formatArgs(args: DecodedArg[]): string {
  return args
    .map((a) => (a.text === undefined ? a.value : `${a.type}(${JSON.stringify(a.text)})`))
    .join(", ");
}

function describeReview(request: ApprovalRequest, reporter: Reporter): void {
  const title = clean(request.review?.title ?? request.signatureReview?.title ?? "Request");
  reporter.active(
    `${reporter.c.bold(`${request.index}.`)} ${title} ${reporter.c.dim("— review it in your browser")}`,
  );
  const review = request.review;
  if (review) {
    if (review.constructorArgs?.length)
      reporter.note(`args: ${formatArgs(review.constructorArgs)}`);
    if (review.args?.length && review.action === "call")
      reporter.note(`args: ${formatArgs(review.args)}`);
    if (review.to && review.action !== "deploy_create2") reporter.note(`to: ${review.to}`);
    if (review.value !== "0") reporter.note(`value: ${review.valueDisplay}`);
    if (review.simulation.status === "failed")
      reporter.warn(`Simulation failed: ${clean(review.simulation.message ?? "unknown reason")}`);
  }
  reporter.event({
    event: "request",
    index: request.index,
    kind: request.kind,
    title,
    ...(review ? { action: review.action, simulation: review.simulation.status } : {}),
  });
}

function describeFinished(request: ApprovalRequest, reporter: Reporter): void {
  const result = request.result;
  switch (request.state) {
    case "confirmed": {
      const parts = [`block ${result?.blockNumber}`];
      if (result?.feePaidDisplay) parts.push(`fee ${result.feePaidDisplay}`);
      reporter.ok(`Confirmed ${reporter.c.dim(parts.join(" · "))}`);
      if (result?.contractAddress) {
        reporter.note(
          `${clean(request.review?.contractName ?? "Contract")} deployed at ${result.contractAddress}`,
        );
      }
      reporter.line();
      break;
    }
    case "signed":
      reporter.ok(`Signed ${reporter.c.dim(shortHex(result?.signature ?? "", 10, 8))}`);
      reporter.line();
      break;
    case "reverted":
      reporter.fail(`Transaction reverted on-chain ${reporter.c.dim(result?.hash ?? "")}`);
      break;
    case "rejected":
      reporter.fail(clean(request.error?.message ?? "Rejected in wallet."));
      break;
    default:
      reporter.fail(clean(request.error?.message ?? `Request ${request.state}.`));
  }
  reporter.event({
    event: request.state === "confirmed" || request.state === "signed" ? "confirmed" : "failed",
    index: request.index,
    state: request.state,
    ...(result?.hash ? { hash: result.hash } : {}),
    ...(result?.contractAddress ? { contractAddress: result.contractAddress } : {}),
    ...(result?.blockNumber ? { blockNumber: result.blockNumber } : {}),
    ...(request.error ? { code: request.error.code, message: request.error.message } : {}),
  });
}

/** Waits for a wallet, printing guidance while it waits. */
export async function waitForWallet(
  bridge: Bridge,
  reporter: Reporter,
): Promise<{ address: Address }> {
  if (!bridge.session.hasBrowser) reporter.step("Waiting for the browser…");
  const wallet = await bridge.session.waitForWallet();
  return { address: wallet.address as Address };
}

/** Installs Ctrl+C / SIGTERM handling. The first signal runs `onStop`; a second forces exit. */
export function onInterrupt(onStop: (signal: NodeJS.Signals) => void): () => void {
  let count = 0;
  const handler = (signal: NodeJS.Signals) => {
    count += 1;
    if (count > 1) process.exit(130);
    onStop(signal);
  };
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
  return () => {
    process.off("SIGINT", handler);
    process.off("SIGTERM", handler);
  };
}
