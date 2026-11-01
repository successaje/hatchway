/**
 * RPC URLs frequently embed API keys (Alchemy `/v2/<key>`, Infura `/v3/<key>`, `?apikey=`).
 * Anything printed, logged, or sent to the browser goes through `redactUrl` first.
 */

/**
 * Heuristic for API keys in URL path segments and host labels. Long tokens (including
 * JWT-style ones with dots) always count; shorter ones count when they mix letters and digits.
 * False positives only hide harmless text, so the rule leans towards hiding.
 */
function looksSecret(part: string): boolean {
  if (!/^[A-Za-z0-9_.~-]+$/.test(part)) return false;
  if (part.length >= 24) return true;
  return part.length >= 12 && /[0-9]/.test(part) && /[A-Za-z]/.test(part);
}

function looksSecretLabel(label: string): boolean {
  return label.length >= 16 && /[0-9]/.test(label) && /[a-z]/i.test(label);
}

export function redactUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "<invalid url>";
  }
  const userinfo =
    url.username || url.password
      ? `${url.username ? "***" : ""}${url.password ? ":***" : ""}@`
      : "";
  const host = url.hostname
    .split(".")
    .map((label) => (looksSecretLabel(label) ? "***" : label))
    .join(".");
  const port = url.port ? `:${url.port}` : "";
  const path = url.pathname
    .split("/")
    .map((segment) => (looksSecret(segment) ? "***" : segment))
    .join("/");
  const query = [...url.searchParams.keys()].map((key) => `${key}=***`).join("&");
  return `${url.protocol}//${userinfo}${host}${port}${path}${query ? `?${query}` : ""}`;
}

/**
 * The sensitive parts of a URL (credentials, query values, key-like path segments and host
 * labels), so they can be scrubbed from free text without hiding the harmless host and port.
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
  for (const label of url.hostname.split(".")) if (looksSecretLabel(label)) secrets.push(label);
  for (const segment of url.pathname.split("/")) if (looksSecret(segment)) secrets.push(segment);
  for (const value of url.searchParams.values()) if (value) secrets.push(value);
  return secrets;
}

/** Flags whose value is a credential when it appears in a recorded command line. */
const SENSITIVE_FLAGS = new Set([
  "--etherscan-api-key",
  "--verifier-api-key",
  "--api-key",
  "--private-key",
  "--private-keys",
  "--mnemonic",
  "--mnemonics",
  "--password",
  "--keystore-password",
  "--rpc-headers",
  "--verifier-url",
]);

const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Renders a command line for logs and run records: credential flag values are replaced,
 * URLs are redacted, and any known secret is scrubbed.
 */
export function sanitizeCommand(args: readonly string[], secrets: readonly string[] = []): string {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    const eq = token.indexOf("=");
    const flag = eq === -1 ? token : token.slice(0, eq);
    if (SENSITIVE_FLAGS.has(flag)) {
      if (eq !== -1) out.push(`${flag}=***`);
      else {
        out.push(token);
        if (i + 1 < args.length) {
          out.push("***");
          i += 1;
        }
      }
      continue;
    }
    if (URL_LIKE.test(token)) out.push(redactUrl(token));
    else if (eq !== -1 && URL_LIKE.test(token.slice(eq + 1)))
      out.push(`${flag}=${redactUrl(token.slice(eq + 1))}`);
    else out.push(token);
  }
  return scrubSecrets(out.join(" "), secrets);
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
