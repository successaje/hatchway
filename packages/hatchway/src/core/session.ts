import { EventEmitter } from "node:events";
import { getAddress, isAddress, type Address } from "viem";
import { chainSummary } from "../evm/chains.js";
import { dedupeKey, type CanonicalTransaction } from "../evm/tx.js";
import { deferred } from "./deferred.js";
import { HatchwayError } from "./errors.js";
import {
  PROTOCOL_VERSION,
  type ChainSummary,
  type SessionPurpose,
  type SessionSnapshot,
  type SessionState,
  type WalletIssue,
  type WalletSummary,
  type WalletUpdate,
} from "./protocol.js";
import { ApprovalRequest, type RequestOptions, type SignatureMethod } from "./request.js";
import { constantTimeEqual, randomToken, sha256Hex } from "./secrets.js";

export interface SessionOptions {
  purpose: SessionPurpose;
  /** Absolute lifetime of the session. */
  ttlMs: number;
  /** How long to wait for a wallet to be connected. */
  connectTimeoutMs: number;
  /** How long a request may sit in review before it expires. */
  approvalTimeoutMs: number;
  expectedAddress?: Address | undefined;
}

export type SessionEvent =
  | { type: "browser_attached" }
  | { type: "browser_detached" }
  | { type: "wallet_connected"; wallet: WalletSummary }
  | { type: "wallet_issue"; issue: WalletIssue; detail: string }
  | { type: "wallet_issue_resolved" }
  | { type: "request_queued"; request: ApprovalRequest }
  | { type: "request_review"; request: ApprovalRequest }
  | { type: "request_in_wallet"; request: ApprovalRequest }
  | { type: "request_submitted"; request: ApprovalRequest }
  | { type: "request_finished"; request: ApprovalRequest }
  | { type: "request_abandoned"; request: ApprovalRequest }
  | { type: "ended"; state: SessionState; reason: string | undefined };

const MAX_CLAIMS_BEFORE_WALLET = 10;
const ENDED_STATES: readonly SessionState[] = ["completed", "cancelled", "expired", "failed"];

/**
 * State of one signing session: who may drive it from the browser, which wallet is bound,
 * which network is expected, and the ordered list of wallet requests.
 *
 * The session is transport-agnostic; the HTTP server and the approval engine drive it.
 */
export class Session extends EventEmitter<{ change: []; event: [SessionEvent] }> {
  readonly id = randomToken(16);
  readonly options: SessionOptions;
  readonly createdAt = Date.now();
  readonly expiresAt: number;

  state: SessionState = "waiting_for_browser";
  endedReason: string | undefined;
  chain: ChainSummary | undefined;
  wallet: WalletSummary | undefined;
  walletIssue: WalletIssue | undefined;
  /** Last wallet state reported by the browser, even when it is not acceptable. */
  reportedWallet: WalletUpdate | undefined;
  readonly requests: ApprovalRequest[] = [];

  #pairingCode: string | undefined = randomToken(32);
  #claims = 0;
  #browserTokenHash: string | undefined;
  #streams = 0;
  #timers: NodeJS.Timeout[] = [];
  #byDedupeKey = new Map<string, ApprovalRequest>();
  readonly #ended = deferred<void>();

  constructor(options: SessionOptions) {
    super();
    // Many concurrent waiters (one per in-flight RPC call) listen for changes.
    this.setMaxListeners(0);
    this.options = options;
    this.expiresAt = this.createdAt + options.ttlMs;
    this.#timers.push(
      setTimeout(() => this.end("expired", "The session reached its time limit."), options.ttlMs),
      setTimeout(() => {
        if (!this.wallet) this.end("expired", "No wallet was connected in time.");
      }, options.connectTimeoutMs),
    );
    for (const timer of this.#timers) timer.unref();
  }

  get ended(): boolean {
    return ENDED_STATES.includes(this.state);
  }

  get endedPromise(): Promise<void> {
    return this.#ended.promise;
  }

  get pairingCode(): string | undefined {
    return this.#pairingCode;
  }

  get hasBrowser(): boolean {
    return this.#streams > 0;
  }

  /** True when requests can be shown: wallet bound, network known and matching. */
  get walletReady(): boolean {
    return !this.ended && this.wallet !== undefined && this.chain !== undefined && this.walletIssue === undefined;
  }

  // ---- Browser pairing -----------------------------------------------------------------

