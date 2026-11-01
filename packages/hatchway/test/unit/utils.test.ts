import { describe, expect, it } from "vitest";
import { parseOptions, SESSION_OPTIONS } from "../../src/cli/args.js";
import { coerceArg, parseValue } from "../../src/cli/coerce.js";
import { chainSummary, explorerTxUrl } from "../../src/evm/chains.js";
import { formatAmount, parseDuration, shortHex } from "../../src/evm/format.js";
import { HatchwayError } from "../../src/core/errors.js";
import { isLoopbackUrl, redactUrl, scrubSecrets } from "../../src/util/redact.js";
import { isLoopbackHost } from "../../src/server/security.js";

describe("redactUrl", () => {
  it.each([
    [
      "https://eth-sepolia.g.alchemy.com/v2/abcDEF1234567890xyzKEY",
      "https://eth-sepolia.g.alchemy.com/v2/***",
    ],
    [
      "https://sepolia.infura.io/v3/0123456789abcdef0123456789abcdef",
      "https://sepolia.infura.io/v3/***",
    ],
    ["https://rpc.example/?apikey=secret&x=1", "https://rpc.example/?apikey=***&x=***"],
    ["https://user:pass@rpc.example/", "https://***:***@rpc.example/"],
    ["http://127.0.0.1:8545", "http://127.0.0.1:8545/"],
  ])("%s", (input, output) => {
    expect(redactUrl(input)).toBe(output);
  });

  it("scrubs secrets from free text", () => {
    expect(scrubSecrets("failed: https://x/v2/supersecretkey123", ["supersecretkey123"])).toBe(
      "failed: https://x/v2/***",
    );
  });

  it("recognises credential-free loopback URLs only", () => {
    expect(isLoopbackUrl("http://127.0.0.1:8545")).toBe(true);
    expect(isLoopbackUrl("http://localhost:8545")).toBe(true);
    expect(isLoopbackUrl("http://user:pw@localhost:8545")).toBe(false);
    expect(isLoopbackUrl("http://localhost:8545/?key=1")).toBe(false);
    expect(isLoopbackUrl("https://rpc.example")).toBe(false);
  });
});

describe("isLoopbackHost", () => {
  it.each([
    ["127.0.0.1:5000", true],
    ["localhost:5000", true],
    ["LOCALHOST", true],
    ["[::1]:5000", true],
    ["127.0.0.1.nip.io:5000", false],
    ["attacker.example:5000", false],
    ["localhost.attacker.example", false],
    [undefined, false],
  ])("%s → %s", (host, expected) => {
    expect(isLoopbackHost(host)).toBe(expected);
  });
});

describe("formatting", () => {
  it("formats wei without floating point", () => {
    expect(formatAmount(0n, "ETH")).toBe("0 ETH");
    expect(formatAmount(10n ** 18n, "ETH")).toBe("1 ETH");
    expect(formatAmount(1_234_567_891_234_567_891n, "ETH")).toBe("1.234567 ETH");
    expect(formatAmount(368_370_000_184_185n, "ETH")).toBe("0.000368 ETH");
    expect(formatAmount(42n, "ETH")).toBe("0.000000000000000042 ETH");
    expect(formatAmount(123n * 10n ** 30n, "POL")).toBe("123000000000000 POL");
  });

  it("parses durations", () => {
    expect(parseDuration("90s")).toBe(90_000);
    expect(parseDuration("15m")).toBe(900_000);
    expect(parseDuration("2h")).toBe(7_200_000);
    expect(parseDuration("45")).toBe(45_000);
    expect(parseDuration("soon")).toBeUndefined();
  });

  it("shortens hex", () => {
    expect(shortHex("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266")).toBe("0xf39F…2266");
  });
});

