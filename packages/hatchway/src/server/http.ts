import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ApprovalEngine } from "../core/engine.js";
import { HatchwayError, toHatchwayError, type ErrorCode } from "../core/errors.js";
import type { BeginRequest, ClaimResponse, ResultRequest, WalletUpdate } from "../core/protocol.js";
import { PROTOCOL_VERSION } from "../core/protocol.js";
import { constantTimeEqual } from "../core/secrets.js";
import type { Session } from "../core/session.js";
import type { UiAssets } from "./assets.js";
import type { RpcHandler } from "./rpc-handler.js";
import {
  baseHeaders,
  bearerToken,
  htmlHeaders,
  isLoopbackHost,
  isSameOriginRequest,
  looksLikeBrowserRequest,
  readBody,
  readJson,
  sendJson,
  sendStatus,
} from "./security.js";

export interface ServerOptions {
  session: Session;
  engine: ApprovalEngine;
  rpc: RpcHandler;
  rpcToken: string;
  ui: UiAssets;
  port: number;
}

const API_BODY_LIMIT = 64 * 1024;
const RPC_BODY_LIMIT = 16 * 1024 * 1024;
const MAX_FAILED_CLAIMS = 50;

const STATUS_BY_CODE: Partial<Record<ErrorCode, number>> = {
  USAGE: 400,
  INVALID_TRANSACTION: 400,
  INTEGRITY_MISMATCH: 409,
  WRONG_ACCOUNT: 409,
  WRONG_NETWORK: 409,
  SESSION_CLOSED: 410,
  SESSION_EXPIRED: 410,
  SESSION_CANCELLED: 410,
};

/**
 * Loopback-only HTTP server for one session. Three surfaces, three trust rules:
 *
 *  - `/s/<id>` and `/ui/*`: the static signing page (strict CSP, no third-party code).
 *  - `/api/s/<id>/*`: browser API. Requires same-origin `Origin`, and a bearer token that
 *    is only obtainable by redeeming the one-time pairing code in the session URL.
 *  - `/rpc/<token>`: JSON-RPC for local tools. Requires the RPC token and rejects anything
 *    that looks like a browser request, so web pages cannot drive it even if they guess it.
 *
 * Every request must carry a loopback `Host` header (DNS-rebinding defence).
 */
export class HatchwayServer {
  readonly #options: ServerOptions;
  readonly #server: Server;
  readonly #streams = new Set<ServerResponse>();
  #failedClaims = 0;
  #port = 0;

