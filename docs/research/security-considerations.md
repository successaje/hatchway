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

| Threat                                                     | Mitigation                                                                                                                                                                                                                                                  | Test                    |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| Exposure to the LAN                                        | Binds `127.0.0.1` only                                                                                                                                                                                                                                      | security                |
| DNS rebinding (attacker domain resolving to 127.0.0.1)     | Rejects any non-loopback `Host` header (421)                                                                                                                                                                                                                | security                |
| CSRF from a malicious page                                 | Browser API requires same-origin `Origin`, `Sec-Fetch-Site` same-origin when present, and a bearer token in a custom header (not a cookie)                                                                                                                  | security                |
| Malicious page or other user calling the tool RPC endpoint | Token in path, any request with `Origin` or `Sec-Fetch-Site` refused, and the URL is passed to forge in its environment (readable only by the user) rather than its arguments (visible to all users)                                                        | security, forge         |
| Session link leakage (history, referrer, logs)             | Pairing code lives in the URL fragment (never sent over HTTP, never in `Referer`), removed via `history.replaceState`, and **single-use**: a copy is worthless once opened                                                                                  | security, e2e           |
| Link reuse / second tab or browser                         | Each code works once; the paired tab can mint a one-time handoff link (before a wallet is bound); a fresh link is printed if the tab disconnects; a new claim revokes the older tab                                                                         | security, e2e           |
| Cross-session confusion                                    | One session per process and port; tokens and session ids are checked against the serving session                                                                                                                                                            | security, e2e           |
| Replayed or forged results                                 | Results accepted only for a request in the right state with the matching payload hash; one answer per request                                                                                                                                               | engine                  |
| Transaction substitution between review and signing        | Page re-checks account and chain, server re-validates before `begin`; the broadcast transaction is fetched and `from/to/data/value/nonce/chainId` compared                                                                                                  | forge (tamper)          |
| Wallet chooses a different nonce (MetaMask)                | Detected by the post-broadcast comparison; run stops with exit code 9                                                                                                                                                                                       | forge                   |
| Fabricated or replayed hashes                              | Hashes are released only after the broadcast is found and matches; unknown hashes fail on local nodes; hashes already used, or older transactions with the same contents, are rejected; on public chains, contents are checked when the transaction appears | engine                  |
| Duplicate broadcasts from tool retries                     | Retries keyed by sender+nonce+payload join the open approval or receive the stored outcome                                                                                                                                                                  | forge-timeout, engine   |
| Approval after the tool gave up                            | Abandoned requests are withdrawn before the wallet is asked; if already in the wallet the terminal warns                                                                                                                                                    | engine                  |
| Wallet sends a request after it was withdrawn              | The account is watched for 10 minutes after a withdrawal; a matching broadcast stops the run with a clear warning                                                                                                                                           | engine                  |
| Lost wallet answer (page reloaded mid-approval)            | While a request is in the wallet, the chain is scanned for a matching transaction from the account and it is adopted                                                                                                                                        | engine                  |
| Blind signing                                              | `eth_sign` blocked; typed data shown with domain; permits and approvals flagged                                                                                                                                                                             | engine                  |
| Locally signed transactions slipping through               | Only read namespaces are forwarded (allow-list); every send/sign variant (raw, sync, bundle, private, `personal_*`, dev-node admin, case tricks) is refused; the Hardhat plugin routes all of them to the session; forge signer flags refused               | security, hardhat, unit |
| Terminal injection                                         | Control characters (ANSI/OSC sequences) stripped from revert strings, wallet messages, tool output and labels                                                                                                                                               | unit                    |
| Script injection into the signing page                     | Strict CSP (`script-src 'self'`, no inline), all assets bundled, no third-party scripts or analytics; wallet icons limited to `data:image/*`                                                                                                                | security                |
| Clickjacking                                               | `frame-ancestors 'none'`, `X-Frame-Options: DENY`                                                                                                                                                                                                           | security                |
| Secret leakage in output and files                         | RPC URLs redacted for display; credentials, query values, key-like path segments and host labels scrubbed from all terminal/JSON output (including tool output and endpoints attached later) and from run records                                           | unit                    |
| Oversized or malformed input                               | Body limits (64 KB API, 16 MB RPC), strict JSON shape checks, transaction field validation                                                                                                                                                                  | security, unit          |
| Unsupported transaction kinds                              | EIP-7702 authorizations, blob and access-list transactions rejected                                                                                                                                                                                         | unit                    |
| Stale sessions                                             | Absolute TTL (default 2 h), wallet-connect timeout (15 min), per-request approval timeout (15 min)                                                                                                                                                          | unit, engine            |

## Independent review (2026-11-01)

A reviewer who had not written the code audited the server, session, engine, plugin and page,
and confirmed most findings with throwaway probes. All findings were addressed before the
first release candidate; regression tests cover each.

| #   | Finding                                                                                                        | Severity              | Resolution                                                                            |
| --- | -------------------------------------------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------- |
| 1   | Hash released when the broadcast could not be found; contents never checked later                              | Medium-High           | Fixed: local nodes fail; public chains verify on appearance                           |
| 2   | Retried caller could receive the hash before verification finished                                             | Medium                | Fixed: callers always wait for the verified result                                    |
| 3   | Raw `--rpc-url`/API-key flags written to run records                                                           | Medium                | Fixed: commands sanitized before writing                                              |
| 4   | RPC token visible to other users through forge's process arguments                                             | Medium (shared hosts) | Fixed: passed via `ETH_RPC_URL`                                                       |
| 5   | Block-list forwarding let raw-send variants through; plugin skipped raw sends                                  | Medium-Low            | Fixed: read allow-list; plugin routes all send/sign methods                           |
| 6   | Older matching transaction accepted when the request had no nonce                                              | Low-Medium            | Fixed: nonce floor and duplicate-hash check                                           |
| 7   | Concurrent `hatchway_attach` calls could rebind the network                                                    | Low                   | Fixed: single attach attempt shared by callers                                        |
| 8   | Pairing code reusable until a wallet connected                                                                 | Low                   | Fixed: single-use code plus authenticated handoff link                                |
| 9   | Terminal escape sequences from untrusted text                                                                  | Low                   | Fixed: control characters stripped                                                    |
| 10  | Endpoint attached later not scrubbed; key patterns missed                                                      | Low                   | Fixed: dynamic secret sources; broader patterns                                       |
| 11  | Withdrawn request could still be sent by an open wallet prompt, silently                                       | Low                   | Fixed: late-broadcast watch stops the run                                             |
| 12  | Info: personal_sign text verification, HTML via asset path, 7702/legacy checks, unbound typed data, batch size | Info                  | Fixed; claim lockout and `requestTimeout = 0` accepted (local denial of service only) |

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
- **Browser launch arguments.** On Linux, the session URL is briefly visible in the arguments of
  the `xdg-open` process. The code is single-use, so a racing reader would be noticed (the
  user's tab reports the link as used); pass `--no-open` on shared machines.
- **Local denial of service.** A local process can exhaust the failed-claim limit or hold
  connections open; this cannot approve anything.
- **Forge timeouts.** On forge builds that drop held requests after 45 s, a user who approves
  in the wallet after forge has given up still broadcasts a transaction forge does not know
  about. Hatchway warns in that case; `--resume` behaviour is forge's.
- **Reorgs.** Confirmation means "included in a block"; Hatchway does not wait for a
  configurable number of confirmations.
- **Public RPC trust.** Simulation and verification use the developer's RPC; a malicious RPC
  could misreport. The wallet uses its own RPC for broadcasting.
