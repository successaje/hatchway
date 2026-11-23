import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildForgeArgs,
  checksUnfinishedBroadcasts,
  parseForgeArgs,
  resolveForgeRpc,
  sigFileName,
  unfinishedBroadcast,
} from "../../src/adapters/foundry.js";
import { selectedNetwork } from "../../src/adapters/hardhat.js";

const SENDER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

describe("parseForgeArgs", () => {
  it("finds the script, rpc, broadcast and sender", () => {
    const parsed = parseForgeArgs([
      "script/Deploy.s.sol:Deploy",
      "--rpc-url",
      "sepolia",
      "--broadcast",
      "--sender",
      SENDER,
      "-vvvv",
    ]);
    expect(parsed).toMatchObject({
      script: "script/Deploy.s.sol:Deploy",
      rpc: "sepolia",
      broadcast: true,
      sender: SENDER,
      hasSlow: false,
    });
  });

  it("accepts an optional leading `script` word and --flag=value forms", () => {
    const parsed = parseForgeArgs([
      "script",
      "script/Deploy.s.sol",
      "--fork-url=http://x",
      "--slow",
    ]);
    expect(parsed).toMatchObject({ script: "script/Deploy.s.sol", rpc: "http://x", hasSlow: true });
  });

  it.each([
    "--private-key",
    "--account",
    "--ledger",
    "--trezor",
    "--keystore",
    "--mnemonic",
    "--browser",
    "--aws",
    "-i",
  ])("rejects the conflicting signer %s", (flag) => {
    expect(() => parseForgeArgs(["script/D.s.sol", flag, "x"])).toThrow(/different signer/);
  });

  it("rejects multi-chain broadcasting", () => {
    expect(() => parseForgeArgs(["script/D.s.sol", "--multi"])).toThrow(/Multi-chain/);
  });

  it("notes --sig, --resume and --start-fresh, and passes them through", () => {
    const parsed = parseForgeArgs(["script/D.s.sol", "--sig", "deploy(uint256)", "7", "--resume"]);
    expect(parsed).toMatchObject({ sig: "deploy(uint256)", resume: true, startFresh: false });
    expect(buildForgeArgs(parsed, SENDER)).toEqual(
      expect.arrayContaining(["--sig", "deploy(uint256)", "7", "--resume"]),
    );
    expect(parseForgeArgs(["script/D.s.sol", "-s", "run()", "--start-fresh"])).toMatchObject({
      sig: "run()",
      startFresh: true,
    });
  });
});

