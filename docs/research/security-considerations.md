# Security considerations and threat model

Hatchway brokers financial transactions between local tools and a browser wallet. This
document lists what it protects, against whom, how, and what remains open. It reflects a
self-review plus automated tests; it is **not** an independent audit.

## Assets

1. **Wallet authority.** The ability to get a transaction or signature approved. The private
   key itself never reaches Hatchway.
2. **Approval integrity.** The transaction approved is the one the tool asked for.
3. **Session capability.** The pairing code, browser token and RPC token.
4. **Developer secrets.** RPC URLs and headers that may contain API keys.

## Trust boundaries and assumptions

- **Trusted:** the user, their wallet, the Hatchway process, and the tool it launches.
- **Same-user local processes** are not a boundary Hatchway can enforce; such a process can
  read memory, environment variables and browser profiles. Hatchway avoids handing them extra
  power (tokens are never written to disk; the RPC endpoint needs a 256-bit token).
- **Untrusted:** every web page in the user's browser, other users on the machine, the network,
  and repository content (scripts, artifacts) as a source of _labels_ (see below).

## Threats and mitigations

| Threat                                                 | Mitigation                                                                                                                                                 | Test                  |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| Exposure to the LAN                                    | Binds `127.0.0.1` only                                                                                                                                     | security              |
| DNS rebinding (attacker domain resolving to 127.0.0.1) | Rejects any non-loopback `Host` header (421)                                                                                                               | security              |
| CSRF from a malicious page                             | Browser API requires same-origin `Origin`, `Sec-Fetch-Site` same-origin when present, and a bearer token in a custom header (not a cookie)                 | security              |
| Malicious page calling the tool RPC endpoint           | Token in path, and any request with `Origin` or `Sec-Fetch-Site` is refused                                                                                | security              |
| Session link leakage (history, referrer, logs)         | Pairing code lives in the URL fragment (never sent over HTTP, never in `Referer`), removed via `history.replaceState`, and burned once a wallet is bound   | e2e                   |
| Link reuse / second tab or browser                     | New claims revoke older browser tokens; after binding, the link no longer works; a fresh link is printed if the tab disconnects                            | security, e2e         |
| Cross-session confusion                                | One session per process and port; tokens and session ids are checked against the serving session                                                           | security, e2e         |
| Replayed or forged results                             | Results accepted only for a request in the right state with the matching payload hash; one answer per request                                              | engine                |
| Transaction substitution between review and signing    | Page re-checks account and chain, server re-validates before `begin`; the broadcast transaction is fetched and `from/to/data/value/nonce/chainId` compared | forge (tamper)        |
| Wallet chooses a different nonce (MetaMask)            | Detected by the post-broadcast comparison; run stops with exit code 9                                                                                      | forge                 |
| Duplicate broadcasts from tool retries                 | Retries keyed by sender+nonce+payload join the open approval or receive the stored outcome                                                                 | forge-timeout, engine |
| Approval after the tool gave up                        | Abandoned requests are withdrawn before the wallet is asked; if already in the wallet the terminal warns                                                   | engine                |
| Lost wallet answer (page reloaded mid-approval)        | While a request is in the wallet, the chain is scanned for a matching transaction from the account and it is adopted                                       | engine                |
| Blind signing                                          | `eth_sign` blocked; typed data shown with domain; permits and approvals flagged                                                                            | engine                |
| Locally signed transactions slipping through           | `eth_sendRawTransaction` and `eth_signTransaction` blocked; forge signer flags refused                                                                     | engine, unit          |
| Script injection into the signing page                 | Strict CSP (`script-src 'self'`, no inline), all assets bundled, no third-party scripts or analytics; wallet icons limited to `data:image/*`               | security              |
| Clickjacking                                           | `frame-ancestors 'none'`, `X-Frame-Options: DENY`                                                                                                          | security              |
| Secret leakage in output                               | RPC URLs redacted for display; credentials, query values and key-like path segments scrubbed from all terminal/JSON output, including tool output          | unit                  |
| Oversized or malformed input                           | Body limits (64 KB API, 16 MB RPC), strict JSON shape checks, transaction field validation                                                                 | security, unit        |
| Unsupported transaction kinds                          | EIP-7702 authorizations, blob and access-list transactions rejected                                                                                        | unit                  |
| Stale sessions                                         | Absolute TTL (default 2 h), wallet-connect timeout (15 min), per-request approval timeout (15 min)                                                         | unit, engine          |

## Labels are hints, the wallet is the authority

Contract names, decoded arguments and "simulation passed" come from the project's build
artifacts and the developer's RPC. A malicious repository could make a review page say
"Deploy SafeToken" for arbitrary bytecode. The page states that the wallet shows the final
transaction, and the wallet remains the only place a signature can be produced. Simulation is
reported as passed / failed / unavailable and never implies safety.

## Dependency review

Runtime dependencies are deliberately few: `viem`, `picocolors`, `open` (and their trees).
The signing page bundles only Preact. CI runs `pnpm audit --prod --audit-level high`.

One advisory is ignored with justification: **GHSA-mrhx-c7xc-m3w5** (Zod memory exhaustion,
fixed in 4.6.6). Zod is an _optional_ peer of `abitype` (used by viem) and is never imported by
viem or Hatchway; it appears in the workspace only because Hardhat 3 depends on Zod 3. npm does
not install optional peers for consumers. Re-evaluate when Hardhat moves to Zod ≥ 4.6.6.

## Open risks

- **No independent audit.** The design and tests are the author's own.
- **Real-wallet behaviour** (MetaMask, Rabby) is covered by a manual acceptance procedure, not
  by automated tests; wallets change behaviour between releases.
- **Same-user malware** can read the session URL from the terminal or the process environment.
- **Forge timeouts.** On forge builds that drop held requests after 45 s, a user who approves
  in the wallet after forge has given up still broadcasts a transaction forge does not know
  about. Hatchway warns in that case; `--resume` behaviour is forge's.
- **Reorgs.** Confirmation means "included in a block"; Hatchway does not wait for a
  configurable number of confirmations.
- **Public RPC trust.** Simulation and verification use the developer's RPC; a malicious RPC
  could misreport. The wallet uses its own RPC for broadcasting.
