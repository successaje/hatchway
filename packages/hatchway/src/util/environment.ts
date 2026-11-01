import { existsSync } from "node:fs";

export interface RemoteContext {
  kind: "ssh" | "container" | "codespaces";
  description: string;
}

/**
 * Detects sessions where the browser is probably on a different machine than this process.
 * A loopback URL printed there is not reachable until the port is forwarded.
 */
export function detectRemoteContext(env: NodeJS.ProcessEnv = process.env): RemoteContext | undefined {
  if (env.CODESPACES === "true") return { kind: "codespaces", description: "GitHub Codespaces" };
  if (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) return { kind: "ssh", description: "an SSH session" };
  if (env.REMOTE_CONTAINERS === "true" || existsSync("/.dockerenv")) {
    return { kind: "container", description: "a container" };
  }
  return undefined;
}

export function canOpenBrowser(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.CI) return false;
  if (detectRemoteContext(env)) return false;
  if (process.platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY && !env.WSL_DISTRO_NAME) return false;
  return true;
}

/** Opens a URL in the default browser. Resolves to false instead of throwing. */
export async function openInBrowser(url: string): Promise<boolean> {
  try {
    const { default: open } = await import("open");
    const child = await open(url, { wait: false });
    return await new Promise<boolean>((resolve) => {
      child.once("error", () => resolve(false));
      child.once("spawn", () => resolve(true));
      setTimeout(() => resolve(true), 1_000).unref();
    });
  } catch {
    return false;
  }
}
