# Hardhat plugin reference

```ts
import hatchway from "hatchway/hardhat";
```

`hatchway` is a `HardhatPlugin` (`id: "hatchway"`) for Hardhat **3.x**. Add it to `plugins`
in `hardhat.config.ts`. It has no options and adds no tasks, global options or config fields.

## Behaviour

- **Inactive** unless the `HATCHWAY_BRIDGE_URL` environment variable is set, which
  `hatchway hardhat` does for the Hardhat process it starts. Tests and other tasks run
  untouched.
- When active, for **HTTP networks**, these methods are answered by the Hatchway session
  instead of the network: `eth_accounts`, `eth_requestAccounts`, `eth_sendTransaction`,
  `personal_sign`, `eth_signTypedData_v4`. Every other method that sends or signs (for example
  `eth_sendRawTransaction` from a script using a local key) is routed to the session too and
  refused, so nothing reaches the chain without wallet approval.
- On the first such call for a network connection, the plugin sends the resolved URL and HTTP
  headers of that network to the session, which uses it for simulation, verification and
  receipts. A session serves one network.
- For **EDR (in-process) networks**, wallet methods return an error explaining that a wallet
  cannot reach that network.

## Stability

The plugin's import path and behaviour are public API and follow semantic versioning. The
`HATCHWAY_BRIDGE_URL` variable and the `hatchway_attach` RPC method are internal and may change.
