# Project status

_Last updated: 2026-11-01._

## Summary

Hatchway 0.1.0 is functionally complete for local and testnet use with Foundry and Hardhat 3,
verified end to end on Anvil with a deterministic test wallet, and across platforms in CI. A real
MetaMask install ran two `hatchway forge` deployments (1 and 5 transactions) on BNB Smart Chain
Testnet. It is
**published on npm** as `hatchway` 0.1.0. The full MetaMask acceptance checklist has not been
run, and **Rabby is untested**.

## Completed

- CLI: `forge`, `hardhat`, `deploy`, `connect`, `doctor`, `chains`, `--json` NDJSON events,
  exit codes, run records.
- Loopback bridge: session lifecycle, one-time pairing, browser token, SSE snapshots, JSON-RPC
  endpoint for tools, Host/Origin/CSP protections, body limits, secret redaction.
- Approval engine: nonce-ordered sequential approvals, retry de-duplication, abandonment and
  timeouts, post-broadcast integrity verification, receipt tracking, replacement detection,
  reconciliation after page reload, on-chain revert halting.
- Review: artifact-based decoding (Foundry `out/`, Hardhat `artifacts/`), CREATE/CREATE2
  address prediction, proxy-aware call labelling, `eth_call` simulation with custom-error
  decoding, fee estimates, warnings.
- Signing page: EIP-6963 discovery, connect, network switch/add, account-change handling,
  review, approve/reject, confirming/done, error states, light/dark, mobile width.
- Foundry adapter (`--unlocked --sender --slow`), Hardhat 3 plugin (`hatchway/hardhat`).
- Examples: `examples/foundry` (5 scripts), `examples/hardhat-basic` (ethers, signing,
  Ignition).
- Docs: README, 11 guides, 3 references, research, threat model, ADRs.
- Independent security review (2026-11-01): 11 findings plus informational items, all fixed
  with regression tests; see docs/research/security-considerations.md.
- CI (all green on 2026-11-01, including forge 1.8.7 integration after the security fixes), release workflow with npm trusted publishing, Dependabot.

## Latest verification (2026-11-01)

| Suite                                                                                                  | Result | Where                                                                             |
| ------------------------------------------------------------------------------------------------------ | ------ | --------------------------------------------------------------------------------- |
| Unit + security (103 tests)                                                                            | Pass   | Local macOS arm64; CI Linux x64/arm64, macOS arm64/x64, Windows x64; Node 22 & 24 |
| Integration: forge (13), Hardhat (8), engine (14), commands (8), forge timeout (1), packed tarball (3) | Pass   | Local (forge 1.6.0-nightly); CI Linux + macOS (forge 1.8.7)                       |
| Browser E2E (Playwright, 12 tests)                                                                     | Pass   | Local; CI Linux                                                                   |
| Lint, Prettier, TypeScript strict, build                                                               | Pass   | Local and CI                                                                      |
| Production dependency audit                                                                            | Pass   | CI (one documented ignore: GHSA-mrhx-c7xc-m3w5)                                   |

### Real wallet on a public testnet (2026-11-01)

Both runs: `hatchway forge <script> --rpc-url https://bsc-testnet-rpc.publicnode.com --broadcast`
from `examples/foundry`, forge 1.6.0-nightly, MetaMask, macOS arm64. In both, the wallet
connected on Ethereum mainnet (chain 1) and the page switched it to BNB Smart Chain Testnet (97).
Every result below was checked independently with `cast` against a second RPC
(`data-seed-prebsc-1-s1`).

**`DeployToken.s.sol`, one transaction**

- One deployment approved in MetaMask: tx
  `0xb3a1349b315dacbd8dc0fae7966fa5862a65494793531d8d3bbed47144b4805a`, block 140198153,
  HatchToken at `0x8694e706810958aD9c1C7218dCD6eC42e54B65Dc`. Hatchway's integrity check
  accepted the broadcast and forge wrote its broadcast file.
- On-chain: status 1, sender is the connected account, address equals CREATE(sender, nonce
  135), 1468 bytes of code, `name()` "Hatch Token", `symbol()` "HATCH", total supply and
  deployer balance 1e24.
- MetaMask sent a type-2 transaction at 0.55 gwei, replacing forge's 0.1 gwei estimate; the
  summary reported the fee actually paid (0.000261 tBNB, from the receipt).

**`DeploySystem.s.sol`, five transactions**

- Two deployments and three calls, each shown after the previous one was mined and approved
  separately in MetaMask (nonces 136–140, blocks 140198659–140198729, type 2 at 0.1 gwei).
- HatchToken at `0x58E5eB88156641DCC2c9ddB22F75A19ee0bbbfdd` and Registry at
  `0xaF6952fd2BfeA545cb5Dc45bC4E5A1c0Cb7ca7Bd`, both equal to CREATE(sender, nonce) and to the
  addresses forge planned.
- On-chain: all five receipts have status 1 and come from the connected account; the calls
  went to the registry with the `initialize`, `register` and `transferOwnership` selectors.
  The registry reports `initialized()` true, `token()` and `entries("token")` equal to the
  token, and `owner()` `0x…bEEF`. The deployer holds 1e24 HATCH and its nonce is now 141.

Not covered by these runs: rejection, reload and account switching with a real extension,
Hardhat on a public network, and Rabby.

## Release

`hatchway@0.1.0` was published to npm on 2026-11-01 by `finishr`, from a clean build of commit
`a9d5548`. The published tarball's shasum (`73da48db035274f6ee9ef8dcb0a5c11b62936c08`, 87 files)
matches the locally packed build, and a fresh `npm install hatchway@0.1.0` runs `version`,
`doctor` and loads `hatchway/hardhat`. npm's staged-publishing flow also left a placeholder
version, `0.0.0-stage` ("Temporary package placeholder for staged publishing"); `latest` points
to 0.1.0. The GitHub repository was made public the same day.

## Remaining work

1. **Manual acceptance with MetaMask and Rabby** (docs/guides/manual-acceptance.md). MetaMask
   has done two testnet deployments; the full checklist is still needed for both wallets, and
   results go in the release notes.
2. **Hardhat 3 on a public testnet** (forge single- and multi-transaction runs on BNB Smart
   Chain Testnet are done).
3. **Trusted publishing for later releases**: on npmjs.com, add `successaje/hatchway` with the
   `release.yml` workflow and the `npm` environment as a trusted publisher for `hatchway`.
   Until then, tag pushes cannot publish. Do not push a `v0.1.0` tag: 0.1.0 is already on npm,
   so the workflow would fail; the next tag is `v0.1.1` or later.
4. Windows end-to-end flows (integration tests use POSIX signals and `pgrep`; unit/security
   tests pass on Windows).
5. Possible next features: persistent multi-run session (`connect` covers part of this),
   WalletConnect/mobile transport (needs its own security design), MCP wrapper over the NDJSON
   interface, configurable confirmation depth.

## Known issues and limitations

- Forge 1.6 gives each transaction ≈4 minutes for approval (its 45 s timeout × retries).
- One wallet account and one chain per session; `forge script --multi` unsupported.
- Hardhat 2 only through `hatchway connect`.
- Labels (contract names, decoded args) come from project artifacts and are hints; the wallet
  prompt is authoritative.
- No independent security audit.

## Next concrete engineering action

Run the manual acceptance checklist with MetaMask and Rabby against Anvil (rejection, reload and
account switching are the parts not yet seen with a real extension) and a Hardhat 3 run on BNB
Smart Chain Testnet; fix anything they find, then release 0.1.1 through the tag workflow.
