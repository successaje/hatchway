import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { ANVIL_ACCOUNTS, startAnvil, type Anvil } from "../packages/hatchway/test/helpers/anvil.js";
import { FOUNDRY_EXAMPLE, runCli, type CliRun } from "../packages/hatchway/test/helpers/cli.js";
import { TestWallet } from "./test-wallet.js";

const SHOTS = "docs/assets/screenshots";

/** Documentation screenshots are only (re)written when UPDATE_SCREENSHOTS=1. */
async function shot(page: Page, name: string, options: { fullPage?: boolean } = {}): Promise<void> {
  if (process.env.UPDATE_SCREENSHOTS !== "1") return;
  await page.screenshot({ path: `${SHOTS}/${name}.png`, animations: "disabled", ...options });
}
let anvil: Anvil;
const runs: CliRun[] = [];

test.beforeAll(async () => {
  mkdirSync(SHOTS, { recursive: true });
  execFileSync("forge", ["build"], { cwd: FOUNDRY_EXAMPLE, stdio: "ignore" });
  anvil = await startAnvil();
});

test.afterAll(async () => {
  for (const run of runs) if (run.child.exitCode === null) run.child.kill("SIGKILL");
  await anvil?.stop();
});

function deploy(
  args: string[] = ["HatchToken", "--args", "Hatch Token", "HATCH", "1000000"],
): CliRun {
  const run = runCli(
    ["deploy", "--json", "--no-open", "--no-build", "--rpc-url", anvil.url, ...args],
    { cwd: FOUNDRY_EXAMPLE },
  );
  runs.push(run);
  return run;
}

async function openWithWallet(
  page: Page,
  url: string,
  options: Partial<ConstructorParameters<typeof TestWallet>[0]> = {},
) {
  const wallet = new TestWallet({
    nodeUrl: anvil.url,
    account: ANVIL_ACCOUNTS[0],
    chainId: 31337,
    ...options,
  });
  await wallet.install(page);
  await page.goto(url);
  return wallet;
}

test("deploys a contract: connect, review, approve in wallet, confirm", async ({ page }) => {
  const run = deploy();
  const wallet = await openWithWallet(page, await run.sessionUrl);

  await expect(page.getByRole("heading", { name: "Connect your wallet" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Test Wallet/ })).toBeVisible();
  // The pairing code is removed from the address bar immediately.
  expect(new URL(page.url()).hash).toBe("");
  await shot(page, "connect-light");

  await page.getByRole("button", { name: /Test Wallet/ }).click();
  await expect(page.getByRole("heading", { name: "Deploy HatchToken" })).toBeVisible();
  await expect(page.getByText("Simulation passed")).toBeVisible();
  await expect(page.getByText('"Hatch Token"')).toBeVisible();
  await expect(page.getByText("Contract creation")).toBeVisible();
  await shot(page, "review-light", { fullPage: true });

  await page.getByRole("button", { name: "Confirm in Test Wallet" }).click();
  await expect(page.getByRole("heading", { name: "All done" })).toBeVisible();
  await shot(page, "done-light", { fullPage: true });

  expect(await run.exited).toBe(0);
  const [tx] = run.result()!.transactions as { contractAddress: `0x${string}` }[];
  expect(await anvil.client.getCode({ address: tx!.contractAddress })).toMatch(/^0x[0-9a-f]+/);
  expect(wallet.calls).toContain("eth_sendTransaction");
});

test("dark theme and narrow screens render the review screen", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  const run = deploy();
  await openWithWallet(page, await run.sessionUrl);
  await expect(page.getByRole("heading", { name: "Connect your wallet" })).toBeVisible();
  await shot(page, "connect-dark");
  await page.getByRole("button", { name: /Test Wallet/ }).click();
  await expect(page.getByRole("heading", { name: "Deploy HatchToken" })).toBeVisible();
  await shot(page, "review-dark", { fullPage: true });

  await page.setViewportSize({ width: 375, height: 812 });
  await shot(page, "review-mobile-dark", { fullPage: true });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);

  await page.getByRole("button", { name: "Reject" }).click();
  expect(await run.exited).toBe(3);
});

test("rejecting in the wallet fails the command with exit code 3", async ({ page }) => {
  const run = deploy();
  const wallet = await openWithWallet(page, await run.sessionUrl);
  wallet.rejectTransactions = true;
  await page.getByRole("button", { name: /Test Wallet/ }).click();
  await page.getByRole("button", { name: "Confirm in Test Wallet" }).click();
  expect(await run.exited).toBe(3);
  await expect(page.getByRole("heading", { name: /Session ended/ })).toBeVisible();
  await expect(page.getByText("Transaction rejected in wallet.", { exact: true })).toBeVisible();
});

test("shows guidance when no wallet is installed", async ({ page }) => {
  const run = deploy();
  await page.goto(await run.sessionUrl);
  await expect(page.getByText("No browser wallet found")).toBeVisible();
  await shot(page, "no-wallet-light");
  run.child.kill("SIGINT");
  await run.exited;
});

