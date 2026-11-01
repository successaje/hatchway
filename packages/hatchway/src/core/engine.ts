import { getAddress, hexToString, isHex, type Address, type Hex } from "viem";
import { ArtifactIndex } from "../evm/artifacts.js";
import { explorerTxUrl, isLocalChain, nativeSymbol } from "../evm/chains.js";
import { formatAmount } from "../evm/format.js";
import { buildTransactionReview, type KnownContract } from "../evm/review.js";
import type { UpstreamRpc } from "../evm/rpc.js";
import {
  findIntegrityMismatches,
  hashPayload,
  toWalletTransaction,
  type CanonicalTransaction,
} from "../evm/tx.js";
import { sleep } from "./deferred.js";
import { HatchwayError, toHatchwayError } from "./errors.js";
import type {
  BeginRequest,
  Notice,
  ResultRequest,
  SignatureReview,
  TransactionReview,
} from "./protocol.js";
import type { ApprovalRequest, RequestOptions, SignatureMethod, WalletOutcome } from "./request.js";
import type { Session } from "./session.js";

export interface EngineOptions {
  session: Session;
  /** The developer's RPC endpoint; may be attached after the engine starts (Hardhat). */
  upstream: () => UpstreamRpc | undefined;
  artifacts: () => Promise<ArtifactIndex>;
  /** Grace period before a request with no remaining callers is considered abandoned. */
  abandonGraceMs?: number;
  /** Upper bound for waiting on the previous transaction before showing the next one. */
  previousConfirmationTimeoutMs?: number;
}

/**
 * Processes wallet requests strictly one at a time:
 *
 *   queued → review → in_wallet → submitted → confirmed | reverted
 *
 * Requests that pin a nonce are shown in nonce order. A request is only shown after the
 * previous transaction is mined, so its review and simulation reflect the state it will
 * actually execute against, and so a revert stops the remaining requests.
 */
export class ApprovalEngine {
  readonly #options: EngineOptions;
  readonly #known = new Map<string, KnownContract>();
  readonly #stop = new AbortController();
  #lastTransaction: ApprovalRequest | undefined;
  #lastBroadcastNonce: number | undefined;
  #halted: HatchwayError | undefined;
  #running: Promise<void> | undefined;

  constructor(options: EngineOptions) {
    this.#options = options;
  }

  get session(): Session {
    return this.#options.session;
  }

  start(): void {
    this.#running ??= this.#loop();
  }

  async stop(): Promise<void> {
    this.#stop.abort();
    this.session.changed();
    await this.#running;
  }

  // ---- Entry points for callers ----------------------------------------------------------

  /**
   * Queues a transaction (or joins an identical in-flight one) and returns the request.
   * Callers then `await request.completion.promise` for the transaction hash.
   */
  enqueueTransaction(tx: CanonicalTransaction, options: RequestOptions = {}): ApprovalRequest {
    const wallet = this.session.wallet;
    if (wallet && tx.from.toLowerCase() !== wallet.address.toLowerCase()) {
      throw new HatchwayError(
        "WRONG_ACCOUNT",
        `Transaction sender ${tx.from} does not match the connected wallet ${wallet.address}.`,
      );
    }
    const chain = this.session.chain;
    if (chain && tx.chainId !== undefined && tx.chainId !== chain.id) {
      throw new HatchwayError(
        "WRONG_NETWORK",
        `Transaction targets chain ${tx.chainId}, but this session is on ${chain.name} (${chain.id}).`,
      );
    }
    return this.session.enqueueTransaction(tx, options);
  }

  enqueueSignature(method: SignatureMethod, address: Address, payload: string): ApprovalRequest {
    const wallet = this.session.wallet;
    if (wallet && address.toLowerCase() !== wallet.address.toLowerCase()) {
      throw new HatchwayError(
        "WRONG_ACCOUNT",
        `Signature requested for ${address}, but the connected wallet is ${wallet.address}.`,
      );
    }
    return this.session.enqueueSignature(method, address, payload);
  }

