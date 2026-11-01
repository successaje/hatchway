import type { Address } from "viem";
import { ApprovalEngine } from "./core/engine.js";
import { HatchwayError } from "./core/errors.js";
import type { SessionPurpose } from "./core/protocol.js";
import { randomToken } from "./core/secrets.js";
import { Session } from "./core/session.js";
import { ArtifactIndex } from "./evm/artifacts.js";
import { UpstreamRpc } from "./evm/rpc.js";
import { UiAssets } from "./server/assets.js";
import { HatchwayServer } from "./server/http.js";
import { RpcHandler, type AttachParams } from "./server/rpc-handler.js";

export interface BridgeOptions {
  purpose: SessionPurpose;
  /** 0 picks a free port. */
  port?: number;
  ttlMs?: number;
  connectTimeoutMs?: number;
  approvalTimeoutMs?: number;
  expectedAddress?: Address | undefined;
  /** Known up front for forge/deploy/connect; attached later by the Hardhat plugin. */
  upstream?: { url: string; headers?: Record<string, string> } | undefined;
  /** Project root used to find compiled artifacts for decoding. */
  projectRoot?: string | undefined;
  uiDirectory?: string;
  /** Tuning knobs, mainly for tests. */
  engine?: { abandonGraceMs?: number; previousConfirmationTimeoutMs?: number };
}

export const DEFAULTS = {
  ttlMs: 2 * 60 * 60_000,
  connectTimeoutMs: 15 * 60_000,
  approvalTimeoutMs: 15 * 60_000,
};

/**
 * One running Hatchway session: a loopback server, the browser session, the approval
 * engine, and the connection to the developer's RPC endpoint.
 */
export class Bridge {
  readonly session: Session;
  readonly engine: ApprovalEngine;
  readonly #server: HatchwayServer;
  readonly #rpcToken = randomToken(32);
  readonly #projectRoot: string | undefined;
  #upstream: UpstreamRpc | undefined;
  #artifacts: Promise<ArtifactIndex> | undefined;
  #closing: Promise<void> | undefined;

  private constructor(options: BridgeOptions) {
    this.#projectRoot = options.projectRoot;
    this.session = new Session({
      purpose: options.purpose,
      ttlMs: options.ttlMs ?? DEFAULTS.ttlMs,
      connectTimeoutMs: options.connectTimeoutMs ?? DEFAULTS.connectTimeoutMs,
      approvalTimeoutMs: options.approvalTimeoutMs ?? DEFAULTS.approvalTimeoutMs,
      expectedAddress: options.expectedAddress,
    });
    this.engine = new ApprovalEngine({
      session: this.session,
      upstream: () => this.#upstream,
      artifacts: () => this.artifacts(),
      ...options.engine,
    });
    const rpc = new RpcHandler({
      engine: this.engine,
      upstream: () => this.#upstream,
      attach: (params) => this.#attach(params),
    });
    this.#server = new HatchwayServer({
      session: this.session,
      engine: this.engine,
      rpc,
      rpcToken: this.#rpcToken,
      ui: new UiAssets(options.uiDirectory ?? UiAssets.defaultDirectory()),
      port: options.port ?? 0,
    });
  }

  static async start(options: BridgeOptions): Promise<Bridge> {
    const bridge = new Bridge(options);
    if (options.upstream) {
      bridge.#upstream = new UpstreamRpc(
        options.upstream.url,
        options.upstream.headers ? { headers: options.upstream.headers } : {},
      );
      const chainId = await bridge.#upstream.chainId().catch((error: unknown) => {
        throw error instanceof HatchwayError
          ? error
          : new HatchwayError(
              "RPC_UNREACHABLE",
              `RPC endpoint could not be reached (${bridge.#upstream!.display}).`,
            );
      });
      bridge.session.setChain(chainId, options.upstream.url);
    }
    await bridge.#server.listen();
    bridge.engine.start();
    // Start indexing artifacts in the background so the first review is fast.
    void bridge.artifacts();
    return bridge;
  }

  get port(): number {
    return this.#server.port;
  }

  get origin(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** URL to open in the browser. The fragment carries the one-time pairing code. */
  get sessionUrl(): string {
    const code = this.session.pairingCode;
    return `${this.origin}/s/${this.session.id}${code ? `#${code}` : ""}`;
  }

  /** Issues a fresh link for reconnecting after the original tab was closed. */
  newSessionUrl(): string {
    const code = this.session.rotatePairingCode();
    return `${this.origin}/s/${this.session.id}#${code}`;
  }

  /** JSON-RPC endpoint for local tools. Contains a secret; never print it in shared logs. */
  get rpcUrl(): string {
    return `${this.origin}/rpc/${this.#rpcToken}`;
  }

  get upstream(): UpstreamRpc | undefined {
    return this.#upstream;
  }

  get secrets(): string[] {
    return [this.#rpcToken, ...(this.#upstream?.secrets ?? [])];
  }

  artifacts(): Promise<ArtifactIndex> {
    this.#artifacts ??= this.#projectRoot
      ? ArtifactIndex.load(this.#projectRoot)
      : Promise.resolve(ArtifactIndex.empty());
    return this.#artifacts;
  }

  async #attach(params: AttachParams): Promise<{ chainId: number }> {
    if (this.#upstream) {
      if (this.#upstream.url !== params.url) {
        throw new HatchwayError(
          "WRONG_NETWORK",
          `This session is bound to ${this.#upstream.display}; the script connected to a different network${params.network ? ` (${params.network})` : ""}.`,
          { hint: "Use one network per Hatchway session." },
        );
      }
      return { chainId: this.session.chain!.id };
    }
    const upstream = new UpstreamRpc(params.url, params.headers ? { headers: params.headers } : {});
    const chainId = await upstream.chainId();
    if (params.chainId !== undefined && params.chainId !== chainId) {
      throw new HatchwayError(
        "WRONG_NETWORK",
        `The network reports chain ${chainId}, but Hardhat expected ${params.chainId}.`,
      );
    }
    this.#upstream = upstream;
    this.session.setChain(chainId, params.url);
    return { chainId };
  }

  /** Ends the session and stops the server. Safe to call more than once; later calls wait for the first. */
  close(
    state: "completed" | "cancelled" | "expired" | "failed" = "completed",
    reason?: string,
  ): Promise<void> {
    this.#closing ??= (async () => {
      this.session.end(state, reason);
      // Give the page a moment to receive the final state before connections drop.
      await new Promise((resolve) => setTimeout(resolve, 150));
      await this.engine.stop();
      await this.#server.close();
    })();
    return this.#closing;
  }
}
