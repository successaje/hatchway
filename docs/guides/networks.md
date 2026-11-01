# Networks

Hatchway works on any EVM chain with standard contract creation. It reads the chain id from
your RPC endpoint and never needs a list; `hatchway chains` shows the networks it can name and
link to an explorer for:

```bash
hatchway chains
```

Included: Ethereum, Sepolia, Hoodi, Base, Base Sepolia, OP Mainnet, OP Sepolia, Arbitrum One,
Arbitrum Sepolia, Polygon, Polygon Amoy, BNB Smart Chain and testnet, Avalanche and Fuji,
Gnosis, Linea and Linea Sepolia, Scroll and Scroll Sepolia, and local Anvil/Hardhat (31337).
Names and explorers come from viem's chain list, so many more are recognised.

## RPC endpoints

Use your own endpoint — local node, public RPC, or a provider URL with a key:

```bash
hatchway forge script/Deploy.s.sol --rpc-url "$SEPOLIA_RPC_URL" --broadcast
```

- The endpoint is used for reads, simulation, nonce checks, verification and receipts. Your
  wallet broadcasts through its own RPC, so both must be on the same chain (for public chains
  they are; for a local node, add the same URL to your wallet).
- API keys are never shown: URLs are printed as `https://eth-sepolia.g.alchemy.com/v2/***`,
  and credentials, query values and key-like path segments are scrubbed from all output.
- Your endpoint URL is never sent to the browser. When the page offers to add a network to your
  wallet, it uses the chain's public RPC (or your local URL only if it is a credential-free
  loopback address).

## Testnets

1. Get test funds from the testnet's faucet into your wallet account.
2. Use an RPC endpoint for that testnet.
3. Run your command with `--rpc-url <endpoint>` and `--broadcast`.

The page labels testnets and warns on production networks ("This transaction spends real
funds").

## Mainnet

Hatchway does not treat mainnet differently beyond the warning: every transaction already needs
your explicit approval in the wallet. Review each request, and prefer rehearsing on a fork or
testnet first.

## Unsupported

- zkSync Era and other chains with non-standard deployment transactions (the page warns that
  predicted addresses may be wrong; scripts may not work).
- Blob (EIP-4844) and EIP-7702 transactions.
- Multi-chain scripts (one chain per session).
