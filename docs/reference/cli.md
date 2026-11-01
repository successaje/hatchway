# CLI reference

```text
hatchway forge   [options] <script> [forge script args…]
hatchway hardhat [options] <hardhat args…> --network <name>
hatchway deploy  [options] <Contract | Artifact.json> --rpc-url <url> [--args <arg>…]
hatchway connect [options] --rpc-url <url> [--from <address>]
hatchway doctor  [--rpc-url <url>] [--json]
hatchway chains  [--json]
hatchway help [command] | --help
hatchway --version
```

## Session options

Accepted by `forge`, `hardhat`, `deploy` and `connect`. For `forge` and `hardhat` they must
come **before** the tool's own arguments.

| Option                    | Default | Meaning                                                         |
| ------------------------- | ------- | --------------------------------------------------------------- |
| `--no-open`               | open    | Print the session link instead of opening a browser.            |
| `--port <n>`              | random  | Listen on a fixed loopback port (for SSH forwarding).           |
| `--session-timeout <dur>` | `2h`    | Maximum session length, e.g. `30m`, `90m`, `2h` (minimum `1m`). |
| `--json`                  | off     | NDJSON events on stdout; human output on stderr.                |
| `--debug`                 | off     | Stack traces and details on errors.                             |
| `--no-color`              | auto    | Disable colours. `NO_COLOR` and `FORCE_COLOR` are honoured.     |

Other limits: a wallet must connect within 15 minutes; each request must be approved within
15 minutes of being shown.

## `hatchway forge`

Runs `forge script` with the wallet as the sender. All arguments after the script path go to
forge. Hatchway adds `--rpc-url <bridge> --unlocked --sender <wallet> --slow` and sets
`ETH_RPC_TIMEOUT`. Refuses `--private-key(s)`, `--mnemonic*`, `--keystore(s)`, `--account(s)`,
`--password*`, `--ledger`, `--trezor`, `--aws`, `--gcp`, `--turnkey`, `--browser`,
`-i/--interactive(s)`, `--multi` and `--debug`. If `--sender` is given, only that account is
accepted.

## `hatchway hardhat`

Runs the project's Hardhat 3 CLI with the session attached. Requires the `hatchway/hardhat`
plugin and `--network` (or `HARDHAT_NETWORK`).

## `hatchway deploy`

| Option             | Meaning                                                                 |
| ------------------ | ----------------------------------------------------------------------- |
| `<Contract>`       | Contract name, `path/File.sol:Name`, or a path to an artifact JSON file |
| `--rpc-url <url>`  | RPC endpoint (or `ETH_RPC_URL`)                                         |
| `--args <arg>…`    | Constructor arguments, **last** on the line. Arrays/tuples as JSON      |
| `--value <amount>` | Native value: `0.1ether`, `20gwei`, or wei                              |
| `--from <address>` | Require this wallet account                                             |
| `--no-build`       | Skip `forge build` / `hardhat build`                                    |
| `--root <dir>`     | Project directory                                                       |

Libraries that need linking are not supported here; use a script.

## `hatchway connect`

Connects a wallet and prints a local JSON-RPC endpoint (`http://127.0.0.1:<port>/rpc/<token>`)
until Ctrl+C. The endpoint answers `eth_accounts` with the wallet address, sends
`eth_sendTransaction`/`personal_sign`/`eth_signTypedData_v4` for approval, and forwards
everything else to `--rpc-url`. It refuses `eth_sign`, `eth_signTransaction`,
`eth_sendRawTransaction` and `wallet_*` methods.

## `hatchway doctor`

Checks Node.js, the bundled page, loopback networking, browser opening, Foundry and
`--unlocked`, the Hardhat project and plugin, and (with `--rpc-url` or `ETH_RPC_URL`) the
endpoint. Exits 1 if a check fails.

## Exit codes

| Code | Meaning                                                    |
| ---- | ---------------------------------------------------------- |
| 0    | Success                                                    |
| 1    | Failure (tool failed, wallet error, internal error)        |
| 2    | Usage error (bad arguments, project or artifact not found) |
| 3    | Rejected in the wallet                                     |
| 4    | Session or approval timed out                              |
| 5    | RPC endpoint unreachable or erroring                       |
| 6    | Wrong network or wrong account                             |
| 7    | Required tool not installed (forge, Hardhat)               |
| 8    | Transaction reverted on-chain                              |
| 9    | Integrity check failed (broadcast differs, or replaced)    |
| 10   | Session cancelled in the browser                           |
| 130  | Interrupted (Ctrl+C)                                       |

## Files

- `.hatchway/runs/<timestamp>-<chainId>.json` in the project: run record with every request,
  hash, nonce, block, gas, fee, contract address and error. Written when anything was sent or
  signed.
- Forge's `broadcast/` and Hardhat Ignition's `ignition/deployments/` are written by those tools
  as usual.
