# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-11-01

First release candidate (not yet published to npm).

### Added

- `hatchway forge`: runs `forge script` with a browser wallet as the sender via
  `--unlocked --sender --slow` and a loopback JSON-RPC bridge. Resolves `foundry.toml` RPC
  aliases, refuses conflicting signer flags, absorbs forge's request retries.
- `hatchway hardhat` and the `hatchway/hardhat` plugin for Hardhat 3: ethers/viem scripts,
  message and typed-data signatures, Hardhat Ignition.
- `hatchway deploy` for single compiled contracts with typed constructor arguments and value.
- `hatchway connect`: a wallet-backed local RPC endpoint for cast, viem, ethers and others.
- `hatchway doctor` and `hatchway chains`.
- Local signing page: EIP-6963 wallet discovery, decoded review (contract names, constructor
  and call arguments, CREATE/CREATE2 address prediction), simulation, fee estimates, warnings,
  network switching, account-change handling, reload recovery, light and dark themes.
- Approval engine: nonce-ordered, one request at a time after the previous is mined;
  post-broadcast integrity verification; replacement detection; recovery of transactions sent
  while the page was reloading; abandonment and timeouts.
- Security: loopback-only server, DNS-rebinding and CSRF protection, one-time pairing via URL
  fragment, strict CSP, secret redaction.
- `--json` NDJSON events and meaningful exit codes; run records in `.hatchway/runs/`.
- Unit, security, integration (forge, Hardhat, anvil, packed tarball) and Playwright tests;
  CI for Linux, macOS and Windows; release workflow with npm trusted publishing.

[Unreleased]: https://github.com/successaje/hatchway/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/successaje/hatchway/releases/tag/v0.1.0
