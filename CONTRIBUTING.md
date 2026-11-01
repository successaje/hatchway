# Contributing

Thanks for helping. Hatchway handles transaction signing, so changes are held to a high bar:
every behaviour change needs a test, and security-relevant changes need a note in
`docs/research/security-considerations.md`.

## Setup

Requirements: Node.js 22+, pnpm 10, [Foundry](https://getfoundry.sh) (for integration tests).

```bash
pnpm install
```

```bash
pnpm build
```

## Repository layout

| Path                  | What                                                                |
| --------------------- | ------------------------------------------------------------------- |
| `packages/hatchway`   | The published package: CLI, bridge, approval engine, Hardhat plugin |
| `packages/signing-ui` | The browser page (Preact), built into `packages/hatchway/dist/ui`   |
| `examples/`           | Foundry and Hardhat 3 example projects (also used by tests)         |
| `e2e/`                | Playwright tests with a deterministic EIP-6963 test wallet          |
| `docs/`               | Guides, reference, research, architecture decisions                 |

Start with [docs/architecture/decisions.md](docs/architecture/decisions.md).

## Checks

| Command                              | What it runs                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------------- |
| `pnpm lint`                          | ESLint                                                                          |
| `pnpm format:check`                  | Prettier (`pnpm format` to fix)                                                 |
| `pnpm typecheck`                     | TypeScript, strict                                                              |
| `pnpm test`                          | Unit and security tests (no external tools)                                     |
| `pnpm test:integration`              | Real forge, Hardhat and anvil; installs the packed tarball (needs a build)      |
| `pnpm test:e2e`                      | Playwright against the real page (`pnpm exec playwright install chromium` once) |
| `UPDATE_SCREENSHOTS=1 pnpm test:e2e` | Same, and refreshes the screenshots in `docs/assets/screenshots`                |

`pnpm check` runs lint, format, types, build and unit tests. CI runs everything on Linux and
macOS, and unit tests on Windows.

## Guidelines

- TypeScript strict mode, no `any`, no silent `catch` blocks.
- Keep runtime dependencies minimal; discuss new ones in an issue first.
- Never log or print secrets; use `redactUrl`/`scrubSecrets`.
- The signing page must stay free of third-party scripts and inline code (strict CSP).
- Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat(cli): …`,
  `fix(session): …`, `docs: …`).
- Update `CHANGELOG.md` under "Unreleased" for user-visible changes.

## Releasing (maintainers)

1. Update the version in `packages/hatchway/package.json` and move "Unreleased" entries in
   `CHANGELOG.md` under the new version.
2. Run the [manual acceptance test](docs/guides/manual-acceptance.md) with MetaMask and Rabby.
3. Tag `vX.Y.Z` and push the tag. The release workflow tests, packs and publishes to npm with
   provenance through trusted publishing, then creates a GitHub release.