  /**
   * Exchanges the one-time pairing code from the session URL for a browser token.
   * The code can be claimed again (e.g. from a different browser) until a wallet is bound;
   * each new claim revokes the previous browser.
   */
  claim(code: string): string {
    if (this.ended) throw new HatchwayError("SESSION_CLOSED", "This session has ended.");
    if (!this.#pairingCode || !constantTimeEqual(code, this.#pairingCode)) {
      throw new HatchwayError("USAGE", "This link is invalid or has already been used.");
    }
    this.#claims += 1;
    if (this.wallet || this.#claims >= MAX_CLAIMS_BEFORE_WALLET) this.#pairingCode = undefined;
    const token = randomToken(32);
    this.#browserTokenHash = sha256Hex(token);
    if (this.state === "waiting_for_browser") this.state = "waiting_for_wallet";
    this.#changed();
    return token;
  }

  authenticate(token: string | undefined): boolean {
    if (!token || !this.#browserTokenHash) return false;
    return constantTimeEqual(sha256Hex(token), this.#browserTokenHash);
  }

  /** Issues a fresh pairing code so a new browser tab can take over the session. */
  rotatePairingCode(): string {
    this.#pairingCode = randomToken(32);
    return this.#pairingCode;
  }

  streamOpened(): void {
    this.#streams += 1;
    if (this.#streams === 1) this.#emit({ type: "browser_attached" });
  }

  streamClosed(): void {
    this.#streams = Math.max(0, this.#streams - 1);
    if (this.#streams === 0 && !this.ended) this.#emit({ type: "browser_detached" });
  }

  // ---- Network and wallet -----------------------------------------------------------------

  setChain(chainId: number, upstreamUrl?: string): void {
    this.chain = chainSummary(chainId, upstreamUrl);
    this.#evaluateWallet();
    this.#changed();
  }

  updateWallet(update: WalletUpdate): void {
    if (this.ended) return;
    if (!Number.isSafeInteger(update.chainId) || update.chainId <= 0) {
      throw new HatchwayError("USAGE", "Invalid chain id.");
    }
    if (update.address !== "" && !isAddress(update.address, { strict: false })) {
      throw new HatchwayError("USAGE", "Invalid wallet address.");
    }
    this.reportedWallet = {
      address: update.address === "" ? "" : getAddress(update.address),
      chainId: update.chainId,
      name: update.name.slice(0, 64),
      ...(update.rdns ? { rdns: update.rdns.slice(0, 128) } : {}),
    };

    if (!this.wallet && this.reportedWallet.address !== "") {
      const expected = this.options.expectedAddress;
      if (!expected || expected.toLowerCase() === this.reportedWallet.address.toLowerCase()) {
        this.wallet = {
          address: this.reportedWallet.address,
          name: this.reportedWallet.name,
          chainId: this.reportedWallet.chainId,
          ...(this.reportedWallet.rdns ? { rdns: this.reportedWallet.rdns } : {}),
        };
        // Once a wallet is bound, the original link can no longer be used to take over.
        this.#pairingCode = undefined;
        if (this.state === "waiting_for_wallet" || this.state === "waiting_for_browser") this.state = "ready";
        this.#emit({ type: "wallet_connected", wallet: this.wallet });
      }
    } else if (this.wallet) {
      this.wallet.chainId = this.reportedWallet.chainId;
    }
    this.#evaluateWallet();
    this.#changed();
  }

  #evaluateWallet(): void {
    const reported = this.reportedWallet;
    let issue: WalletIssue | undefined;
    let detail = "";
    const expected = this.wallet?.address ?? this.options.expectedAddress;
    if (!reported) {
      issue = undefined;
    } else if (reported.address === "") {
      issue = this.wallet ? "disconnected" : undefined;
      detail = "The wallet disconnected from the page.";
    } else if (expected && reported.address.toLowerCase() !== expected.toLowerCase()) {
      issue = "wrong_account";
      detail = this.wallet
        ? `The selected wallet address changed to ${reported.address}. Switch back to ${expected}.`
        : `The connected account ${reported.address} is not the expected ${expected}.`;
    } else if (this.chain && reported.chainId !== this.chain.id) {
      issue = "wrong_chain";
      detail = `The wallet is on chain ${reported.chainId}; this session needs ${this.chain.name} (${this.chain.id}).`;
    }
    if (issue !== this.walletIssue) {
      const hadIssue = this.walletIssue !== undefined;
      this.walletIssue = issue;
      if (issue) this.#emit({ type: "wallet_issue", issue, detail });
      else if (hadIssue) this.#emit({ type: "wallet_issue_resolved" });
    }
  }

  /** Resolves once a wallet is bound and on the expected chain. */
  async waitForWallet(): Promise<WalletSummary> {
    for (;;) {
      if (this.ended) throw this.endError();
      if (this.walletReady && this.wallet) return this.wallet;
      await this.nextChange();
    }
  }

  /** Resolves on the next state change (or when the session ends). */
  nextChange(): Promise<void> {
    if (this.ended) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        this.off("change", done);
        resolve();
      };
      this.on("change", done);
    });
  }

  // ---- Requests -------------------------------------------------------------------------

  /**
   * Adds a transaction request, or returns the existing request if this is a retry of one
   * already seen (same sender, nonce and payload).
   */
  enqueueTransaction(tx: CanonicalTransaction, options: RequestOptions = {}): ApprovalRequest {
    this.#assertOpen();
    const key = dedupeKey(tx);
    if (key) {
      const existing = this.#byDedupeKey.get(key);
      if (existing) return existing;
    }
    const request = new ApprovalRequest(this.requests.length + 1, { kind: "transaction", tx, dedupeKey: key }, options);
    if (key) this.#byDedupeKey.set(key, request);
    this.requests.push(request);
    this.#emit({ type: "request_queued", request });
    this.#changed();
    return request;
  }

  enqueueSignature(method: SignatureMethod, address: Address, payload: string): ApprovalRequest {
    this.#assertOpen();
    const request = new ApprovalRequest(this.requests.length + 1, { kind: "signature", method, address, payload });
    this.requests.push(request);
    this.#emit({ type: "request_queued", request });
    this.#changed();
    return request;
  }

  findRequest(id: string): ApprovalRequest | undefined {
    return this.requests.find((request) => request.id === id);
  }

  emitRequest(type: "request_review" | "request_in_wallet" | "request_submitted" | "request_finished" | "request_abandoned", request: ApprovalRequest): void {
    this.#emit({ type, request });
    this.#changed();
  }

  #assertOpen(): void {
    if (this.ended) throw this.endError();
  }

