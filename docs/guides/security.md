# Security

## The promise

Hatchway never asks for, receives, stores or logs a seed phrase, private key, keystore,
wallet password, or signed raw transaction. Your wallet signs and broadcasts every transaction
after you approve it there. Connecting a wallet only shares its address.

## What you should check

- **The terminal and the page agree.** The page shows the command it belongs to and the
  network; the terminal shows the connected address.
- **Your wallet is the authority.** The page decodes requests using your project's build
  artifacts and your RPC endpoint. Those are helpful labels, not guarantees: a malicious
  dependency or repository could label bytecode misleadingly. Check the wallet prompt
  (recipient, value, network) before confirming.
- **Simulation is not a safety proof.** "Simulation passed" means the call did not revert
  against the current state on your RPC. It says nothing about what the contract does.
- **Warnings matter.** The page flags value transfers, production networks, token approvals,
  ownership changes, proxy upgrades, permits, contracts without code, and low balances.

## How the local session is protected

- The server listens on `127.0.0.1` only and rejects requests whose `Host` is not a loopback
  name (blocks DNS rebinding).
- The session link carries a one-time pairing code in the URL fragment, which browsers never
  send to servers or in `Referer`. The page removes it from the address bar on load and trades
  it for a token kept in that tab only. The link works once; a tab without a wallet can mint a
  one-time link for another browser.
- Every browser API call needs that token and a same-origin `Origin` header (blocks CSRF).
- The page loads only bundled files under a strict Content Security Policy: no remote
  scripts, no analytics, no trackers, no frames.
- The endpoint used by forge or Hardhat requires its own random token and refuses requests
  that come from a browser.
- Each approval is bound to the session, account, chain and the exact payload. After the
  wallet broadcasts, Hatchway fetches the transaction and checks sender, recipient, data,
  value, nonce and chain. Any difference stops the run.
- Retries from tools never create second prompts or second transactions.

## What Hatchway cannot protect against

- Malware running as your user (it could read the link from your terminal).
- A compromised wallet extension or browser.
- Bugs in the contracts you deploy.
- A malicious RPC endpoint misreporting simulation results (your wallet uses its own RPC to
  broadcast).

The full threat model, test coverage per threat, and open risks are in
[security-considerations.md](../research/security-considerations.md). Hatchway has **not** had
an independent security audit.

Report vulnerabilities privately as described in [SECURITY.md](../../SECURITY.md).
