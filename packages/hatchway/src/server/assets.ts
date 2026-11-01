import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json; charset=utf-8",
};

export interface Asset {
  body: Buffer;
  contentType: string;
}

/**
 * The prebuilt signing page, loaded into memory once. Only files present at startup are
 * ever served, so request paths cannot escape the asset directory.
 */
export class UiAssets {
  readonly index: Buffer;
  readonly #files = new Map<string, Asset>();

  constructor(directory: string) {
    this.index = readFileSync(join(directory, "index.html"));
    for (const file of walk(directory)) {
      const type = CONTENT_TYPES[extname(file)];
      // HTML is only served at /s/<session> with the page's CSP, never as a cached asset.
      if (!type || extname(file) === ".html") continue;
      const key = relative(directory, file).split(sep).join("/");
      this.#files.set(key, { body: readFileSync(file), contentType: type });
    }
  }

  get(path: string): Asset | undefined {
    return this.#files.get(path);
  }

  static defaultDirectory(): string {
    // dist/server/assets.js -> dist/ui
    return fileURLToPath(new URL("../ui", import.meta.url));
  }
}

function* walk(directory: string): Generator<string> {
  for (const name of readdirSync(directory)) {
    const full = join(directory, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}
