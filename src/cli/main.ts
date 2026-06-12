#!/usr/bin/env node
import { executeReviewCommand, isCliDisplayExit, parseReviewCommand } from "./review-command.js";
import { executeProviderCommand } from "./provider-command.js";
import { errorExitCode, isCodeninjaError } from "../util/errors.js";

async function main(): Promise<void> {
  try {
    const argv = process.argv.slice(2);
    if (argv[0] === "provider" || (argv[0] === "help" && argv[1] === "provider")) {
      await executeProviderCommand(argv, { allowOutput: true });
      return;
    }
    const parsed = parseReviewCommand(argv, { allowOutput: true });
    await executeReviewCommand(parsed, { writeOutput: (text) => process.stdout.write(text) });
  } catch (error) {
    if (isCliDisplayExit(error)) {
      process.exitCode = error.exitCode;
      return;
    }
    if (isCodeninjaError(error)) {
      process.stderr.write(`${error.code}: ${error.message}\n`);
    } else if (error instanceof Error) {
      process.stderr.write(`${error.name}: ${error.message}\n`);
    } else {
      process.stderr.write("unknown error\n");
    }
    process.exitCode = errorExitCode(error);
  }
}

await main();
