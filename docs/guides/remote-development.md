# Remote development (SSH, containers)

The session page is served on the loopback interface of the machine running Hatchway. When
that machine is not the one with your browser, forward the port. Hatchway never listens on
`0.0.0.0`.

## SSH

Pick a fixed port so the forward is predictable:

```bash
hatchway forge --port 9555 script/Deploy.s.sol --rpc-url "$RPC_URL" --broadcast
```

On your local computer, forward that port:

```bash
ssh -N -L 9555:127.0.0.1:9555 you@dev-box
```

Then open the link Hatchway printed (it uses `http://127.0.0.1:9555/…`) in your local browser.
Hatchway detects SSH sessions, skips opening a browser on the remote machine, and prints these
instructions.

Use the **same port number** locally when you can. Hatchway accepts `localhost`/`127.0.0.1` on
any port, so a different local port also works.

## VS Code Remote and dev containers

VS Code forwards ports automatically when a process listens on them. Use `--port` so the port
is stable, then open the printed link from your local browser. If VS Code maps it to a different
local port, replace the port in the link.

## Not supported

- **GitHub Codespaces / browser-based IDE forwarding.** These expose ports through a public
  hostname (`*.app.github.dev`), which Hatchway rejects as a DNS-rebinding defence. Supporting
  them safely needs a separate design.
- **Phones.** A phone cannot reach your computer's loopback address.

## Security notes

The forwarded port is only reachable from your local machine. The session link still needs the
one-time pairing code from the terminal, and the page still requires your wallet for every
signature.
