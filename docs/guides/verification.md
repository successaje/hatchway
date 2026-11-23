# Verifying contracts

Verification publishes a contract's source so explorers can show it and check that it matches the
deployed bytecode. It needs no wallet, so Hatchway leaves it to the tools that already do it:
`forge verify-contract`, forge script's `--verify`, and Hardhat's `hardhat-verify` plugin. API
keys never pass through Hatchway's options or the signing page.

## `hatchway deploy --verify`

For contracts in a Foundry project:

```bash
hatchway deploy HatchToken --rpc-url bsc_testnet --verify --args "Hatch Token" HATCH 1000000
```

Once the deployment is confirmed, Hatchway runs `forge verify-contract` with the address, the
`path/File.sol:Contract` name, the chain and the ABI-encoded constructor arguments filled in, and
waits for the verifier's answer.

| Option                 | Meaning                                                                         |
| ---------------------- | ------------------------------------------------------------------------------- |
| `--verify`             | Verify the source after deploying                                               |
| `--verifier <name>`    | `sourcify` (forge's default), `etherscan`, `blockscout`, `oklink` or `custom`   |
| `--verifier-url <url>` | The verifier's API URL, e.g. `https://<blockscout instance>/api` for Blockscout |

- **API keys** come from where forge reads them: `ETHERSCAN_API_KEY` (or `VERIFIER_API_KEY`) in
  the environment, or an `[etherscan]` entry in `foundry.toml`. Hatchway has no option for a key,
  so it stays out of shell history and run records.
- **If verification fails, the deployment stands.** Hatchway exits with code 11
  (`VERIFICATION_FAILED`) and prints the `forge verify-contract` command that retries it without
  deploying again.
- With `--json`, a `verification` event follows the deployment, and the `result` event has
  `verification: { ok, verifier? }`. The run record has the same field.
- `--verify` is refused, before anything is deployed, for an artifact JSON file (there are no
  sources to submit) and for Hardhat projects (see [Hardhat](#hardhat)).

## `hatchway forge … --verify`

forge's own verification flags pass through unchanged:

```bash
hatchway forge script/Deploy.s.sol --rpc-url sepolia --broadcast --verify
```

After the last receipt, forge verifies every contract the script deployed. `--verifier`,
`--verifier-url` and `--etherscan-api-key` pass through as well; prefer the environment variable
for the key (Hatchway hides key values in its run records either way).

## Hardhat

Add the `hardhat-verify` plugin to your config. Sourcify and Blockscout need no key; Etherscan
needs one:

```ts
import hardhatVerify from "@nomicfoundation/hardhat-verify";
import { configVariable, defineConfig } from "hardhat/config";
import hatchway from "hatchway/hardhat";

export default defineConfig({
  plugins: [/* … */ hardhatVerify, hatchway],
  verify: {
    etherscan: { apiKey: configVariable("ETHERSCAN_API_KEY") },
  },
  // …
});
```

Then verify while deploying with Ignition, or afterwards with plain Hardhat (verification needs
no wallet, so no Hatchway session):

```bash
hatchway hardhat ignition deploy ignition/modules/Token.ts --network sepolia --verify
npx hardhat verify --network sepolia <address> <constructor args…>
```

Hatchway passes these through unchanged, but has not tested them yet.

## Choosing a verifier

- **Sourcify** needs no account or key and supports many chains, including BNB Smart Chain
  (56), BNB Smart Chain Testnet (97) and Sepolia. It is forge's default.
- **Etherscan** and the explorers built on it (BscScan and others) need an API key. Etherscan's
  free plan does not cover every chain: check that yours includes the network you deploy to.
- **Blockscout** needs no key; pass the instance's API URL with `--verifier-url`.

## Tested

- `hatchway deploy --verify` and `hatchway forge … --verify` run against a local
  Etherscan-compatible verifier in the integration tests, with the real forge: they check what
  forge submits (address, contract name, compiler version, constructor arguments, standard JSON
  input), a failed verification (exit code 11, retry command), and the refusals.
