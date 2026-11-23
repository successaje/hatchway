import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/** What forge submitted in a `verifysourcecode` call. */
export interface Submission {
  contractaddress: string;
  contractname: string;
  compilerversion: string;
  codeformat: string;
  constructorArguments?: string;
}

export interface Verifier {
  /** API URL to pass as `--verifier-url` with `--verifier blockscout`. */
  url: string;
  submissions: Submission[];
  close: () => Promise<void>;
}

/**
 * A local Etherscan-compatible verification API (the shape Blockscout also serves), so forge's
 * real `verify-contract` and `script --verify` code paths run without a public explorer.
 * Every contract reads as unverified; each submission is recorded and then passes, or fails
 * when `fail` is set.
 */
export async function startVerifier({ fail = false }: { fail?: boolean } = {}): Promise<Verifier> {
  const submissions: Submission[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      const query = new URL(req.url ?? "/", "http://localhost").searchParams;
      const params = new URLSearchParams(body || query.toString());
      res.setHeader("content-type", "application/json");
      const reply = (status: "0" | "1", result: string) =>
        res.end(JSON.stringify({ status, message: status === "1" ? "OK" : "NOTOK", result }));
      switch (params.get("action")) {
        case "getabi":
          return reply("0", "Contract source code not verified");
        case "verifysourcecode":
          submissions.push(Object.fromEntries(params) as unknown as Submission);
          return reply("1", `guid-${submissions.length}`);
        case "checkverifystatus":
          return fail ? reply("0", "Fail - Unable to verify") : reply("1", "Pass - Verified");
        default:
          return reply("0", "Unknown action");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/api`,
    submissions,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
