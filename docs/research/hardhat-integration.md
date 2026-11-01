# Hardhat integration research

Target: Hardhat 3 (verified with 3.21.2), with ethers, viem and Ignition working unchanged.

## Findings

- **Plugins** are objects with `id`, `npmPackage` and lazily imported `hookHandlers`
  (`hardhat/types/plugins`).
- **Network hooks** (`hardhat/types/hooks` → `NetworkHooks`) include
  `onRequest(context, connection, request, next)`, called for every JSON-RPC request on every
  network connection.
- **Hook order.** Chained hooks run in reverse plugin registration order
  (`internal/core/hook-manager.js`), so a user plugin's `onRequest` runs **before** the built-in
  network plugin applies its request handlers (local accounts, gas defaults, chain checks).
  A plugin can therefore answer `eth_accounts` and `eth_sendTransaction` itself.
- **Resolved config.** `connection.networkConfig` exposes `type`, `url` (a
  `ResolvedConfigurationVariable`; `await url.get()` returns the string) and `httpHeaders`.
- **Defaults.** HTTP networks default to `accounts: "remote"` and a 300 s request timeout.
  The default network is the in-process EDR simulation, which a browser wallet cannot reach.
- **Ignition** sends `eth_sendTransaction` with explicit `nonce`, `gas` and fees, and refuses
  to continue if it sees pending transactions it did not send.

## Options considered

| Option                                                        | Verdict                                                                                          |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Ask users to add a network pointing at a local proxy URL      | Works, but the URL changes per run and duplicates the real endpoint. Kept as the `connect` path. |
| `extendUserConfig` hook that rewrites network URLs            | Rejected: the selected network is unknown at config time and URLs may be config variables.       |
| **`onRequest` hook forwarding wallet methods to the session** | **Chosen.** No config changes beyond adding the plugin; works for any HTTP network.              |

## Design

1. `hatchway hardhat <args>` starts a session **without** an upstream RPC and runs Hardhat's
   own CLI (resolved from the project's `node_modules`) with `HATCHWAY_BRIDGE_URL` set.
2. The plugin is inert without that variable. With it, for HTTP networks, it intercepts
   `eth_accounts`, `eth_requestAccounts`, `eth_sendTransaction`, `personal_sign` and the
   typed-data methods; all other requests go through `next()` to the user's network unchanged.
3. On the first intercepted call per connection, the plugin sends `hatchway_attach` with the
   resolved URL and headers. The session adopts that endpoint as its upstream for simulation,
   nonce checks, verification and receipts. A second, different network is rejected.
4. `eth_accounts` blocks until a wallet is connected, so `ethers.getSigners()` returns the
   wallet address.
5. The in-process network gets a clear error telling the user to pass `--network`.

The same approval engine serves Foundry, Hardhat and `connect`; only the transport differs.

## Verified (integration tests, Hardhat 3.21.2 + Anvil)

| Scenario                                            | Result                                           |
| --------------------------------------------------- | ------------------------------------------------ |
| `hardhat run` with `ethers.deployContract` + calls  | 3 transactions, all confirmed                    |
| `signer.signMessage`                                | Signed in wallet, recovered address matches      |
| `hardhat ignition deploy` (2 contracts + call)      | 3 transactions confirmed                         |
| Wallet rejection                                    | Script fails, exit code 3                        |
| Reverting call                                      | Caught by ethers' gas estimate before the wallet |
| Missing `--network` / in-process network            | Clear usage error                                |
| Installed from the npm tarball into a clean project | Deploys successfully                             |

## Not supported

- Hardhat 2 through `hatchway hardhat` (use `hatchway connect` and point a network at the
  printed endpoint).
- Hardhat's in-process network (`default`/`hardhat`).
- Networks configured with local `accounts` keep working for reads, but signing always goes to
  the browser wallet while the plugin is active.
