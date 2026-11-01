import type {
  ApiError,
  BeginRequest,
  ClaimResponse,
  ResultRequest,
  SessionSnapshot,
  WalletUpdate,
} from "../../hatchway/src/core/protocol.ts";

/**
 * Talks to the local Hatchway server. The pairing code arrives in the URL fragment (never
 * sent to the server, never in Referer headers) and is exchanged once for a bearer token.
 * The token lives in sessionStorage, so a refresh of this tab reconnects but other tabs and
 * browsers cannot reuse it.
 */

export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface SessionLink {
  sessionId: string;
  token: string;
}

const storageKey = (sessionId: string) => `hatchway:${sessionId}`;

function readStorage(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // Storage can be disabled; the session still works until the tab is refreshed.
  }
}

export function currentSessionId(): string | undefined {
  const match = /^\/s\/([A-Za-z0-9_-]{8,64})$/.exec(location.pathname);
  return match?.[1];
}

async function post(path: string, body: unknown, token?: string): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(path, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    credentials: "omit",
    cache: "no-store",
  });
}

async function failure(response: Response): Promise<ApiFailure> {
  let body: Partial<ApiError> = {};
  try {
    body = (await response.json()) as ApiError;
  } catch {
    // keep defaults
  }
  return new ApiFailure(
    response.status,
    body.error ?? "HTTP_ERROR",
    body.message ?? `Request failed (${response.status}).`,
  );
}

/** Redeems the pairing code from the URL fragment, or reuses this tab's token. */
export async function pair(sessionId: string): Promise<SessionLink> {
  const code = location.hash.length > 1 ? decodeURIComponent(location.hash.slice(1)) : undefined;
  // Remove the code from the address bar and history immediately.
  if (location.hash) history.replaceState(null, "", location.pathname);

  const stored = readStorage(storageKey(sessionId));
  if (code) {
    const response = await post(`/api/s/${sessionId}/claim`, { code });
    if (response.ok) {
      const { token } = (await response.json()) as ClaimResponse;
      writeStorage(storageKey(sessionId), token);
      return { sessionId, token };
    }
    if (!stored) throw await failure(response);
  }
  if (stored) return { sessionId, token: stored };
  throw new ApiFailure(401, "NO_LINK", "Open the link printed in your terminal to start.");
}

export class SessionApi {
  constructor(readonly link: SessionLink) {}

  #path(suffix: string): string {
    return `/api/s/${this.link.sessionId}/${suffix}`;
  }

  async #send(suffix: string, body: unknown): Promise<void> {
    const response = await post(this.#path(suffix), body, this.link.token);
    if (!response.ok) throw await failure(response);
  }

  reportWallet(update: WalletUpdate): Promise<void> {
    return this.#send("wallet", update);
  }

  begin(requestId: string, body: BeginRequest): Promise<void> {
    return this.#send(`requests/${requestId}/begin`, body);
  }

  result(requestId: string, body: ResultRequest): Promise<void> {
    return this.#send(`requests/${requestId}/result`, body);
  }

  cancel(): Promise<void> {
    return this.#send("cancel", {});
  }

  /** A fresh one-time link for opening this session in another browser. */
  async handoffUrl(): Promise<string> {
    const response = await post(this.#path("handoff"), {}, this.link.token);
    if (!response.ok) throw await failure(response);
    const { code } = (await response.json()) as { code: string };
    return `${location.origin}/s/${this.link.sessionId}#${code}`;
  }

  /**
   * Streams session snapshots (server-sent events over fetch, so the token can travel in a
   * header). Resolves when the stream ends; rejects with ApiFailure on auth errors.
   */
  async stream(
    onSnapshot: (snapshot: SessionSnapshot) => void,
    onRevoked: () => void,
    signal: AbortSignal,
  ): Promise<void> {
    const response = await fetch(this.#path("events"), {
      headers: { authorization: `Bearer ${this.link.token}`, accept: "text/event-stream" },
      cache: "no-store",
      credentials: "omit",
      signal,
    });
    if (!response.ok || !response.body) throw await failure(response);
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += value;
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
        let event = "message";
        const data: string[] = [];
        for (const line of block.split("\n")) {
          if (line.startsWith("event: ")) event = line.slice(7);
          else if (line.startsWith("data: ")) data.push(line.slice(6));
        }
        if (event === "snapshot" && data.length)
          onSnapshot(JSON.parse(data.join("\n")) as SessionSnapshot);
        if (event === "revoked") onRevoked();
      }
    }
  }
}
