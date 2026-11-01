const SESSION = `Session options (put them before the tool's own arguments):
  --no-open                 Print the link instead of opening a browser
  --port <n>                Listen on a fixed loopback port (useful with SSH forwarding)
  --session-timeout <dur>   Maximum session length, e.g. 30m or 2h (default 2h)
  --json                    Machine-readable NDJSON events on stdout
  --debug                   Show diagnostic details on errors
  --no-color                Disable colors (NO_COLOR is also honoured)`;

export const HELP = {
  main: `Hatchway — deploy from your terminal, approve with your wallet, keep your keys.

Usage
  hatchway forge   [options] <script> [forge script args…]
  hatchway hardhat [options] <hardhat args…> --network <name>
  hatchway deploy  [options] <Contract> --rpc-url <url> [--args …]
  hatchway connect [options] --rpc-url <url>
  hatchway doctor  [--rpc-url <url>]
  hatchway chains
  hatchway --version

Every transaction is shown for review in a local browser page and approved in your own
wallet (MetaMask, Rabby, or any EIP-6963 wallet). Private keys never leave the wallet.

Run \`hatchway help <command>\` for details. Docs: https://github.com/successaje/hatchway`,

  forge: `hatchway forge — run a Foundry script with your browser wallet as the sender

Usage
  hatchway forge [options] <script> [forge script args…]

Examples
  hatchway forge script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
  hatchway forge script/Deploy.s.sol --rpc-url sepolia --broadcast --verify

Hatchway runs \`forge script\` with --unlocked --sender <your wallet> --slow and points
--rpc-url at a local bridge that forwards reads to your endpoint and sends each transaction
to your wallet for approval. Do not pass --private-key, --account, --ledger or similar.

${SESSION}`,

  hardhat: `hatchway hardhat — run a Hardhat 3 task with your browser wallet as the signer

Usage
  hatchway hardhat [options] <hardhat args…> --network <name>

Examples
  hatchway hardhat run scripts/deploy.ts --network localhost
  hatchway hardhat ignition deploy ignition/modules/Token.ts --network sepolia

Requires the plugin in hardhat.config.ts:
  import hatchway from "hatchway/hardhat";
  export default defineConfig({ plugins: [hatchway], … });

${SESSION}`,

  deploy: `hatchway deploy — deploy one compiled contract

Usage
  hatchway deploy [options] <Contract | path/to/Artifact.json> --rpc-url <url> [--args <arg>…]

Options
  --rpc-url <url>     RPC endpoint (or ETH_RPC_URL)
  --args <arg>…       Constructor arguments; must come last. Arrays/tuples as JSON
  --value <amount>    Native value to send, e.g. 0.1ether or 20gwei
  --from <address>    Require this wallet address
  --no-build          Skip \`forge build\` / \`hardhat build\`
  --root <dir>        Project directory

Example
  hatchway deploy HatchToken --rpc-url http://127.0.0.1:8545 --args "Hatch Token" HATCH 1000000

${SESSION}`,

  connect: `hatchway connect — connect a wallet and serve a local RPC endpoint

Usage
  hatchway connect [options] --rpc-url <url> [--from <address>]

Prints a local JSON-RPC URL. Point any tool that uses eth_sendTransaction at it (cast with
--unlocked, Hardhat 2 networks, scripts); every request is approved in your wallet.
Runs until Ctrl+C.

${SESSION}`,

  doctor: `hatchway doctor — check your environment

Usage
  hatchway doctor [--rpc-url <url>] [--json]`,

  chains: `hatchway chains — list well-known networks

Usage
  hatchway chains [--json]

Any EVM chain works; this list only adds names and explorer links.`,
};
