# Wallets

Hatchway works with browser wallets that implement **EIP-1193** and announce themselves with
**EIP-6963**: MetaMask, Rabby, Coinbase Wallet, Brave Wallet and others. If several are
installed, the page lists each one and you choose. A wallet that only injects `window.ethereum`
is offered as a fallback.

| Wallet   | Status                                                                                                    |
| -------- | --------------------------------------------------------------------------------------------------------- |
| MetaMask | Designed for; manual acceptance test documented in [manual-acceptance.md](manual-acceptance.md), pending  |
| Rabby    | Designed for; same manual test, pending                                                                   |
| Others   | Should work if they support `eth_requestAccounts`, `eth_sendTransaction` and `wallet_switchEthereumChain` |

Automated tests use a deterministic EIP-6963 test wallet; they prove the page and protocol,
not any particular extension.

## What the wallet is asked to do

| Wallet method                           | When                                                                                      |
| --------------------------------------- | ----------------------------------------------------------------------------------------- |
| `eth_requestAccounts`                   | When you click a wallet on the page                                                       |
| `eth_accounts`, `eth_chainId`           | Before each approval, to re-check account and network                                     |
| `wallet_switchEthereumChain`            | When you click "Switch to …"                                                              |
| `wallet_addEthereumChain`               | If the wallet does not know the network (public RPC URLs, or a credential-free local URL) |
| `eth_sendTransaction`                   | When you click "Confirm in …" for a transaction                                           |
| `personal_sign`, `eth_signTypedData_v4` | When you click "Sign in …" for a signature request                                        |

Hatchway never calls `eth_sign`, never asks for raw signed transactions, and never asks for a
seed phrase, private key or password.

## Behaviour to know about

- **Nonces.** MetaMask ignores a nonce supplied by the page and picks its own. Hatchway shows
  one request at a time after the previous one is mined, so MetaMask's choice matches what
  forge planned. If it does not (for example because you sent something else from the same
  account), Hatchway stops with an integrity error instead of continuing with wrong addresses.
- **Editing in the wallet.** Changing gas or fees in the wallet is fine. Changing the data,
  value, recipient or nonce is detected after broadcast and stops the run.
- **Speed up / cancel.** Using these on a transaction Hatchway is tracking replaces it;
  Hatchway reports the replacement and stops.
- **Local chains.** After restarting Anvil, MetaMask may remember old nonces. Clear activity
  data (Settings → Advanced → Clear activity tab data) or reset the account.

## Mobile wallets

Not supported yet. The session page is served from your computer's loopback address, which a
phone cannot open. WalletConnect support would need a separately designed, opt-in transport.
