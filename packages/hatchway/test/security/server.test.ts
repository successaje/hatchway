import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Bridge } from "../../src/bridge.js";

let ui: string;
const bridges: Bridge[] = [];

beforeAll(() => {
  ui = mkdtempSync(join(tmpdir(), "hatchway-ui-"));
  mkdirSync(join(ui, "assets"));
  writeFileSync(join(ui, "index.html"), "<!doctype html><title>t</title>");
  writeFileSync(join(ui, "assets", "app.js"), "console.log(1)");
});

afterEach(async () => {
  for (const bridge of bridges.splice(0)) await bridge.close();
});

async function start(options: { ttlMs?: number } = {}): Promise<Bridge> {
  // No upstream: like a Hardhat session before the script attaches. No network needed.
  const bridge = await Bridge.start({
    purpose: { kind: "hardhat", title: "security test" },
    uiDirectory: ui,
    ...options,
  });
  bridges.push(bridge);
  return bridge;
}

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** Raw HTTP so tests control every header (fetch would normalise Host/Origin). */
function raw(
  port: number,
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path, method: init.method ?? "GET", headers: init.headers ?? {} },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => (body += chunk.toString()));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    if (init.body) req.write(init.body);
    req.end();
  });
}

function parts(bridge: Bridge) {
  const url = new URL(bridge.sessionUrl);
  return {
    host: url.host,
    origin: url.origin,
    sid: url.pathname.split("/")[2]!,
    code: url.hash.slice(1),
  };
}

function json(bridge: Bridge, path: string, body: unknown, headers: Record<string, string> = {}) {
  const { host, origin } = parts(bridge);
  const text = JSON.stringify(body);
  return raw(bridge.port, path, {
    method: "POST",
    headers: {
      host,
      origin,
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(text)),
      ...headers,
    },
    body: text,
  });
}

async function claim(bridge: Bridge): Promise<string> {
  const { sid, code } = parts(bridge);
  const res = await json(bridge, `/api/s/${sid}/claim`, { code });
  expect(res.status).toBe(200);
  return (JSON.parse(res.body) as { token: string }).token;
}

