/** EIP-1193 provider surface used by the page. */
export interface Eip1193Provider {
  request(args: { method: string; params?: unknown }): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
}

/** EIP-6963 provider info. */
export interface WalletInfo {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
}

export interface WalletOption {
  id: string;
  name: string;
  /** data: URI from the wallet's EIP-6963 announcement. */
  icon?: string;
  rdns?: string;
  legacy: boolean;
  provider: Eip1193Provider;
}

export interface ProviderError {
  code?: number;
  message: string;
}

export function asProviderError(error: unknown): ProviderError {
  if (error && typeof error === "object") {
    const e = error as { code?: unknown; message?: unknown; data?: { originalError?: { code?: unknown } } };
    const code = typeof e.code === "number" ? e.code : typeof e.data?.originalError?.code === "number" ? (e.data.originalError.code as number) : undefined;
    return { ...(code !== undefined ? { code } : {}), message: typeof e.message === "string" ? e.message : String(error) };
  }
  return { message: String(error) };
}

/** Accepts only data: image URIs for wallet icons, which the page CSP also enforces. */
function safeIcon(icon: unknown): string | undefined {
  return typeof icon === "string" && /^data:image\/(svg\+xml|png|webp|jpeg|gif)[;,]/.test(icon) ? icon : undefined;
}

function legacyName(provider: Record<string, unknown>): string {
  if (provider.isRabby) return "Rabby";
  if (provider.isCoinbaseWallet) return "Coinbase Wallet";
  if (provider.isBraveWallet) return "Brave Wallet";
  if (provider.isMetaMask) return "MetaMask";
  return "Browser wallet";
}

/**
 * Discovers wallets with EIP-6963 so several installed extensions can coexist. Falls back to
 * `window.ethereum` only when no wallet announces itself.
 */
export function discoverWallets(onChange: (wallets: WalletOption[]) => void): () => void {
  const wallets = new Map<string, WalletOption>();
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<{ info?: Partial<WalletInfo>; provider?: Eip1193Provider }>).detail;
    if (!detail?.info?.uuid || !detail.provider || typeof detail.provider.request !== "function") return;
    const info = detail.info;
    const icon = safeIcon(info.icon);
    wallets.set(info.uuid!, {
      id: info.uuid!,
      name: String(info.name ?? "Wallet").slice(0, 40),
      ...(icon ? { icon } : {}),
      ...(typeof info.rdns === "string" ? { rdns: info.rdns } : {}),
      legacy: false,
      provider: detail.provider,
    });
    wallets.delete("legacy");
    onChange([...wallets.values()]);
  };
  window.addEventListener("eip6963:announceProvider", handler);
  window.dispatchEvent(new Event("eip6963:requestProvider"));

  const fallback = window.setTimeout(() => {
    const injected = (window as unknown as { ethereum?: Eip1193Provider & Record<string, unknown> }).ethereum;
    if (wallets.size === 0 && injected && typeof injected.request === "function") {
      wallets.set("legacy", { id: "legacy", name: legacyName(injected), legacy: true, provider: injected });
    }
    onChange([...wallets.values()]);
  }, 700);

  return () => {
    window.removeEventListener("eip6963:announceProvider", handler);
    window.clearTimeout(fallback);
  };
}

export async function readAccount(provider: Eip1193Provider, prompt: boolean): Promise<string | undefined> {
  const accounts = (await provider.request({ method: prompt ? "eth_requestAccounts" : "eth_accounts" })) as unknown;
  return Array.isArray(accounts) && typeof accounts[0] === "string" ? accounts[0] : undefined;
}

export async function readChainId(provider: Eip1193Provider): Promise<number> {
  const hex = (await provider.request({ method: "eth_chainId" })) as string;
  return Number.parseInt(hex, 16);
}

export function isMobileBrowser(): boolean {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}
