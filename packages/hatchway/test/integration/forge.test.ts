import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAddress, parseAbi, type Address } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ANVIL_ACCOUNTS, rpc, startAnvil, type Anvil } from "../helpers/anvil.js";
import { FOUNDRY_EXAMPLE, runCli, type CliEvent } from "../helpers/cli.js";
import { HeadlessWallet, type Decision } from "../helpers/headless-wallet.js";
import type { RequestView } from "../../src/core/protocol.js";

let anvil: Anvil;
const deployer = ANVIL_ACCOUNTS[0];

beforeAll(async () => {
  execFileSync("forge", ["build"], { cwd: FOUNDRY_EXAMPLE, stdio: "ignore" });
  anvil = await startAnvil();
});

afterAll(async () => {
  await anvil?.stop();
});

interface ForgeRun {
  code: number;
  result: CliEvent;
  wallet: HeadlessWallet;
  events: CliEvent[];
  stderr: string;
}

async function forge(
  script: string,
  opts: {
    decide?: (r: RequestView) => Decision;
    ignoreNonce?: boolean;
    chainId?: number;
    extra?: string[];
    env?: NodeJS.ProcessEnv;
    onWallet?: (w: HeadlessWallet) => Promise<void>;
  } = {},
): Promise<ForgeRun> {
  const run = runCli(
    [
      "forge",
      "--json",
      "--no-open",
      script,
      "--rpc-url",
      anvil.url,
      "--broadcast",
      ...(opts.extra ?? []),
    ],
    { cwd: FOUNDRY_EXAMPLE, ...(opts.env ? { env: opts.env } : {}) },
  );
  const url = await run.sessionUrl;
  const wallet = await HeadlessWallet.open({
    sessionUrl: url,
    nodeUrl: anvil.url,
    address: deployer,
    ...(opts.decide ? { decide: opts.decide } : {}),
    ...(opts.ignoreNonce ? { ignoreNonce: true } : {}),
    ...(opts.chainId ? { chainId: opts.chainId } : {}),
  });
  if (opts.onWallet) await opts.onWallet(wallet);
  const code = await run.exited;
  wallet.close();
  const result = run.result();
  if (!result) throw new Error(`no result event; stderr:\n${run.stderr()}`);
  return { code, result, wallet, events: run.events, stderr: run.stderr() };
}

function transactions(result: CliEvent) {
  return result.transactions as {
    title: string;
    state: string;
    hash?: string;
    contractAddress?: string;
    contractName?: string;
  }[];
}

