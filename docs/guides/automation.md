# Automation and AI agents

Hatchway separates **preparing** a deployment from **authorising** it. A script, CI job or AI
coding agent can compile, test, run the deployment command and read the results; a human
approves each transaction in their wallet. The automation never sees a private key and cannot
approve anything itself.

## Machine-readable output

Add `--json` (before the tool's own arguments). Stdout becomes one JSON object per line;
human-readable progress goes to stderr.

```bash
hatchway forge --json --no-open script/Deploy.s.sol --rpc-url "$RPC_URL" --broadcast
```

```json
{"event":"session","url":"http://127.0.0.1:53712/s/…#…","port":53712,"expiresAt":"2026-11-01T12:00:00.000Z"}
{"event":"wallet","address":"0xf39F…","chainId":31337,"wallet":"MetaMask"}
{"event":"request","index":1,"kind":"transaction","title":"Deploy HatchToken","action":"deploy","simulation":"passed"}
{"event":"submitted","index":1,"hash":"0xd42c…"}
{"event":"confirmed","index":1,"state":"confirmed","hash":"0xd42c…","contractAddress":"0x5FbD…","blockNumber":"1"}
{"event":"result","ok":true,"exitCode":0,"chainId":31337,"wallet":"0xf39F…","transactions":[…],"runRecord":".hatchway/runs/…json"}
```

All events are listed in the [JSON events reference](../reference/json-events.md). The process
exit code is meaningful (0 success, 3 rejected, 8 reverted, 9 integrity, …; see the
[CLI reference](../reference/cli.md#exit-codes)).

## A recommended agent loop

1. Run the command with `--json --no-open` in the background.
2. Read the first `session` event and show the URL to the human ("Open this link to review and
   approve the deployment"). If another `session` event arrives with `reconnect: true`, the tab
   was closed: show the new link.
3. Follow `request`/`submitted`/`confirmed`/`failed` events to report progress.
4. Read the final `result` event (or the `runRecord` file) for addresses and hashes, then
   continue (verify, update config, run integration tests). If `ok` is false, see
   [when a run stops](#when-a-run-stops) before doing anything else.

## When a run stops

Hatchway never turns a human decision into a retry. The `result` event's `exitCode` and
`error.code`, also the process exit code, say why a run ended:

| Exit | `error.code`                                 | What happened                                                                                                                                 | What the agent should do                                                       |
| ---- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 3    | `USER_REJECTED`                              | The person rejected a request in the wallet. Nothing after it was sent.                                                                       | Stop. Ask before running anything again, and what to change.                   |
| 10   | `SESSION_CANCELLED`                          | The person clicked "Cancel session" on the page.                                                                                              | Stop and ask.                                                                  |
| 4    | `APPROVAL_TIMEOUT`, `SESSION_EXPIRED`        | Nobody approved within 15 minutes of a request being shown, connected a wallet within 15 minutes, or the session reached `--session-timeout`. | Check with the person before starting a new session.                           |
| 2    | `USAGE`                                      | Includes, with forge 1.10 and later, a script whose previous broadcast stopped part-way. No session was opened.                               | Ask whether to `--resume` (send what is left) or `--start-fresh` (start over). |
| 8    | `TRANSACTION_REVERTED`                       | Approved and mined, but reverted on-chain. Later transactions were not sent.                                                                  | Investigate. A rerun deploys and sends again.                                  |
| 9    | `INTEGRITY_MISMATCH`, `TRANSACTION_REPLACED` | The wallet broadcast something other than what was approved, or the transaction was replaced.                                                 | Stop and report it; do not retry.                                              |

The full list is in the [CLI reference](../reference/cli.md#exit-codes). Each entry in
`transactions` has its own `state` (`confirmed`, `rejected`, `expired`, `reverted`, …), so the
agent can tell what went through before the stop.

- **A closed tab is not a stop.** The session keeps waiting. After a few seconds without a page,
  Hatchway emits a `session` event with `reconnect: true` and a fresh link (links are single-use).
  If nobody returns, the open request expires and the run ends with exit code 4.
- **A rerun is a new request.** It asks the wallet again for every transaction; a rejection is
  never replayed as an approval. Rerunning after a rejection without asking only puts the same
  question back in front of the person.

## Rules the boundary enforces

- Only a human with the wallet can approve. There is no flag, environment variable or API to
  auto-approve.
- Each transaction is approved individually; there is no blanket permission or delegation.
- A rejected request is never retried as approved. Retries by tools get the original answer.
- The session link is a capability: treat it like a one-time password and show it only to the
  person who should approve.
- Repository content and tool output cannot change what is shown or signed: the wallet prompt
  is built from the exact request the tool sent, and the broadcast is verified against it.

## `connect` for long-running agents

`hatchway connect --json --rpc-url <url>` emits a `ready` event with a local `rpcUrl`. Any
JSON-RPC client can send `eth_sendTransaction` there; each one is queued for human approval.
The endpoint carries a secret token: keep it in the agent's process and do not log it.

## Model Context Protocol

There is no MCP server yet. The NDJSON interface is the supported integration point; an MCP
wrapper would expose the same flow and must keep human approval for every signature.
