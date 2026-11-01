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

/**
 * The sensitive parts of a URL (credentials, query values, key-like path segments), so they
 * can be scrubbed from free text without hiding the harmless host and port.
 */
export function urlSecrets(raw: string): string[] {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return [raw];
  }
  const secrets: string[] = [];
  if (url.username) secrets.push(decodeURIComponent(url.username));
  if (url.password) secrets.push(decodeURIComponent(url.password));
  for (const segment of url.pathname.split("/"))
    if (SECRETISH_SEGMENT.test(segment)) secrets.push(segment);
  for (const value of url.searchParams.values()) if (value) secrets.push(value);
  return secrets;
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
