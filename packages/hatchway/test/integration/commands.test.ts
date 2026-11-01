import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { createWalletClient, http, parseAbi, parseEther, type Address } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ANVIL_ACCOUNTS, startAnvil, type Anvil } from "../helpers/anvil.js";
import { BIN, FOUNDRY_EXAMPLE, runCli, type CliEvent } from "../helpers/cli.js";
import { HeadlessWallet, type HeadlessWalletOptions } from "../helpers/headless-wallet.js";

let anvil: Anvil;
const deployer = ANVIL_ACCOUNTS[0];

beforeAll(async () => {
  execFileSync("forge", ["build"], { cwd: FOUNDRY_EXAMPLE, stdio: "ignore" });
  anvil = await startAnvil();
});

afterAll(async () => {
  await anvil?.stop();
});

async function deploy(args: string[], walletOptions: Partial<HeadlessWalletOptions> = {}) {
  const run = runCli(["deploy", "--json", "--no-open", "--no-build", "--rpc-url", anvil.url, ...args], { cwd: FOUNDRY_EXAMPLE });
  const url = await Promise.race([run.sessionUrl, run.exited.then(() => undefined)]);
  const wallet = url ? await HeadlessWallet.open({ sessionUrl: url, nodeUrl: anvil.url, address: deployer, ...walletOptions }) : undefined;
  const code = await run.exited;
  wallet?.close();
  return { code, result: run.result()!, stderr: run.stderr() };
}

const txs = (result: CliEvent) => result.transactions as { state: string; contractAddress?: string; hash?: string }[];

describe("hatchway deploy", () => {
  it("deploys a compiled contract with typed constructor arguments", async () => {
    const run = await deploy(["HatchToken", "--args", "Hatch Token", "HATCH", "5000"]);
    expect(run.code, run.stderr).toBe(0);
    const token = txs(run.result)[0]!.contractAddress as Address;
    const abi = parseAbi(["function name() view returns (string)", "function totalSupply() view returns (uint256)"]);
    expect(await anvil.client.readContract({ address: token, abi, functionName: "name" })).toBe("Hatch Token");
    expect(await anvil.client.readContract({ address: token, abi, functionName: "totalSupply" })).toBe(5000n);
  });

  it("sends native value with the deployment", async () => {
    const box = await deploy(["BoxV1"]);
    const implementation = txs(box.result)[0]!.contractAddress!;
    const run = await deploy(["ERC1967Proxy", "--value", "0.25ether", "--args", implementation, "0x"]);
    expect(run.code, run.stderr).toBe(0);
    const proxy = txs(run.result)[0]!.contractAddress as Address;
    expect(await anvil.client.getBalance({ address: proxy })).toBe(parseEther("0.25"));
  });

  it("reports an on-chain revert with exit code 8", async () => {
    const run = await deploy(["Faulty", "--args", "true"], { forceGas: true });
    expect(run.code).toBe(8);
    expect(run.result.error).toMatchObject({ code: "TRANSACTION_REVERTED" });
    expect(txs(run.result)[0]!.state).toBe("reverted");
  });

  it("validates the contract name and argument count before opening a session", async () => {
    const unknown = await deploy(["NoSuchContract"]);
    expect(unknown.code).toBe(2);
    expect(unknown.result.error).toMatchObject({ code: "ARTIFACT_NOT_FOUND" });
    const wrongArgs = await deploy(["HatchToken", "--args", "only-one"]);
    expect(wrongArgs.code).toBe(2);
    expect(String((wrongArgs.result.error as { message: string }).message)).toContain("takes 3 constructor argument");
  });

  it("requires --from to match the connected wallet", async () => {
    const run = runCli(["deploy", "--json", "--no-open", "--no-build", "--rpc-url", anvil.url, "--from", ANVIL_ACCOUNTS[1], "--session-timeout", "1m", "Counter"], { cwd: FOUNDRY_EXAMPLE });
    const wallet = await HeadlessWallet.open({ sessionUrl: await run.sessionUrl, nodeUrl: anvil.url, address: deployer });
    await run.waitForEvent("wallet_issue", (e) => e.issue === "wrong_account");
    await wallet.switchAccount(ANVIL_ACCOUNTS[1]);
    expect(await run.exited).toBe(0);
    wallet.close();
    const receipt = await anvil.client.getTransactionReceipt({ hash: txs(run.result()!)[0]!.hash as `0x${string}` });
    expect(receipt.from.toLowerCase()).toBe(ANVIL_ACCOUNTS[1].toLowerCase());
  });
});

describe("hatchway connect", () => {
  it("serves a wallet-backed RPC endpoint for other tools until interrupted", async () => {
    const run = runCli(["connect", "--json", "--no-open", "--rpc-url", anvil.url], { cwd: FOUNDRY_EXAMPLE });
    const wallet = await HeadlessWallet.open({ sessionUrl: await run.sessionUrl, nodeUrl: anvil.url, address: deployer });
    const ready = await run.waitForEvent("ready");
    const endpoint = ready.rpcUrl as string;
    expect(endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/rpc\//);

    // viem with a JSON-RPC (remote) account, as any app would use it.
    const client = createWalletClient({ transport: http(endpoint), account: deployer });
    const hash = await client.sendTransaction({ to: ANVIL_ACCOUNTS[2], value: 123n, chain: null });
    expect((await anvil.client.waitForTransactionReceipt({ hash })).status).toBe("success");

    // forge's cast, unlocked against the endpoint.
    // Async: the headless wallet answering the approval runs in this same process.
    const { stdout } = await promisify(execFile)("cast", ["send", "--unlocked", "--from", deployer, "--rpc-url", endpoint, ANVIL_ACCOUNTS[2], "--value", "7", "--async"], { encoding: "utf8" });
    const castHash = stdout.trim();
    expect(castHash).toMatch(/^0x[0-9a-f]{64}$/);

    run.child.kill("SIGINT");
    expect(await run.exited).toBe(0);
    wallet.close();
    expect((run.result()!.transactions as unknown[]).length).toBe(2);
  });
});

describe("hatchway doctor and chains", () => {
  it("doctor reports checks as JSON", () => {
    const out = execFileSync(process.execPath, [BIN, "doctor", "--json", "--rpc-url", anvil.url], { cwd: FOUNDRY_EXAMPLE, encoding: "utf8" });
    const result = JSON.parse(out.trim().split("\n").pop()!) as { ok: boolean; checks: { name: string; status: string }[] };
    expect(result.ok).toBe(true);
    expect(result.checks.find((c) => c.name === "RPC endpoint")?.status).toBe("ok");
    expect(result.checks.find((c) => c.name === "Foundry")?.status).toBe("ok");
  });

  it("chains lists well-known networks", () => {
    const out = execFileSync(process.execPath, [BIN, "chains", "--json"], { encoding: "utf8" });
    const result = JSON.parse(out.trim()) as { chains: { id: number; name: string }[] };
    expect(result.chains.map((c) => c.id)).toContain(84532);
  });
});
