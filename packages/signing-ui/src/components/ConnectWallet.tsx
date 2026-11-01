import type { SessionSnapshot } from "../../../hatchway/src/core/protocol.ts";
import { isMobileBrowser, type WalletOption } from "../wallets.ts";
import { useState } from "preact/hooks";
import { CheckIcon, CopyButton, Hex, Spinner, WalletIcon } from "./common.tsx";

interface Props {
  snapshot: SessionSnapshot;
  wallets: WalletOption[] | undefined;
  connectingId: string | undefined;
  error: string | undefined;
  onConnect: (wallet: WalletOption) => void;
  onHandoff: () => Promise<string>;
}

export function ConnectWallet({
  snapshot,
  wallets,
  connectingId,
  error,
  onConnect,
  onHandoff,
}: Props) {
  const purpose = snapshot.purpose;
  return (
    <section class="card enter" aria-labelledby="connect-title">
      <p class="eyebrow">Step 1 of 2</p>
      <h1 id="connect-title">Connect your wallet</h1>
      <p class="lede">
        Your terminal is waiting to run <code class="mono">{purpose.title}</code>
        {purpose.project && purpose.project !== "." ? (
          <>
            {" "}
            in <code class="mono">{purpose.project}</code>
          </>
        ) : null}
        . Choose the wallet that should approve its transactions.
      </p>

      {snapshot.expectedAddress ? (
        <p class="hint">
          Use the account <Hex value={snapshot.expectedAddress} /> — the script expects it.
        </p>
      ) : null}

      <div class="wallets" role="group" aria-label="Detected wallets">
        {wallets === undefined ? (
          <div class="wallet wallet-skeleton" aria-busy="true">
            <span class="wallet-icon skeleton" />
            <span class="skeleton skeleton-text" />
          </div>
        ) : wallets.length === 0 ? (
          <NoWallet onHandoff={onHandoff} />
        ) : (
          wallets.map((wallet) => {
            const busy = connectingId === wallet.id;
            return (
              <button
                type="button"
                key={wallet.id}
                class={`wallet ${busy ? "is-busy" : ""}`}
                disabled={connectingId !== undefined}
                onClick={() => onConnect(wallet)}
                aria-describedby={busy ? "connect-status" : undefined}
              >
                <span class="wallet-icon">
                  {wallet.icon ? (
                    <img src={wallet.icon} alt="" width={28} height={28} />
                  ) : (
                    <WalletIcon />
                  )}
                </span>
                <span class="wallet-name">
                  {wallet.name}
                  <span class="wallet-meta">
                    {wallet.legacy ? "Injected provider" : (wallet.rdns ?? "EIP-6963")}
                  </span>
                </span>
                {busy ? (
                  <span class="wallet-state" id="connect-status">
                    <Spinner /> Check your wallet
                  </span>
                ) : (
                  <span class="wallet-state wallet-detected">Detected</span>
                )}
              </button>
            );
          })
        )}
      </div>

      {error ? (
        <p class="form-error" role="alert">
          {error}
        </p>
      ) : null}

      <ul class="assurances">
        <li>
          <CheckIcon /> Your private key stays in your wallet. Hatchway never asks for it.
        </li>
        <li>
          <CheckIcon /> Connecting only shares your address. It sends nothing.
        </li>
        <li>
          <CheckIcon /> Every transaction is shown here first, then approved in your wallet.
        </li>
      </ul>
    </section>
  );
}

function NoWallet({ onHandoff }: { onHandoff: () => Promise<string> }) {
  const mobile = isMobileBrowser();
  const [link, setLink] = useState<string>();
  const [failed, setFailed] = useState<string>();
  return (
    <div class="empty">
      <p class="empty-title">No browser wallet found</p>
      {mobile ? (
        <p>
          This link only works in a desktop browser on the computer running Hatchway, with a wallet
          extension such as MetaMask or Rabby. Mobile wallets are not supported yet.
        </p>
      ) : (
        <>
          <p>
            Install{" "}
            <a href="https://metamask.io/download/" target="_blank" rel="noreferrer noopener">
              MetaMask
            </a>{" "}
            or{" "}
            <a href="https://rabby.io/" target="_blank" rel="noreferrer noopener">
              Rabby
            </a>{" "}
            in this browser and reload, or continue in the browser where your wallet is installed.
          </p>
          {link ? (
            <div class="handoff">
              <p>
                Open this one-time link in that browser. This tab stops working once it is used.
              </p>
              <span class="handoff-link">
                <code class="mono">{link}</code>
                <CopyButton value={link} label="Copy link" />
              </span>
            </div>
          ) : (
            <button
              type="button"
              class="btn btn-small"
              onClick={() => {
                onHandoff().then(setLink, (error: unknown) =>
                  setFailed(error instanceof Error ? error.message : String(error)),
                );
              }}
            >
              Get a link for another browser
            </button>
          )}
          {failed ? <p class="form-error">{failed}</p> : null}
        </>
      )}
    </div>
  );
}
