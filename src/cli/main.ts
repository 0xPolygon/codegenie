#!/usr/bin/env node
import { executeReviewCommand, isCliDisplayExit, parseReviewCommand } from "./review-command.js";
import { createReviewProgress, type ReviewProgress } from "./review-progress.js";
import { executeProviderCommand } from "./provider-command.js";
import { executeEvalCommand } from "../evals/eval-command.js";
import { stripCredentials } from "../telemetry/redaction.js";
import { errorExitCode, isCodegenieError } from "../util/errors.js";
import { renderVersion } from "./version.js";

async function main(): Promise<void> {
  let progress: ReviewProgress | undefined;
  try {
    const argv = process.argv.slice(2);
    if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-V" || argv[0] === "version")) {
      process.stdout.write(renderVersion());
      return;
    }
    if (argv[0] === "provider" || (argv[0] === "help" && argv[1] === "provider")) {
      await executeProviderCommand(argv, { allowOutput: true });
      return;
    }
    if (argv[0] === "eval" || (argv[0] === "help" && argv[1] === "eval")) {
      process.exitCode = await executeEvalCommand(argv, {
        allowOutput: true,
        writeOutput: (text) => process.stdout.write(text)
      });
      return;
    }
    const parsed = parseReviewCommand(argv, { allowOutput: true });
    progress = createReviewProgress({
      enabled: parsed.options.progress,
      env: process.env,
      stream: process.stderr
    });
    await executeReviewCommand(parsed, {
      ...(progress !== undefined ? { onTelemetryEvent: progress.onTelemetryEvent } : {}),
      writeOutput: (text) => {
        progress?.stop();
        progress = undefined;
        process.stdout.write(text);
      }
    });
    progress?.stop();
  } catch (error) {
    progress?.stop();
    if (isCliDisplayExit(error)) {
      process.exitCode = error.exitCode;
      return;
    }
    if (isCodegenieError(error)) {
      process.stderr.write(stripCredentials(renderCodegenieError(error)));
    } else if (error instanceof Error) {
      process.stderr.write(stripCredentials(`${error.name}: ${error.message}\n`));
    } else {
      process.stderr.write("unknown error\n");
    }
    process.exitCode = errorExitCode(error);
  }
}

function renderCodegenieError(error: { code: string; message: string; context?: Record<string, unknown> }): string {
  const helpText = typeof error.context?.helpText === "string" ? error.context.helpText.trimEnd() : undefined;
  const hint = typeof error.context?.hint === "string" ? error.context.hint : undefined;
  if (helpText !== undefined) {
    return `${error.message}\n\n${helpText}${hint !== undefined ? `\n\n${hint}` : ""}\n`;
  }
  return `${error.code}: ${error.message}\n`;
}

await main();
