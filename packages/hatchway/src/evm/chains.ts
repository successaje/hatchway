import type { Chain } from "viem";
import * as viemChains from "viem/chains";
import type { AddChainParameter, ChainSummary } from "../core/protocol.js";
import { isLoopbackUrl } from "../util/redact.js";

/** Networks shown by `hatchway chains`, in display order. Any EVM chain id works. */
export const FEATURED_CHAIN_IDS = [
  1, 11155111, 560048, 8453, 84532, 10, 11155420, 42161, 421614, 137, 80002, 56, 97, 43114, 43113,
  100, 59144, 59141, 534352, 534351, 31337,
] as const;

const LOCAL_CHAIN_IDS = new Set([31337, 1337]);

/**
 * Chains whose contract deployment does not follow the standard EVM CREATE semantics,
 * so deployment previews and address predictions would be wrong.
 */
const NONSTANDARD_DEPLOYMENT = new Set([324, 300, 232, 37111]);

let byId: Map<number, Chain> | undefined;

function chainIndex(): Map<number, Chain> {
  if (byId) return byId;
  byId = new Map();
  for (const value of Object.values(viemChains)) {
    const chain = value as Partial<Chain>;
    if (typeof chain.id !== "number" || typeof chain.name !== "string" || !chain.nativeCurrency)
      continue;
    // Keep the first definition: viem lists canonical chains before aliases sharing an id.
    if (!byId.has(chain.id)) byId.set(chain.id, chain as Chain);
  }
  return byId;
}

export function getChain(chainId: number): Chain | undefined {
  return chainIndex().get(chainId);
}

export function isLocalChain(chainId: number): boolean {
  return LOCAL_CHAIN_IDS.has(chainId);
}

export function hasNonstandardDeployment(chainId: number): boolean {
  return NONSTANDARD_DEPLOYMENT.has(chainId);
}

export function chainName(chainId: number): string {
  if (chainId === 31337) return "Local (Anvil/Hardhat)";
  if (chainId === 1337) return "Local (1337)";
  return getChain(chainId)?.name ?? `Chain ${chainId}`;
}

export function nativeSymbol(chainId: number): string {
  return getChain(chainId)?.nativeCurrency.symbol ?? "ETH";
}

function explorerBase(chainId: number): string | undefined {
  const url = getChain(chainId)?.blockExplorers?.default.url;
  return url ? url.replace(/\/$/, "") : undefined;
}

export function explorerTxUrl(chainId: number, hash: string): string | undefined {
  const base = explorerBase(chainId);
  return base ? `${base}/tx/${hash}` : undefined;
}

export function explorerAddressUrl(chainId: number, address: string): string | undefined {
  const base = explorerBase(chainId);
  return base ? `${base}/address/${address}` : undefined;
}

/**
 * Parameters for `wallet_addEthereumChain`. The developer's own RPC URL is only shared with
 * the wallet when it is a credential-free loopback URL; for public chains the well-known
 * public endpoint is used instead, so API keys never reach the browser.
 */
function addChainParameter(
  chainId: number,
  upstreamUrl: string | undefined,
): AddChainParameter | undefined {
  const chain = getChain(chainId);
  const local = isLocalChain(chainId);
  let rpcUrls: string[] = [];
  if (local || !chain) {
    if (upstreamUrl && isLoopbackUrl(upstreamUrl)) rpcUrls = [upstreamUrl];
  } else {
    rpcUrls = [...chain.rpcUrls.default.http].filter((url) => url.startsWith("https://"));
  }
  if (rpcUrls.length === 0) return undefined;
  const explorer = explorerBase(chainId);
  const parameter: AddChainParameter = {
    chainId: `0x${chainId.toString(16)}`,
    chainName: chainName(chainId),
    nativeCurrency: chain?.nativeCurrency ?? { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls,
  };
  if (explorer) parameter.blockExplorerUrls = [explorer];
  return parameter;
}

export function chainSummary(chainId: number, upstreamUrl?: string): ChainSummary {
  const chain = getChain(chainId);
  const local = isLocalChain(chainId);
  const summary: ChainSummary = {
    id: chainId,
    name: chainName(chainId),
    nativeSymbol: nativeSymbol(chainId),
    testnet: local || chain?.testnet === true,
    local,
  };
  const explorer = explorerBase(chainId);
  if (explorer && !local) summary.explorerUrl = explorer;
  const add = addChainParameter(chainId, upstreamUrl);
  if (add) summary.addChain = add;
  return summary;
}
