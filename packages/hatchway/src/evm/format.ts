import { formatUnits } from "viem";

/** Formats a wei amount with at most `maxDecimals` fractional digits, never using floats. */
export function formatAmount(wei: bigint, symbol: string, decimals = 18, maxDecimals = 6): string {
  if (wei === 0n) return `0 ${symbol}`;
  const full = formatUnits(wei, decimals);
  const [whole, fraction = ""] = full.split(".");
  let trimmed = fraction.slice(0, maxDecimals).replace(/0+$/, "");
  if (trimmed === "" && whole === "0") {
    // Amount is smaller than the display precision; show significant digits instead.
    const firstSignificant = fraction.search(/[1-9]/);
    trimmed = fraction.slice(0, firstSignificant + 2).replace(/0+$/, "");
  }
  return `${trimmed ? `${whole}.${trimmed}` : whole} ${symbol}`;
}

export function formatGwei(wei: bigint): string {
  return `${formatAmount(wei, "gwei", 9, 3).replace(" gwei", "")} gwei`;
}

export function shortHex(value: string, lead = 6, tail = 4): string {
  if (value.length <= lead + tail + 1) return value;
  return `${value.slice(0, lead)}…${value.slice(-tail)}`;
}

/**
 * The text a fixed-size bytes value holds, such as "token" for `bytes32("token")`: printable
 * ASCII followed only by zero padding. Anything else (hashes, numbers, empty) returns undefined.
 */
export function fixedBytesText(type: string, value: string): string | undefined {
  if (!/^bytes([1-9]|[12][0-9]|3[0-2])$/.test(type)) return undefined;
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(value)) return undefined;
  const bytes = value
    .slice(2)
    .match(/../g)!
    .map((pair) => parseInt(pair, 16));
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  const text = bytes.slice(0, end);
  if (text.some((byte) => byte < 0x20 || byte > 0x7e)) return undefined;
  const result = String.fromCharCode(...text);
  return result.trim() ? result : undefined;
}

export function formatInteger(value: bigint | number): string {
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Parses durations such as "90s", "15m", "2h" or plain seconds. */
export function parseDuration(input: string): number | undefined {
  const match = /^(\d+)(ms|s|m|h)?$/.exec(input.trim());
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unit = match[2] ?? "s";
  const factor = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000;
  return amount * factor;
}
