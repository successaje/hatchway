import { describe, expect, it } from "vitest";
import { buildForgeArgs, parseForgeArgs, resolveForgeRpc } from "../../src/adapters/foundry.js";
import { selectedNetwork } from "../../src/adapters/hardhat.js";

const BRIDGE = "http://127.0.0.1:5555/rpc/token";
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
});

describe("buildForgeArgs", () => {
  it("points forge at the bridge as an unlocked, slow sender", () => {
    const parsed = parseForgeArgs([
      "script/D.s.sol",
      "--rpc-url",
      "https://rpc.example/key",
      "--broadcast",
      "--verify",
    ]);
    expect(buildForgeArgs(parsed, BRIDGE, SENDER)).toEqual([
      "script/D.s.sol",
      "--rpc-url",
      BRIDGE,
      "--broadcast",
      "--verify",
      "--unlocked",
      "--sender",
      SENDER,
      "--slow",
    ]);
  });

  it("replaces inline and short rpc flags and drops duplicate sender/unlocked flags", () => {
    const parsed = parseForgeArgs([
      "script/D.s.sol",
      "-r",
      "http://a",
      "--unlocked",
      "--sender",
      SENDER,
      "--slow",
    ]);
    expect(buildForgeArgs(parsed, BRIDGE, SENDER)).toEqual([
      "script/D.s.sol",
      "--rpc-url",
      BRIDGE,
      "--slow",
      "--unlocked",
      "--sender",
      SENDER,
    ]);
    const inline = parseForgeArgs(["script/D.s.sol", "--rpc-url=http://a"]);
    expect(buildForgeArgs(inline, BRIDGE, SENDER)).toEqual([
      "script/D.s.sol",
      "--rpc-url",
      BRIDGE,
      "--unlocked",
      "--sender",
      SENDER,
      "--slow",
    ]);
  });

  it("adds --rpc-url when the user relied on ETH_RPC_URL", () => {
    const parsed = parseForgeArgs(["script/D.s.sol", "--broadcast"]);
    expect(buildForgeArgs(parsed, BRIDGE, SENDER)).toContain(BRIDGE);
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
