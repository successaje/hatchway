# JSON events (`--json`)

With `--json`, stdout carries one JSON object per line. Every object has an `event` field. New
fields may be added in minor versions; existing fields keep their meaning.

| `event`          | When                                                      | Fields                                                                                                                  |
| ---------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `session`        | Session started, or a reconnect link                      | `url`, `port`, `expiresAt` (ISO time) · `reconnect: true` for a fresh link after the tab closed                         |
| `wallet`         | A wallet account was bound                                | `address`, `chainId`, `wallet` (display name)                                                                           |
| `wallet_issue`   | Wallet on wrong chain/account/disconnected                | `issue` (`wrong_chain` \| `wrong_account` \| `disconnected`), `message`                                                 |
| `ready`          | `connect` only: endpoint available                        | `rpcUrl` (contains a secret token), `address`, `chainId`                                                                |
| `request`        | A request is shown for review                             | `index`, `kind` (`transaction` \| `signature`), `title`, `action`, `simulation` (`passed` \| `failed` \| `unavailable`) |
| `submitted`      | The wallet broadcast a transaction                        | `index`, `hash`                                                                                                         |
| `confirmed`      | Mined successfully, or signed                             | `index`, `state`, `hash?`, `contractAddress?`, `blockNumber?`                                                           |
| `failed`         | Rejected, reverted, expired, withdrawn, integrity failure | `index`, `state`, `hash?`, `code`, `message`                                                                            |
| `late_broadcast` | The wallet sent a request after it was withdrawn          | `index`, `hash`                                                                                                         |
| `error`          | A command-level error                                     | `code`, `message`, `hint?`                                                                                              |
| `result`         | Last line                                                 | `ok`, `exitCode`, `chainId?`, `wallet?`, `transactions`, `runRecord?`, `broadcastFile?` (forge), `error?`               |

`transactions` entries:

```json
{
  "index": 1,
  "kind": "transaction",
  "title": "Deploy HatchToken",
  "state": "confirmed",
  "action": "deploy",
  "contractName": "HatchToken",
  "hash": "0x…",
  "nonce": 0,
  "blockNumber": "1",
  "gasUsed": "475269",
  "fee": "950538000475269",
  "contractAddress": "0x…",
  "explorerUrl": "https://…"
}
```

Amounts (`fee`, `gasUsed`, `blockNumber`) are decimal strings to avoid precision loss.

Error `code` values: `USAGE`, `USER_REJECTED`, `SESSION_EXPIRED`, `APPROVAL_TIMEOUT`,
`SESSION_CANCELLED`, `SESSION_CLOSED`, `RPC_UNREACHABLE`, `RPC_ERROR`, `WRONG_NETWORK`,
`WRONG_ACCOUNT`, `UNSUPPORTED_SIGNER`, `UNSUPPORTED_TRANSACTION`, `INVALID_TRANSACTION`,
`NONCE_CONFLICT`, `TRANSACTION_REVERTED`, `PREVIOUS_FAILED`, `INTEGRITY_MISMATCH`,
`TRANSACTION_REPLACED`, `WALLET_ERROR`, `TOOL_NOT_FOUND`, `TOOL_FAILED`, `PROJECT_NOT_FOUND`,
`ARTIFACT_NOT_FOUND`, `PORT_IN_USE`, `INTERRUPTED`, `INTERNAL`.

`doctor --json` and `chains --json` print a single `result` event with `checks` or `chains`.

Secrets (RPC tokens, provider keys) are scrubbed from events, except `ready.rpcUrl`, whose
purpose is to hand the endpoint to the caller.
