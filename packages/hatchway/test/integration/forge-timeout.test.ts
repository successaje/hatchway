import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ANVIL_ACCOUNTS, startAnvil, type Anvil } from "../helpers/anvil.js";
import { FOUNDRY_EXAMPLE, runCli } from "../helpers/cli.js";
import { HeadlessWallet } from "../helpers/headless-wallet.js";

let anvil: Anvil;

beforeAll(async () => {
  execFileSync("forge", ["build"], { cwd: FOUNDRY_EXAMPLE, stdio: "ignore" });
  anvil = await startAnvil();
});

afterAll(async () => {
  await anvil?.stop();
});

describe("slow approvals with forge", () => {
  // Some forge versions drop an eth_sendTransaction after 45 s regardless of --rpc-timeout
  // and retry it. The retry must join the open approval rather than create a second one.
  it("survives an approval that takes longer than forge's request timeout", async () => {
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
      address: ANVIL_ACCOUNTS[0],
      decide: () => ({ action: "approve", delayMs: 55_000 }),
    });
    const code = await run.exited;
    wallet.close();
    expect(code, run.stderr()).toBe(0);
    const transactions = run.result()!.transactions as { state: string }[];
    expect(transactions).toHaveLength(1);
    expect(transactions[0]!.state).toBe("confirmed");
  }, 150_000);
});
