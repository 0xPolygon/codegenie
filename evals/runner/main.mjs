#!/usr/bin/env node
import { runCase } from './case.mjs';

const args = process.argv.slice(2);
if (args.length !== 3 || args[0] !== 'run' || args[1] !== '--campaign') {
  console.error('Usage: node evals/runner/main.mjs run --campaign <file>');
  process.exitCode = 2;
} else {
  try {
    const result = await runCase(args[2]);
    console.log(JSON.stringify({ caseName: result.caseName, status: result.status, runDir: result.runDir }));
    if (result.status !== 'pass') process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
