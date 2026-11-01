import { execFileSync } from "node:child_process";
import { encodeDeployData, encodeFunctionData, parseAbi, toHex, type Abi, type Hex } from "viem";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Bridge, type BridgeOptions } from "../../src/bridge.js";
import { ANVIL_ACCOUNTS, rpc, startAnvil, type Anvil } from "../helpers/anvil.js";
import { BIN, FOUNDRY_EXAMPLE } from "../helpers/cli.js";
import { HeadlessWallet, type HeadlessWalletOptions } from "../helpers/headless-wallet.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";

const UI = join(dirname(BIN), "ui");
const deployer = ANVIL_ACCOUNTS[0];
let anvil: Anvil;
const open: { bridge: Bridge; wallet?: HeadlessWallet }[] = [];

beforeAll(async () => {
  execFileSync("forge", ["build"], { cwd: FOUNDRY_EXAMPLE, stdio: "ignore" });
  anvil = await startAnvil();
});

afterEach(async () => {
  for (const { bridge, wallet } of open.splice(0)) {
    wallet?.close();
    await bridge.close();
  }
});

afterAll(async () => {
  await anvil?.stop();
});

async function session(options: Partial<BridgeOptions> = {}, walletOptions: Partial<HeadlessWalletOptions> = {}) {
  const bridge = await Bridge.start({
    purpose: { kind: "connect", title: "engine test" },
    upstream: { url: anvil.url },
    projectRoot: FOUNDRY_EXAMPLE,
    uiDirectory: UI,
    ...options,
  });
  const wallet = await HeadlessWallet.open({ sessionUrl: bridge.sessionUrl, nodeUrl: anvil.url, address: deployer, ...walletOptions });
  open.push({ bridge, wallet });
  await bridge.session.waitForWallet();
  return { bridge, wallet };
}

async function call(bridge: Bridge, method: string, params: unknown[], signal?: AbortSignal) {
  const response = await fetch(bridge.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    ...(signal ? { signal } : {}),
  });
  return (await response.json()) as { result?: unknown; error?: { code: number; message: string; data?: { hatchway?: string } } };
}

function artifact(name: string, file = `${name}.sol`) {
  return JSON.parse(readFileSync(join(FOUNDRY_EXAMPLE, "out", file, `${name}.json`), "utf8")) as { abi: Abi; bytecode: { object: Hex } };
}

