import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ANVIL_ACCOUNTS, startAnvil, type Anvil } from "../helpers/anvil.js";
import { FOUNDRY_EXAMPLE, HARDHAT_EXAMPLE, REPO_ROOT } from "../helpers/cli.js";
import { HeadlessWallet } from "../helpers/headless-wallet.js";
import { spawn } from "node:child_process";

/**
 * Installs the packed npm tarball into fresh projects outside the monorepo and runs real
 * deployments through the installed binary. Catches missing files, monorepo-only paths and
 * undeclared dependencies.
 */
let anvil: Anvil;
let tarball: string;
const workdir = mkdtempSync(join(tmpdir(), "hatchway-pack-"));

beforeAll(async () => {
  const out = execFileSync("pnpm", ["pack", "--pack-destination", workdir], {
    cwd: join(REPO_ROOT, "packages/hatchway"),
    encoding: "utf8",
  });
  tarball = join(workdir, readdirSync(workdir).find((f) => f.endsWith(".tgz"))!);
  expect(out).toContain(".tgz");
  anvil = await startAnvil();
}, 120_000);

afterAll(async () => {
  await anvil?.stop();
  rmSync(workdir, { recursive: true, force: true });
});

function installedRun(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  const child = spawn(join(cwd, "node_modules/.bin/hatchway"), args, {
    cwd,
    env: { ...process.env, CI: "1", NO_COLOR: "1", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let resolveUrl!: (url: string) => void;
  const sessionUrl = new Promise<string>((resolve) => (resolveUrl = resolve));
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
    for (const line of stdout.split("\n")) {
      if (line.includes('"event":"session"')) resolveUrl((JSON.parse(line) as { url: string }).url);
    }
  });
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const exited = new Promise<number>((resolve) => child.once("close", (code) => resolve(code ?? -1)));
  const result = () =>
    JSON.parse(
      stdout
        .trim()
        .split("\n")
        .filter((l) => l.includes('"event":"result"'))
        .pop() ?? "{}",
    ) as { ok?: boolean; transactions?: { state: string }[] };
  return { sessionUrl, exited, result, stderr: () => stderr };
}

describe("packed npm package", () => {
  it("contains the CLI, the plugin entry and the bundled signing page, and nothing else", () => {
    const listing = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" }).split("\n");
    expect(listing).toContain("package/dist/bin.js");
    expect(listing).toContain("package/dist/hardhat/index.js");
    expect(listing).toContain("package/dist/hardhat/index.d.ts");
    expect(listing).toContain("package/dist/ui/index.html");
    expect(listing.some((f) => /^package\/dist\/ui\/assets\/.+\.js$/.test(f))).toBe(true);
    expect(listing).toContain("package/README.md");
    expect(listing).toContain("package/LICENSE");
    expect(listing.some((f) => f.includes("/test/") || f.includes("/src/"))).toBe(false);
    const manifest = JSON.parse(execFileSync("tar", ["-xOzf", tarball, "package/package.json"], { encoding: "utf8" })) as {
      devDependencies?: Record<string, string>;
    };
    expect(JSON.stringify(manifest)).not.toContain("workspace:");
  });

  it("installs into an empty project and deploys a Foundry script", async () => {
    const project = join(workdir, "foundry-consumer");
    cpSync(FOUNDRY_EXAMPLE, project, {
      recursive: true,
      filter: (src) => !/[/\\](out|cache|broadcast|\.hatchway)$/.test(src),
    });
    writeFileSync(join(project, "package.json"), JSON.stringify({ name: "consumer", private: true }));
    execFileSync("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error", tarball], { cwd: project, stdio: "ignore" });
    expect(execFileSync(join(project, "node_modules/.bin/hatchway"), ["--version"], { encoding: "utf8" }).trim()).toMatch(/^\d+\.\d+\.\d+/);

    const run = installedRun(project, ["forge", "--json", "--no-open", "script/DeployToken.s.sol", "--rpc-url", anvil.url, "--broadcast"]);
    const wallet = await HeadlessWallet.open({ sessionUrl: await run.sessionUrl, nodeUrl: anvil.url, address: ANVIL_ACCOUNTS[0] });
    expect(await run.exited, run.stderr()).toBe(0);
    wallet.close();
    expect(run.result().transactions?.[0]?.state).toBe("confirmed");
  }, 240_000);

  it("works as a Hardhat 3 plugin installed from the tarball", async () => {
    const project = join(workdir, "hardhat-consumer");
    cpSync(HARDHAT_EXAMPLE, project, {
      recursive: true,
      filter: (src) => !/[/\\](node_modules|artifacts|cache|types|deployments|\.hatchway)$/.test(src),
    });
    const pkg = JSON.parse(readFileSync(join(project, "package.json"), "utf8")) as { devDependencies: Record<string, string> };
    pkg.devDependencies.hatchway = `file:${tarball}`;
    writeFileSync(join(project, "package.json"), JSON.stringify(pkg, null, 2));
    execFileSync("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: project, stdio: "ignore" });

    const run = installedRun(project, ["hardhat", "--json", "--no-open", "run", "scripts/deploy.ts", "--network", "localhost"], { LOCAL_RPC_URL: anvil.url });
    const wallet = await HeadlessWallet.open({ sessionUrl: await run.sessionUrl, nodeUrl: anvil.url, address: ANVIL_ACCOUNTS[0] });
    expect(await run.exited, run.stderr()).toBe(0);
    wallet.close();
    expect(run.result().transactions?.map((t) => t.state)).toEqual(["confirmed", "confirmed", "confirmed"]);
  }, 600_000);
});
