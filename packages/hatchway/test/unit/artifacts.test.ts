import { encodeAbiParameters, encodeFunctionData, parseAbi, type Abi } from "viem";
import { describe, expect, it } from "vitest";
import {
  ArtifactIndex,
  decodeCall,
  decodeConstructorArgs,
  formatAbiValue,
} from "../../src/evm/artifacts.js";

const tokenAbi = parseAbi([
  "constructor(string name, string symbol, uint256 supply)",
  "function transfer(address to, uint256 value) returns (bool)",
]) as Abi;
const counterAbi = parseAbi(["function setNumber(uint256 newNumber)"]) as Abi;

const index = new ArtifactIndex([
  {
    name: "HatchToken",
    sourcePath: "src/HatchToken.sol",
    abi: tokenAbi,
    bytecode: "6080604052aaaa",
  },
  { name: "HatchTokenLong", sourcePath: "src/X.sol", abi: [], bytecode: "6080604052aaaabbbb" },
  { name: "Linked", sourcePath: "src/L.sol", abi: [], bytecode: `6080__$${"ab".repeat(17)}$__ff` },
  { name: "Counter", sourcePath: "src/Counter.sol", abi: counterAbi, bytecode: "6080cccc" },
]);

describe("ArtifactIndex", () => {
  it("matches creation bytecode and separates constructor arguments", () => {
    const args = encodeAbiParameters(
      [{ type: "string" }, { type: "string" }, { type: "uint256" }],
      ["Hatch", "HATCH", 5n],
    );
    const match = index.matchCreation(`0x6080604052aaaa${args.slice(2)}`);
    expect(match?.entry.name).toBe("HatchToken");
    expect(
      decodeConstructorArgs(match!.entry.abi, match!.argsData)?.map((a) => `${a.name}=${a.value}`),
    ).toEqual(['name="Hatch"', 'symbol="HATCH"', "supply=5"]);
  });

  it("prefers the longest matching artifact", () => {
    expect(index.matchCreation("0x6080604052aaaabbbb00")?.entry.name).toBe("HatchTokenLong");
  });

  it("treats library placeholders as wildcards", () => {
    expect(index.matchCreation(`0x6080${"12".repeat(20)}ff`)?.entry.name).toBe("Linked");
    expect(index.matchCreation(`0x6081${"12".repeat(20)}ff`)).toBeUndefined();
  });

  it("finds functions by selector across artifacts", () => {
    const data = encodeFunctionData({ abi: counterAbi, functionName: "setNumber", args: [7n] });
    const [found] = index.functionsForSelector(data.slice(0, 10));
    expect(found?.entry.name).toBe("Counter");
    expect(decodeCall(counterAbi, data)).toEqual({
      signature: "setNumber(uint256)",
      functionName: "setNumber",
      args: [{ name: "newNumber", type: "uint256", value: "7" }],
    });
  });

  it("adds the text held in bytes32 arguments", () => {
    const abi = parseAbi(["function register(bytes32 key, address value)"]);
    const value = "0x58E5eB88156641DCC2c9ddB22F75A19ee0bbbfdd";
    const key = `0x746f6b656e${"0".repeat(54)}` as const;
    expect(decodeCall(abi, encodeFunctionData({ abi, args: [key, value] }))?.args).toEqual([
      { name: "key", type: "bytes32", value: key, text: "token" },
      { name: "value", type: "address", value },
    ]);
    const hash = `0x${"9f".repeat(32)}` as const;
    expect(decodeCall(abi, encodeFunctionData({ abi, args: [hash, value] }))?.args[0]).toEqual({
      name: "key",
      type: "bytes32",
      value: hash,
    });
  });

  it("formats decoded values readably", () => {
    expect(
      formatAbiValue([1n, "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266", true, { a: "x" }]),
    ).toBe('[1, 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266, true, { a: "x" }]');
  });
});
