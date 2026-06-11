#!/usr/bin/env node
import { executeReviewCommand, parseReviewCommand } from "./review-command.js";
import { errorExitCode, isCodeninjaError } from "../util/errors.js";

async function main(): Promise<void> {
  try {
    const parsed = parseReviewCommand(process.argv.slice(2));
    const result = await executeReviewCommand(parsed);
    process.stdout.write(
      `codeninja review foundation initialized. Review pipeline stages are not implemented yet. Run artifacts: ${result.runDir || "disabled"}\n`
    );
  } catch (error) {
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
