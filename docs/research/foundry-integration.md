# Foundry integration research

Goal: run an unmodified `forge script` while a browser wallet authorises every broadcast, with
script semantics, sender identity, nonces and `broadcast/` artifacts preserved.

## Options considered

| Option                                           | Verdict                                                                                                                |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Wrap Foundry's own `--browser`                   | Rejected: it is Foundry's UI and session, so Hatchway would add nothing; it is also missing from older forge versions. |
| **`--unlocked --sender` + local RPC bridge**     | **Chosen.** Officially supported forge flag: "Send via `eth_sendTransaction` using the `--sender` argument as sender". |
| External signer plugin                           | Not available: forge has no pluggable signer interface outside its built-in list.                                      |
| Re-implement scripts (compile + deploy bytecode) | Rejected: not equivalent to running arbitrary scripts (loops, conditionals, calls, CREATE2, libraries).                |

With `--unlocked`, forge still simulates the script locally, estimates gas, computes nonces,
writes `broadcast/<script>/<chain>/run-latest.json`, waits for receipts and supports
`--verify`. Only the signing step changes: forge calls `eth_sendTransaction` on the RPC URL.

## Verified behaviour (forge 1.6.0-nightly, 2026-04-27)

All of these were observed by running forge against a logging proxy in front of Anvil **[run]**:

1. **Request shape.** Each send carries `from`, `to` (`null` for creation), `input` (not
   `data`), `gas`, EIP-1559 fees, `value`, `nonce`, `chainId` and `type: "0x2"`.
2. **Concurrency.** Without `--slow`, forge sends **all** `eth_sendTransaction` calls at once
   (four requests within the same millisecond in the probe). With `--slow` it sends one, waits
   for the receipt, then sends the next.
3. **Timeout.** A held `eth_sendTransaction` is dropped after **~45 s even with
   `--rpc-timeout 600` and `ETH_RPC_TIMEOUT=600`**. Forge then retries the same transaction:
   five sends over ~236 s, then `Failed to send transaction after 4 attempts … operation timed
out`. Source reading suggests newer forge builds honour `--rpc-timeout` for unlocked sends
   and disable these retries **[code]**.
4. **Rejections are retried too.** A `4001 User rejected` response is retried four times (1 s,
   2 s, 3 s, 4 s back-off) before forge gives up.
5. **No forge-std needed.** A script contract only needs `run()` and the cheatcode address; the
   examples define a three-function `Vm` interface.

## Design consequences

- **Add `--slow`.** One wallet approval at a time matches one send at a time, gives each
  transaction its own retry window, and lets forge stop after a failed transaction. It does
  not change which transactions are sent, their order or their nonces.
- **De-duplicate retries.** A retry is the same `(from, to, value, data, nonce)`. It joins the
  open approval (so a slow human does not get a second prompt), or receives the stored outcome
  (so a rejection is never re-prompted and a sent transaction is never re-sent). Covered by an
  integration test that approves after 55 s.
- **Order by nonce.** Concurrent sends (older forge without `--slow`, or users adding their
  own `eth_sendTransaction` callers) are shown lowest-nonce first.
- **Set `ETH_RPC_TIMEOUT`.** Harmless where ignored, and effective on forge builds that honour
  it.
- **Detect abandonment.** If every connection for a request closes and no retry arrives within
  15 s, the request is withdrawn before the wallet is asked. If the wallet was already asked,
  the terminal warns that the tool will not see the result.
- **Verify nonces.** MetaMask ignores a dapp-supplied nonce. If the wallet picks a different
  nonce, CREATE addresses forge predicted would be wrong, so Hatchway compares the broadcast
  transaction with the request and stops on any mismatch.

## Compatibility matrix

| Feature                                           | Status                | Notes / test                                                             |
| ------------------------------------------------- | --------------------- | ------------------------------------------------------------------------ |
| `forge script … --broadcast`                      | Supported             | `forge.test.ts`: deploys and checks code, receipt, sender                |
| Constructor arguments                             | Supported             | Decoded from `out/` artifacts; state checked on-chain                    |
| Multiple deployments and calls                    | Supported             | 5-transaction system; approvals in nonce order                           |
| Deploy then initialize, ownership transfer        | Supported             | `DeploySystem.s.sol`                                                     |
| Proxies (ERC-1967) and calls through them         | Supported             | `DeployProxy.s.sol`; calls labelled with the implementation ABI          |
| `new C{salt: s}()` (CREATE2 deployer)             | Supported             | Decoded as deterministic deployment; predicted address shown             |
| Reverts during simulation                         | Supported             | Fails before any wallet prompt                                           |
| User rejection                                    | Supported             | Exit code 3; forge's retries answered without re-prompting               |
| Wrong network, account changes                    | Supported             | Requests pause until the wallet matches                                  |
| Ctrl+C                                            | Supported             | Forge and the session are stopped; exit 130                              |
| Dry runs (no `--broadcast`)                       | Supported             | Wallet supplies the sender; nothing is sent                              |
| `--verify`, `--resume`, `--sig`, `-vvvv`, etc.    | Passed through        | Not specifically tested beyond argument handling                         |
| `foundry.toml` `[rpc_endpoints]` aliases          | Supported             | `${ENV}` interpolation                                                   |
| Slow approvals (> 45 s)                           | Supported             | `forge-timeout.test.ts`; window ≈ 4 minutes per transaction on forge 1.6 |
| `vm.startBroadcast(privateKey)` / `--private-key` | Unsupported (refused) | Signed outside the wallet; `eth_sendRawTransaction` is blocked           |
| Multiple broadcasting senders                     | Unsupported           | One wallet account per session                                           |
| `--multi` / `vm.createSelectFork` broadcasts      | Unsupported           | Only the primary `--rpc-url` is routed through the wallet                |
| `--debug`                                         | Unsupported           | Debugger cannot be combined with wallet signing                          |
| zkSync-style chains                               | Unsupported           | Non-standard deployment transactions                                     |

Verified forge versions: **1.6.0-nightly (commit 5e88010, 2026-04-27)** locally and **1.8.7**
(stable) in CI, Linux and macOS.

Version note: Hatchway passes the bridge URL in forge's environment rather than its arguments
(the URL carries a token). The 1.6 nightly reads `ETH_RPC_URL`; forge 1.8.7 ran without the
bridge when only `ETH_RPC_URL` was set, and works with `FOUNDRY_ETH_RPC_URL` (the config-level
override), so both are set. The integration suite checks that forge's process arguments do not
contain the token and that the bridge wins over an `eth_rpc_url` in `foundry.toml`.
