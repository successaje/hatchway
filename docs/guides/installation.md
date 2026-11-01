# Installation

## Requirements

- **Node.js 22 or newer** (`node --version`).
- A desktop browser with an EIP-1193 wallet extension: MetaMask, Rabby, or another wallet that
  announces itself through EIP-6963.
- For `hatchway forge`: [Foundry](https://getfoundry.sh) with `forge script --unlocked`
  (any 1.x release).
- For `hatchway hardhat`: a Hardhat 3 project.

No Docker, database, cloud account, API key or private key is needed.

## Install

Hatchway is published on npm as [`hatchway`](https://www.npmjs.com/package/hatchway):

```bash
npm install --global hatchway        # global CLI
npm install --save-dev hatchway      # per project (required for the Hardhat plugin)
npx hatchway --help                  # zero-install
```

### From source

To run unreleased changes, build from a clone:

```bash
git clone https://github.com/successaje/hatchway
```

```bash
cd hatchway && pnpm install && pnpm build
```

```bash
npm link ./packages/hatchway
```

`npm link` puts a `hatchway` command on your `PATH`. To install a build in another project
instead, pack it into a tarball:

```bash
pnpm --filter hatchway pack --pack-destination .
```

```bash
npm install --global ./hatchway-0.1.0.tgz
```

The package bundles the browser page, so there is no separate frontend to build or serve.

## Check your setup

```bash
hatchway doctor --rpc-url http://127.0.0.1:8545
```

`doctor` checks Node, the bundled page, loopback networking, whether a browser can be opened,
Foundry and `--unlocked` support, the Hardhat project and plugin in the current directory, and
the RPC endpoint (chain id, latest block, latency). Add `--json` for machine-readable output.

## Uninstall

```bash
npm uninstall --global hatchway
```

Hatchway stores nothing outside your projects. Run records are written to `.hatchway/runs/`
inside each project; delete that directory if you do not want them.
