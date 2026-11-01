import { mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { Bridge } from "../bridge.js";
import { HatchwayError, type ErrorCode } from "../core/errors.js";
import type { ApprovalRequest } from "../core/request.js";
import { explorerAddressUrl } from "../evm/chains.js";
import { sanitizeCommand } from "../util/redact.js";
import { VERSION } from "./version.js";
import type { Reporter } from "./output.js";

export interface TransactionRecord {
  index: number;
  kind: "transaction" | "signature";
  title: string;
  state: string;
  action?: string;
  contractName?: string;
  hash?: string;
  nonce?: number;
  blockNumber?: string;
  gasUsed?: string;
  fee?: string;
  contractAddress?: string;
  explorerUrl?: string;
  error?: { code: string; message: string };
}

export function transactionRecords(bridge: Bridge): TransactionRecord[] {
  return bridge.session.requests.map((request) => toRecord(request));
}

function toRecord(request: ApprovalRequest): TransactionRecord {
  const record: TransactionRecord = {
    index: request.index,
    kind: request.kind,
    title: request.review?.title ?? request.signatureReview?.title ?? "Request",
    state: request.state,
  };
  const r = request.result;
  if (request.review?.action) record.action = request.review.action;
  if (request.review?.contractName) record.contractName = request.review.contractName;
  if (r?.hash) record.hash = r.hash;
  if (request.broadcastNonce !== undefined) record.nonce = request.broadcastNonce;
  if (r?.blockNumber) record.blockNumber = r.blockNumber;
  if (r?.gasUsed) record.gasUsed = r.gasUsed;
  if (r?.feePaid) record.fee = r.feePaid;
  if (r?.contractAddress) record.contractAddress = r.contractAddress;
  if (r?.explorerUrl) record.explorerUrl = r.explorerUrl;
  if (request.error) record.error = { code: request.error.code, message: request.error.message };
  return record;
}

/**
 * Waits (bounded) for every broadcast transaction to be confirmed or reverted, so the
 * summary reflects receipts even when the wrapped tool finished waiting for them first.
 */
export async function settleSubmitted(bridge: Bridge, timeoutMs: number): Promise<void> {
  const pending = bridge.session.requests
    .filter((r) => r.state === "submitted")
    .map((r) => r.settled.promise);
  if (pending.length === 0) return;
  await Promise.race([
    Promise.all(pending),
    new Promise((resolve) => setTimeout(resolve, timeoutMs).unref()),
  ]);
}

/** The most significant failure among the session's requests, used for the exit code. */
export function firstFailure(bridge: Bridge): HatchwayError | undefined {
  const priority: ErrorCode[] = [
    "INTEGRITY_MISMATCH",
    "TRANSACTION_REPLACED",
    "TRANSACTION_REVERTED",
    "USER_REJECTED",
    "NONCE_CONFLICT",
    "APPROVAL_TIMEOUT",
  ];
  const failed = bridge.session.requests.filter((r) => r.error);
  for (const code of priority) {
    const match = failed.find((r) => r.error?.code === code);
    if (match?.error) return new HatchwayError(match.error.code, match.error.message);
  }
  const any = failed[0]?.error;
  return any ? new HatchwayError(any.code, any.message) : undefined;
}

/** Prints the deployment summary: one block per deployed contract, full addresses. */
export function printSummary(bridge: Bridge, reporter: Reporter): void {
  const chain = bridge.session.chain;
  const deployed = bridge.session.requests.filter(
    (r) => r.state === "confirmed" && r.result?.contractAddress,
  );
  const sent = bridge.session.requests.filter((r) => r.result?.hash);
  if (sent.length === 0) return;
  for (const request of deployed) {
    const address = request.result!.contractAddress!;
    reporter.field("Contract", request.review?.contractName ?? "(unknown)");
    reporter.field("Address", address);
    reporter.field("Tx", request.result!.hash!);
    const explorer = chain ? explorerAddressUrl(chain.id, address) : undefined;
    if (explorer && !chain?.local) reporter.field("Explorer", explorer);
    reporter.line();
  }
  const others = sent.length - deployed.length;
  if (deployed.length > 0 && others > 0)
    reporter.note(`plus ${others} other transaction${others === 1 ? "" : "s"}`);
  if (chain) reporter.field("Network", `${chain.name} (${chain.id})`);
  if (bridge.session.wallet) reporter.field("Deployer", bridge.session.wallet.address);
}

export interface RunRecordInput {
  bridge: Bridge;
  /** The command line as arguments; credentials are removed before it is written. */
  command: string[];
  startedAt: Date;
  status: "success" | "failed";
  projectRoot: string;
  extra?: Record<string, unknown>;
}

/**
 * Persists what happened (hashes, receipts, addresses) to `.hatchway/runs/` so results are
 * never only in terminal scrollback. Only written when something was sent or signed.
 */
export async function writeRunRecord(input: RunRecordInput): Promise<string | undefined> {
  const { bridge } = input;
  const transactions = transactionRecords(bridge);
  if (!transactions.some((t) => t.hash || t.state === "signed")) return undefined;
  const chain = bridge.session.chain;
  const record = {
    tool: "hatchway",
    version: VERSION,
    command: sanitizeCommand(input.command, bridge.secrets),
    status: input.status,
    startedAt: input.startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    chain: chain ? { id: chain.id, name: chain.name } : undefined,
    wallet: bridge.session.wallet
      ? { address: bridge.session.wallet.address, name: bridge.session.wallet.name }
      : undefined,
    transactions,
    ...input.extra,
  };
  const dir = join(input.projectRoot, ".hatchway", "runs");
  await mkdir(dir, { recursive: true });
  const stamp = input.startedAt.toISOString().replace(/[:.]/g, "-");
  const file = join(dir, `${stamp}-${chain?.id ?? "unknown"}.json`);
  await writeFile(file, `${JSON.stringify(record, null, 2)}\n`);
  return relative(process.cwd(), file) || file;
}
