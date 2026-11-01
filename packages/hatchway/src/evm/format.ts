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
