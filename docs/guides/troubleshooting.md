# Troubleshooting

Start with `hatchway doctor --rpc-url <your-endpoint>`; it checks most of the below. Add
`--debug` to any command for stack traces and details.

## The page

| Symptom                                  | Cause and fix                                                                                                                                                  |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "No browser wallet found"                | The link was opened in a browser without a wallet extension. Click **Get a link for another browser** and open that link where MetaMask/Rabby is installed.    |
| "This link can't be used"                | Session links work once. Use the tab that opened it first, or close that tab: the terminal prints a fresh link after a few seconds.                            |
| "Session opened elsewhere"               | Another tab claimed the session. Use the newest tab.                                                                                                           |
| "Lost connection to your terminal"       | The command stopped (Ctrl+C, crash, finished). Check the terminal; rerun if needed.                                                                            |
| "Check your wallet" / wrong network      | The wallet is on another chain. Click **Switch to …**, or change it in the wallet. If the chain is unknown to the wallet, add it (chain id and RPC are shown). |
| "The selected account changed"           | Switch the wallet back to the account shown in the bar. Approval is disabled until it matches.                                                                 |
| Connect button shows "Check your wallet" | The wallet popup is waiting. Open the extension. MetaMask returns `-32002` if a previous request is still pending.                                             |
| The browser did not open                 | Expected in CI, SSH, containers or with `--no-open`. Copy the printed link.                                                                                    |

## The terminal

| Message                                                | Fix                                                                                                                        |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `RPC endpoint could not be reached`                    | Check the URL and that the node is running (`anvil`). Keys in the URL are hidden in the message.                           |
| `Foundry is not installed`                             | Install with `curl -L https://foundry.paradigm.xyz \| bash && foundryup`, then open a new terminal.                        |
| `--private-key selects a different signer`             | Remove signer flags; Hatchway signs with your wallet.                                                                      |
| `Transaction rejected in wallet.` (exit 3)             | You (or the wallet) rejected it. Rerun to try again.                                                                       |
| `forge script exited with code 1`                      | See forge's own output above the summary (simulation revert, compiler error…).                                             |
| `Nonce N is already used`                              | Another transaction was sent from this account during the run. Rerun so forge re-plans.                                    |
| `The wallet broadcast 0x…, but it differs` (exit 9)    | The wallet changed nonce/data. Do not edit data or nonce in the wallet; on local chains, clear the wallet's activity data. |
| `was replaced or dropped`                              | You used speed-up/cancel in the wallet. Rerun.                                                                             |
| `The calling tool stopped waiting`                     | Approval took longer than forge waits (~4 minutes per transaction on forge 1.6). Rerun and approve sooner.                 |
| `Hatchway needs an HTTP network your wallet can reach` | Pass `--network localhost` (with `npx hardhat node` or `anvil`) or a testnet; not Hardhat's in-process network.            |
| `… does not seem to load the Hatchway plugin`          | Add `import hatchway from "hatchway/hardhat"` and `plugins: [hatchway]` to `hardhat.config.ts`.                            |
| `Port N is already in use`                             | Omit `--port` to pick a free one, or choose another.                                                                       |
| `No wallet was connected in time` / `session expired`  | Sessions wait 15 minutes for a wallet and last 2 hours (`--session-timeout`). Rerun.                                       |

## MetaMask on a local chain

- **"Nonce too high"** after restarting Anvil: Settings → Advanced → **Clear activity tab data**.
- **Wrong balance or stuck transactions:** same fix; MetaMask caches chain state per network.
- **Network not added:** add RPC `http://127.0.0.1:8545`, chain id `31337`.

## Getting help

Open an issue with the command, `hatchway --version`, `hatchway doctor --json` output, your OS,
and the wallet and version. Never include private keys, seed phrases or RPC URLs with keys.