  /**
   * Registers a waiting caller. Returns a release function to call when the caller goes
   * away (e.g. its HTTP connection closed before an answer was ready).
   */
  attachCaller(request: ApprovalRequest): () => void {
    request.waiters += 1;
    request.abandonedAt = undefined;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      request.waiters -= 1;
      if (request.waiters > 0 || request.isTerminal || request.state === "submitted") return;
      request.abandonedAt = Date.now();
      const grace = this.#options.abandonGraceMs ?? 15_000;
      setTimeout(() => this.#checkAbandoned(request), grace).unref();
    };
  }

  #checkAbandoned(request: ApprovalRequest): void {
    if (request.waiters > 0 || request.isTerminal || request.abandonedAt === undefined) return;
    if (request.state === "queued" || request.state === "review") {
      request.fail(
        "cancelled",
        new HatchwayError(
          "SESSION_CLOSED",
          "The calling tool stopped waiting for this request, so it was withdrawn. Nothing was sent.",
        ),
      );
      this.session.emitRequest("request_finished", request);
    } else if (request.state === "in_wallet") {
      this.session.emitRequest("request_abandoned", request);
    }
  }

  // ---- Entry points for the browser --------------------------------------------------------

  /** The page is about to call the wallet. Re-validates everything the approval binds to. */
  begin(request: ApprovalRequest, body: BeginRequest): void {
    const session = this.session;
    if (request.state !== "review") {
      throw new HatchwayError("USAGE", `Request is ${request.state}, not awaiting review.`);
    }
    if (body.payloadHash !== request.payloadHash) {
      throw new HatchwayError("INTEGRITY_MISMATCH", "The request changed; reload the page.");
    }
    if (!session.walletReady || !session.wallet || !session.chain) {
      throw new HatchwayError("WRONG_NETWORK", "Fix the wallet connection before approving.");
    }
    if (body.address.toLowerCase() !== session.wallet.address.toLowerCase()) {
      throw new HatchwayError("WRONG_ACCOUNT", `Switch your wallet to ${session.wallet.address}.`);
    }
    if (body.chainId !== session.chain.id) {
      throw new HatchwayError("WRONG_NETWORK", `Switch your wallet to ${session.chain.name}.`);
    }
    request.state = "in_wallet";
    request.inWalletSince = Date.now();
    session.emitRequest("request_in_wallet", request);
  }

  report(request: ApprovalRequest, body: ResultRequest): void {
    if (body.payloadHash !== request.payloadHash) {
      throw new HatchwayError("INTEGRITY_MISMATCH", "Result does not match the request.");
    }
    if (body.outcome === "rejected") {
      // The user may abandon a request from the review screen without opening the wallet.
      if (request.state !== "in_wallet" && request.state !== "review") {
        throw new HatchwayError("USAGE", `Request is ${request.state}.`);
      }
      request.outcome.resolve({ kind: "rejected", message: body.message });
      return;
    }
    if (request.state !== "in_wallet")
      throw new HatchwayError("USAGE", `Request is ${request.state}, not in the wallet.`);
    switch (body.outcome) {
      case "submitted":
        if (request.kind !== "transaction" || !isHex(body.hash) || body.hash.length !== 66) {
          throw new HatchwayError("USAGE", "Invalid transaction hash.");
        }
        request.outcome.resolve({ kind: "submitted", hash: body.hash });
        return;
      case "signed":
        if (request.kind !== "signature" || !isHex(body.signature))
          throw new HatchwayError("USAGE", "Invalid signature.");
        request.outcome.resolve({ kind: "signed", signature: body.signature });
        return;
      case "error":
        request.outcome.resolve({
          kind: "error",
          code: body.code,
          message: String(body.message).slice(0, 500),
        });
        return;
    }
  }

  // ---- Processing loop ----------------------------------------------------------------------

  async #loop(): Promise<void> {
    const session = this.session;
    while (!session.ended && !this.#stop.signal.aborted) {
      const request = this.#nextQueued();
      if (!request) {
        await session.nextChange();
        continue;
      }
      try {
        await this.#process(request);
      } catch (error) {
        if (!request.isTerminal) {
          request.fail("failed", toHatchwayError(error));
        }
        session.emitRequest("request_finished", request);
      }
    }
  }

  #nextQueued(): ApprovalRequest | undefined {
    const queued = this.session.requests.filter((r) => r.state === "queued");
    queued.sort((a, b) => {
      const na = a.tx?.nonce;
      const nb = b.tx?.nonce;
      if (na !== undefined && nb !== undefined && na !== nb) return na - nb;
      return a.index - b.index;
    });
    return queued[0];
  }

  /** Fails the request when an earlier transaction failed; returns true if it did. */
  #failIfHalted(request: ApprovalRequest): boolean {
    const halted = this.#halted;
    if (!halted) return false;
    request.fail(
      "failed",
      new HatchwayError(
        "PREVIOUS_FAILED",
        `Not sent because an earlier transaction failed: ${halted.message}`,
      ),
    );
    this.session.emitRequest("request_finished", request);
    return true;
  }

  async #process(request: ApprovalRequest): Promise<void> {
    const session = this.session;

    if (this.#failIfHalted(request)) return;

    // 1. A bound wallet on the right network.
    while (!session.walletReady) {
      if (session.ended || request.isTerminal || this.#stop.signal.aborted) return;
      request.waitingFor = "wallet";
      session.changed();
      await session.nextChange();
    }

    // 2. The previous transaction is mined.
    const previous = this.#lastTransaction;
    if (previous && previous.state === "submitted") {
      request.waitingFor = "previous_confirmation";
      session.changed();
      const limit = this.#options.previousConfirmationTimeoutMs ?? 10 * 60_000;
      await Promise.race([
        previous.settled.promise,
        session.endedPromise,
        sleep(limit, this.#stop.signal),
      ]);
    }
    if (request.isTerminal || session.ended || this.#stop.signal.aborted) return;
    if (this.#failIfHalted(request)) return;

    const upstream = this.#options.upstream();
    const chain = session.chain;
    const wallet = session.wallet;
    if (!upstream || !chain || !wallet)
      throw new HatchwayError("INTERNAL", "Session is not ready.");

    // 3. Review data.
    request.waitingFor = "review";
    session.changed();
    if (request.tx) {
      await this.#prepareTransaction(request, request.tx, upstream, chain.id);
    } else if (request.signature) {
      this.#prepareSignature(request, chain.id);
    }
    if (request.isTerminal) {
      session.emitRequest("request_finished", request);
      return;
    }

    // 4. Show it and wait for the wallet's answer.
    request.waitingFor = undefined;
    request.state = "review";
    request.deadline = Date.now() + session.options.approvalTimeoutMs;
    session.emitRequest("request_review", request);

    let outcome: WalletOutcome;
    try {
      outcome = await this.#awaitOutcome(request, upstream);
    } catch {
      session.emitRequest("request_finished", request);
      return;
    }

    // 5. Act on the answer.
    switch (outcome.kind) {
      case "rejected":
        request.fail(
          "rejected",
          new HatchwayError(
            "USER_REJECTED",
            request.kind === "transaction"
              ? "Transaction rejected in wallet."
              : "Signature request rejected in wallet.",
          ),
        );
        break;
      case "error":
        request.fail(
          outcome.code === 4001 ? "rejected" : "failed",
          walletError(outcome.code, outcome.message),
        );
        break;
      case "submitted":
        await this.#onSubmitted(request, outcome.hash, upstream, chain.id);
        return;
      case "signed":
        await this.#onSigned(request, outcome.signature, upstream);
        break;
    }
    session.emitRequest("request_finished", request);
  }

  async #prepareTransaction(
    request: ApprovalRequest,
    tx: CanonicalTransaction,
    upstream: UpstreamRpc,
    chainId: number,
  ): Promise<void> {
    const extraNotices: Notice[] = [];
    let expectedNonce: number | undefined;
    try {
      const pending = await upstream.client.getTransactionCount({
        address: tx.from,
        blockTag: "pending",
      });
      expectedNonce = Math.max(
        pending,
        this.#lastBroadcastNonce !== undefined ? this.#lastBroadcastNonce + 1 : 0,
      );
    } catch {
      extraNotices.push({
        level: "info",
        message: "Could not read the account nonce from the RPC endpoint.",
      });
    }
    request.expectedNonce = tx.nonce ?? expectedNonce;
    if (tx.nonce !== undefined && expectedNonce !== undefined) {
      if (tx.nonce < expectedNonce) {
        request.fail(
          "failed",
          new HatchwayError(
            "NONCE_CONFLICT",
            `Nonce ${tx.nonce} is already used: the next nonce for ${tx.from} is ${expectedNonce}. Another transaction was sent from this wallet; run the command again.`,
          ),
        );
        return;
      }
      if (tx.nonce > expectedNonce) {
        extraNotices.push({
          level: "warning",
          message: `This request uses nonce ${tx.nonce}, but the account's next nonce is ${expectedNonce}. Your wallet may pick a different nonce; Hatchway will stop if it does.`,
        });
      }
    }

    const artifacts = await this.#options.artifacts().catch(() => ArtifactIndex.empty());
    let review: TransactionReview;
    try {
      review = await buildTransactionReview(tx, {
        rpc: upstream,
        chainId,
        artifacts,
        known: this.#known,
        expectedNonce,
        title: request.options.title,
      });
    } catch (error) {
      review = minimalReview(tx, chainId, toHatchwayError(error).message);
    }
    if (request.options.contractName && !review.contractName)
      review.contractName = request.options.contractName;
    review.notices.unshift(...extraNotices);
    request.review = review;
    request.wallet = { method: "eth_sendTransaction", params: [toWalletTransaction(tx, chainId)] };
    request.payloadHash = hashPayload(request.wallet);
  }

  #prepareSignature(request: ApprovalRequest, chainId: number): void {
    const signature = request.signature!;
    const notices: Notice[] = [];
    let review: SignatureReview;
    if (signature.method === "personal_sign") {
      const text = decodePersonalMessage(signature.payload);
      review = {
        title: "Sign message",
        from: signature.address,
        content: text ?? signature.payload,
        contentKind: text === undefined ? "hex" : "text",
        notices,
      };
      if (text === undefined)
        notices.push({
          level: "warning",
          message: "The message is binary data and cannot be displayed as text.",
        });
      request.wallet = { method: "personal_sign", params: [signature.payload, signature.address] };
    } else {
      let parsed: { domain?: Record<string, unknown>; primaryType?: string; message?: unknown };
      try {
        parsed = JSON.parse(signature.payload) as typeof parsed;
      } catch {
        request.fail(
          "failed",
          new HatchwayError(
            "INVALID_TRANSACTION",
            "eth_signTypedData_v4 payload is not valid JSON.",
          ),
        );
        return;
      }
      const domain = parsed.domain ?? {};
      review = {
        title: `Sign ${parsed.primaryType ?? "typed data"}`,
        from: signature.address,
        content: JSON.stringify(parsed.message ?? {}, null, 2).slice(0, 20_000),
        contentKind: "typed_data",
        domain: {
          ...(typeof domain.name === "string" ? { name: domain.name } : {}),
          ...(typeof domain.version === "string" ? { version: domain.version } : {}),
          ...(domain.chainId !== undefined ? { chainId: String(domain.chainId) } : {}),
          ...(typeof domain.verifyingContract === "string"
            ? { verifyingContract: domain.verifyingContract }
            : {}),
        },
        notices,
      };
      if (parsed.primaryType) review.primaryType = parsed.primaryType;
      if (domain.chainId !== undefined && Number(domain.chainId) !== chainId) {
        notices.push({
          level: "danger",
          message: `The signature is scoped to chain ${String(domain.chainId)}, not the session's chain ${chainId}.`,
        });
      }
      if (/permit/i.test(parsed.primaryType ?? "")) {
        notices.push({
          level: "warning",
          message:
            "This is a permit: signing it can authorise spending of your tokens without a separate transaction.",
        });
      }
      request.wallet = {
        method: "eth_signTypedData_v4",
        params: [signature.address, signature.payload],
      };
    }
    notices.push({ level: "info", message: "Signing does not send a transaction or spend gas." });
    request.signatureReview = review;
    request.payloadHash = hashPayload(request.wallet);
  }

  /**
   * Waits for the browser's answer. While the wallet is open, also watches the chain: if the
   * page was closed or refreshed after the wallet was asked, a transaction the wallet sent is
   * still detected and adopted instead of being lost (or sent twice).
   */
  async #awaitOutcome(request: ApprovalRequest, upstream: UpstreamRpc): Promise<WalletOutcome> {
    const session = this.session;
    const local = session.chain ? isLocalChain(session.chain.id) : false;
    let reconcileFrom: bigint | undefined;
    let nextReconcile = 0;
    const watch = async () => {
      while (!request.outcome.settled && !this.#stop.signal.aborted) {
        if (
          request.state === "review" &&
          request.deadline !== undefined &&
          Date.now() > request.deadline
        ) {
          request.fail(
            "expired",
            new HatchwayError("APPROVAL_TIMEOUT", "The request was not approved in time."),
          );
          return;
        }
        if (request.state === "in_wallet" && request.tx && Date.now() >= nextReconcile) {
          nextReconcile = Date.now() + (local ? 1_000 : 4_000);
          try {
            reconcileFrom ??= await upstream.client.getBlockNumber();
            const found = await findSentTransaction(
              upstream,
              request,
              request.expectedNonce,
              reconcileFrom,
            );
            if (found) request.outcome.resolve({ kind: "submitted", hash: found });
          } catch {
            // Best effort; the browser's answer remains the primary signal.
          }
        }
        await sleep(500, this.#stop.signal);
      }
    };
    void watch();
    return request.outcome.promise;
  }

  async #onSubmitted(
    request: ApprovalRequest,
    hash: Hex,
    upstream: UpstreamRpc,
    chainId: number,
  ): Promise<void> {
    const session = this.session;
    request.state = "submitted";
    request.result = { hash, ...optionalUrl(explorerTxUrl(chainId, hash)) };
    session.changed();

    const verification = await this.#verifyBroadcast(request, hash, upstream, chainId);
    if (verification.problems.length > 0) {
      const error = new HatchwayError(
        "INTEGRITY_MISMATCH",
        `The wallet broadcast ${hash}, but it differs from the approved request: ${verification.problems.join("; ")}. Stopping.`,
        { hint: "Do not edit transaction data or nonce in the wallet while using Hatchway." },
      );
      this.#halted = error;
      request.fail("failed", error);
      session.emitRequest("request_finished", request);
      return;
    }
    if (!verification.found) {
      request.review?.notices.push({
        level: "warning",
        message:
          "The transaction is not visible on your RPC endpoint yet, so its contents could not be verified.",
      });
    }
    if (verification.nonce !== undefined) {
      request.broadcastNonce = verification.nonce;
      this.#lastBroadcastNonce = verification.nonce;
    }
    this.#lastTransaction = request;
    request.completion.resolve(hash);
    session.emitRequest("request_submitted", request);
    void this.#track(request, hash, upstream, chainId);
  }

  async #verifyBroadcast(
    request: ApprovalRequest,
    hash: Hex,
    upstream: UpstreamRpc,
    chainId: number,
  ): Promise<{ found: boolean; problems: string[]; nonce?: number }> {
    const local = isLocalChain(chainId);
    const deadline = Date.now() + (local ? 5_000 : 45_000);
    while (Date.now() < deadline && !this.#stop.signal.aborted) {
      try {
        const tx = await upstream.client.getTransaction({ hash });
        const problems = findIntegrityMismatches(request.tx!, chainId, {
          from: tx.from,
          to: tx.to,
          input: tx.input,
          value: tx.value,
          nonce: tx.nonce,
          chainId: tx.chainId,
        });
        return { found: true, problems, nonce: tx.nonce };
      } catch {
        await sleep(local ? 200 : 1_500, this.#stop.signal);
      }
    }
    return { found: false, problems: [] };
  }

  async #track(
    request: ApprovalRequest,
    hash: Hex,
    upstream: UpstreamRpc,
    chainId: number,
  ): Promise<void> {
    const session = this.session;
    const local = isLocalChain(chainId);
    const interval = local ? 300 : 2_000;
    let polls = 0;
    while (!request.isTerminal && !this.#stop.signal.aborted) {
      polls += 1;
      try {
        const receipt = await upstream.client.getTransactionReceipt({ hash });
        const fee = receipt.gasUsed * receipt.effectiveGasPrice;
        request.result = {
          ...request.result,
          hash,
          blockNumber: receipt.blockNumber.toString(),
          gasUsed: receipt.gasUsed.toString(),
          feePaid: fee.toString(),
          feePaidDisplay: formatAmount(fee, nativeSymbol(chainId)),
          ...(receipt.contractAddress
            ? { contractAddress: getAddress(receipt.contractAddress) }
            : {}),
        };
        if (receipt.status === "success") {
          request.state = "confirmed";
          await this.#rememberDeployment(request, receipt.contractAddress ?? undefined);
          request.settled.resolve();
        } else {
          const error = new HatchwayError(
            "TRANSACTION_REVERTED",
            `Transaction reverted on-chain in block ${receipt.blockNumber}.`,
            {
              details: { hash },
            },
          );
          this.#halted = error;
          request.fail("reverted", error);
        }
        session.emitRequest("request_finished", request);
        return;
      } catch {
        // Not mined yet (or a transient RPC error). Periodically check for replacement.
        if (
          polls % 10 === 0 &&
          request.broadcastNonce !== undefined &&
          (await wasReplaced(upstream, request, hash))
        ) {
          const error = new HatchwayError(
            "TRANSACTION_REPLACED",
            `Transaction ${hash} was replaced or dropped (another transaction used nonce ${request.broadcastNonce}).`,
            {
              hint: "Avoid using the wallet's speed-up or cancel actions during a Hatchway session.",
            },
          );
          this.#halted = error;
          request.fail("failed", error);
          session.emitRequest("request_finished", request);
          return;
        }
      }
      await sleep(interval, this.#stop.signal);
    }
  }

  async #rememberDeployment(request: ApprovalRequest, address: string | undefined): Promise<void> {
    const review = request.review;
    const deployed =
      address ?? (review?.action === "deploy_create2" ? review.predictedAddress : undefined);
    if (!deployed || !review?.contractName) return;
    const artifacts = await this.#options.artifacts().catch(() => ArtifactIndex.empty());
    const entry =
      artifacts
        .findByName(review.contractName)
        .find((e) => !review.sourcePath || e.sourcePath === review.sourcePath) ??
      artifacts.findByName(review.contractName)[0];
    this.#known.set(deployed.toLowerCase(), {
      name: review.contractName,
      ...(entry ? { abi: entry.abi } : {}),
    });
  }

  async #onSigned(request: ApprovalRequest, signature: Hex, upstream: UpstreamRpc): Promise<void> {
    const details = request.signature!;
    let valid: boolean | undefined;
    try {
      if (details.method === "personal_sign") {
        valid = await upstream.client.verifyMessage({
          address: details.address,
          message: { raw: details.payload as Hex },
          signature,
        });
      } else {
        const typed = JSON.parse(details.payload) as Parameters<
          UpstreamRpc["client"]["verifyTypedData"]
        >[0];
        valid = await upstream.client.verifyTypedData({
          ...typed,
          address: details.address,
          signature,
        });
      }
    } catch {
      valid = undefined;
    }
    if (valid === false) {
      request.fail(
        "failed",
        new HatchwayError(
          "INTEGRITY_MISMATCH",
          `The signature does not belong to ${details.address}.`,
        ),
      );
      return;
    }
    request.state = "signed";
    request.result = { signature };
    request.completion.resolve(signature);
    request.settled.resolve();
  }
}

