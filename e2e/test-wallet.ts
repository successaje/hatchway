import type { Page } from "@playwright/test";

/**
 * Deterministic browser wallet for end-to-end tests.
 *
 * The page sees a real EIP-1193 provider announced through EIP-6963. Every request is
 * answered on the Node side: account and chain state live here, and transactions and
 * signatures are broadcast through anvil's unlocked development accounts. Behaviour such as
 * rejecting a connection or a transaction is controlled per test. It is not a substitute for
 * testing with MetaMask or Rabby (see docs/guides/manual-acceptance.md).
 */
export interface TestWalletOptions {
  nodeUrl: string;
  account: string;
  chainId: number;
  name?: string;
  /** Chains the wallet knows; switching to others fails with 4902 until added. */
  knownChains?: number[];
}

type Reply = { result: unknown } | { error: { code: number; message: string } };

export class TestWallet {
  connected = false;
  account: string;
  chainId: number;
  rejectConnect = false;
  rejectTransactions = false;
  readonly calls: string[] = [];
  readonly #known: Set<number>;
  readonly #options: TestWalletOptions;
  #page: Page | undefined;

  constructor(options: TestWalletOptions) {
    this.#options = options;
    this.account = options.account;
    this.chainId = options.chainId;
    this.#known = new Set(options.knownChains ?? [options.chainId]);
  }

  async install(page: Page): Promise<void> {
    this.#page = page;
    await page.exposeFunction("__hatchwayTestWallet", (method: string, params: unknown[]) =>
      this.#handle(method, params),
    );
    await page.addInitScript(
      ({ name }) => {
        const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
        const call = (
          window as unknown as { __hatchwayTestWallet: (m: string, p: unknown) => Promise<Reply> }
        ).__hatchwayTestWallet;
        const provider = {
          async request({ method, params }: { method: string; params?: unknown[] }) {
            const reply = await call(method, params ?? []);
            if ("error" in reply)
              throw Object.assign(new Error(reply.error.message), { code: reply.error.code });
            return reply.result;
          },
          on(event: string, listener: (...args: unknown[]) => void) {
            (listeners[event] ??= []).push(listener);
          },
          removeListener(event: string, listener: (...args: unknown[]) => void) {
            listeners[event] = (listeners[event] ?? []).filter((l) => l !== listener);
          },
        };
        (
          window as unknown as { __testWalletEmit: (e: string, v: unknown) => void }
        ).__testWalletEmit = (event, value) => {
          for (const listener of listeners[event] ?? []) listener(value);
        };
        const icon =
          "data:image/svg+xml;base64," +
          btoa(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#6d5dfc"/><path d="M9 12h14v10H9z" fill="none" stroke="#fff" stroke-width="2"/></svg>',
          );
        const announce = () =>
          window.dispatchEvent(
            new CustomEvent("eip6963:announceProvider", {
              detail: Object.freeze({
                info: {
                  uuid: "6f1b8a2e-5f0e-4d1b-9a64-hatchway-e2e",
                  name,
                  icon,
                  rdns: "dev.hatchway.testwallet",
                },
                provider,
              }),
            }),
          );
        window.addEventListener("eip6963:requestProvider", announce);
        announce();
      },
      { name: this.#options.name ?? "Test Wallet" },
    );
  }

  async emit(event: "accountsChanged" | "chainChanged", value: unknown): Promise<void> {
    await this.#page?.evaluate(
      ([e, v]) =>
        (
          window as unknown as { __testWalletEmit: (e: string, v: unknown) => void }
        ).__testWalletEmit(e, v),
      [event, value] as const,
    );
  }

  async switchAccount(account: string): Promise<void> {
    this.account = account;
    await this.emit("accountsChanged", [account]);
  }

  async #node(method: string, params: unknown[]): Promise<Reply> {
    const response = await fetch(this.#options.nodeUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const body = (await response.json()) as {
      result?: unknown;
      error?: { code: number; message: string };
    };
    return body.error ? { error: body.error } : { result: body.result };
  }

  async #handle(method: string, params: unknown[]): Promise<Reply> {
    this.calls.push(method);
    switch (method) {
      case "eth_requestAccounts":
        if (this.rejectConnect)
          return { error: { code: 4001, message: "User rejected the request." } };
        this.connected = true;
        return { result: [this.account] };
      case "eth_accounts":
        return { result: this.connected ? [this.account] : [] };
      case "eth_chainId":
        return { result: `0x${this.chainId.toString(16)}` };
      case "wallet_switchEthereumChain": {
        const target = Number.parseInt((params[0] as { chainId: string }).chainId, 16);
        if (!this.#known.has(target))
          return { error: { code: 4902, message: "Unrecognized chain ID." } };
        this.chainId = target;
        await this.emit("chainChanged", `0x${target.toString(16)}`);
        return { result: null };
      }
      case "wallet_addEthereumChain": {
        const target = Number.parseInt((params[0] as { chainId: string }).chainId, 16);
        this.#known.add(target);
        this.chainId = target;
        await this.emit("chainChanged", `0x${target.toString(16)}`);
        return { result: null };
      }
      case "eth_sendTransaction": {
        if (this.rejectTransactions)
          return { error: { code: 4001, message: "User rejected the request." } };
        const tx = params[0] as { chainId?: string };
        if (tx.chainId && Number.parseInt(tx.chainId, 16) !== this.chainId) {
          return { error: { code: -32602, message: "chainId does not match the active network" } };
        }
        return this.#node("eth_sendTransaction", params);
      }
      case "personal_sign":
      case "eth_signTypedData_v4":
        if (this.rejectTransactions)
          return { error: { code: 4001, message: "User rejected the request." } };
        return this.#node(method, params);
      default:
        return { error: { code: 4200, message: `Unsupported method ${method}` } };
    }
  }
}
