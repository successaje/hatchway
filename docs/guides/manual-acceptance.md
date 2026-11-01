# Manual acceptance test with a real wallet

Automated tests use a deterministic EIP-6963 test wallet. They prove the page, protocol and
engine, not compatibility with a specific extension. Run this checklist with **MetaMask** and
with **Rabby** before each release and record the results in the release notes.

Use a fresh browser profile and a wallet account that holds no real funds.

## Setup

```bash
anvil
```

```bash
pnpm install && pnpm build && npm link ./packages/hatchway
```

In the wallet: add network `http://127.0.0.1:8545` / chain id `31337` (or skip it to test the
"add network" path), then fund your account:

```bash
cast send --unlocked --from 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 --rpc-url http://127.0.0.1:8545 <your-address> --value 10ether
```

## Checklist

Run from `examples/foundry` unless noted. Mark each ✅/❌ with the wallet name and version.

1. **Discovery.** `hatchway forge script/DeployCounter.s.sol --rpc-url http://127.0.0.1:8545 --broadcast`.
   The page lists the wallet with its icon; with both MetaMask and Rabby installed, both appear.
2. **Connect.** Clicking the wallet opens its connection prompt; approving shows the address
   and network in the wallet bar; the terminal prints "Wallet connected".
3. **Review.** The page shows "Deploy Counter", simulation passed, estimated fee, predicted
   address. The wallet prompt shows the same chain and a contract deployment.
4. **Approve.** The page shows "Confirming", then "All done"; the terminal prints the address,
   and `cast code <address> --rpc-url http://127.0.0.1:8545` is non-empty.
5. **Multi-transaction.** `script/DeploySystem.s.sol`: five prompts, one at a time, in order;
   each deployment's predicted address matches the final address.
6. **Reject.** Rerun step 1 and reject in the wallet: the terminal exits with code 3, the page
   shows the rejection, nothing is mined (`cast nonce <address>` unchanged).
7. **Wrong network.** Switch the wallet to another network before connecting: the page asks to
   switch; "Switch to Local (Anvil/Hardhat)" switches (or adds) the network; the run continues.
8. **Account change.** During review, switch to another account: approval is disabled with a
   message; switching back re-enables it.
9. **Reload.** During review, reload the page: the session resumes without a new link and
   without reconnecting manually.
10. **Reload while the wallet prompt is open.** Click Confirm, then reload the page before
    answering; approve in the wallet: the terminal still reports the transaction (recovered
    from the chain).
11. **Slow approval.** Wait about 60 seconds before approving step 1: the run still succeeds.
12. **Signatures (Hardhat).** In `examples/hardhat-basic`:
    `LOCAL_RPC_URL=http://127.0.0.1:8545 hatchway hardhat run scripts/sign.ts --network localhost`.
    The page shows the message text; the wallet shows the same message; the script prints the
    recovered address equal to yours.
13. **Ignition.** `hatchway hardhat ignition deploy ignition/modules/Token.ts --network localhost`:
    three approvals, Ignition completes.
14. **Cancel.** Click "Cancel session" on the page: the terminal stops with exit code 10.
15. **Dark mode and narrow window.** The page is readable and nothing overflows.

## Known wallet behaviours to note

- MetaMask ignores the nonce in the request; this is expected and handled.
- After restarting Anvil, clear MetaMask's activity data before testing.