describe("parseOptions", () => {
  it("stops at the first positional so the tool keeps its own flags", () => {
    const { options, rest } = parseOptions(
      ["--no-open", "--port", "9000", "script/Deploy.s.sol", "--json", "--rpc-url", "x"],
      SESSION_OPTIONS,
      { stopAtPositional: true },
    );
    expect(options).toMatchObject({ open: false, port: "9000" });
    expect(options.json).toBeUndefined();
    expect(rest).toEqual(["script/Deploy.s.sol", "--json", "--rpc-url", "x"]);
  });

  it("supports --flag=value and short flags, and rejects unknown flags", () => {
    expect(parseOptions(["--port=1", "-h"], SESSION_OPTIONS).options).toMatchObject({
      port: "1",
      help: true,
    });
    expect(() => parseOptions(["--nope"], SESSION_OPTIONS)).toThrow(HatchwayError);
    expect(() => parseOptions(["--port"], SESSION_OPTIONS)).toThrow(/needs a value/);
  });
});

describe("constructor argument coercion", () => {
  it("coerces scalar types", () => {
    expect(coerceArg({ type: "uint256", name: "n" }, "0x10")).toBe(16n);
    expect(coerceArg({ type: "int8", name: "n" }, "-5")).toBe(-5n);
    expect(coerceArg({ type: "bool", name: "b" }, "true")).toBe(true);
    expect(
      coerceArg({ type: "address", name: "a" }, "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"),
    ).toBe("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
    expect(coerceArg({ type: "string", name: "s" }, "Hatch Token")).toBe("Hatch Token");
    expect(coerceArg({ type: "bytes32", name: "b" }, "0x01")).toBe("0x01");
  });

  it("coerces arrays and tuples from JSON", () => {
    expect(coerceArg({ type: "uint256[]", name: "xs" }, "[1, 2]")).toEqual([1n, 2n]);
    expect(
      coerceArg(
        {
          type: "tuple",
          name: "t",
          components: [
            { name: "a", type: "uint8" },
            { name: "b", type: "bool" },
          ],
        },
        '{"a": 1, "b": false}',
      ),
    ).toEqual({ a: 1n, b: false });
  });

  it("explains invalid input", () => {
    expect(() => coerceArg({ type: "uint256", name: "supply" }, "lots")).toThrow(
      /"supply" \(uint256\) must be an integer/,
    );
    expect(() => coerceArg({ type: "address", name: "owner" }, "me")).toThrow(/must be an address/);
    expect(() => coerceArg({ type: "uint8[2]", name: "pair" }, "[1]")).toThrow(/exactly 2/);
  });

  it("parses values with units", () => {
    expect(parseValue("0.25ether")).toBe(250_000_000_000_000_000n);
    expect(parseValue("1 eth")).toBe(10n ** 18n);
    expect(parseValue("20gwei")).toBe(20_000_000_000n);
    expect(parseValue("123")).toBe(123n);
    expect(() => parseValue("1.5")).toThrow(/whole number/);
    expect(() => parseValue("a lot")).toThrow();
  });
});

describe("chains", () => {
  it("never shares a non-loopback RPC URL with the wallet for local chains", () => {
    expect(chainSummary(31337, "http://127.0.0.1:8545").addChain?.rpcUrls).toEqual([
      "http://127.0.0.1:8545",
    ]);
    expect(chainSummary(31337, "https://private.example/v2/key").addChain).toBeUndefined();
  });

  it("uses public https endpoints, not the developer's, for public chains", () => {
    const base = chainSummary(84532, "https://base-sepolia.g.alchemy.com/v2/SECRETSECRETSECRET");
    expect(base).toMatchObject({ name: "Base Sepolia", testnet: true, local: false });
    expect(
      base.addChain?.rpcUrls.every((u) => u.startsWith("https://") && !u.includes("SECRET")),
    ).toBe(true);
    expect(explorerTxUrl(84532, "0xabc")).toBe("https://sepolia.basescan.org/tx/0xabc");
  });

  it("handles unknown chains", () => {
    expect(chainSummary(987654321)).toMatchObject({ name: "Chain 987654321", nativeSymbol: "ETH" });
  });
});

describe("urlSecrets", () => {
  it("returns only the sensitive parts of a URL", async () => {
    const { urlSecrets } = await import("../../src/util/redact.js");
    expect(urlSecrets("http://127.0.0.1:8545")).toEqual([]);
    expect(urlSecrets("https://eth.g.alchemy.com/v2/abcDEF1234567890xyzKEY")).toEqual([
      "abcDEF1234567890xyzKEY",
    ]);
    expect(urlSecrets("https://u:p4ssword@rpc.example/?apikey=k3y")).toEqual([
      "u",
      "p4ssword",
      "k3y",
    ]);
  });
});

describe("hardening helpers", () => {
  it("redacts JWT-style, short mixed and subdomain keys", async () => {
    const { redactUrl, sanitizeCommand } = await import("../../src/util/redact.js");
    expect(redactUrl("https://rpc.example/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOjF9.c2lnbmF0dXJl")).toBe(
      "https://rpc.example/***",
    );
    expect(redactUrl("https://rpc.example/v1/k3yk3yk3y123")).toBe("https://rpc.example/v1/***");
    expect(redactUrl("https://a1b2c3d4e5f6g7h8.quiknode.pro/")).toBe("https://***.quiknode.pro/");
    expect(redactUrl("https://base-sepolia.public.example/")).toBe(
      "https://base-sepolia.public.example/",
    );
    expect(
      sanitizeCommand(
        [
          "hatchway",
          "forge",
          "s.sol",
          "--rpc-url",
          "https://x.example/v2/abcDEF1234567890xyzKEY",
          "--etherscan-api-key",
          "SECRETKEY",
          "--verifier-url=https://api.example/?apikey=K",
        ],
        [],
      ),
    ).toBe(
      "hatchway forge s.sol --rpc-url https://x.example/v2/*** --etherscan-api-key *** --verifier-url=***",
    );
  });

  it("strips terminal control sequences from untrusted text", async () => {
    const { clean } = await import("../../src/cli/output.js");
    expect(clean("revert \u001b]52;c;cm0gLXJm\u0007 \u001b[2Kdone\r")).toBe(
      "revert ]52;c;cm0gLXJm [2Kdone",
    );
    expect(clean("tab\tok")).toBe("tab\tok");
  });

  it("only forwards read namespaces", async () => {
    const { isForwardable } = await import("../../src/server/rpc-handler.js");
    for (const ok of [
      "eth_call",
      "eth_getBlockByNumber",
      "net_version",
      "web3_clientVersion",
      "debug_traceTransaction",
      "trace_block",
    ]) {
      expect(isForwardable(ok), ok).toBe(true);
    }
    for (const no of [
      "eth_sendRawTransactionSync",
      "Eth_call",
      "personal_sign",
      "anvil_mine",
      "admin_peers",
      "eth_submitWork",
    ]) {
      expect(isForwardable(no), no).toBe(false);
    }
  });

  it("gives retries the verified answer only", async () => {
    const { awaitRequest } = await import("../../src/server/rpc-handler.js");
    const { ApprovalRequest } = await import("../../src/core/request.js");
    const request = new ApprovalRequest(1, {
      kind: "transaction",
      tx: normalizeTransactionForTest(),
    });
    request.state = "submitted";
    request.result = { hash: "0xabc" };
    let settled = false;
    const engine = { attachCaller: () => () => undefined };
    const pending = awaitRequest(engine, request, new AbortController().signal).then((hash) => {
      settled = true;
      return hash;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false); // hash exists, but verification has not finished
    request.completion.resolve("0xabc");
    await expect(pending).resolves.toBe("0xabc");
  });
});

function normalizeTransactionForTest() {
  return {
    from: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const,
    value: 0n,
    data: "0x01" as const,
  };
}
