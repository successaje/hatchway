// Copies the prebuilt signing UI into dist/ui so the published package is self-contained.
import { chmodSync, cpSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../../signing-ui/dist", import.meta.url));
const target = fileURLToPath(new URL("../dist/ui", import.meta.url));

if (!existsSync(`${source}/index.html`)) {
  console.error("signing UI build not found at", source);
  console.error("run `pnpm --filter @hatchway/signing-ui build` first (the root `pnpm build` does this)");
  process.exit(1);
}

cpSync(source, target, { recursive: true });
chmodSync(fileURLToPath(new URL("../dist/bin.js", import.meta.url)), 0o755);
