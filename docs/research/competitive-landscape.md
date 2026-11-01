# Competitive landscape

Researched 2026-11-01 by reading source code and READMEs (not marketing pages). Tags:
**[code]** read in source, **[docs]** official docs/README, **[run]** observed by running it
here, **[inferred]** reading of code not exercised at runtime.

## Summary

| Tool                                     | How it signs                                    | Foundry scripts                | Hardhat 3 | Notes                                                                         |
| ---------------------------------------- | ----------------------------------------------- | ------------------------------ | --------- | ----------------------------------------------------------------------------- |
| **Foundry `--browser`** (built in)       | Local queue polled by a page; wallet broadcasts | Yes (`forge script`, `create`) | —         | Raw JSON review; new session per command; no Host check; 300 s timeout        |
| **gskril/browser-rpc**                   | Local JSON-RPC proxy, one tab per request       | Yes, via `--unlocked`          | Yes       | Closest design to Hatchway; young (npm 0.0.12); no LICENSE file               |
| **nikicat/browser-web3-signer**          | Per-request CLI/library                         | No                             | No        | Cannot deploy EVM contracts (`to` required); bridge unauthenticated, CORS `*` |
| **Frame**                                | Desktop wallet exposing RPC on :1248            | Yes, via `--unlocked`          | Yes       | Archived (2025); requires adopting Frame as your wallet                       |
| **@web3camp/hardhat-metamask-connector** | Replaces `signer.sendTransaction`               | No                             | No (HH2)  | Depends on Hardhat 2 APIs                                                     |
| **thirdweb deploy**                      | Uploads to IPFS, deploy in their dashboard      | No (single contracts)          | Partly    | Requires a thirdweb secret key; does not run deployment scripts               |
| **foundry-dashboard**                    | Truffle-Dashboard-style RPC + page              | Yes                            | —         | Decodes from artifacts; stale since 2025-05; no license                       |

## Foundry's native browser wallet

Foundry ships `--browser` for `cast send` (PR #12302, 2025-11), `forge script` (PR #12952,
2026-01) and `forge create` (PR #14394, 2026-04). The implementation now lives in
`foundry-rs/foundry-core/crates/wallets/src/wallet_browser` **[code]**.

- **Mechanism.** An axum server on `127.0.0.1:9545` (fixed default port; in use = hard error)
  holds a FIFO queue. The page polls it every second, calls the wallet's `eth_sendTransaction`
  through viem, and posts back the hash. Forge never gets a signed transaction **[code]**.
- **Review.** The page shows a "Sign & Send" button and the raw request JSON; calldata is not
  decoded **[code]**.
- **Security.** Loopback bind, a per-run UUID token in an `X-Session-Token` header, strict CORS
  and a CSP. There is no `Host` header check (no explicit DNS-rebinding defence), the token is
  embedded in an unauthenticated `main.js`, and a returned hash is not compared with the
  request **[code]**.
- **Limits.** One sender per run, 300 s timeout, a new session per command, forge does not
  switch chains, and the version installed here (nightly 2026-04-27) cannot sign messages
  **[code, docs]**. On master, forge now saves browser/unlocked requests before submitting and
  fails closed on ambiguous outcomes (PR #16996, 2026-09) **[code]**.

**Implication.** For a Foundry-only user on a recent forge who is happy with raw JSON review,
`--browser` is a reasonable choice and Hatchway should say so. Hatchway's differences are
cross-tool support (Hardhat 3, Ignition, viem, cast via one endpoint), decoded review with
simulation, stronger local-boundary and post-broadcast checks, NDJSON for automation, and
compatibility with older forge versions through `--unlocked`.

## gskril/browser-rpc

A Hono proxy on `127.0.0.1:8545` that forwards reads upstream and intercepts
`eth_sendTransaction`, `eth_sign`, `personal_sign` and typed data; its README documents
`forge script --unlocked --sender` and a Hardhat 3 network config **[docs, code]**. It holds the
request open (5-minute timeout), opens one browser tab per request, and added Host and Origin
allowlists in July 2026 **[code]**. It does not de-duplicate forge's retries or order
concurrent sends by nonce **[inferred]**, and it does not check the broadcast transaction
against the request **[inferred]**. The README says MIT but the repository has no LICENSE file,
so no code was reused from it.

## nikicat/browser-web3-signer

A Rust core with EVM and TRON front ends, exposed as a one-shot CLI and as a `serve` mode for TS
and Go bindings. It is not an RPC proxy and has no forge or Hardhat integration. Its EVM
`eth_sendTransaction` requires a `to` address, so it cannot deploy contracts. The README states
the bridge is unauthenticated, and CORS allows any origin **[docs, code]**. MIT; active but very
small.

## Frame, Hardhat connectors, thirdweb

- **Frame** exposes `http://127.0.0.1:1248` and worked well with `--unlocked`, but it is a
  separate wallet application, reads go through its own RPC, and the project is archived
  (GPL-3.0) **[docs]**.
- **Hardhat** has no native browser-wallet support; official signer plugins are Ledger and
  keystore. HTTP networks default to `accounts: "remote"`, so any proxy that answers
  `eth_accounts` works **[docs]**. The only MetaMask connector found targets Hardhat 2.
- **thirdweb deploy** needs a thirdweb secret key, uploads sources and bytecode to IPFS, and
  hands off to a web dashboard; it deploys single contracts and does not run scripts **[code]**.

## What Hatchway reuses conceptually

- The proxy-plus-page split pioneered by Truffle Dashboard and Frame, which keeps the
  developer's toolchain untouched.
- EIP-6963 discovery and the "wallet broadcasts, tool receives the hash" model that Foundry,
  browser-rpc and browser-web3-signer all use.

## What Hatchway avoids

- One browser tab per request (browser-rpc) or polling queues (Foundry): a single page with
  server-sent events shows requests in order.
- Unauthenticated bridges or permissive CORS (browser-web3-signer).
- Trusting a hash returned by the page without checking it on-chain (Foundry, browser-rpc).
- Requiring an account, API key or hosted dashboard (thirdweb).

No third-party code was copied. Hatchway's own code is MIT licensed.
