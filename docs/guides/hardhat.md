# Hardhat

Hatchway supports **Hardhat 3** through a plugin. Any task that signs on an HTTP network —
`hardhat run`, Hardhat Ignition, your own tasks — uses your browser wallet.

## Setup

```bash
npm install --save-dev hatchway
```

```ts
// hardhat.config.ts
import hardhatEthers from "@nomicfoundation/hardhat-ethers";
import { configVariable, defineConfig } from "hardhat/config";
import hatchway from "hatchway/hardhat";

export default defineConfig({
  plugins: [hardhatEthers, hatchway],
  solidity: "0.8.28",
  networks: {
    localhost: { type: "http", url: "http://127.0.0.1:8545" },
    sepolia: { type: "http", url: configVariable("SEPOLIA_RPC_URL") },
  },
});
```

Networks need no `accounts` entry: the browser wallet is the account. The plugin does nothing
unless Hardhat is started by `hatchway hardhat`, so normal `npx hardhat test` runs are
unaffected.

## Usage

```bash
hatchway hardhat run scripts/deploy.ts --network sepolia
```

```bash
hatchway hardhat ignition deploy ignition/modules/Token.ts --network sepolia
```

Hatchway options go before the Hardhat arguments (`hatchway hardhat --no-open run …`). A
`--network` (or `HARDHAT_NETWORK`) is required, because the wallet must reach the same chain.

Inside your script nothing changes:

```ts
import { network } from "hardhat";

const { ethers } = await network.connect();
const [deployer] = await ethers.getSigners(); // your wallet's account
const token = await ethers.deployContract("Token", ["Name", "SYM", 1_000_000n]);
await token.waitForDeployment();
await (await token.transfer(recipient, 10n)).wait();
const signature = await deployer.signMessage("hello"); // approved in the wallet too
```

## How it works

The plugin registers a network `onRequest` hook. Wallet methods (`eth_accounts`,
`eth_requestAccounts`, `eth_sendTransaction`, `personal_sign`, typed data) go to the Hatchway
session; everything else goes to your configured network as usual. On the first wallet call,
the plugin tells the session which endpoint the script connected to, so simulation and receipt
tracking use the same node. Details: [Hardhat integration research](../research/hardhat-integration.md).

## Verified

Hardhat **3.21.2** with `@nomicfoundation/hardhat-ethers` 4.2 and Hardhat Ignition 3.1:
`run` scripts with deployments and calls, `signMessage`, Ignition deployments, rejection,
reverts, and installation from the npm tarball into a clean project.

## Limitations

- **Hardhat 2** is not supported by `hatchway hardhat`. Use `hatchway connect` and point a
  network's `url` at the printed endpoint.
- Hardhat's **in-process network** cannot be used: your wallet cannot reach it. Run
  `npx hardhat node` or `anvil` and use `--network localhost`.
- One network per session.
- Ignition refuses to continue when the account has pending transactions it did not send;
  avoid using the wallet for other things during a deployment.
