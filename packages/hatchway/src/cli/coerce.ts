import { getAddress, isAddress, isHex, parseEther, parseUnits, type AbiParameter } from "viem";
import { HatchwayError } from "../core/errors.js";

/** Converts a command-line string into the value viem expects for an ABI type. */
export function coerceArg(param: AbiParameter, raw: unknown): unknown {
  const type = param.type;
  const label = param.name ? `"${param.name}" (${type})` : type;

  const arrayMatch = /^(.*)\[(\d*)\]$/.exec(type);
  if (arrayMatch) {
    const items = typeof raw === "string" ? parseJson(raw, label) : raw;
    if (!Array.isArray(items))
      throw usage(`Argument ${label} must be a JSON array, e.g. '[1,2,3]'.`);
    if (arrayMatch[2] && items.length !== Number(arrayMatch[2]))
      throw usage(`Argument ${label} needs exactly ${arrayMatch[2]} items.`);
    const inner = { ...param, type: arrayMatch[1]! } as AbiParameter;
    return items.map((item) => coerceArg(inner, item));
  }
  if (type === "tuple") {
    const components = (param as { components?: readonly AbiParameter[] }).components ?? [];
    const value = typeof raw === "string" ? parseJson(raw, label) : raw;
    if (Array.isArray(value)) return components.map((c, i) => coerceArg(c, value[i]));
    if (value && typeof value === "object") {
      return Object.fromEntries(
        components.map((c) => [
          c.name,
          coerceArg(c, (value as Record<string, unknown>)[c.name ?? ""]),
        ]),
      );
    }
    throw usage(`Argument ${label} must be a JSON array or object.`);
  }

  const text = typeof raw === "string" ? raw : JSON.stringify(raw);
  if (/^u?int\d*$/.test(type)) {
    try {
      return BigInt(text);
    } catch {
      throw usage(`Argument ${label} must be an integer (decimal or 0x hex), got ${text}.`);
    }
  }
  if (type === "address") {
    if (!isAddress(text, { strict: false }))
      throw usage(`Argument ${label} must be an address, got ${text}.`);
    return getAddress(text);
  }
  if (type === "bool") {
    if (["true", "1"].includes(text)) return true;
    if (["false", "0"].includes(text)) return false;
    throw usage(`Argument ${label} must be true or false.`);
  }
  if (type === "string") return typeof raw === "string" ? raw : text;
  if (/^bytes\d*$/.test(type)) {
    if (!isHex(text)) throw usage(`Argument ${label} must be 0x-prefixed hex.`);
    return text;
  }
  throw usage(`Unsupported constructor argument type ${type}.`);
}

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw usage(`Argument ${label} must be valid JSON.`);
  }
}

function usage(message: string): HatchwayError {
  return new HatchwayError("USAGE", message);
}

/** Parses "0.1ether", "20gwei", "1 ether" or a plain wei integer. */
export function parseValue(input: string): bigint {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(ether|eth|gwei|wei)?\s*$/i.exec(input);
  if (!match)
    throw usage(`Cannot parse value "${input}". Use e.g. 0.1ether, 20gwei or a wei amount.`);
  const amount = match[1]!;
  const unit = (match[2] ?? "wei").toLowerCase();
  if (unit === "ether" || unit === "eth") return parseEther(amount);
  if (unit === "gwei") return parseUnits(amount, 9);
  if (amount.includes(".")) throw usage("A wei amount must be a whole number.");
  return BigInt(amount);
}
