import { ExitCode } from "../../core/errors.js";
import { chainSummary, FEATURED_CHAIN_IDS } from "../../evm/chains.js";
import { parseOptions } from "../args.js";
import { HELP } from "../help.js";
import type { Reporter } from "../output.js";

export async function chainsCommand(
  argv: string[],
  reporterFor: (json: boolean, debug: boolean, color?: boolean) => Reporter,
): Promise<number> {
  const { options } = parseOptions(argv, {
    json: { type: "boolean" },
    color: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  });
  const reporter = reporterFor(options.json === true, false, options.color as boolean | undefined);
  if (options.help) {
    reporter.line(HELP.chains);
    return ExitCode.Success;
  }
  const chains = FEATURED_CHAIN_IDS.map((id) => chainSummary(id));
  reporter.header("chains");
  for (const chain of chains) {
    const kind = chain.local ? "local" : chain.testnet ? "testnet" : "mainnet";
    reporter.line(
      `  ${String(chain.id).padStart(9)}  ${chain.name.padEnd(26)} ${reporter.c.dim(kind.padEnd(8))} ${reporter.c.dim(chain.explorerUrl ?? "")}`,
    );
  }
  reporter.line();
  reporter.note("Any EVM chain works: Hatchway reads the chain id from your RPC endpoint.");
  reporter.line();
  reporter.event({
    event: "result",
    ok: true,
    chains: chains.map(({ id, name, nativeSymbol, testnet, local, explorerUrl }) => ({
      id,
      name,
      nativeSymbol,
      testnet,
      local,
      explorerUrl,
    })),
  });
  return ExitCode.Success;
}
