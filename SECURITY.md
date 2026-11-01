# Security policy

Hatchway sits between developer tools and a browser wallet. We take reports seriously.

## Reporting a vulnerability

Please **do not open a public issue**. Report privately through GitHub's
[private vulnerability reporting](https://github.com/successaje/hatchway/security/advisories/new)
for this repository.

Include what you found, how to reproduce it, the impact you expect, and the Hatchway version
(`hatchway --version`). Never include real private keys or seed phrases.

We aim to acknowledge reports within three working days and to share a fix plan within ten.

## Scope

In scope: anything that could let a party other than the user get a transaction or signature
approved, change what is approved, learn session tokens or RPC credentials, reach the local
server from a web page or another machine, or bypass the post-broadcast integrity checks.

Out of scope: vulnerabilities in wallets, browsers, forge or Hardhat themselves; attacks that
require malware already running as the user; issues in the example contracts (they are
examples, not audited code).

## Supported versions

Only the latest released minor version receives security fixes until 1.0.

## Audit status

Hatchway has not been independently audited. The threat model and its known gaps are in
[docs/research/security-considerations.md](docs/research/security-considerations.md).
