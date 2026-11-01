# Project status

_Last updated: 2026-11-01._

## Summary

Hatchway 0.1.0 is functionally complete for local and testnet use with Foundry and Hardhat 3,
verified end to end on Anvil with a deterministic test wallet, and across platforms in CI. It is
**not yet published** to npm and **not yet tested with real MetaMask or Rabby installs**.

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

## Remaining work

1. **Manual acceptance with MetaMask and Rabby** (docs/guides/manual-acceptance.md). Needs a
   human with the extensions installed; results go in the release notes.
2. **Testnet run** (e.g. Base Sepolia or Sepolia) with a funded test wallet, to confirm
   behaviour with real block times and public RPCs.
3. **First npm release**: publish `hatchway` 0.1.0 (owner action), then configure npm trusted
   publishing for the release workflow.
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

Run the manual acceptance checklist with MetaMask and Rabby against Anvil, fix anything it
finds, then tag `v0.1.0`.