describe("approval engine (bridge API + anvil)", () => {
  it("forwards reads to the upstream node and blocks raw or unsafe signing methods", async () => {
    const { bridge } = await session();
    expect(Number((await call(bridge, "eth_chainId", [])).result)).toBe(31337);
    expect((await call(bridge, "eth_accounts", [])).result).toEqual([deployer]);
    for (const method of ["eth_sendRawTransaction", "eth_sign", "eth_signTransaction", "wallet_switchEthereumChain"]) {
      const response = await call(bridge, method, ["0x00"]);
      expect(response.error?.code, method).toBe(4200);
    }
  });

  it("rejects a transaction from an address other than the connected wallet", async () => {
    const { bridge } = await session();
    const response = await call(bridge, "eth_sendTransaction", [{ from: ANVIL_ACCOUNTS[1], to: deployer, value: "0x1" }]);
    expect(response.error?.data?.hatchway).toBe("WRONG_ACCOUNT");
  });

  it("refuses a request whose nonce is already used, before showing it", async () => {
    const { bridge } = await session();
    const used = await anvil.client.getTransactionCount({ address: deployer });
    await rpc(anvil.url, "eth_sendTransaction", [{ from: deployer, to: ANVIL_ACCOUNTS[1], value: "0x1" }]);
    const response = await call(bridge, "eth_sendTransaction", [{ from: deployer, to: ANVIL_ACCOUNTS[1], value: "0x1", nonce: toHex(used) }]);
    expect(response.error?.data?.hatchway).toBe("NONCE_CONFLICT");
    expect(bridge.session.requests[0]?.state).toBe("failed");
  });

  it("joins identical concurrent retries into one approval and returns the same hash to both", async () => {
    const { bridge } = await session();
    const nonce = await anvil.client.getTransactionCount({ address: deployer });
    const tx = { from: deployer, to: ANVIL_ACCOUNTS[1], value: "0x2", nonce: toHex(nonce), chainId: "0x7a69" };
    const [a, b] = await Promise.all([call(bridge, "eth_sendTransaction", [tx]), call(bridge, "eth_sendTransaction", [tx])]);
    expect(a.result).toMatch(/^0x[0-9a-f]{64}$/);
    expect(b.result).toBe(a.result);
    expect(bridge.session.requests).toHaveLength(1);
  });

  it("withdraws a request when the calling tool stops waiting before it is approved", async () => {
    const { bridge, wallet } = await session({ engine: { abandonGraceMs: 300 } }, { decide: () => ({ action: "ignore" }) });
    const controller = new AbortController();
    const pending = call(bridge, "eth_sendTransaction", [{ from: deployer, to: ANVIL_ACCOUNTS[1], value: "0x3" }], controller.signal).catch(() => undefined);
    await wallet.waitFor((s) => s.requests[0]?.state === "review");
    controller.abort();
    await pending;
    const snapshot = await wallet.waitFor((s) => s.requests[0]?.state === "cancelled", 5_000);
    expect(snapshot.requests[0]!.error?.message).toMatch(/stopped waiting/);
  });

  it("expires a request that is not answered in time", async () => {
    const { bridge } = await session({ approvalTimeoutMs: 1_200 }, { decide: () => ({ action: "ignore" }) });
    const response = await call(bridge, "eth_sendTransaction", [{ from: deployer, to: ANVIL_ACCOUNTS[1], value: "0x4" }]);
    expect(response.error?.data?.hatchway).toBe("APPROVAL_TIMEOUT");
    expect(bridge.session.requests[0]?.state).toBe("expired");
  });

  it("recovers a transaction the wallet sent after the page lost track of it", async () => {
    const { bridge, wallet } = await session({}, { decide: () => ({ action: "ignore" }) });
    const pending = call(bridge, "eth_sendTransaction", [{ from: deployer, to: ANVIL_ACCOUNTS[1], value: "0x5" }]);
    const snapshot = await wallet.waitFor((s) => s.requests[0]?.state === "review");
    const request = snapshot.requests[0]!;
    // The page hands the request to the wallet, then reloads before the wallet answers.
    await wallet.post(`requests/${request.id}/begin`, { payloadHash: request.payloadHash, address: deployer, chainId: 31337 });
    const params = request.wallet.method === "eth_sendTransaction" ? request.wallet.params[0] : undefined;
    const sent = await rpc<string>(anvil.url, "eth_sendTransaction", [params]);
    const response = await pending;
    expect(response.result).toBe(sent);
    await wallet.waitFor((s) => s.requests[0]?.state === "confirmed");
  });

  it("reports an on-chain revert and stops the remaining requests", async () => {
    const { bridge } = await session({}, { forceGas: true });
    const faulty = artifact("Faulty");
    const deploy = await call(bridge, "eth_sendTransaction", [{ from: deployer, data: encodeDeployData({ abi: faulty.abi, bytecode: faulty.bytecode.object, args: [false] }) }]);
    const receipt = await anvil.client.waitForTransactionReceipt({ hash: deploy.result as Hex });
    const boom = encodeFunctionData({ abi: parseAbi(["function boom()"]), functionName: "boom" });
    const failing = await call(bridge, "eth_sendTransaction", [{ from: deployer, to: receipt.contractAddress, data: boom }]);
    expect(failing.result).toMatch(/^0x/);
    expect(bridge.session.requests[1]!.review?.simulation.status).toBe("failed");
    expect(bridge.session.requests[1]!.review?.simulation.message).toContain("Boom(42)");
    const next = await call(bridge, "eth_sendTransaction", [{ from: deployer, to: ANVIL_ACCOUNTS[1], value: "0x6" }]);
    expect(next.error?.data?.hatchway).toBe("PREVIOUS_FAILED");
    expect(bridge.session.requests[1]!.state).toBe("reverted");
  });

  it("verifies message signatures against the connected address", async () => {
    const { bridge } = await session();
    const message = toHex("hello from hatchway");
    const response = await call(bridge, "personal_sign", [message, deployer]);
    expect(response.result).toMatch(/^0x[0-9a-f]{130}$/);
    expect(bridge.session.requests[0]!.state).toBe("signed");
    expect(bridge.session.requests[0]!.signatureReview?.content).toBe("hello from hatchway");
  });

  it("expires the whole session at its time limit and fails pending work", async () => {
    const { bridge, wallet } = await session({ ttlMs: 1_500 }, { decide: () => ({ action: "ignore" }) });
    const response = await call(bridge, "eth_sendTransaction", [{ from: deployer, to: ANVIL_ACCOUNTS[1], value: "0x7" }]);
    expect(response.error?.data?.hatchway).toBe("SESSION_EXPIRED");
    expect(bridge.session.state).toBe("expired");
    const claim = await wallet.post("claim", { code: wallet.code }, false);
    expect(claim.status).toBe(410);
  });
});
