import { describe, expect, it } from "vitest";
import {
  dedupeKey,
  findIntegrityMismatches,
  hashPayload,
  normalizeTransaction,
  toWalletTransaction,
} from "../../src/evm/tx.js";

const FROM = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const TO = "0x5fbdb2315678afecb367f032d93f642f64180aa3";

describe("normalizeTransaction", () => {
  it("accepts what forge --unlocked sends (input, to: null, type 2, nonce, chainId)", () => {
    const tx = normalizeTransaction({
      from: FROM,
      to: null,
      maxFeePerGas: "0x77359401",
      maxPriorityFeePerGas: "0x1",
      gas: "0x2cf79",
      value: "0x0",
      input: "0x6080",
      nonce: "0x2",
      chainId: "0x7a69",
      type: "0x2",
    });
    expect(tx).toEqual({
      from: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      value: 0n,
      data: "0x6080",
      gas: 0x2cf79n,
      nonce: 2,
      maxFeePerGas: 0x77359401n,
      maxPriorityFeePerGas: 1n,
      chainId: 31337,
    });
    expect(tx.to).toBeUndefined();
  });

  it("accepts ethers/viem style requests with data and gasLimit", () => {
    const tx = normalizeTransaction({
      from: FROM,
      to: TO,
      data: "0xabcd",
      gasLimit: "0x5208",
      value: "0x10",
    });
    expect(tx).toMatchObject({
      to: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
      data: "0xabcd",
      gas: 21000n,
      value: 16n,
    });
  });

  it.each([
    [{ from: FROM, to: TO, authorizationList: [{}] }, /7702/],
    [{ from: FROM, to: TO, type: "0x4" }, /7702/],
    [{ from: FROM, to: TO, blobVersionedHashes: ["0x01"] }, /blob/],
    [{ from: FROM, to: TO, type: "0x3" }, /blob/],
    [{ from: FROM, to: TO, accessList: [{ address: TO, storageKeys: [] }] }, /access list/],
  ])("rejects unsupported transaction kinds %#", (input, message) => {
    expect(() => normalizeTransaction(input)).toThrow(message);
  });

  it.each([
    [{ to: TO }, /from/],
    [{ from: "0x123", to: TO }, /from/],
    [{ from: FROM, to: "0xnope" }, /to/],
    [{ from: FROM, to: TO, value: "10" }, /hex quantity/],
    [{ from: FROM, to: TO, data: "0x123" }, /even-length/],
    [{ from: FROM, to: TO, gasPrice: "0x1", maxFeePerGas: "0x1" }, /both gasPrice/],
    [{ from: FROM, to: TO, maxFeePerGas: "0x1", maxPriorityFeePerGas: "0x2" }, /exceed/],
    [{ from: FROM, to: TO, data: "0x01", input: "0x02" }, /different values/],
    [{ from: FROM }, /no bytecode/],
    [{ from: FROM, to: TO, surprise: 1 }, /unsupported transaction field/],
    [{ from: FROM, to: TO, value: `0x1${"0".repeat(64)}` }, /out of range/],
    ["not an object", /object/],
  ])("rejects malformed input %#", (input, message) => {
    expect(() => normalizeTransaction(input)).toThrow(message);
  });
});

describe("wallet payload", () => {
  it("pins the chain id and uses data, never input", () => {
    const tx = normalizeTransaction({ from: FROM, to: TO, input: "0xab", nonce: "0x5" });
    expect(toWalletTransaction(tx, 8453)).toEqual({
      from: tx.from,
      to: tx.to,
      value: "0x0",
      data: "0xab",
      nonce: "0x5",
      chainId: "0x2105",
    });
  });

  it("hashes payloads independent of key order", () => {
    expect(hashPayload({ a: 1, b: [1, { c: 2, d: 3 }] })).toBe(
      hashPayload({ b: [1, { d: 3, c: 2 }], a: 1 }),
    );
  });
});

describe("dedupeKey", () => {
  it("identifies retries of the same nonce-pinned transaction", () => {
    const a = normalizeTransaction({ from: FROM, to: TO, data: "0x01", nonce: "0x1", gas: "0x1" });
    const b = normalizeTransaction({
      from: FROM.toUpperCase().replace("0X", "0x"),
      to: TO,
      data: "0x01",
      nonce: "0x1",
      gas: "0x2",
    });
    expect(dedupeKey(a)).toBe(dedupeKey(b));
  });

  it("never merges transactions without a nonce", () => {
    expect(dedupeKey(normalizeTransaction({ from: FROM, to: TO }))).toBeUndefined();
  });
});

describe("findIntegrityMismatches", () => {
  const expected = normalizeTransaction({
    from: FROM,
    to: TO,
    data: "0x01",
    value: "0x1",
    nonce: "0x3",
  });
  const actual = { from: FROM, to: TO, input: "0x01", value: 1n, nonce: 3, chainId: 1 };

  it("accepts a matching broadcast even if gas fields changed", () => {
    expect(findIntegrityMismatches(expected, 1, actual)).toEqual([]);
  });

  it("flags every field that changes what the transaction does", () => {
    const problems = findIntegrityMismatches(expected, 1, {
      from: TO,
      to: FROM,
      input: "0x02",
      value: 2n,
      nonce: 4,
      chainId: 5,
    });
    expect(problems).toHaveLength(6);
  });

  it("treats creation vs call as a destination mismatch", () => {
    expect(findIntegrityMismatches(expected, 1, { ...actual, to: null })[0]).toMatch(
      /contract creation/,
    );
  });
});

describe("integrity hardening", () => {
  const expected = normalizeTransaction({ from: FROM, to: TO, data: "0x01" });
  const actual = { from: FROM, to: TO, input: "0x01", value: 0n, nonce: 5, chainId: 1 };

  it("rejects an older transaction with the same contents when the request had no nonce", () => {
    expect(findIntegrityMismatches(expected, 1, { ...actual, nonce: 2 }, 5)[0]).toMatch(
      /below the account's next nonce 5/,
    );
    expect(findIntegrityMismatches(expected, 1, { ...actual, nonce: 7 }, 5)).toEqual([]);
  });

  it("rejects broadcasts without replay protection or with EIP-7702 authorizations", () => {
    expect(findIntegrityMismatches(expected, 1, { ...actual, chainId: undefined })[0]).toMatch(
      /replay-protected/,
    );
    expect(findIntegrityMismatches(expected, 1, { ...actual, type: "eip7702" })[0]).toMatch(/7702/);
    expect(
      findIntegrityMismatches(expected, 1, { ...actual, hasAuthorizationList: true })[0],
    ).toMatch(/7702/);
  });
});