describe("hatchway forge (Foundry, real forge + anvil)", () => {
  it("deploys a contract and reports address, receipt and run record", async () => {
    const run = await forge("script/DeployCounter.s.sol");
    expect(run.code, run.stderr).toBe(0);
    const [tx] = transactions(run.result);
    expect(tx).toMatchObject({
      state: "confirmed",
      contractName: "Counter",
      title: "Deploy Counter",
    });
    const address = tx!.contractAddress as Address;
    expect(await anvil.client.getCode({ address })).toMatch(/^0x[0-9a-f]{10,}/);
    const receipt = await anvil.client.getTransactionReceipt({ hash: tx!.hash as `0x${string}` });
    expect(receipt.status).toBe("success");
    expect(getAddress(receipt.from)).toBe(deployer);
    expect(receipt.contractAddress && getAddress(receipt.contractAddress)).toBe(address);
    const record = run.result.runRecord as string;
    expect(existsSync(join(FOUNDRY_EXAMPLE, record))).toBe(true);
    const saved = JSON.parse(readFileSync(join(FOUNDRY_EXAMPLE, record), "utf8")) as {
      transactions: { hash: string }[];
    };
    expect(saved.transactions[0]!.hash).toBe(tx!.hash);
    expect(run.result.broadcastFile).toBeTruthy();
  });

  it("decodes and applies constructor arguments", async () => {
    let seen: RequestView | undefined;
    const run = await forge("script/DeployToken.s.sol", {
      decide: (request) => {
        seen = request;
        return { action: "approve" };
      },
    });
    expect(run.code, run.stderr).toBe(0);
    expect(seen?.review?.contractName).toBe("HatchToken");
    expect(seen?.review?.constructorArgs?.map((a) => a.value)).toEqual([
      '"Hatch Token"',
      '"HATCH"',
      "1000000000000000000000000",
    ]);
    expect(seen?.review?.simulation.status).toBe("passed");
    expect(seen?.review?.predictedAddress).toBe(transactions(run.result)[0]!.contractAddress);
    const token = transactions(run.result)[0]!.contractAddress as Address;
    const abi = parseAbi([
      "function symbol() view returns (string)",
      "function balanceOf(address) view returns (uint256)",
    ]);
    expect(await anvil.client.readContract({ address: token, abi, functionName: "symbol" })).toBe(
      "HATCH",
    );
    expect(
      await anvil.client.readContract({
        address: token,
        abi,
        functionName: "balanceOf",
        args: [deployer],
      }),
    ).toBe(10n ** 24n);
  });

  it("runs a multi-transaction script one approval at a time, in nonce order", async () => {
    const reviewed: string[] = [];
    const run = await forge("script/DeploySystem.s.sol", {
      decide: (request) => {
        reviewed.push(request.review!.title);
        return { action: "approve" };
      },
    });
    expect(run.code, run.stderr).toBe(0);
    expect(reviewed).toEqual([
      "Deploy HatchToken",
      "Deploy Registry",
      "Registry.initialize",
      "Registry.register",
      "Registry.transferOwnership",
    ]);
    const txs = transactions(run.result);
    expect(txs.every((t) => t.state === "confirmed")).toBe(true);
    const registry = txs[1]!.contractAddress as Address;
    const abi = parseAbi([
      "function owner() view returns (address)",
      "function token() view returns (address)",
      "function initialized() view returns (bool)",
    ]);
    expect(await anvil.client.readContract({ address: registry, abi, functionName: "owner" })).toBe(
      "0x000000000000000000000000000000000000bEEF",
    );
    expect(await anvil.client.readContract({ address: registry, abi, functionName: "token" })).toBe(
      txs[0]!.contractAddress,
    );
    expect(
      await anvil.client.readContract({ address: registry, abi, functionName: "initialized" }),
    ).toBe(true);
  });

  it("deploys an initialized proxy and calls through it", async () => {
    const run = await forge("script/DeployProxy.s.sol");
    expect(run.code, run.stderr).toBe(0);
    const txs = transactions(run.result);
    expect(txs.map((t) => t.title)).toEqual([
      "Deploy BoxV1",
      "Deploy ERC1967Proxy",
      "BoxV1.setValue",
    ]);
    const proxy = txs[1]!.contractAddress as Address;
    const abi = parseAbi([
      "function value() view returns (uint256)",
      "function admin() view returns (address)",
    ]);
    expect(await anvil.client.readContract({ address: proxy, abi, functionName: "value" })).toBe(
      43n,
    );
    expect(await anvil.client.readContract({ address: proxy, abi, functionName: "admin" })).toBe(
      deployer,
    );
  });

  it("propagates a revert found during forge's simulation without asking the wallet", async () => {
    const run = await forge("script/Fails.s.sol");
    expect(run.code).not.toBe(0);
    expect(transactions(run.result)).toHaveLength(0);
    expect(run.result.error).toMatchObject({ code: "TOOL_FAILED" });
  });

  it("stops on rejection, answers forge's retries without re-prompting, and sends nothing", async () => {
    const nonceBefore = await anvil.client.getTransactionCount({ address: deployer });
    const run = await forge("script/DeployCounter.s.sol", { decide: () => ({ action: "reject" }) });
    expect(run.code).toBe(3);
    expect(run.result.error).toMatchObject({ code: "USER_REJECTED" });
    // forge retries a failed send up to 4 times; each retry must get the same answer.
    expect(transactions(run.result)).toHaveLength(1);
    expect(run.wallet.log.filter((l) => l.endsWith(":reject"))).toHaveLength(1);
    expect(await anvil.client.getTransactionCount({ address: deployer })).toBe(nonceBefore);
  });

  it("waits while the wallet is on the wrong network, then continues after switching", async () => {
    const run = await forge("script/DeployCounter.s.sol", {
      chainId: 1,
      onWallet: async (wallet) => {
        await wallet.waitFor((s) => s.walletIssue === "wrong_chain");
        expect(wallet.snapshot!.requests.every((r) => r.state === "queued")).toBe(true);
        await wallet.switchChain(31337);
      },
    });
    expect(run.code, run.stderr).toBe(0);
    expect(run.events.some((e) => e.event === "wallet_issue" && e.issue === "wrong_chain")).toBe(
      true,
    );
  });

  it("works with a wallet that ignores the requested nonce (MetaMask behaviour)", async () => {
    const run = await forge("script/DeployToken.s.sol", { ignoreNonce: true });
    expect(run.code, run.stderr).toBe(0);
  });

  it("detects a wallet that broadcasts something other than what was approved", async () => {
    const run = await forge("script/DeployCounter.s.sol", { decide: () => ({ action: "tamper" }) });
    expect(run.code).toBe(9);
    expect(run.result.error).toMatchObject({ code: "INTEGRITY_MISMATCH" });
  });

  it("rejects conflicting signer flags before starting a session", async () => {
    const run = runCli(
      [
        "forge",
        "--json",
        "--no-open",
        "script/DeployCounter.s.sol",
        "--rpc-url",
        anvil.url,
        "--broadcast",
        "--private-key",
        "0x01",
      ],
      { cwd: FOUNDRY_EXAMPLE },
    );
    expect(await run.exited).toBe(2);
    expect(run.result()?.error).toMatchObject({ code: "UNSUPPORTED_SIGNER" });
    expect(run.events.some((e) => e.event === "session")).toBe(false);
  });

  it("stops forge and closes the session on Ctrl+C without leaving processes behind", async () => {
    const run = runCli(
      [
        "forge",
        "--json",
        "--no-open",
        "script/DeployCounter.s.sol",
        "--rpc-url",
        anvil.url,
        "--broadcast",
      ],
      { cwd: FOUNDRY_EXAMPLE },
    );
    const wallet = await HeadlessWallet.open({
      sessionUrl: await run.sessionUrl,
      nodeUrl: anvil.url,
      address: deployer,
      decide: () => ({ action: "ignore" }),
    });
    await wallet.waitFor((s) => s.requests.some((r) => r.state === "review"));
    const forgePids = execFileSync("pgrep", ["-P", String(run.child.pid)])
      .toString()
      .trim()
      .split("\n")
      .filter(Boolean);
    expect(forgePids.length).toBeGreaterThan(0);
    run.child.kill("SIGINT");
    const code = await run.exited;
    wallet.close();
    expect(code).toBe(130);
    expect(wallet.snapshot?.state).toBe("cancelled");
    for (const pid of forgePids) {
      expect(() => process.kill(Number(pid), 0)).toThrow();
    }
  });

  it("stops when another transaction from the same wallet takes the nonce forge planned with", async () => {
    const run = await forge("script/DeployCounter.s.sol", {
      ignoreNonce: true,
      decide: () => ({
        action: "approve",
        // Simulates the user sending something else from this account mid-session.
        before: async () => {
          await rpc(anvil.url, "eth_sendTransaction", [
            { from: deployer, to: ANVIL_ACCOUNTS[1], value: "0x1" },
          ]);
        },
      }),
    });
    expect(run.code).toBe(9);
    expect(run.result.error).toMatchObject({ code: "INTEGRITY_MISMATCH" });
    expect(String((run.result.error as { message: string }).message)).toMatch(
      /nonce is \d+, expected \d+/,
    );
  });
});
