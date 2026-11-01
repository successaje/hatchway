# Architecture and decisions

## Overview

```text
packages/
  hatchway/            the npm package: CLI, bridge, engine, Hardhat plugin, bundled UI
    src/core/          session state, approval engine, protocol types, errors, secrets
    src/evm/           transaction validation, chains, RPC client, artifacts, review builder
    src/server/        loopback HTTP server, security checks, JSON-RPC handler, static assets
    src/adapters/      Foundry and Hardhat project/tool handling, child processes
    src/hardhat/       the `hatchway/hardhat` plugin (network onRequest hook)
    src/cli/           commands, argument parsing, terminal and NDJSON output, run records
  signing-ui/          Preact page, built into hatchway/dist/ui
examples/foundry, examples/hardhat-basic
e2e/                   Playwright tests with a deterministic EIP-6963 wallet
```

Runtime flow for one session:

1. A command starts a `Bridge`: a `Session`, an `ApprovalEngine`, a `HatchwayServer` on a
   random loopback port, and (when known) an `UpstreamRpc` for the developer's endpoint.
2. The browser opens `/s/<session>#<pairing code>`, redeems the code for a token, and receives
   session snapshots over server-sent events.
3. The wrapped tool talks JSON-RPC to `/rpc/<token>`. Reads are forwarded upstream; wallet
   methods become `ApprovalRequest`s.
4. The engine shows requests one at a time; the page hands each to the wallet; the engine
   verifies the broadcast, tracks the receipt and answers the tool.

## Decisions

### ADR-1: Local JSON-RPC bridge, wallet broadcasts

Browser wallets do not offer raw transaction signing (`eth_signTransaction`) in general, and a
signing bridge that hands raw bytes back would be more powerful than needed. The wallet signs
and broadcasts through `eth_sendTransaction`; tools receive the hash. Tools that require raw
signed bytes are out of scope and receive a clear error.

### ADR-2: Foundry via `--unlocked --sender --slow`

Officially supported, preserves forge's simulation, nonces, artifacts and receipts. `--slow`
aligns forge with one-at-a-time human approval. See
[foundry-integration.md](../research/foundry-integration.md).

### ADR-3: Hardhat via an `onRequest` network hook

No configuration beyond adding the plugin, works for any HTTP network, keeps Hardhat's own
request handling for reads, and shares the engine with Foundry. See
[hardhat-integration.md](../research/hardhat-integration.md).

### ADR-4: TypeScript on Node.js, single published package

The wallet ecosystem (EIP-1193/6963, viem), the Hardhat plugin, and the browser page are all
JavaScript; a Rust bridge would add a second toolchain without a concrete benefit. One npm
package (`hatchway`) contains the CLI, the plugin (`hatchway/hardhat` subpath) and the prebuilt
page, so there is nothing else to install or start. Runtime dependencies: viem, picocolors,
open.

### ADR-5: One session per process, in memory

No database, no daemon. Sessions end with the process. Two terminals mean two independent
servers on different ports, so there is no cross-session state to confuse.

### ADR-6: Pairing code in the fragment, bearer token in sessionStorage

The fragment is never sent to the server or in `Referer`. It is exchanged once for a token held
in `sessionStorage` (survives a reload of that tab, not shared with other tabs or browsers) and
sent in an `Authorization` header, which also defeats CSRF without cookies. Server-sent events
are read with `fetch` streaming so the header can be used.

### ADR-7: Strict sequencing

A request is shown only after the previous transaction is mined. Reviews and simulations then
reflect the state the transaction executes against; a revert stops the remaining requests;
and nonce expectations stay simple. The cost is one block of latency per transaction on public
networks, which matches `forge --slow`.

### ADR-8: Verify every broadcast

The page is trusted code, but wallets can change nonces (MetaMask ignores dapp nonces) or let
users edit data. Fetching the transaction by hash and comparing it with the approved request
turns a silent divergence into a clear stop.

### ADR-9: Snapshots, not deltas, over SSE

Session state is small. Sending the whole snapshot on every change (coalesced) removes a whole
class of client/server desynchronisation bugs.

### ADR-10: Machine-readable output as NDJSON events

`--json` prints one event per line (`session`, `wallet`, `request`, `submitted`, `confirmed`,
`failed`, `result`) so an agent can show the link to a human, follow progress and read the
result without parsing prose. Human output moves to stderr in that mode.

## Protocol versioning

`packages/hatchway/src/core/protocol.ts` defines the browser protocol and is imported by both
sides; `PROTOCOL_VERSION` is 1. The page and server always ship together in one package, so the
protocol is internal and may change between minor versions. It is not a public API.
