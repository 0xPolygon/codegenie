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
    const result = await executeReviewCommand(parsed);
    process.stdout.write(
      `codeninja review inventory completed (${result.filesChanged} files, ${result.hunks} hunks; ${result.keptFiles} kept). Later review stages are not implemented yet. Run artifacts: ${result.runDir || "disabled"}\n`
    );
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
