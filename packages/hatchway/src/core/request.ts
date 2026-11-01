import type { Address } from "viem";
import type { CanonicalTransaction } from "../evm/tx.js";
import { deferred, type Deferred } from "./deferred.js";
import { HatchwayError, type ErrorCode } from "./errors.js";
import {
  TERMINAL_REQUEST_STATES,
  type RequestResult,
  type RequestState,
  type RequestView,
  type SignatureReview,
  type TransactionReview,
  type WalletRequestPayload,
} from "./protocol.js";
import { randomId } from "./secrets.js";

export type SignatureMethod = "personal_sign" | "eth_signTypedData_v4";

/** What the browser reported for a request it was asked to handle. */
export type WalletOutcome =
  | { kind: "submitted"; hash: `0x${string}` }
  | { kind: "signed"; signature: `0x${string}` }
  | { kind: "rejected"; message?: string | undefined }
  | { kind: "error"; code?: number | undefined; message: string };

export interface RequestOptions {
  /** Title supplied by the caller, overriding the decoded one. */
  title?: string | undefined;
  /** Contract name supplied by the caller (e.g. `hatchway deploy`). */
  contractName?: string | undefined;
}

/**
 * One wallet request (transaction or signature). The `completion` promise is what the
 * calling tool waits on: a transaction hash, a signature, or a HatchwayError.
 */
export class ApprovalRequest {
  readonly id = randomId();
  readonly index: number;
  readonly kind: "transaction" | "signature";
  readonly createdAt = Date.now();
  readonly tx: CanonicalTransaction | undefined;
  readonly signature: { method: SignatureMethod; address: Address; payload: string } | undefined;
  readonly dedupeKey: string | undefined;
  readonly options: RequestOptions;

  state: RequestState = "queued";
  deadline: number | undefined;
  waitingFor: RequestView["waitingFor"];
  wallet: WalletRequestPayload | undefined;
  payloadHash = "";
  review: TransactionReview | undefined;
  signatureReview: SignatureReview | undefined;
  result: RequestResult | undefined;
  /** Nonce the account was expected to use when the request was shown. */
  expectedNonce: number | undefined;
  /** Nonce the wallet actually used, from the broadcast transaction. */
  broadcastNonce: number | undefined;
  /** When the page handed the request to the wallet. */
  inWalletSince: number | undefined;
  error: { code: ErrorCode; message: string } | undefined;

  /** Number of callers currently waiting on this request (forge retries add callers). */
  waiters = 0;
  /** Set when every caller disconnected; used to detect a tool that gave up waiting. */
  abandonedAt: number | undefined;

  /** Resolved by the browser's answer, a timeout, or cancellation. */
  readonly outcome: Deferred<WalletOutcome>;
  /** What callers receive. */
  readonly completion: Deferred<string>;
  /** Resolves when the request reaches a terminal state (after confirmation for transactions). */
  readonly settled: Deferred<void>;

  constructor(
    index: number,
    init:
      | { kind: "transaction"; tx: CanonicalTransaction; dedupeKey?: string | undefined }
      | { kind: "signature"; method: SignatureMethod; address: Address; payload: string },
    options: RequestOptions = {},
  ) {
    this.index = index;
    this.kind = init.kind;
    this.options = options;
    if (init.kind === "transaction") {
      this.tx = init.tx;
      this.dedupeKey = init.dedupeKey;
      this.signature = undefined;
    } else {
      this.tx = undefined;
      this.dedupeKey = undefined;
      this.signature = { method: init.method, address: init.address, payload: init.payload };
    }
    this.outcome = deferred<WalletOutcome>();
    this.completion = deferred<string>();
    this.settled = deferred<void>();
  }

  get isTerminal(): boolean {
    return TERMINAL_REQUEST_STATES.includes(this.state);
  }

  /** Moves to a terminal failure state and notifies every waiter. */
  fail(
    state: "rejected" | "failed" | "expired" | "cancelled" | "reverted",
    error: HatchwayError,
  ): void {
    if (this.isTerminal) return;
    this.state = state;
    this.error = { code: error.code, message: error.message };
    this.waitingFor = undefined;
    this.outcome.reject(error);
    this.completion.reject(error);
    this.settled.resolve();
  }

  /** Error to hand a retrying caller once this request has finished unsuccessfully. */
  replayError(): HatchwayError {
    const error = this.error ?? { code: "INTERNAL" as const, message: "Request failed." };
    return new HatchwayError(error.code, error.message);
  }

  view(): RequestView {
    const view: RequestView = {
      id: this.id,
      index: this.index,
      kind: this.kind,
      state: this.state,
      createdAt: this.createdAt,
      wallet: this.wallet ?? placeholderPayload(this),
      payloadHash: this.payloadHash,
    };
    if (this.deadline !== undefined) view.deadline = this.deadline;
    if (this.waitingFor) view.waitingFor = this.waitingFor;
    if (this.review) view.review = this.review;
    if (this.signatureReview) view.signatureReview = this.signatureReview;
    if (this.result) view.result = this.result;
    if (this.error) view.error = { code: this.error.code, message: this.error.message };
    return view;
  }
}

function placeholderPayload(request: ApprovalRequest): WalletRequestPayload {
  if (request.signature) {
    return request.signature.method === "personal_sign"
      ? { method: "personal_sign", params: [request.signature.payload, request.signature.address] }
      : {
          method: "eth_signTypedData_v4",
          params: [request.signature.address, request.signature.payload],
        };
  }
  return {
    method: "eth_sendTransaction",
    params: [{ from: request.tx?.from ?? "", value: "0x0", data: "0x", chainId: "0x0" }],
  };
}