  // ---- Lifecycle ---------------------------------------------------------------------------

  endError(): HatchwayError {
    switch (this.state) {
      case "expired":
        return new HatchwayError("SESSION_EXPIRED", this.endedReason ?? "The signing session expired.", {
          hint: "Run the command again to start a new session.",
        });
      case "cancelled":
        return new HatchwayError("SESSION_CANCELLED", this.endedReason ?? "The session was cancelled in the browser.");
      default:
        return new HatchwayError("SESSION_CLOSED", this.endedReason ?? "The signing session has ended.");
    }
  }

  end(state: "completed" | "cancelled" | "expired" | "failed", reason?: string): void {
    if (this.ended) return;
    this.state = state;
    this.endedReason = reason;
    for (const timer of this.#timers) clearTimeout(timer);
    this.#pairingCode = undefined;
    const error = this.endError();
    for (const request of this.requests) {
      if (request.isTerminal) continue;
      if (request.state === "submitted") {
        // Already broadcast: the chain decides the outcome, not the session.
        continue;
      }
      request.fail(state === "expired" ? "expired" : "cancelled", error);
    }
    this.#emit({ type: "ended", state, reason });
    this.#changed();
    this.#ended.resolve();
  }

  snapshot(): SessionSnapshot {
    const snapshot: SessionSnapshot = {
      protocol: PROTOCOL_VERSION,
      id: this.id,
      state: this.state,
      purpose: this.options.purpose,
      createdAt: this.createdAt,
      expiresAt: this.expiresAt,
      now: Date.now(),
      requests: this.requests.map((request) => request.view()),
    };
    if (this.chain) snapshot.chain = this.chain;
    if (this.options.expectedAddress) snapshot.expectedAddress = this.options.expectedAddress;
    if (this.wallet) snapshot.wallet = { ...this.wallet };
    if (this.walletIssue) snapshot.walletIssue = this.walletIssue;
    if (this.endedReason) snapshot.endedReason = this.endedReason;
    return snapshot;
  }

  changed(): void {
    this.#changed();
  }

  #changed(): void {
    this.emit("change");
  }

  #emit(event: SessionEvent): void {
    this.emit("event", event);
  }
}
