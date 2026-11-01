# Hatchway

**Deploy from your terminal. Approve with your wallet. Keep your keys.**

Hatchway runs your existing Foundry scripts and Hardhat 3 tasks with your browser wallet
(MetaMask, Rabby, or any EIP-6963 wallet) as the signer. Each transaction is decoded and
shown on a local review page, then approved in the wallet. No private key ever leaves it.

```sh
npm install --global hatchway

# Foundry
hatchway forge script/Deploy.s.sol --rpc-url sepolia --broadcast

# Hardhat 3 (add the plugin, see below)
hatchway hardhat run scripts/deploy.ts --network sepolia

# One compiled contract, with constructor arguments
hatchway deploy MyToken --rpc-url http://127.0.0.1:8545 --args "My Token" MTK 1000000
```

The command prints a link to a page served from `127.0.0.1`. Open it in the browser where
your wallet is installed, connect, review each transaction, and approve it in the wallet.
The command continues and finishes as usual, with addresses, hashes and receipts.

## Hardhat 3 plugin

```ts
// hardhat.config.ts
import hatchway from "hatchway/hardhat";

export default defineConfig({
  plugins: [hatchway],
  networks: { sepolia: { type: "http", url: configVariable("SEPOLIA_RPC_URL") } },
});
```

The plugin does nothing unless Hardhat is started by `hatchway hardhat`.

## Commands

| Command            | What it does                                                               |
| ------------------ | -------------------------------------------------------------------------- |
| `hatchway forge`   | Runs `forge script` with your wallet as the sender                         |
| `hatchway hardhat` | Runs any Hardhat 3 task (scripts, Ignition) with your wallet as the signer |
| `hatchway deploy`  | Deploys one compiled contract                                              |
| `hatchway connect` | Serves a wallet-backed local RPC endpoint for other tools (cast, viem, …)  |
| `hatchway doctor`  | Checks your environment                                                    |
| `hatchway chains`  | Lists well-known networks                                                  |

Add `--json` for newline-delimited JSON events (for scripts and AI agents) and `--no-open`
to print the link instead of opening a browser.

Documentation, security model and compatibility notes:
<https://github.com/successaje/hatchway>

MIT licensed.