function walletError(code: number | undefined, message: string): HatchwayError {
  switch (code) {
    case 4001:
      return new HatchwayError("USER_REJECTED", "Transaction rejected in wallet.");
    case 4100:
      return new HatchwayError("WRONG_ACCOUNT", `The wallet refused the account: ${message}`);
    case 4900:
    case 4901:
      return new HatchwayError(
        "WRONG_NETWORK",
        `The wallet is not connected to the expected network: ${message}`,
      );
    default:
      return new HatchwayError("WALLET_ERROR", `The wallet returned an error: ${message}`);
  }
}

function optionalUrl(url: string | undefined): { explorerUrl?: string } {
  return url ? { explorerUrl: url } : {};
}

function minimalReview(
  tx: CanonicalTransaction,
  chainId: number,
  reason: string,
): TransactionReview {
  const symbol = nativeSymbol(chainId);
  const review: TransactionReview = {
    action: tx.to ? (tx.data === "0x" ? "transfer" : "call") : "deploy",
    title: tx.to ? "Contract call" : "Deploy contract",
    from: tx.from,
    value: tx.value.toString(),
    valueDisplay: formatAmount(tx.value, symbol),
    dataSize: (tx.data.length - 2) / 2,
    dataPreview: tx.data.length > 74 ? `${tx.data.slice(0, 74)}…` : tx.data,
    simulation: { status: "unavailable", message: reason },
    notices: [{ level: "warning", message: `Review details are incomplete: ${reason}` }],
  };
  if (tx.to) review.to = tx.to;
  if (tx.nonce !== undefined) review.nonce = tx.nonce;
  return review;
}

