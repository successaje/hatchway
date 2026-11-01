# Your first deployment

This walkthrough deploys the example contracts to a local Anvil chain with MetaMask (Rabby
works the same way). It takes about five minutes and uses no real funds.

## 1. Install

Follow [installation](installation.md) and confirm `hatchway --version` prints a version.

## 2. Start a local chain

In a separate terminal:

```bash
anvil
```

Anvil listens on `http://127.0.0.1:8545` with chain id `31337` and ten funded development
accounts whose keys are public. Never send real funds to them.

## 3. Prepare your wallet

1. In MetaMask, add a network: **RPC URL** `http://127.0.0.1:8545`, **Chain ID** `31337`,
   **Currency** `ETH`. (If you skip this, the Hatchway page offers to add it for you.)
2. Select the account you want to deploy from and copy its address.
3. Fund it from Anvil's first development account — no key import needed, Anvil's accounts are
   unlocked:

   ```bash
   cast send --unlocked --from 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 --rpc-url http://127.0.0.1:8545 <your-address> --value 10ether
   ```

## 4. Deploy a token

```bash
cd examples/foundry
```

```bash
hatchway forge script/DeployToken.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
```

Your browser opens the session page. If it does not (or you are on another machine), copy the
link the terminal prints into the browser where MetaMask is installed.

## 5. Connect and approve

1. Click **MetaMask** on the page and approve the connection in MetaMask. Connecting only
   shares your address.
2. The page shows **Deploy HatchToken** with its constructor arguments, a simulation result,
   the estimated fee and the predicted contract address.
3. Click **Confirm in MetaMask**. MetaMask opens with the transaction; check it and confirm.

The page moves to "Confirming", then "All done". The terminal prints:

```text
  ✓ Deployment successful

  Contract   HatchToken
  Address    0x…
  Tx         0x…
```

## 6. Check it on-chain

```bash
cast call <address> "symbol()(string)" --rpc-url http://127.0.0.1:8545
```

Forge's usual `broadcast/DeployToken.s.sol/31337/run-latest.json` is written, and Hatchway adds
a run record under `.hatchway/runs/`.

## Next

- A multi-step deployment: `script/DeploySystem.s.sol` (five approvals, one at a time).
- A proxy: `script/DeployProxy.s.sol`.
- Hardhat: [hardhat.md](hardhat.md). Testnets: [networks.md](networks.md).

If MetaMask later reports "nonce too high" after you restart Anvil, clear its activity data
(Settings → Advanced → Clear activity tab data). See [troubleshooting](troubleshooting.md).