test("explains a declined connection and lets the user retry", async ({ page }) => {
  const run = deploy();
  const wallet = await openWithWallet(page, await run.sessionUrl);
  wallet.rejectConnect = true;
  await page.getByRole("button", { name: /Test Wallet/ }).click();
  await expect(page.getByRole("alert")).toHaveText("You declined the connection in your wallet.");
  wallet.rejectConnect = false;
  await page.getByRole("button", { name: /Test Wallet/ }).click();
  await expect(page.getByRole("heading", { name: "Deploy HatchToken" })).toBeVisible();
  await page.getByRole("button", { name: "Reject" }).click();
  await run.exited;
});

test("asks to switch networks and continues once the wallet is on the right chain", async ({
  page,
}) => {
  const run = deploy();
  await openWithWallet(page, await run.sessionUrl, { chainId: 1, knownChains: [1] });
  await page.getByRole("button", { name: /Test Wallet/ }).click();
  await expect(
    page.getByText("This session deploys to Local (Anvil/Hardhat) (chain 31337)."),
  ).toBeVisible();
  await shot(page, "wrong-network-light");
  // The chain is unknown to the wallet, so the page offers to add it (loopback RPC only).
  await page.getByRole("button", { name: /Switch to Local/ }).click();
  await expect(page.getByRole("heading", { name: "Deploy HatchToken" })).toBeVisible();
  await page.getByRole("button", { name: "Confirm in Test Wallet" }).click();
  expect(await run.exited).toBe(0);
});

test("blocks approval while the wallet is on a different account", async ({ page }) => {
  const run = deploy();
  const wallet = await openWithWallet(page, await run.sessionUrl);
  await page.getByRole("button", { name: /Test Wallet/ }).click();
  await expect(page.getByRole("heading", { name: "Deploy HatchToken" })).toBeVisible();
  await wallet.switchAccount(ANVIL_ACCOUNTS[1]);
  await expect(page.getByText(/The selected account changed/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Confirm in Test Wallet" })).toBeDisabled();
  await wallet.switchAccount(ANVIL_ACCOUNTS[0]);
  await expect(page.getByRole("button", { name: "Confirm in Test Wallet" })).toBeEnabled();
  await page.getByRole("button", { name: "Confirm in Test Wallet" }).click();
  expect(await run.exited).toBe(0);
});

test("survives a page reload and refuses to reuse the link in another browser", async ({
  page,
  browser,
}) => {
  const run = deploy();
  const url = await run.sessionUrl;
  await openWithWallet(page, url);
  await page.getByRole("button", { name: /Test Wallet/ }).click();
  await expect(page.getByRole("heading", { name: "Deploy HatchToken" })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("heading", { name: "Deploy HatchToken" })).toBeVisible();

  const other = await browser.newContext();
  const intruder = await other.newPage();
  await intruder.goto(url);
  await expect(intruder.getByRole("heading", { name: "This link can't be used" })).toBeVisible();
  await other.close();

  await page.getByRole("button", { name: "Confirm in Test Wallet" }).click();
  expect(await run.exited).toBe(0);
});

test("runs two sessions side by side without crossing over", async ({ browser }) => {
  const a = deploy(["Counter"]);
  const b = deploy(["HatchToken", "--args", "B", "B", "1"]);
  const pageA = await (await browser.newContext()).newPage();
  const pageB = await (await browser.newContext()).newPage();
  await openWithWallet(pageA, await a.sessionUrl);
  await openWithWallet(pageB, await b.sessionUrl, { account: ANVIL_ACCOUNTS[1] });
  await pageA.getByRole("button", { name: /Test Wallet/ }).click();
  await pageB.getByRole("button", { name: /Test Wallet/ }).click();
  await expect(pageA.getByRole("heading", { name: "Deploy Counter" })).toBeVisible();
  await expect(pageB.getByRole("heading", { name: "Deploy HatchToken" })).toBeVisible();
  await pageB.getByRole("button", { name: "Confirm in Test Wallet" }).click();
  await pageA.getByRole("button", { name: "Confirm in Test Wallet" }).click();
  expect(await a.exited).toBe(0);
  expect(await b.exited).toBe(0);
});

test("shows when the terminal session is gone", async ({ page }) => {
  const run = deploy();
  await openWithWallet(page, await run.sessionUrl);
  await page.getByRole("button", { name: /Test Wallet/ }).click();
  await expect(page.getByRole("heading", { name: "Deploy HatchToken" })).toBeVisible();
  run.child.kill("SIGINT");
  await run.exited;
  await expect(page.getByRole("heading", { name: /cancelled|Lost connection/ })).toBeVisible();
});

test("cancelling in the browser stops the command", async ({ page }) => {
  const run = deploy();
  await openWithWallet(page, await run.sessionUrl);
  page.on("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Cancel session" }).click();
  expect(await run.exited).toBe(10);
  await expect(page.getByRole("heading", { name: "Session cancelled" })).toBeVisible();
});
