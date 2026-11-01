/**
 * RPC URLs frequently embed API keys (Alchemy `/v2/<key>`, Infura `/v3/<key>`, `?apikey=`).
 * Anything printed, logged, or sent to the browser goes through `redactUrl` first.
 */

const SECRETISH_SEGMENT = /^[A-Za-z0-9_-]{16,}$/;

export function redactUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "<invalid url>";
  }
  if (url.username || url.password) {
    url.username = url.username ? "***" : "";
    url.password = url.password ? "***" : "";
  }
  const segments = url.pathname
    .split("/")
    .map((segment) => (SECRETISH_SEGMENT.test(segment) ? "***" : segment));
  url.pathname = segments.join("/");
  for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, "***");
  // URL serialisation percent-encodes "*"; keep the placeholder readable.
  return url.toString().replaceAll("%2A%2A%2A", "***");
}

/** True for http(s) URLs that point at this machine and carry no credentials. */
export function isLoopbackUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (host === "127.0.0.1" || host === "localhost" || host === "::1") &&
      !url.username &&
      !url.password &&
      url.search === ""
    );
  } catch {
    return false;
  }
}

/** Replaces every occurrence of known secret strings in free text. */
export function scrubSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 8) out = out.split(secret).join("***");
  }
  return out;
}
