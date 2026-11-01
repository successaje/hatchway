#!/usr/bin/env node
import { main } from "./cli/main.js";

const code = await main(process.argv.slice(2));
// Let stdout drain before exiting; never leave background timers keeping us alive.
process.stdout.write("", () => process.exit(code));
