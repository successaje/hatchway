import { ExitCode, HatchwayError, toHatchwayError } from "../core/errors.js";
import { chainsCommand } from "./commands/chains.js";
import { connectCommand } from "./commands/connect.js";
import { deployCommand } from "./commands/deploy.js";
import { doctorCommand } from "./commands/doctor.js";
import { forgeCommand } from "./commands/forge.js";
import { hardhatCommand } from "./commands/hardhat.js";
import { HELP } from "./help.js";
import { Reporter } from "./output.js";
import { VERSION } from "./version.js";

type Command = (argv: string[], reporterFor: (json: boolean, debug: boolean, color?: boolean) => Reporter) => Promise<number>;

const COMMANDS: Record<string, Command> = {
  forge: forgeCommand,
  hardhat: hardhatCommand,
  deploy: deployCommand,
  connect: connectCommand,
  doctor: doctorCommand,
  chains: chainsCommand,
};

export async function main(argv: string[]): Promise<number> {
  let reporter: Reporter | undefined;
  const reporterFor = (json: boolean, debug: boolean, color?: boolean) => {
    reporter = new Reporter({ json, debug, color });
    return reporter;
  };

  const [command, ...rest] = argv;
  try {
    if (command === undefined || command === "help" || command === "--help" || command === "-h") {
      const topic = command === "help" ? rest[0] : undefined;
      const text = topic && topic in HELP ? HELP[topic as keyof typeof HELP] : HELP.main;
      reporterFor(false, false).line(text);
      return command === undefined ? ExitCode.Usage : ExitCode.Success;
    }
    if (command === "--version" || command === "-v" || command === "version") {
      process.stdout.write(`${VERSION}\n`);
      return ExitCode.Success;
    }
    const handler = COMMANDS[command];
    if (!handler) {
      throw new HatchwayError("USAGE", `Unknown command "${command}".`, { hint: "Run `hatchway help` to see the commands." });
    }
    return await handler(rest, reporterFor);
  } catch (error) {
    const hatchway = toHatchwayError(error);
    const out = reporter ?? reporterFor(argv.includes("--json"), argv.includes("--debug"));
    out.error(hatchway);
    out.line();
    out.event({ event: "result", ok: false, exitCode: hatchway.exitCode, error: { code: hatchway.code, message: hatchway.message } });
    return hatchway.exitCode;
  }
}