function decodePersonalMessage(payload: string): string | undefined {
  if (!isHex(payload)) return payload;
  try {
    const text = hexToString(payload);
    // Only show as text when it is printable; otherwise the user sees raw hex.
    return /^[\p{L}\p{N}\p{P}\p{S}\p{Zs}\n\r\t]*$/u.test(text) ? text : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Looks for a mined transaction from the request's sender with the expected nonce that
 * matches the approved payload. Used when the page lost the wallet's answer.
 */
async function findSentTransaction(
  upstream: UpstreamRpc,
  request: ApprovalRequest,
  nonce: number | undefined,
  fromBlock: bigint,
): Promise<Hex | undefined> {
  const tx = request.tx;
  if (!tx || nonce === undefined) return undefined;
  const latestNonce = await upstream.client.getTransactionCount({
    address: tx.from,
    blockTag: "latest",
  });
  if (latestNonce <= nonce) return undefined;
  const latest = await upstream.client.getBlockNumber();
  const start = latest - fromBlock > 50n ? latest - 50n : fromBlock;
  for (let n = latest; n >= start; n -= 1n) {
    const block = await upstream.client.getBlock({ blockNumber: n, includeTransactions: true });
    for (const candidate of block.transactions) {
      if (candidate.from.toLowerCase() === tx.from.toLowerCase() && candidate.nonce === nonce) {
        return candidate.hash;
      }
    }
    if (n === 0n) break;
  }
  return undefined;
}

async function wasReplaced(
  upstream: UpstreamRpc,
  request: ApprovalRequest,
  hash: Hex,
): Promise<boolean> {
  const nonce = request.broadcastNonce!;
  const latestNonce = await upstream.client.getTransactionCount({
    address: request.tx!.from,
    blockTag: "latest",
  });
  if (latestNonce <= nonce) return false;
  try {
    await upstream.client.getTransactionReceipt({ hash });
    return false;
  } catch {
    return true;
  }
}