describe("loopback server security", () => {
  it("listens on 127.0.0.1 only", async () => {
    const bridge = await start();
    expect(bridge.sessionUrl.startsWith(`http://127.0.0.1:${bridge.port}/s/`)).toBe(true);
    await expect(
      raw(bridge.port, "/favicon.ico", { headers: { host: `127.0.0.1:${bridge.port}` } }),
    ).resolves.toMatchObject({ status: 204 });
  });

  it("rejects requests with a non-loopback Host header (DNS rebinding)", async () => {
    const bridge = await start();
    const { sid } = parts(bridge);
    for (const host of [
      "evil.example",
      `evil.example:${bridge.port}`,
      `127.0.0.1.evil.example:${bridge.port}`,
      "localhost.evil:80",
    ]) {
      const res = await raw(bridge.port, `/s/${sid}`, { headers: { host } });
      expect(res.status, host).toBe(421);
    }
    const ok = await raw(bridge.port, `/s/${sid}`, {
      headers: { host: `localhost:${bridge.port}` },
    });
    expect(ok.status).toBe(200);
  });

  it("serves the page with a strict content security policy and hardening headers", async () => {
    const bridge = await start();
    const { host, sid } = parts(bridge);
    const res = await raw(bridge.port, `/s/${sid}`, { headers: { host } });
    expect(res.headers["content-security-policy"]).toContain("script-src 'self'");
    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("serves only files that exist in the bundled UI (no path traversal)", async () => {
    const bridge = await start();
    const { host } = parts(bridge);
    expect((await raw(bridge.port, "/ui/assets/app.js", { headers: { host } })).status).toBe(200);
    for (const path of [
      "/ui/../package.json",
      "/ui/%2e%2e/%2e%2e/package.json",
      "/ui/assets/../../index.html",
      "/ui/missing.js",
    ]) {
      expect((await raw(bridge.port, path, { headers: { host } })).status, path).toBe(404);
    }
  });

  it("requires a same-origin Origin header for browser API calls (CSRF)", async () => {
    const bridge = await start();
    const { sid, code, host } = parts(bridge);
    const noOrigin = await raw(bridge.port, `/api/s/${sid}/claim`, {
      method: "POST",
      headers: { host, "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    expect(noOrigin.status).toBe(403);
    const foreign = await json(
      bridge,
      `/api/s/${sid}/claim`,
      { code },
      { origin: "https://evil.example" },
    );
    expect(foreign.status).toBe(403);
    const crossSite = await json(
      bridge,
      `/api/s/${sid}/claim`,
      { code },
      { "sec-fetch-site": "cross-site" },
    );
    expect(crossSite.status).toBe(403);
  });

  it("only issues a browser token for the correct pairing code", async () => {
    const bridge = await start();
    const { sid } = parts(bridge);
    const wrong = await json(bridge, `/api/s/${sid}/claim`, { code: "not-the-code" });
    expect(wrong.status).toBe(400);
    expect(await claim(bridge)).toMatch(/^[A-Za-z0-9_-]{40,}$/);
  });

  it("requires the browser token for events and actions", async () => {
    const bridge = await start();
    const { sid, host } = parts(bridge);
    expect((await raw(bridge.port, `/api/s/${sid}/events`, { headers: { host } })).status).toBe(
      401,
    );
    expect(
      (
        await raw(bridge.port, `/api/s/${sid}/events`, {
          headers: { host, authorization: "Bearer guess" },
        })
      ).status,
    ).toBe(401);
    expect((await json(bridge, `/api/s/${sid}/cancel`, {})).status).toBe(401);
    expect(
      (
        await json(
          bridge,
          `/api/s/${sid}/wallet`,
          { address: "0x0000000000000000000000000000000000000001", chainId: 1, name: "x" },
          { authorization: "Bearer guess" },
        )
      ).status,
    ).toBe(401);
  });

  it("revokes an earlier browser when the link is claimed again, and burns the link once a wallet is bound", async () => {
    const bridge = await start();
    const { sid, code } = parts(bridge);
    const first = await claim(bridge);
    const second = await claim(bridge);
    expect(first).not.toBe(second);
    expect(bridge.session.authenticate(first)).toBe(false);
    expect(bridge.session.authenticate(second)).toBe(true);

    const bound = await json(
      bridge,
      `/api/s/${sid}/wallet`,
      { address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", chainId: 31337, name: "Test" },
      { authorization: `Bearer ${second}` },
    );
    expect(bound.status).toBe(204);
    expect(parts(bridge).code).toBe("");
    const reuse = await json(bridge, `/api/s/${sid}/claim`, { code });
    expect(reuse.status).toBe(400);
  });

  it("does not accept another session's token or session id", async () => {
    const a = await start();
    const b = await start();
    const tokenA = await claim(a);
    const { sid: sidB, host: hostB } = parts(b);
    const res = await raw(b.port, `/api/s/${sidB}/events`, {
      headers: { host: hostB, authorization: `Bearer ${tokenA}` },
    });
    expect(res.status).toBe(401);
    const { sid: sidA } = parts(a);
    const crossed = await json(
      b,
      `/api/s/${sidA}/cancel`,
      {},
      { authorization: `Bearer ${tokenA}` },
    );
    expect(crossed.status).toBe(404);
  });

  it("validates request bodies: content type, JSON, size, shape", async () => {
    const bridge = await start();
    const token = await claim(bridge);
    const { sid, host, origin } = parts(bridge);
    const auth = { authorization: `Bearer ${token}` };
    const textBody = await raw(bridge.port, `/api/s/${sid}/wallet`, {
      method: "POST",
      headers: { host, origin, "content-type": "text/plain", ...auth },
      body: "{}",
    });
    expect(textBody.status).toBe(400);
    const malformed = await raw(bridge.port, `/api/s/${sid}/wallet`, {
      method: "POST",
      headers: { host, origin, "content-type": "application/json", ...auth },
      body: "{not json",
    });
    expect(malformed.status).toBe(400);
    const big = "x".repeat(70 * 1024);
    const tooLarge = await raw(bridge.port, `/api/s/${sid}/wallet`, {
      method: "POST",
      headers: {
        host,
        origin,
        "content-type": "application/json",
        "content-length": String(big.length + 12),
        ...auth,
      },
      body: JSON.stringify({ name: big }),
    });
    expect(tooLarge.status).toBe(400);
    const badShape = await json(
      bridge,
      `/api/s/${sid}/wallet`,
      { address: "not-an-address", chainId: 1, name: "x" },
      auth,
    );
    expect(badShape.status).toBe(400);
    const unknownRequest = await json(
      bridge,
      `/api/s/${sid}/requests/AAAAAAAAAAAAAAAA/result`,
      { payloadHash: "x", outcome: "rejected" },
      auth,
    );
    expect(unknownRequest.status).toBe(404);
  });

  it("keeps the RPC endpoint away from browsers and requires its token", async () => {
    const bridge = await start();
    const rpcPath = new URL(bridge.rpcUrl).pathname;
    const { host } = parts(bridge);
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "hatchway_unknown", params: [] });
    const headers = { host, "content-type": "application/json" };
    expect(
      (
        await raw(bridge.port, rpcPath, {
          method: "POST",
          headers: { ...headers, origin: `http://${host}` },
          body,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await raw(bridge.port, rpcPath, {
          method: "POST",
          headers: { ...headers, "sec-fetch-site": "same-origin" },
          body,
        })
      ).status,
    ).toBe(403);
    expect(
      (await raw(bridge.port, "/rpc/wrong-token", { method: "POST", headers, body })).status,
    ).toBe(404);
    const ok = await raw(bridge.port, rpcPath, { method: "POST", headers, body });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toMatchObject({ error: { code: expect.any(Number) } });
  });

  it("rejects requests after the session expires", async () => {
    const bridge = await start({ ttlMs: 300 });
    const { sid, code } = parts(bridge);
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(bridge.session.state).toBe("expired");
    const late = await json(bridge, `/api/s/${sid}/claim`, { code });
    expect(late.status).toBe(410);
  });
});
