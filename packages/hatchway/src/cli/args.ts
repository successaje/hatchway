import { HatchwayError } from "../core/errors.js";

export type OptionSpec = Record<string, { type: "boolean" | "string"; short?: string }>;

export type ParsedOptions = Record<string, string | boolean | undefined>;

/**
 * Parses Hatchway's own options. With `stopAtPositional`, parsing ends at the first
 * positional argument and everything from there on is returned untouched in `rest`. That is
 * how `hatchway forge <hatchway options> script/Deploy.s.sol <forge options>` keeps forge's
 * flags (including ones that share names with ours, such as --json) intact.
 */
export function parseOptions(
  argv: readonly string[],
  spec: OptionSpec,
  { stopAtPositional = false }: { stopAtPositional?: boolean } = {},
): { options: ParsedOptions; rest: string[] } {
  const options: ParsedOptions = {};
  const rest: string[] = [];
  const shortToLong = new Map(Object.entries(spec).flatMap(([name, s]) => (s.short ? [[s.short, name] as const] : [])));

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === "--") {
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (!token.startsWith("-") || token === "-") {
      if (stopAtPositional) {
        rest.push(...argv.slice(i));
        break;
      }
      rest.push(token);
      continue;
    }

    let name: string;
    let inline: string | undefined;
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      name = eq === -1 ? token.slice(2) : token.slice(2, eq);
      inline = eq === -1 ? undefined : token.slice(eq + 1);
    } else {
      const long = shortToLong.get(token.slice(1));
      if (!long) throw new HatchwayError("USAGE", `Unknown option ${token}`);
      name = long;
    }

    if (name.startsWith("no-") && spec[name.slice(3)]?.type === "boolean") {
      options[name.slice(3)] = false;
      continue;
    }
    const definition = spec[name];
    if (!definition) {
      throw new HatchwayError("USAGE", `Unknown option --${name}`, { hint: "Run `hatchway help` to see the available options." });
    }
    if (definition.type === "boolean") {
      options[name] = inline === undefined ? true : inline !== "false";
      continue;
    }
    const value = inline ?? argv[i + 1];
    if (value === undefined || (inline === undefined && value.startsWith("--"))) {
      throw new HatchwayError("USAGE", `Option --${name} needs a value.`);
    }
    if (inline === undefined) i += 1;
    options[name] = value;
  }
  return { options, rest };
}

export const SESSION_OPTIONS: OptionSpec = {
  json: { type: "boolean" },
  open: { type: "boolean" },
  port: { type: "string" },
  "session-timeout": { type: "string" },
  debug: { type: "boolean" },
  color: { type: "boolean" },
  help: { type: "boolean", short: "h" },
};
