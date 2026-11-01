# Foundry

```bash
hatchway forge [hatchway options] <script> [forge script options]
```

Use your usual `forge script` command, put `hatchway forge` in front, and remove any signer
flags (`--private-key`, `--account`, `--ledger`, `--interactive`, `--browser`, …):

```bash
hatchway forge script/Deploy.s.sol:Deploy --rpc-url sepolia --broadcast --verify -vvvv
```

`hatchway forge script script/Deploy.s.sol …` (with the literal `script`) also works.

## What happens

1. Hatchway finds the project (`foundry.toml`), resolves the RPC endpoint forge would use
   (`--rpc-url` URL or `[rpc_endpoints]` alias with `${ENV}` interpolation, else `ETH_RPC_URL`,
   else `eth_rpc_url` from config), checks it, and opens the session page.
2. You connect your wallet. If you passed `--sender`, only that account is accepted.
3. Hatchway runs:

   ```text
   forge script <your args> --rpc-url <local bridge> --unlocked --sender <wallet> --slow
   ```

   Forge compiles, simulates and estimates as usual. Each `eth_sendTransaction` appears on the
   page, decoded; you confirm it in the wallet; forge receives the hash and waits for the
   receipt itself.

4. Forge writes `broadcast/…/run-latest.json`. Hatchway prints a summary and writes
   `.hatchway/runs/<timestamp>-<chain>.json`. The exit code is forge's, or a more specific one
   from Hatchway (see [CLI reference](../reference/cli.md#exit-codes)).

Hatchway options go **before** the script path because forge has options with the same names
(e.g. `--json`):

```bash
hatchway forge --no-open --port 9555 --json script/Deploy.s.sol --rpc-url $RPC_URL --broadcast
```

## Scripts

Any script works, with or without forge-std. The sender is the wallet account, so
`msg.sender` inside `vm.startBroadcast()` is that address:

```solidity
function run() external {
    vm.startBroadcast(); // the browser wallet signs everything until stopBroadcast
    Token token = new Token("Name", "SYM", 1_000_000 ether);
    token.transferOwnership(vm.envAddress("OWNER"));
    vm.stopBroadcast();
}
```

`vm.startBroadcast(address)` works when the address is your wallet's.
`vm.startBroadcast(privateKey)` signs locally and is refused: Hatchway never relays
transactions signed outside the wallet.

## Dry runs

Without `--broadcast`, forge only simulates. Hatchway still connects the wallet to learn the
sender, then forge runs; nothing is sent.

## Approval timing

Forge 1.6 (and some earlier versions) gives up on a pending send after about 45 seconds and
retries it four times, so you have roughly **four minutes per transaction** to approve.
Hatchway turns the retries into one approval. If forge gives up before you approve, the request
is withdrawn from the page; if it was already in your wallet, the terminal warns you to reject
it there. Newer forge builds honour the `ETH_RPC_TIMEOUT` value Hatchway sets.

## Resuming

If a run stops part-way (rejection, timeout), rerun the same command; forge re-simulates from
the current chain state. `--resume` is passed through to forge unchanged.

## Compatibility matrix

| Feature                                                    | Status         | Notes                                             |
| ---------------------------------------------------------- | -------------- | ------------------------------------------------- |
| `forge script … --broadcast`                               | Supported      | Tested                                            |
| Constructor arguments                                      | Supported      | Decoded from `out/`; tested                       |
| Multiple deployments and calls in one script               | Supported      | One approval at a time, nonce order; tested       |
| Deploy + initialize, ownership transfer                    | Supported      | Tested                                            |
| ERC-1967 proxy deployment and calls through it             | Supported      | Tested                                            |
| CREATE2 via `new C{salt: …}()`                             | Supported      | Decoded; predicted address shown                  |
| Revert during simulation                                   | Supported      | Fails before the wallet is asked; tested          |
| Rejection, wrong network, account change, Ctrl+C           | Supported      | Tested                                            |
| Approvals slower than forge's 45 s RPC timeout             | Supported      | ~4 minutes per transaction on forge 1.6; tested   |
| Dry run (no `--broadcast`)                                 | Supported      |                                                   |
| `--verify`, `--resume`, `--sig`, `--with-gas-price`, `-v…` | Passed through | Not separately tested                             |
| `[rpc_endpoints]` aliases with `${ENV}`                    | Supported      |                                                   |
| `vm.startBroadcast(privateKey)`, signer flags              | Unsupported    | Refused with an explanation                       |
| Several broadcasting senders in one script                 | Unsupported    | One wallet account per session                    |
| `--multi`, broadcasting on `createSelectFork` forks        | Unsupported    | Only the primary RPC is routed through the wallet |
| `--debug`                                                  | Unsupported    |                                                   |
| zkSync and other non-standard deployment chains            | Unsupported    |                                                   |

Verified with forge **1.6.0-nightly (2026-04-27)**; CI also runs the current stable release.
Background: [Foundry integration research](../research/foundry-integration.md).

## Foundry's own `--browser`

Recent forge versions include a built-in browser wallet (`forge script --browser`). If you use
only Foundry, are on a recent version, and are happy with its raw JSON review, it is a fine
choice. Hatchway adds decoded review with simulation, the same flow for Hardhat and other tools,
post-broadcast verification, retry handling, and NDJSON output. Do not combine the two.
