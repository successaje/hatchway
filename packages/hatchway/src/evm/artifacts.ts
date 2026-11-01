import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import {
  decodeAbiParameters,
  decodeFunctionData,
  getAddress,
  isAddress,
  toFunctionSelector,
  type Abi,
  type AbiFunction,
  type AbiParameter,
  type Hex,
} from "viem";
import type { DecodedArg } from "../core/protocol.js";

export interface ArtifactEntry {
  name: string;
  sourcePath?: string;
  abi: Abi;
  /** Creation bytecode, lowercase hex without 0x. May contain library link placeholders. */
  bytecode: string;
}

const MAX_FILES = 10_000;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const PLACEHOLDER = /__\$[0-9a-fA-F]{34}\$__/g;

/**
 * Index of compiled contracts in a Foundry (`out/`) or Hardhat (`artifacts/`) project.
 * Used only to label and decode requests for review; it never influences what is signed.
 */
export class ArtifactIndex {
  readonly entries: ArtifactEntry[];
  readonly #bySelector = new Map<string, { entry: ArtifactEntry; fn: AbiFunction }[]>();

  constructor(entries: ArtifactEntry[]) {
    this.entries = entries;
    for (const entry of entries) {
      for (const item of entry.abi) {
        if (item.type !== "function") continue;
        const selector = toFunctionSelector(item);
        const list = this.#bySelector.get(selector) ?? [];
        list.push({ entry, fn: item });
        this.#bySelector.set(selector, list);
      }
    }
  }

  static empty(): ArtifactIndex {
    return new ArtifactIndex([]);
  }

  /** Loads artifacts from the standard Foundry and Hardhat output directories under `root`. */
  static async load(root: string, directories: string[] = ["out", "artifacts"]): Promise<ArtifactIndex> {
    const entries: ArtifactEntry[] = [];
    const budget = { files: 0 };
    for (const dir of directories) {
      await collect(join(root, dir), root, entries, budget);
    }
    return new ArtifactIndex(entries);
  }

  findByName(name: string): ArtifactEntry[] {
    return this.entries.filter((entry) => entry.name === name || `${entry.sourcePath}:${entry.name}` === name);
  }

  /** Finds the artifact whose creation bytecode prefixes `data`, preferring the longest match. */
  matchCreation(data: Hex): { entry: ArtifactEntry; argsData: Hex } | undefined {
    const body = data.slice(2).toLowerCase();
    let best: ArtifactEntry | undefined;
    for (const entry of this.entries) {
      if (entry.bytecode.length === 0 || entry.bytecode.length > body.length) continue;
      if (best && best.bytecode.length >= entry.bytecode.length) continue;
      if (bytecodePrefixMatches(body, entry.bytecode)) best = entry;
    }
    if (!best) return undefined;
    return { entry: best, argsData: `0x${body.slice(best.bytecode.length)}` };
  }

  /** All known functions with this 4-byte selector, across every artifact. */
  functionsForSelector(selector: string): { entry: ArtifactEntry; fn: AbiFunction }[] {
    return this.#bySelector.get(selector.toLowerCase()) ?? [];
  }
}

function bytecodePrefixMatches(body: string, bytecode: string): boolean {
  if (!bytecode.includes("__$")) return body.startsWith(bytecode);
  // Library placeholders are 40 hex characters wide; treat them as wildcards.
  let cursor = 0;
  for (const match of bytecode.matchAll(PLACEHOLDER)) {
    const start = match.index;
    if (body.slice(cursor, start) !== bytecode.slice(cursor, start)) return false;
    cursor = start + match[0].length;
  }
  return body.slice(cursor, bytecode.length) === bytecode.slice(cursor);
}

async function collect(dir: string, root: string, out: ArtifactEntry[], budget: { files: number }): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (budget.files >= MAX_FILES) return;
    const full = join(dir, name);
    if (name === "build-info" || name === "node_modules" || name.startsWith(".")) continue;
    let info;
    try {
      info = await stat(full);
    } catch {
      continue;
    }
    if (info.isDirectory()) {
      await collect(full, root, out, budget);
      continue;
    }
    if (!name.endsWith(".json") || name.endsWith(".dbg.json") || info.size > MAX_FILE_BYTES) continue;
    budget.files += 1;
    const entry = await parseArtifact(full, root);
    if (entry) out.push(entry);
  }
}

async function parseArtifact(path: string, root: string): Promise<ArtifactEntry | undefined> {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (!Array.isArray(json.abi)) return undefined;
  const rawBytecode =
    typeof json.bytecode === "string"
      ? json.bytecode
      : typeof (json.bytecode as { object?: unknown } | undefined)?.object === "string"
        ? (json.bytecode as { object: string }).object
        : undefined;
  if (rawBytecode === undefined) return undefined;
  const bytecode = rawBytecode.replace(/^0x/, "").toLowerCase();

  const name =
    typeof json.contractName === "string" ? json.contractName : basename(path, ".json");
  let sourcePath: string | undefined;
  if (typeof json.sourceName === "string") sourcePath = json.sourceName;
  const target = (json.metadata as { settings?: { compilationTarget?: Record<string, string> } } | undefined)
    ?.settings?.compilationTarget;
  if (!sourcePath && target) sourcePath = Object.keys(target)[0];
  if (!sourcePath) sourcePath = relative(root, path);

  return { name, sourcePath, abi: json.abi as Abi, bytecode };
}

/** Renders a decoded ABI value as compact, human readable text. */
export function formatAbiValue(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") {
    if (isAddress(value, { strict: false })) return getAddress(value);
    if (/^0x[0-9a-fA-F]*$/.test(value)) return value;
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(formatAbiValue).join(", ")}]`;
  if (value !== null && typeof value === "object") {
    const fields = Object.entries(value as Record<string, unknown>).map(([k, v]) => `${k}: ${formatAbiValue(v)}`);
    return `{ ${fields.join(", ")} }`;
  }
  return String(value);
}

function toDecodedArgs(inputs: readonly AbiParameter[], values: readonly unknown[]): DecodedArg[] {
  return inputs.map((input, i) => ({
    name: input.name || `arg${i}`,
    type: input.type,
    value: formatAbiValue(values[i]),
  }));
}

export function decodeConstructorArgs(abi: Abi, argsData: Hex): DecodedArg[] | undefined {
  const ctor = abi.find((item) => item.type === "constructor");
  const inputs = ctor && "inputs" in ctor ? ctor.inputs : [];
  if (inputs.length === 0) return argsData === "0x" ? [] : undefined;
  try {
    return toDecodedArgs(inputs, decodeAbiParameters(inputs, argsData));
  } catch {
    return undefined;
  }
}

export function decodeCall(
  abi: Abi,
  data: Hex,
): { signature: string; functionName: string; args: DecodedArg[] } | undefined {
  try {
    const decoded = decodeFunctionData({ abi, data });
    const fn = abi.find(
      (item): item is AbiFunction =>
        item.type === "function" &&
        item.name === decoded.functionName &&
        toFunctionSelector(item) === data.slice(0, 10).toLowerCase(),
    );
    if (!fn) return undefined;
    const signature = `${fn.name}(${fn.inputs.map((i) => i.type).join(",")})`;
    return { signature, functionName: fn.name, args: toDecodedArgs(fn.inputs, decoded.args ?? []) };
  } catch {
    return undefined;
  }
}