  constructor(options: ServerOptions) {
    this.#options = options;
    this.#server = createServer((req, res) => {
      this.#route(req, res).catch((error: unknown) => this.#fail(res, error));
    });
    this.#server.headersTimeout = 30_000;
    // Long-held RPC calls (waiting for a human) must not be cut by Node's request timeout.
    this.#server.requestTimeout = 0;
    this.#server.keepAliveTimeout = 5_000;
  }

  get port(): number {
    return this.#port;
  }

  async listen(): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        this.#server.off("listening", onListening);
        if (error.code === "EADDRINUSE") {
          reject(new HatchwayError("PORT_IN_USE", `Port ${this.#options.port} is already in use.`, { hint: "Choose another port with --port, or omit it to pick a free one." }));
        } else reject(error);
      };
      const onListening = () => {
        this.#server.off("error", onError);
        resolve();
      };
      this.#server.once("error", onError);
      this.#server.once("listening", onListening);
      // Loopback only. Never 0.0.0.0: remote access goes through SSH port forwarding.
      this.#server.listen(this.#options.port, "127.0.0.1");
    });
    this.#port = (this.#server.address() as AddressInfo).port;
    return this.#port;
  }

  async close(): Promise<void> {
    for (const stream of this.#streams) stream.end();
    this.#streams.clear();
    this.#server.closeAllConnections();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  async #route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isLoopbackHost(req.headers.host)) {
      sendJson(res, 421, { error: "BAD_HOST", message: "Requests must address 127.0.0.1 or localhost." });
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    const method = req.method ?? "GET";
    const { session } = this.#options;

    if (path.startsWith("/rpc/")) {
      if (method !== "POST") return sendStatus(res, 405);
      return this.#rpc(req, res, path.slice("/rpc/".length));
    }

    if (method === "GET" && path === `/s/${session.id}`) {
      res.writeHead(200, htmlHeaders());
      res.end(this.#options.ui.index);
      return;
    }
    if (method === "GET" && path.startsWith("/ui/")) {
      const asset = this.#options.ui.get(path.slice("/ui/".length));
      if (!asset) return sendStatus(res, 404);
      res.writeHead(200, {
        ...baseHeaders(),
        "content-type": asset.contentType,
        "cache-control": "public, max-age=3600, immutable",
      });
      res.end(asset.body);
      return;
    }
    if (method === "GET" && path === "/favicon.ico") return sendStatus(res, 204);

    const prefix = `/api/s/${session.id}/`;
    if (path.startsWith("/api/")) {
      if (!path.startsWith(prefix)) {
        return sendJson(res, 404, { error: "UNKNOWN_SESSION", message: "This session does not exist or has ended." });
      }
      return this.#api(req, res, method, path.slice(prefix.length));
    }

    if (method === "GET" && path.startsWith("/s/")) {
      res.writeHead(404, { ...htmlHeaders() });
      res.end(this.#options.ui.index);
      return;
    }
    sendStatus(res, 404);
  }

  async #api(req: IncomingMessage, res: ServerResponse, method: string, route: string): Promise<void> {
    const { session, engine } = this.#options;

    if (method === "GET" && route === "events") {
      if (!session.authenticate(bearerToken(req))) return sendJson(res, 401, { error: "UNAUTHORIZED", message: "Not paired with this session." });
      return this.#events(req, res, bearerToken(req)!);
    }
    if (method !== "POST") return sendStatus(res, 405);
    if (!isSameOriginRequest(req)) {
      return sendJson(res, 403, { error: "FORBIDDEN_ORIGIN", message: "Cross-origin requests are not allowed." });
    }

    if (route === "claim") {
      if (this.#failedClaims >= MAX_FAILED_CLAIMS) return sendJson(res, 429, { error: "LOCKED", message: "Too many attempts." });
      const body = (await readJson(req, API_BODY_LIMIT)) as { code?: unknown };
      if (typeof body.code !== "string") throw new HatchwayError("USAGE", "Missing pairing code.");
      try {
        const token = session.claim(body.code);
        const response: ClaimResponse = { token, protocol: PROTOCOL_VERSION };
        return sendJson(res, 200, response);
      } catch (error) {
        this.#failedClaims += 1;
        throw error;
      }
    }

    if (!session.authenticate(bearerToken(req))) {
      return sendJson(res, 401, { error: "UNAUTHORIZED", message: "Not paired with this session." });
    }

    if (route === "wallet") {
      session.updateWallet(parseWalletUpdate(await readJson(req, API_BODY_LIMIT)));
      return sendStatus(res, 204);
    }
    if (route === "cancel") {
      session.end("cancelled", "Cancelled in the browser.");
      return sendStatus(res, 204);
    }
    const match = /^requests\/([A-Za-z0-9_-]{8,64})\/(begin|result)$/.exec(route);
    if (match) {
      const request = session.findRequest(match[1]!);
      if (!request) return sendJson(res, 404, { error: "UNKNOWN_REQUEST", message: "Unknown request." });
      const body = await readJson(req, API_BODY_LIMIT);
      if (match[2] === "begin") engine.begin(request, parseBegin(body));
      else engine.report(request, parseResult(body));
      return sendStatus(res, 204);
    }
    sendStatus(res, 404);
  }

  #events(req: IncomingMessage, res: ServerResponse, token: string): void {
    const { session } = this.#options;
    res.writeHead(200, {
      ...baseHeaders(),
      "content-type": "text/event-stream; charset=utf-8",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    this.#streams.add(res);
    session.streamOpened();

    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    send("snapshot", session.snapshot());

    let scheduled = false;
    const onChange = () => {
      if (scheduled) return;
      scheduled = true;
      setTimeout(() => {
        scheduled = false;
        if (res.writableEnded) return;
        if (!session.authenticate(token)) {
          send("revoked", { message: "This session was opened in another browser tab." });
          res.end();
          return;
        }
        send("snapshot", session.snapshot());
      }, 25);
    };
    session.on("change", onChange);
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);
    heartbeat.unref();

    res.on("close", () => {
      clearInterval(heartbeat);
      session.off("change", onChange);
      this.#streams.delete(res);
      session.streamClosed();
    });
    req.on("error", () => res.end());
  }

  async #rpc(req: IncomingMessage, res: ServerResponse, token: string): Promise<void> {
    if (looksLikeBrowserRequest(req)) {
      return sendJson(res, 403, { error: "FORBIDDEN", message: "The RPC endpoint is for local tools, not browsers." });
    }
    if (!constantTimeEqual(token, this.#options.rpcToken)) return sendStatus(res, 404);
    const body = await readBody(req, RPC_BODY_LIMIT);

    // Detect callers that give up (forge times out unanswered sends) so their requests
    // can be withdrawn instead of being approved after nobody is listening.
    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) abort.abort();
    });
    const text = await this.#options.rpc.handle(body, abort.signal);
    if (res.destroyed) return;
    res.writeHead(200, { ...baseHeaders(), "content-type": "application/json" });
    res.end(text);
  }

  #fail(res: ServerResponse, error: unknown): void {
    if (res.headersSent) {
      res.end();
      return;
    }
    const hatchway = toHatchwayError(error);
    const status = STATUS_BY_CODE[hatchway.code] ?? (hatchway.code === "INTERNAL" ? 500 : 400);
    sendJson(res, status, { error: hatchway.code, message: hatchway.code === "INTERNAL" ? "Internal error." : hatchway.message });
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new HatchwayError("USAGE", "Expected an object.");
  return value as Record<string, unknown>;
}

