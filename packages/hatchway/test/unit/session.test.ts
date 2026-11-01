import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HatchwayError } from "../../src/core/errors.js";
import { Session, type SessionEvent } from "../../src/core/session.js";
import { normalizeTransaction } from "../../src/evm/tx.js";

const A = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const B = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

function make(overrides: Partial<ConstructorParameters<typeof Session>[0]> = {}) {
  const session = new Session({
    purpose: { kind: "forge", title: "t" },
    ttlMs: 60_000,
    connectTimeoutMs: 30_000,
    approvalTimeoutMs: 10_000,
    ...overrides,
  });
  const events: SessionEvent[] = [];
  session.on("event", (e) => events.push(e));
  return { session, events };
}

describe("Session", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("moves through pairing, wallet binding and ready", () => {
    const { session, events } = make();
    session.setChain(31337);
    expect(session.state).toBe("waiting_for_browser");
    const token = session.claim(session.pairingCode!);
    expect(session.state).toBe("waiting_for_wallet");
    expect(session.authenticate(token)).toBe(true);
    session.updateWallet({ address: A.toLowerCase(), chainId: 31337, name: "MetaMask" });
    expect(session.state).toBe("ready");
    expect(session.wallet?.address).toBe(A);
    expect(session.walletReady).toBe(true);
    expect(session.pairingCode).toBeUndefined();
    expect(events.map((e) => e.type)).toContain("wallet_connected");
  });

  it("does not bind an account other than the expected one", () => {
    const { session } = make({ expectedAddress: A });
    session.setChain(1);
    session.claim(session.pairingCode!);
    session.updateWallet({ address: B, chainId: 1, name: "Rabby" });
    expect(session.wallet).toBeUndefined();
    expect(session.walletIssue).toBe("wrong_account");
    session.updateWallet({ address: A, chainId: 1, name: "Rabby" });
    expect(session.wallet?.address).toBe(A);
    expect(session.walletIssue).toBeUndefined();
  });

  it("flags wrong chain and account changes after binding, and recovers", () => {
    const { session, events } = make();
    session.setChain(84532);
    session.claim(session.pairingCode!);
    session.updateWallet({ address: A, chainId: 1, name: "MetaMask" });
    expect(session.walletIssue).toBe("wrong_chain");
    expect(session.walletReady).toBe(false);
    session.updateWallet({ address: A, chainId: 84532, name: "MetaMask" });
    expect(session.walletReady).toBe(true);
    session.updateWallet({ address: B, chainId: 84532, name: "MetaMask" });
    expect(session.walletIssue).toBe("wrong_account");
    expect(session.wallet?.address).toBe(A);
    session.updateWallet({ address: "", chainId: 84532, name: "MetaMask" });
    expect(session.walletIssue).toBe("disconnected");
    session.updateWallet({ address: A, chainId: 84532, name: "MetaMask" });
    expect(events.filter((e) => e.type === "wallet_issue_resolved").length).toBeGreaterThanOrEqual(
      2,
    );
  });

  it("rejects invalid pairing codes and reuse after the wallet is bound", () => {
    const { session } = make();
    const code = session.pairingCode!;
    expect(() => session.claim("wrong")).toThrow(HatchwayError);
    session.claim(code);
    session.updateWallet({ address: A, chainId: 1, name: "x" });
    expect(() => session.claim(code)).toThrow(/already been used/);
    const fresh = session.rotatePairingCode();
    expect(session.claim(fresh)).toBeTruthy();
  });

  it("expires when no wallet connects in time", () => {
    const { session } = make({ connectTimeoutMs: 1_000 });
    vi.advanceTimersByTime(1_001);
    expect(session.state).toBe("expired");
    expect(session.endedReason).toMatch(/No wallet/);
  });

  it("expires at its time limit and fails queued requests", async () => {
    const { session } = make({ ttlMs: 5_000 });
    session.claim(session.pairingCode!);
    session.updateWallet({ address: A, chainId: 1, name: "x" });
    const request = session.enqueueTransaction(normalizeTransaction({ from: A, to: B }));
    vi.advanceTimersByTime(5_001);
    expect(session.state).toBe("expired");
    expect(request.state).toBe("expired");
    await expect(request.completion.promise).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
    expect(() => session.enqueueTransaction(normalizeTransaction({ from: A, to: B }))).toThrow(
      /time limit/,
    );
  });

  it("deduplicates retries of the same nonce-pinned transaction", () => {
    const { session } = make();
    const tx = normalizeTransaction({ from: A, to: B, nonce: "0x1", data: "0x01" });
    const first = session.enqueueTransaction(tx);
    expect(session.enqueueTransaction({ ...tx })).toBe(first);
    expect(session.requests).toHaveLength(1);
  });

  it("produces snapshots without secrets", () => {
    const { session } = make();
    const token = session.claim(session.pairingCode!);
    const json = JSON.stringify(session.snapshot());
    expect(json).not.toContain(token);
    expect(json).not.toContain(session.pairingCode ?? "never");
  });
});
