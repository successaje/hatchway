import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { RequestView, SessionSnapshot } from "../../hatchway/src/core/protocol.ts";
import { Activity } from "./components/Activity.tsx";
import {
  CheckIcon,
  formatRemaining,
  Hex,
  LockIcon,
  Mark,
  Pill,
  Spinner,
  useNow,
  WalletIcon,
} from "./components/common.tsx";
import { ConnectWallet } from "./components/ConnectWallet.tsx";
import { RequestCard } from "./components/RequestCard.tsx";
import { ApiFailure, currentSessionId, pair, SessionApi } from "./session.ts";
import {
  asProviderError,
  discoverWallets,
  readAccount,
  readChainId,
  type WalletOption,
} from "./wallets.ts";

type Phase =
  | { kind: "pairing" }
  | { kind: "live" }
  | { kind: "reconnecting" }
  | { kind: "lost" }
  | { kind: "revoked" }
  | { kind: "error"; title: string; message: string };

const WALLET_KEY = "hatchway:wallet";

export function App() {
  const [phase, setPhase] = useState<Phase>({ kind: "pairing" });
  const [snapshot, setSnapshot] = useState<SessionSnapshot>();
  const [offset, setOffset] = useState(0);
  const [wallets, setWallets] = useState<WalletOption[]>();
  const [active, setActive] = useState<WalletOption>();
  const [connectingId, setConnectingId] = useState<string>();
  const [connectError, setConnectError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const [switching, setSwitching] = useState(false);
  const api = useRef<SessionApi>();
  const initiated = useRef(new Set<string>());
  const now = useNow(offset);

  // ---- Pair and stream session state -----------------------------------------------------
  useEffect(() => {
    const sessionId = currentSessionId();
    if (!sessionId) {
      setPhase({
        kind: "error",
        title: "Link not recognised",
        message: "Open the link printed in your terminal.",
      });
      return;
    }
    const controller = new AbortController();
    let attempts = 0;
    let ended = false;

    const run = async () => {
      try {
        api.current = new SessionApi(await pair(sessionId));
      } catch (error) {
        setPhase(pairingError(error));
        return;
      }
      while (!controller.signal.aborted && !ended) {
        try {
          await api.current.stream(
            (next) => {
              attempts = 0;
              setOffset(next.now - Date.now());
              setSnapshot(next);
              setPhase({ kind: "live" });
              if (["completed", "cancelled", "expired", "failed"].includes(next.state))
                ended = true;
            },
            () => {
              ended = true;
              setPhase({ kind: "revoked" });
            },
            controller.signal,
          );
        } catch (error) {
          if (controller.signal.aborted) return;
          if (
            error instanceof ApiFailure &&
            (error.status === 401 || error.status === 404 || error.status === 410)
          ) {
            setPhase(error.status === 401 ? { kind: "revoked" } : { kind: "lost" });
            return;
          }
        }
        if (ended || controller.signal.aborted) return;
        attempts += 1;
        if (attempts > 5) {
          setPhase({ kind: "lost" });
          return;
        }
        setPhase({ kind: "reconnecting" });
        await new Promise((resolve) => setTimeout(resolve, Math.min(4000, 500 * attempts)));
      }
    };
    void run();
    return () => controller.abort();
  }, []);

  useEffect(() => discoverWallets(setWallets), []);

  // ---- Wallet connection -------------------------------------------------------------------
  const report = useCallback(async (wallet: WalletOption, address: string | undefined) => {
    if (!api.current) return;
    const chainId = await readChainId(wallet.provider);
    await api.current.reportWallet({
      address: address ?? "",
      chainId,
      name: wallet.name,
      ...(wallet.rdns ? { rdns: wallet.rdns } : {}),
    });
  }, []);

  const connect = useCallback(
    async (wallet: WalletOption, prompt: boolean) => {
      setConnectError(undefined);
      if (prompt) setConnectingId(wallet.id);
      try {
        const address = await readAccount(wallet.provider, prompt);
        if (!address) {
          if (prompt) setConnectError(`${wallet.name} did not share an account.`);
          return;
        }
        setActive(wallet);
        try {
          sessionStorage.setItem(WALLET_KEY, wallet.rdns ?? wallet.name);
        } catch {
          // ignore storage errors
        }
        await report(wallet, address);
      } catch (error) {
        const e = asProviderError(error);
        if (prompt) {
          setConnectError(
            e.code === 4001
              ? "You declined the connection in your wallet."
              : e.code === -32002
                ? `${wallet.name} already has a pending request. Open the wallet to answer it.`
                : `Could not connect: ${e.message}`,
          );
        }
      } finally {
        setConnectingId(undefined);
      }
    },
    [report],
  );

  // After a refresh, silently reconnect the wallet used before (no prompt).
  useEffect(() => {
    if (active || !wallets || phase.kind !== "live") return;
    let preferred: string | null = null;
    try {
      preferred = sessionStorage.getItem(WALLET_KEY);
    } catch {
      preferred = null;
    }
    const match = wallets.find((w) => (w.rdns ?? w.name) === preferred);
    if (match) void connect(match, false);
  }, [wallets, phase.kind, active, connect]);

  // Follow account and network changes in the wallet.
  useEffect(() => {
    if (!active) return;
    const provider = active.provider;
    const onAccounts = (accounts: unknown) => {
      const first =
        Array.isArray(accounts) && typeof accounts[0] === "string" ? accounts[0] : undefined;
      void report(active, first).catch(() => undefined);
    };
    const onChain = () => {
      void readAccount(provider, false)
        .then((address) => report(active, address))
        .catch(() => undefined);
    };
    provider.on?.("accountsChanged", onAccounts);
    provider.on?.("chainChanged", onChain);
    return () => {
      provider.removeListener?.("accountsChanged", onAccounts);
      provider.removeListener?.("chainChanged", onChain);
    };
  }, [active, report]);

  // ---- Requests ------------------------------------------------------------------------------
  const current = useMemo(() => pickCurrent(snapshot), [snapshot]);

  useEffect(() => {
    setActionError(undefined);
  }, [current?.id]);

  const approve = useCallback(async () => {
    const request = current;
    const wallet = active;
    const s = snapshot;
    if (!request || !wallet || !s?.wallet || !s.chain || !api.current) return;
    setBusy(true);
    setActionError(undefined);
    try {
      // Re-check the live wallet state right before asking it to sign.
      const [address, chainId] = await Promise.all([
        readAccount(wallet.provider, false),
        readChainId(wallet.provider),
      ]);
      if (!address || address.toLowerCase() !== s.wallet.address.toLowerCase()) {
        setActionError(`Your wallet is on a different account. Switch to ${s.wallet.address}.`);
        return;
      }
      if (chainId !== s.chain.id) {
        setActionError(`Your wallet is on another network. Switch to ${s.chain.name}.`);
        return;
      }
      await api.current.begin(request.id, { payloadHash: request.payloadHash, address, chainId });
      initiated.current.add(request.id);
      try {
        const result = (await wallet.provider.request(request.wallet)) as string;
        await api.current.result(
          request.id,
          request.kind === "transaction"
            ? { payloadHash: request.payloadHash, outcome: "submitted", hash: result }
            : { payloadHash: request.payloadHash, outcome: "signed", signature: result },
        );
      } catch (error) {
        const e = asProviderError(error);
        await api.current.result(
          request.id,
          e.code === 4001
            ? { payloadHash: request.payloadHash, outcome: "rejected", message: e.message }
            : {
                payloadHash: request.payloadHash,
                outcome: "error",
                message: e.message,
                ...(e.code !== undefined ? { code: e.code } : {}),
              },
        );
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [current, active, snapshot]);

  const reject = useCallback(async () => {
    if (!current || !api.current) return;
    setBusy(true);
    try {
      await api.current.result(current.id, {
        payloadHash: current.payloadHash,
        outcome: "rejected",
        message: "Rejected on the review page.",
      });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [current]);

  const switchNetwork = useCallback(async () => {
    const chain = snapshot?.chain;
    if (!active || !chain) return;
    setSwitching(true);
    setActionError(undefined);
    const chainIdHex = `0x${chain.id.toString(16)}`;
    try {
      await active.provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: chainIdHex }],
      });
    } catch (error) {
      const e = asProviderError(error);
      if (e.code === 4902 && chain.addChain) {
        try {
          await active.provider.request({
            method: "wallet_addEthereumChain",
            params: [chain.addChain],
          });
        } catch (addError) {
          setActionError(`Could not add ${chain.name}: ${asProviderError(addError).message}`);
        }
      } else if (e.code === 4902) {
        setActionError(
          `${chain.name} (chain ${chain.id}) is not in your wallet. Add it in the wallet's network settings.`,
        );
      } else if (e.code !== 4001) {
        setActionError(`Could not switch network: ${e.message}`);
      }
    } finally {
      setSwitching(false);
      void readAccount(active.provider, false)
        .then((address) => report(active, address))
        .catch(() => undefined);
    }
  }, [active, snapshot?.chain, report]);

  const cancelSession = useCallback(async () => {
    if (!api.current) return;
    if (!window.confirm("Cancel this session? The command in your terminal will stop.")) return;
    try {
      await api.current.cancel();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  // ---- Render --------------------------------------------------------------------------------
  const ended =
    snapshot && ["completed", "cancelled", "expired", "failed"].includes(snapshot.state);
  const walletName = snapshot?.wallet?.name ?? active?.name ?? "your wallet";

  return (
    <div class="shell">
      <header class="top">
        <div class="brand">
          <Mark />
          <span class="brand-name">Hatchway</span>
        </div>
        <div class="top-meta">
          {phase.kind === "live" && snapshot && !ended ? (
            <>
              <Pill tone="live">
                <span class="live-dot" aria-hidden="true" /> Connected to terminal
              </Pill>
              <span class="expires" title="Time left before this session expires">
                Ends in {formatRemaining(snapshot.expiresAt - now)}
              </span>
            </>
          ) : phase.kind === "reconnecting" ? (
            <Pill tone="warn">Reconnecting…</Pill>
          ) : null}
        </div>
      </header>

      <main class="main">
        {phase.kind === "pairing" ? <Loading /> : null}
        {phase.kind === "error" ? (
          <Message tone="bad" title={phase.title} body={phase.message} />
        ) : null}
        {phase.kind === "revoked" ? (
          <Message
            tone="bad"
            title="Session opened elsewhere"
            body="This session is now controlled by another browser tab. Use that tab, or close this one."
          />
        ) : null}
        {phase.kind === "lost" && !ended ? (
          <Message
            tone="bad"
            title="Lost connection to your terminal"
            body="The Hatchway command is no longer running. Check your terminal, then start the command again if needed."
          />
        ) : null}

        {snapshot && (phase.kind === "live" || phase.kind === "reconnecting" || ended) ? (
          <>
            {snapshot.wallet ? (
              <WalletBar
                snapshot={snapshot}
                icon={active?.icon}
                onSwitch={switchNetwork}
                switching={switching}
              />
            ) : null}

            {ended ? (
              <Ended snapshot={snapshot} />
            ) : !snapshot.wallet ? (
              <ConnectWallet
                snapshot={snapshot}
                wallets={wallets}
                connectingId={connectingId}
                error={connectError}
                onConnect={(w) => void connect(w, true)}
              />
            ) : current && current.state !== "queued" ? (
              <RequestCard
                request={current}
                snapshot={snapshot}
                now={now}
                walletName={walletName}
                busy={busy}
                error={actionError}
                initiatedHere={initiated.current.has(current.id)}
                blocked={blockedReason(snapshot, active)}
                onApprove={() => void approve()}
                onReject={() => void reject()}
              />
            ) : (
              <Idle snapshot={snapshot} preparing={current !== undefined} />
            )}

            {actionError && (!current || current.state === "queued") ? (
              <p class="form-error" role="alert">
                {actionError}
              </p>
            ) : null}

            {showActivity(snapshot, current) ? (
              <Activity snapshot={snapshot} currentId={current?.id} />
            ) : null}
          </>
        ) : null}
      </main>

      <footer class="foot">
        <p>
          <LockIcon /> Keys stay in your wallet. This page runs locally from your terminal and loads
          nothing from the internet.
        </p>
        {snapshot && !ended && phase.kind === "live" ? (
          <button type="button" class="link link-quiet" onClick={() => void cancelSession()}>
            Cancel session
          </button>
        ) : null}
      </footer>
    </div>
  );
}

/** The activity list only adds information when there is more than the request on screen. */
function showActivity(snapshot: SessionSnapshot, current: RequestView | undefined): boolean {
  const { requests } = snapshot;
  if (requests.length === 0) return false;
  if (requests.length > 1) return true;
  const only = requests[0]!;
  if (snapshot.state === "completed") return false;
  return only.id !== current?.id || only.state === "queued";
}

function pickCurrent(snapshot: SessionSnapshot | undefined): RequestView | undefined {
  if (!snapshot) return undefined;
  const open = snapshot.requests.filter((r) =>
    ["review", "in_wallet", "submitted"].includes(r.state),
  );
  if (open.length > 0) return open[open.length - 1];
  return snapshot.requests.find((r) => r.state === "queued");
}

function blockedReason(
  snapshot: SessionSnapshot,
  active: WalletOption | undefined,
): string | undefined {
  if (!active) return "Reconnect your wallet to continue.";
  if (snapshot.walletIssue === "wrong_chain")
    return `Switch your wallet to ${snapshot.chain?.name ?? "the expected network"} first.`;
  if (snapshot.walletIssue === "wrong_account")
    return `Switch your wallet back to ${snapshot.wallet?.address ?? "the connected account"}.`;
  if (snapshot.walletIssue === "disconnected")
    return "Your wallet disconnected from this page. Reconnect it to continue.";
  return undefined;
}

function pairingError(error: unknown): Phase {
  if (error instanceof ApiFailure) {
    if (error.code === "UNKNOWN_SESSION" || error.status === 404) {
      return {
        kind: "error",
        title: "Session not found",
        message: "This session has ended or never existed. Run the command in your terminal again.",
      };
    }
    if (error.code === "NO_LINK")
      return { kind: "error", title: "Open the link from your terminal", message: error.message };
    return {
      kind: "error",
      title: "This link can't be used",
      message: `${error.message} If you opened it before, use that tab, or copy the newest link from your terminal.`,
    };
  }
  return {
    kind: "error",
    title: "Could not reach your terminal",
    message: "Make sure the Hatchway command is still running.",
  };
}

function WalletBar({
  snapshot,
  icon,
  onSwitch,
  switching,
}: {
  snapshot: SessionSnapshot;
  icon: string | undefined;
  onSwitch: () => void;
  switching: boolean;
}) {
  const wallet = snapshot.wallet!;
  const chain = snapshot.chain;
  const issue = snapshot.walletIssue;
  return (
    <div class={`walletbar ${issue ? "has-issue" : ""}`}>
      <div class="walletbar-main">
        <span class="wallet-icon small">
          {icon ? <img src={icon} alt="" width={22} height={22} /> : <WalletIcon />}
        </span>
        <span class="walletbar-text">
          <span class="walletbar-name">{wallet.name}</span>
          <Hex value={wallet.address} />
        </span>
      </div>
      <div class="walletbar-net">
        {chain ? (
          <Pill tone={issue === "wrong_chain" ? "bad" : chain.testnet ? "neutral" : "warn"}>
            {issue === "wrong_chain" ? "Wrong network" : chain.name}
          </Pill>
        ) : (
          <Pill tone="neutral">Waiting for network</Pill>
        )}
      </div>
      {issue === "wrong_chain" && chain ? (
        <div class="walletbar-issue" role="alert">
          <span>
            This session deploys to {chain.name} (chain {chain.id}).
          </span>
          <button type="button" class="btn btn-small" onClick={onSwitch} disabled={switching}>
            {switching ? <Spinner /> : null} Switch to {chain.name}
          </button>
        </div>
      ) : null}
      {issue === "wrong_account" ? (
        <div class="walletbar-issue" role="alert">
          <span>
            The selected account changed. Switch back to <Hex value={wallet.address} /> in your
            wallet.
          </span>
        </div>
      ) : null}
      {issue === "disconnected" ? (
        <div class="walletbar-issue" role="alert">
          <span>
            Your wallet disconnected from this page. Reconnect it from the wallet, or reload the
            page.
          </span>
        </div>
      ) : null}
    </div>
  );
}

function Idle({ snapshot, preparing }: { snapshot: SessionSnapshot; preparing: boolean }) {
  const done = snapshot.requests.filter(
    (r) => r.state === "confirmed" || r.state === "signed",
  ).length;
  const queued = snapshot.requests.find((r) => r.state === "queued");
  if (snapshot.walletIssue) {
    return (
      <section class="card idle enter" role="status">
        <span class="idle-mark" aria-hidden="true">
          <span class="dot" />
        </span>
        <div>
          <p class="eyebrow">Paused</p>
          <h1>Check your wallet</h1>
          <p class="lede">
            {queued
              ? "A request is waiting. It will appear here once your wallet matches the session above."
              : "Requests appear here once your wallet matches the session above."}
          </p>
        </div>
      </section>
    );
  }
  const text =
    queued?.waitingFor === "previous_confirmation"
      ? "Waiting for the previous transaction to confirm before showing the next one."
      : preparing
        ? "Preparing the next request: decoding and simulating it."
        : done > 0
          ? "Waiting for the next request from your terminal."
          : snapshot.chain
            ? `Your wallet is ready. Requests from ${snapshot.purpose.kind === "connect" ? "your tools" : "your terminal"} will appear here, one at a time.`
            : "Waiting for the script to choose a network…";
  return (
    <section class="card idle enter" role="status">
      <span class="idle-mark" aria-hidden="true">
        {preparing ? <Spinner /> : <span class="pulse" />}
      </span>
      <div>
        <p class="eyebrow">{done > 0 ? `${done} done` : "Step 2 of 2"}</p>
        <h1>{preparing ? "Preparing…" : "Ready"}</h1>
        <p class="lede">{text}</p>
      </div>
    </section>
  );
}

function Ended({ snapshot }: { snapshot: SessionSnapshot }) {
  const deployed = snapshot.requests.filter(
    (r) => r.state === "confirmed" && r.result?.contractAddress,
  );
  const sent = snapshot.requests.filter((r) => r.state === "confirmed" || r.state === "signed");
  if (snapshot.state === "completed") {
    return (
      <section class="card done enter" role="status">
        <span class="done-mark" aria-hidden="true">
          <CheckIcon />
        </span>
        <h1>{sent.length > 0 ? "All done" : "Session finished"}</h1>
        <p class="lede">
          {sent.length > 0
            ? `${sent.length} request${sent.length === 1 ? "" : "s"} approved${deployed.length ? `, ${deployed.length} contract${deployed.length === 1 ? "" : "s"} deployed` : ""}. You can close this tab and return to your terminal.`
            : "Nothing needed your wallet. You can close this tab."}
        </p>
        {deployed.length > 0 ? (
          <dl class="rows">
            {deployed.map((r) => (
              <div class="row" key={r.id}>
                <dt>{r.review?.contractName ?? "Contract"}</dt>
                <dd>
                  <Hex
                    value={r.result!.contractAddress!}
                    href={
                      snapshot.chain?.explorerUrl
                        ? `${snapshot.chain.explorerUrl}/address/${r.result!.contractAddress}`
                        : undefined
                    }
                  />
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
      </section>
    );
  }
  const titles: Record<string, string> = {
    cancelled: "Session cancelled",
    expired: "Session expired",
    failed: "Session ended with an error",
  };
  return (
    <Message
      tone="bad"
      title={titles[snapshot.state] ?? "Session ended"}
      body={`${snapshot.endedReason ?? ""} Check your terminal for details.`.trim()}
    />
  );
}

function Message({ tone, title, body }: { tone: "bad" | "neutral"; title: string; body: string }) {
  return (
    <section
      class={`card message-card tone-${tone} enter`}
      role={tone === "bad" ? "alert" : "status"}
    >
      <h1>{title}</h1>
      <p class="lede">{body}</p>
    </section>
  );
}

function Loading() {
  return (
    <section class="card" aria-busy="true">
      <span class="skeleton skeleton-title" />
      <span class="skeleton skeleton-text" />
      <span class="skeleton skeleton-text short" />
    </section>
  );
}
