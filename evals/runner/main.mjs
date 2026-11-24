#!/usr/bin/env node
import { runCase } from './case.mjs';
import { openCampaign } from './campaign.mjs';

const args = process.argv.slice(2);
if (args.length === 3 && args[0] === 'run' && args[1] === '--campaign') {
  try {
    const result = await runCase(args[2]);
    console.log(JSON.stringify({ caseName: result.caseName, status: result.status, runDir: result.runDir }));
    if (result.status !== 'pass') process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
} else if (args.length === 5 && ['run', 'release'].includes(args[0]) && args[1] === '--campaign' && args[3] === '--sha256') {
  let campaign;
  try {
    campaign = await openCampaign(args[2], args[4]);
    if (args[0] === 'release') console.log(JSON.stringify({ action: 'released', prefixSHA256: campaign.releaseCheckpoint() }));
    else {
      while (true) {
        const result = await campaign.step();
        console.log(JSON.stringify(result));
        if (['completed', 'paused'].includes(result.action)) break;
        if (['stop', 'reconcile'].includes(result.action)) { process.exitCode = 1; break; }
        if (result.action === 'wait') {
          const delay = Number.isSafeInteger(result.untilMs) ? Math.max(1, Math.min(15_000, result.untilMs - Date.now())) : 15_000;
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
  } catch {
    console.error('Campaign could not start or requires custody reconciliation.');
    process.exitCode = 1;
  } finally {
    if (campaign) {
      try { campaign.close(); } catch { console.error('Campaign driver claim requires reconciliation.'); process.exitCode = 1; }
    }
  }
} else {
  console.error('Usage: node evals/runner/main.mjs run --campaign <file> [--sha256 <hash>] | release --campaign <file> --sha256 <hash>');
  process.exitCode = 2;
}
