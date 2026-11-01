import type { RequestView, SessionSnapshot, WalletTransaction } from "../../src/core/protocol.js";
import { rpc } from "./anvil.js";

export type Decision =
  | { action: "approve"; delayMs?: number; before?: () => Promise<void> }
  | { action: "reject"; delayMs?: number }
  | { action: "error"; code?: number; message?: string }
  /** Never answers (e.g. the user walked away). */
  | { action: "ignore" }
  /** Reports approval but broadcasts different calldata (a misbehaving wallet). */
  | { action: "tamper" };

export interface HeadlessWalletOptions {
  sessionUrl: string;
  /** The node the "wallet" broadcasts through (anvil). */
  nodeUrl: string;
  address: string;
  /** Chain the wallet claims to be on; defaults to the node's chain. */
  chainId?: number;
  name?: string;
  decide?: (request: RequestView) => Decision;
  /** Mimic MetaMask, which ignores a dapp-supplied nonce and picks its own. */
  ignoreNonce?: boolean;
  /** Add a fixed gas limit when the request has none, so reverting transactions still get mined. */
  forceGas?: boolean;
  /** Do not connect a wallet automatically after pairing. */
  manualConnect?: boolean;
}

/**
 * A scripted stand-in for "browser page + wallet extension" that talks to the real Hatchway
 * server over HTTP exactly as the signing page does, and broadcasts through anvil's
 * unlocked accounts. Used by integration tests; the Playwright suite covers the real page.
 */
export class HeadlessWallet {
  readonly origin: string;
  readonly sessionId: string;
  readonly code: string;
  token = "";
  snapshot: SessionSnapshot | undefined;
  readonly handled = new Set<string>();
  readonly log: string[] = [];
  #options: HeadlessWalletOptions;
  #address: string;
  #chainId = 0;
  #abort = new AbortController();
  #waiters: (() => void)[] = [];

  private constructor(options: HeadlessWalletOptions) {
    this.#options = options;
    this.#address = options.address;
    const url = new URL(options.sessionUrl);
    this.origin = url.origin;
    this.sessionId = url.pathname.split("/")[2]!;
    this.code = url.hash.slice(1);
  }

  static async open(options: HeadlessWalletOptions): Promise<HeadlessWallet> {
    const wallet = new HeadlessWallet(options);
    wallet.#chainId =
      options.chainId ?? Number(BigInt(await rpc<string>(options.nodeUrl, "eth_chainId")));
    await wallet.#claim();
    void wallet.#stream();
    if (!options.manualConnect) await wallet.report();
    return wallet;
  }

  get address(): string {
    return this.#address;
  }