function parseWalletUpdate(value: unknown): WalletUpdate {
  const input = asRecord(value);
  if (typeof input.address !== "string" || typeof input.chainId !== "number" || typeof input.name !== "string") {
    throw new HatchwayError("USAGE", "Invalid wallet update.");
  }
  const update: WalletUpdate = { address: input.address, chainId: input.chainId, name: input.name };
  if (typeof input.rdns === "string") update.rdns = input.rdns;
  return update;
}

function parseBegin(value: unknown): BeginRequest {
  const input = asRecord(value);
  if (typeof input.payloadHash !== "string" || typeof input.address !== "string" || typeof input.chainId !== "number") {
    throw new HatchwayError("USAGE", "Invalid begin request.");
  }
  return { payloadHash: input.payloadHash, address: input.address, chainId: input.chainId };
}

function parseResult(value: unknown): ResultRequest {
  const input = asRecord(value);
  if (typeof input.payloadHash !== "string") throw new HatchwayError("USAGE", "Invalid result.");
  switch (input.outcome) {
    case "submitted":
      if (typeof input.hash !== "string") break;
      return { payloadHash: input.payloadHash, outcome: "submitted", hash: input.hash };
    case "signed":
      if (typeof input.signature !== "string") break;
      return { payloadHash: input.payloadHash, outcome: "signed", signature: input.signature };
    case "rejected":
      return { payloadHash: input.payloadHash, outcome: "rejected", ...(typeof input.message === "string" ? { message: input.message } : {}) };
    case "error":
      return {
        payloadHash: input.payloadHash,
        outcome: "error",
        message: typeof input.message === "string" ? input.message : "Unknown wallet error",
        ...(typeof input.code === "number" ? { code: input.code } : {}),
      };
  }
  throw new HatchwayError("USAGE", "Invalid result.");
}
