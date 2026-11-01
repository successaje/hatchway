import { createColors } from "picocolors";
import type { HatchwayError } from "../core/errors.js";
import { scrubSecrets } from "../util/redact.js";

export interface ReporterOptions {
  json: boolean;
  debug: boolean;
  color?: boolean | undefined;
  stdout?: NodeJS.WritableStream & { isTTY?: boolean };
  stderr?: NodeJS.WritableStream & { isTTY?: boolean };
}

export type JsonEvent = { event: string } & Record<string, unknown>;

/**
 * Terminal output. Human-readable lines go to stdout, or to stderr in --json mode where
 * stdout carries one JSON object per line (NDJSON) for scripts and AI agents.
 */
export class Reporter {
  readonly json: boolean;
  readonly debug: boolean;
  readonly c: ReturnType<typeof createColors>;
  readonly #human: NodeJS.WritableStream;
  readonly #stdout: NodeJS.WritableStream;
  #secrets: string[] = [];

  constructor(options: ReporterOptions) {
    this.json = options.json;
    this.debug = options.debug;
    this.#stdout = options.stdout ?? process.stdout;
    const human = options.json ? (options.stderr ?? process.stderr) : this.#stdout;
    this.#human = human;
    const isTty = (human as { isTTY?: boolean }).isTTY === true;
    const env = process.env;
    const noColor = env.NO_COLOR !== undefined && env.NO_COLOR !== "";
    const enabled =
      options.color ??
      (!noColor && (env.FORCE_COLOR !== undefined || (isTty && env.TERM !== "dumb")));
    this.c = createColors(enabled);
  }

  /** Values that must never be printed (RPC tokens, provider API keys). */
  addSecrets(secrets: readonly string[]): void {
    this.#secrets.push(...secrets);
  }

  line(text = ""): void {
    this.#human.write(`${scrubSecrets(text, this.#secrets)}\n`);
  }

  header(command: string): void {
    this.line();
    this.line(`${this.c.bold("Hatchway")}  ${this.c.dim(command)}`);
    this.line();
  }

  field(label: string, value: string): void {
    this.line(`  ${this.c.dim(label.padEnd(11))}${value}`);
  }

  step(text: string): void {
    this.line(`  ${this.c.dim("○")} ${text}`);
  }

  active(text: string): void {
    this.line(`  ${this.c.cyan("●")} ${text}`);
  }

  ok(text: string): void {
    this.line(`  ${this.c.green("✓")} ${text}`);
  }

  warn(text: string): void {
    this.line(`  ${this.c.yellow("!")} ${text}`);
  }

  fail(text: string): void {
    this.line(`  ${this.c.red("✗")} ${text}`);
  }

  note(text: string): void {
    this.line(`    ${this.c.dim(text)}`);
  }

  /** A line of output from a wrapped tool (forge, Hardhat), set off with a gutter. */
  tool(name: string, text: string): void {
    this.line(`  ${this.c.dim(`${name} │`)} ${text}`);
  }

  /**
   * Emits an NDJSON event in --json mode. Secrets are scrubbed unless `revealSecrets` is set
   * for an event whose purpose is to hand over a credential (e.g. `connect`'s endpoint).
   */
  event(event: JsonEvent, { revealSecrets = false }: { revealSecrets?: boolean } = {}): void {
    if (!this.json) return;
    const text = JSON.stringify(event);
    this.#stdout.write(`${revealSecrets ? text : scrubSecrets(text, this.#secrets)}\n`);
  }

  error(error: HatchwayError): void {
    this.line();
    this.line(`  ${this.c.red("✗")} ${this.c.bold(error.message)}`);
    if (error.hint) this.line(`    ${error.hint}`);
    if (this.debug) {
      if (error.details) this.line(this.c.dim(`    details: ${JSON.stringify(error.details)}`));
      const cause = (error as { cause?: unknown }).cause;
      if (error.stack) this.line(this.c.dim(error.stack));
      if (cause instanceof Error && cause.stack) this.line(this.c.dim(`caused by: ${cause.stack}`));
    } else if (error.code === "INTERNAL") {
      this.line(this.c.dim("    Run again with --debug for details."));
    }
    this.event({
      event: "error",
      code: error.code,
      message: error.message,
      ...(error.hint ? { hint: error.hint } : {}),
    });
  }
}
