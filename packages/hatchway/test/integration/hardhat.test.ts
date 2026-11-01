import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAddress, parseAbi, type Address } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ANVIL_ACCOUNTS, startAnvil, type Anvil } from "../helpers/anvil.js";
import { HARDHAT_EXAMPLE, runCli, type CliEvent } from "../helpers/cli.js";
import { HeadlessWallet, type Decision } from "../helpers/headless-wallet.js";
import type { RequestView } from "../../src/core/protocol.js";

let anvil: Anvil;
const deployer = ANVIL_ACCOUNTS[0];

beforeAll(async () => {
  execFileSync(
    process.execPath,
    [join(HARDHAT_EXAMPLE, "node_modules/hardhat/dist/src/cli.js"), "build"],
    { cwd: HARDHAT_EXAMPLE, stdio: "ignore" },
  );
  anvil = await startAnvil();
});

afterAll(async () => {
  await anvil?.stop();
});

async function hardhat(args: string[], decide?: (r: RequestView) => Decision) {
  const run = runCli(["hardhat", "--json", "--no-open", ...args], {
    cwd: HARDHAT_EXAMPLE,
    env: { LOCAL_RPC_URL: anvil.url },
  });
  const url = await Promise.race([run.sessionUrl, run.exited.then(() => undefined)]);
  const wallet = url
    ? await HeadlessWallet.open({
        sessionUrl: url,
        nodeUrl: anvil.url,
        address: deployer,
        ...(decide ? { decide } : {}),
      })
    : undefined;
  const code = await run.exited;
  wallet?.close();
  const result = run.result();
  if (!result) throw new Error(`no result; stderr:\n${run.stderr()}`);
  return { code, result, stderr: run.stderr(), events: run.events };
}

function transactions(result: CliEvent) {
  return result.transactions as {
    title: string;
    state: string;
    kind: string;
    hash?: string;
    contractAddress?: string;
  }[];
}

describe("hatchway hardhat (Hardhat 3 plugin, real hardhat + anvil)", () => {
  it("runs an ethers deploy script with the browser wallet as the signer", async () => {
    const run = await hardhat(["run", "scripts/deploy.ts", "--network", "localhost"]);
    expect(run.code, run.stderr).toBe(0);
    const txs = transactions(run.result);
    expect(txs.map((t) => t.title)).toEqual([
      "Deploy HatchToken",
      "Deploy Counter",
      "Counter.setNumber",
    ]);
    expect(txs.every((t) => t.state === "confirmed")).toBe(true);
    expect(run.stderr).toContain(`Deployer: ${deployer}`);
    const counter = txs[1]!.contractAddress as Address;
    const number = await anvil.client.readContract({
      address: counter,
      abi: parseAbi(["function number() view returns (uint256)"]),
      functionName: "number",
    });
    expect(number).toBe(7n);
    const receipt = await anvil.client.getTransactionReceipt({
      hash: txs[0]!.hash as `0x${string}`,
    });
    expect(getAddress(receipt.from)).toBe(deployer);
  });

  it("routes message signatures to the wallet", async () => {
    const run = await hardhat(["run", "scripts/sign.ts", "--network", "localhost"]);
    expect(run.code, run.stderr).toBe(0);
    expect(transactions(run.result)).toMatchObject([{ kind: "signature", state: "signed" }]);
    expect(run.stderr).toContain(`Recovered: ${deployer}`);
  });

  it("deploys a Hardhat Ignition module", async () => {
    rmSync(join(HARDHAT_EXAMPLE, "ignition/deployments"), { recursive: true, force: true });
    const run = await hardhat([
      "ignition",
      "deploy",
      "ignition/modules/Token.ts",
      "--network",
      "localhost",
    ]);
    expect(run.code, run.stderr).toBe(0);
    const txs = transactions(run.result);
    expect(txs).toHaveLength(3);
    expect(txs.every((t) => t.state === "confirmed")).toBe(true);
    expect(txs.map((t) => t.title).sort()).toEqual([
      "Counter.setNumber",
      "Deploy Counter",
      "Deploy HatchToken",
    ]);
  });

  it("propagates a wallet rejection as a failed script", async () => {
    const run = await hardhat(["run", "scripts/deploy.ts", "--network", "localhost"], () => ({
      action: "reject",
    }));
    expect(run.code).toBe(3);
    expect(run.result.error).toMatchObject({ code: "USER_REJECTED" });
  });

  it("stops at a reverting call before it reaches the wallet", async () => {
    const run = await hardhat(["run", "scripts/fails.ts", "--network", "localhost"]);
    expect(run.code).not.toBe(0);
    const txs = transactions(run.result);
    expect(txs.map((t) => t.title)).toEqual(["Deploy Faulty"]);
    expect(run.stderr).toMatch(/Boom|revert/i);
  });

  it("requires --network", async () => {
    const run = runCli(["hardhat", "--json", "--no-open", "run", "scripts/deploy.ts"], {
      cwd: HARDHAT_EXAMPLE,
    });
    expect(await run.exited).toBe(2);
    expect(run.result()?.error).toMatchObject({ code: "USAGE" });
  });

  it("explains that Hardhat's in-process network cannot be used with a wallet", async () => {
    const run = await hardhat(["run", "scripts/deploy.ts", "--network", "default"]);
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain("in-process network");
  });

  it("blocks transactions signed with a local key while the plugin is active", async () => {
    const script = join(HARDHAT_EXAMPLE, "scripts", "zz-local-signer.ts");
    writeFileSync(
      script,
      `import { network } from "hardhat";
const { ethers } = await network.connect();
const local = ethers.Wallet.createRandom().connect(ethers.provider);
const { chainId } = await ethers.provider.getNetwork();
await local.sendTransaction({ to: local.address, value: 0n, gasLimit: 21000n, gasPrice: 1n, nonce: 0, chainId });
`,
    );
    try {
      const run = await hardhat(["run", "scripts/zz-local-signer.ts", "--network", "localhost"]);
      expect(run.code).not.toBe(0);
      expect(run.stderr).toContain("only relays transactions approved in your wallet");
      expect(transactions(run.result)).toHaveLength(0);
    } finally {
      rmSync(script, { force: true });
    }
  });
});
