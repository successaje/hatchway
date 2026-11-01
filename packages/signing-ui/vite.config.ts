import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

// The page is served by the Hatchway CLI under /ui/ with a strict CSP (script-src 'self'),
// so the build must not emit inline scripts or styles.
export default defineConfig({
  base: "/ui/",
  plugins: [preact({ devToolsEnabled: false, prefreshEnabled: false })],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
    cssCodeSplit: false,
    sourcemap: false,
  },
});