describe("forge's unfinished-broadcast check", () => {
  it.each([
    ["1.10.0-stable (083e229 2026-11-10)", true],
    ["1.11.2", true],
    ["2.0.0-nightly", true],
    ["1.9.4", false],
    ["1.6.0-nightly (5e88010 2026-04-27)", false],
    ["unknown", false],
  ])("applies to forge %s: %s", (version, expected) => {
    expect(checksUnfinishedBroadcasts(version)).toBe(expected);
  });

  it.each([
    ["run()", "run"],
    ["deploy(uint256,address)", "deploy"],
    ["0xDEADBEEF0000000000000000000000000000000000000000000000000000000000000001", "deadbeef"],
    ["0xbeef", "0xbeef"],
    ["run", "run"],
  ])("names the records of --sig %s after %s", (sig, name) => {
    expect(sigFileName(sig)).toBe(name);
  });

  const HASH_A = `0x${"a".repeat(64)}`;
  const HASH_B = `0x${"b".repeat(64)}`;

  /** A Foundry layout with the given files under broadcast/ and cache/ for D.s.sol on chain 31337. */
  function project(files: Record<string, unknown>) {
    const root = mkdtempSync(join(tmpdir(), "hatchway-unfinished-"));
    for (const [name, content] of Object.entries(files)) {
      const path = join(root, name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
    }
    const check = (sig?: string) =>
      unfinishedBroadcast({
        broadcastDir: join(root, "broadcast"),
        cacheDir: join(root, "cache"),
        script: "script/D.s.sol:Deploy",
        sig,
        chainId: 31337,
      });
    return { root, check };
  }
  const RECORD = "broadcast/D.s.sol/31337/run-latest.json";
  const SNAPSHOT = "cache/D.s.sol/31337/run-latest.json.recovery.json";
  const sequence = (hashes: (string | null)[], extra: Record<string, unknown> = {}) => ({
    transactions: hashes.map((hash) => ({ hash })),
    receipts: [],
    ...extra,
  });

  it("finds nothing without records", () => {
    expect(project({}).check()).toBeUndefined();
  });

  it("reports a record with a sent transaction that has no receipt", () => {
    const { root, check } = project({ [RECORD]: sequence([HASH_A, HASH_B]) });
    expect(check()).toEqual({ record: join(root, RECORD), transactions: 2, confirmed: 0 });
  });

  it("accepts a record whose transactions all have receipts or reverted", () => {
    const record = sequence([HASH_A, HASH_B], {
      receipts: [{ transactionHash: HASH_A.toUpperCase().replace("0X", "0x") }],
      reverted: [HASH_B],
    });
    expect(project({ [RECORD]: record }).check()).toBeUndefined();
  });

  it("accepts a record of a run that never sent anything, unless it was recovery-aware", () => {
    expect(project({ [RECORD]: sequence([null]) }).check()).toBeUndefined();
    const aware = sequence([null], { recovery_generation: HASH_A });
    expect(project({ [RECORD]: aware }).check()).toMatchObject({ transactions: 1, confirmed: 0 });
  });

  it("prefers the recovery snapshot, where an attempted send counts as submitted", () => {
    const rejected = {
      version: 1,
      deployments: [{ chain: 31337, attempts: [{ kind: "unlocked" }] }],
      data: { kind: "single", sequence: sequence([null]) },
    };
    const complete = sequence([HASH_A], { receipts: [{ transactionHash: HASH_A }] });
    expect(project({ [RECORD]: complete, [SNAPSHOT]: rejected }).check()).toMatchObject({
      transactions: 1,
      confirmed: 0,
    });
    const untried = { ...rejected, deployments: [{ chain: 31337 }] };
    const aware = sequence([null], { recovery_generation: HASH_A });
    expect(project({ [RECORD]: aware, [SNAPSHOT]: untried }).check()).toBeUndefined();
  });

  it("reads multi-chain snapshots", () => {
    const snapshot = {
      deployments: [],
      data: { kind: "multi", sequence: { deployments: [sequence([HASH_A]), sequence([])] } },
    };
    expect(project({ [SNAPSHOT]: snapshot }).check()).toMatchObject({ transactions: 1 });
  });

  it("always reports a pending snapshot, and leaves unreadable files to forge", () => {
    const pending = { data: { kind: "single", sequence: sequence([HASH_A]) } };
    expect(
      project({ "cache/D.s.sol/31337/run-latest.json.recovery.pending": pending }).check(),
    ).toMatchObject({ transactions: 1, confirmed: 0 });
    expect(project({ [SNAPSHOT]: "{not json" }).check()).toBeUndefined();
    expect(project({ [RECORD]: "{not json" }).check()).toBeUndefined();
  });

  it("looks for the records named after --sig", () => {
    const { check } = project({
      "broadcast/D.s.sol/31337/deploy-latest.json": sequence([HASH_A]),
    });
    expect(check()).toBeUndefined();
    expect(check("deploy(uint256)")).toMatchObject({ transactions: 1 });
  });
});

describe("buildForgeArgs", () => {
  it("makes forge an unlocked, slow sender and keeps the bridge URL off the command line", () => {
    const parsed = parseForgeArgs([
      "script/D.s.sol",
      "--rpc-url",
      "https://rpc.example/key",
      "--broadcast",
      "--verify",
    ]);
    const args = buildForgeArgs(parsed, SENDER);
    expect(args).toEqual([
      "script/D.s.sol",
      "--broadcast",
      "--verify",
      "--unlocked",
      "--sender",
      SENDER,
      "--slow",
    ]);
    // The bridge URL (with its token) travels in ETH_RPC_URL instead.
    expect(args.join(" ")).not.toContain("rpc");
  });

  it("removes short, inline and duplicate rpc/sender/unlocked flags", () => {
    const parsed = parseForgeArgs([
      "script/D.s.sol",
      "-r",
      "http://a",
      "--unlocked",
      "--sender",
      SENDER,
      "--slow",
      "--fork-url=http://b",
    ]);
    expect(buildForgeArgs(parsed, SENDER)).toEqual([
      "script/D.s.sol",
      "--slow",
      "--unlocked",
      "--sender",
      SENDER,
    ]);
  });
});

describe("resolveForgeRpc", () => {
  it("uses URLs as-is and falls back to ETH_RPC_URL", async () => {
    expect(await resolveForgeRpc("https://rpc.example", "/nonexistent")).toBe(
      "https://rpc.example",
    );
    expect(
      await resolveForgeRpc(undefined, "/nonexistent", { ETH_RPC_URL: "http://127.0.0.1:8545" }),
    ).toBe("http://127.0.0.1:8545");
  });
});

describe("selectedNetwork", () => {
  it("reads --network or HARDHAT_NETWORK", () => {
    expect(selectedNetwork(["run", "x.ts", "--network", "sepolia"], {})).toBe("sepolia");
    expect(selectedNetwork(["run", "--network=localhost"], {})).toBe("localhost");
    expect(selectedNetwork(["run"], { HARDHAT_NETWORK: "base" })).toBe("base");
    expect(selectedNetwork(["run"], {})).toBeUndefined();
  });
});