  async #claim(): Promise<void> {
    const response = await this.post("claim", { code: this.code }, false);
    if (!response.ok) throw new Error(`claim failed: ${response.status} ${await response.text()}`);
    this.token = ((await response.json()) as { token: string }).token;
  }

  post(path: string, body: unknown, auth = true): Promise<Response> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      origin: this.origin,
    };
    if (auth) headers.authorization = `Bearer ${this.token}`;
    return fetch(`${this.origin}/api/s/${this.sessionId}/${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  }

  async report(): Promise<void> {
    const response = await this.post("wallet", {
      address: this.#address,
      chainId: this.#chainId,
      name: this.#options.name ?? "Headless Wallet",
      rdns: "dev.hatchway.headless",
    });
    if (!response.ok)
      throw new Error(`wallet update failed: ${response.status} ${await response.text()}`);
  }

  async switchChain(chainId: number): Promise<void> {
    this.#chainId = chainId;
    await this.report();
  }

  async switchAccount(address: string): Promise<void> {
    this.#address = address;
    await this.report();
  }

  async #stream(): Promise<void> {
    try {
      const response = await fetch(`${this.origin}/api/s/${this.sessionId}/events`, {
        headers: { authorization: `Bearer ${this.token}` },
        signal: this.#abort.signal,
      });
      if (!response.body) return;
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk as Uint8Array, { stream: true });
        let index = buffer.indexOf("\n\n");
        while (index !== -1) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          index = buffer.indexOf("\n\n");
          const data = block.split("\n").find((l) => l.startsWith("data: "));
          if (block.startsWith("event: snapshot") && data) {
            this.snapshot = JSON.parse(data.slice(6)) as SessionSnapshot;
            this.#onSnapshot(this.snapshot);
            for (const resolve of this.#waiters.splice(0)) resolve();
          }
        }
      }
    } catch {
      // stream closed
    }
  }

  #onSnapshot(snapshot: SessionSnapshot): void {
    for (const request of snapshot.requests) {
      if (request.state !== "review" || this.handled.has(request.id)) continue;
      if (snapshot.walletIssue) continue;
      this.handled.add(request.id);
      void this.#handle(request).catch((error: unknown) =>
        this.log.push(`handle error: ${String(error)}`),
      );
    }
  }

  async #handle(request: RequestView): Promise<void> {
    const decision = this.#options.decide?.(request) ?? { action: "approve" };
    this.log.push(`${request.index}:${decision.action}`);
    if (decision.action === "ignore") return;
    if ("delayMs" in decision && decision.delayMs)
      await new Promise((r) => setTimeout(r, decision.delayMs));
    const begin = await this.post(`requests/${request.id}/begin`, {
      payloadHash: request.payloadHash,
      address: this.#address,
      chainId: this.#chainId,
    });
    if (!begin.ok) {
      this.log.push(`begin rejected: ${begin.status} ${await begin.text()}`);
      this.handled.delete(request.id);
      return;
    }
    if (decision.action === "reject") {
      await this.post(`requests/${request.id}/result`, {
        payloadHash: request.payloadHash,
        outcome: "rejected",
        message: "User rejected the request.",
      });
      return;
    }
    if (decision.action === "error") {
      await this.post(`requests/${request.id}/result`, {
        payloadHash: request.payloadHash,
        outcome: "error",
        code: decision.code ?? -32603,
        message: decision.message ?? "Internal wallet error",
      });
      return;
    }
    if (decision.action === "approve" && decision.before) await decision.before();
    const payload = request.wallet;
    if (payload.method === "eth_sendTransaction") {
      const tx: Partial<WalletTransaction> = { ...payload.params[0] };
      if (this.#options.ignoreNonce) delete tx.nonce;
      if (this.#options.forceGas && !tx.gas) tx.gas = "0x200000";
      if (decision.action === "tamper") tx.data = `${tx.data}00`;
      let hash: string;
      try {
        hash = await rpc<string>(this.#options.nodeUrl, "eth_sendTransaction", [tx]);
      } catch (error) {
        const e = error as { code?: number; message: string };
        await this.post(`requests/${request.id}/result`, {
          payloadHash: request.payloadHash,
          outcome: "error",
          code: e.code ?? -32603,
          message: e.message,
        });
        return;
      }
      await this.post(`requests/${request.id}/result`, {
        payloadHash: request.payloadHash,
        outcome: "submitted",
        hash,
      });
    } else {
      const signature = await rpc<string>(this.#options.nodeUrl, payload.method, payload.params);
      await this.post(`requests/${request.id}/result`, {
        payloadHash: request.payloadHash,
        outcome: "signed",
        signature,
      });
    }
  }

  async waitFor(
    predicate: (snapshot: SessionSnapshot) => boolean,
    timeoutMs = 20_000,
  ): Promise<SessionSnapshot> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.snapshot && predicate(this.snapshot)) return this.snapshot;
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        throw new Error(
          `timed out waiting; last state: ${JSON.stringify(this.snapshot?.requests.map((r) => r.state))} ${this.snapshot?.state}`,
        );
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(remaining, 250));
        this.#waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  close(): void {
    this.#abort.abort();
  }
}
