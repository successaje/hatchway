import type { SessionSnapshot } from "../../../hatchway/src/core/protocol.ts";
import { isMobileBrowser, type WalletOption } from "../wallets.ts";
import { CheckIcon, Hex, Spinner, WalletIcon } from "./common.tsx";

interface Props {
  snapshot: SessionSnapshot;
  wallets: WalletOption[] | undefined;
  connectingId: string | undefined;
  error: string | undefined;
  onConnect: (wallet: WalletOption) => void;
}

export function ConnectWallet({ snapshot, wallets, connectingId, error, onConnect }: Props) {
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
          <NoWallet />
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

function NoWallet() {
  const mobile = isMobileBrowser();
  return (
    <div class="empty">
      <p class="empty-title">No browser wallet found</p>
      {mobile ? (
        <p>
          This link only works in a desktop browser on the computer running Hatchway, with a wallet
          extension such as MetaMask or Rabby. Mobile wallets are not supported yet.
        </p>
      ) : (
        <p>
          Install{" "}
          <a href="https://metamask.io/download/" target="_blank" rel="noreferrer noopener">
            MetaMask
          </a>{" "}
          or{" "}
          <a href="https://rabby.io/" target="_blank" rel="noreferrer noopener">
            Rabby
          </a>{" "}
          in this browser and reload. If your wallet is in another browser, open the link from your
          terminal there instead.
        </p>
      )}
    </div>
  );
}
