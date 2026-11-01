import type { IncomingMessage, ServerResponse } from "node:http";
import { HatchwayError } from "../core/errors.js";

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * DNS-rebinding defence: a page on attacker.example that rebinds its hostname to 127.0.0.1
 * still sends `Host: attacker.example`, so only loopback host names are accepted. The port is
 * not pinned so that SSH/VS Code port forwarding to a different local port keeps working.
 */
export function isLoopbackHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const match = /^(\[[0-9a-fA-F:]+\]|[^:]+)(?::(\d{1,5}))?$/.exec(hostHeader);
  if (!match) return false;
  return LOOPBACK_HOSTNAMES.has(match[1]!.toLowerCase());
}

/**
 * State-changing browser requests must come from the signing page itself. Browsers always
 * send `Origin` on cross-origin and on POST requests, and pages cannot forge it.
 */
export function isSameOriginRequest(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (!origin || !host || !isLoopbackHost(host)) return false;
  if (origin !== `http://${host}`) return false;
  const site = req.headers["sec-fetch-site"];
  return site === undefined || site === "same-origin";
}

/**
 * Requests to the RPC endpoint must not come from a browser at all. Browsers attach `Origin`
 * to every POST and `Sec-Fetch-Site` to every request, and pages cannot remove either.
 * (`Sec-Fetch-Mode` is not used: Node's own fetch sends it.)
 */
export function looksLikeBrowserRequest(req: IncomingMessage): boolean {
  return req.headers.origin !== undefined || req.headers["sec-fetch-site"] !== undefined;
}

export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

export function baseHeaders(): Record<string, string> {
  return {
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cross-origin-resource-policy": "same-origin",
    "x-frame-options": "DENY",
    "cache-control": "no-store",
  };
}

export function htmlHeaders(): Record<string, string> {
  return {
    ...baseHeaders(),
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": CONTENT_SECURITY_POLICY,
    "cross-origin-opener-policy": "same-origin",
    "permissions-policy":
      "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=()",
  };
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { ...baseHeaders(), "content-type": "application/json; charset=utf-8" });
  res.end(text);
}

export function sendStatus(res: ServerResponse, status: number): void {
  res.writeHead(status, baseHeaders());
  res.end();
}

export async function readBody(req: IncomingMessage, limitBytes: number): Promise<string> {
  const declared = Number(req.headers["content-length"] ?? "0");
  if (declared > limitBytes) throw new HatchwayError("USAGE", "Request body too large.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > limitBytes) throw new HatchwayError("USAGE", "Request body too large.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function readJson(req: IncomingMessage, limitBytes: number): Promise<unknown> {
  const contentType = req.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new HatchwayError("USAGE", "Expected a JSON request body.");
  }
  const text = await readBody(req, limitBytes);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HatchwayError("USAGE", "Malformed JSON.");
  }
}

export function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return undefined;
  return header.slice("Bearer ".length).trim() || undefined;
}
