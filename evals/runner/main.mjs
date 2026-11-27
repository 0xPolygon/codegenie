#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CampaignConfigurationError, outsideCheckout, runCase } from './case.mjs';
import { readCheckedFile } from './safe-read.mjs';
import { TreatmentLeakError } from './blind-sheet.mjs';
import { openCampaign } from './campaign.mjs';

const args = process.argv.slice(2);
if (args.length === 3 && ['run', 'run-case'].includes(args[0]) && args[1] === '--campaign') {
  try {
    const result = await runCase(args[2]);
    console.log(JSON.stringify({ caseName: result.caseName, status: result.status, runDir: result.runDir }));
    if (result.status !== 'pass') process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
} else if (args.length === 9 && args[0] === 'score' && args[1] === '--campaign' && args[3] === '--sha256' && args[5] === '--request' && args[7] === '--request-sha256') {
  let campaign;
  try {
    const bytes = readCheckedFile(outsideCheckout(args[6]));
    if (!/^[a-f0-9]{64}$/u.test(args[8]) || createHash('sha256').update(bytes).digest('hex') !== args[8]) throw new Error('request mismatch');
    const request = JSON.parse(bytes.toString('utf8')), output = outsideCheckout(request.outputFile);
    if (request.bundles.some((bundle) => output === bundle.mappingFile || output.startsWith(`${path.dirname(bundle.manifestFile)}${path.sep}`))) throw new Error('score overlaps protected evidence');
    campaign = await openCampaign(args[2], args[4], { resumeOnly: true });
    const result = Buffer.from(`${JSON.stringify(await campaign.score(request))}\n`), sha256 = createHash('sha256').update(result).digest('hex');
    mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
    try {
      const fd = openSync(output, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, result); fsyncSync(fd); } finally { closeSync(fd); }
    } catch (error) { if (error?.code !== 'EEXIST' || (lstatSync(output).mode & 0o077) !== 0 || !readCheckedFile(output).equals(result)) throw error; }
    const directory = openSync(path.dirname(output), constants.O_RDONLY | constants.O_DIRECTORY);
    try { fsyncSync(directory); } finally { closeSync(directory); }
    console.log(JSON.stringify({ outputFile: output, sha256 }));
  } catch {
    console.error('Score requires verified campaign, lock and reconciliation evidence.'); process.exitCode = 1;
  } finally {
    if (campaign) { try { campaign.close(); } catch { console.error('Campaign driver claim requires reconciliation.'); process.exitCode = 1; } }
  }
} else if (args.length === 9 && args[0] === 'reveal' && args[1] === '--campaign' && args[3] === '--sha256' && args[5] === '--request' && args[7] === '--request-sha256') {
  let campaign;
  try {
    const bytes = readCheckedFile(outsideCheckout(args[6]));
    if (!/^[a-f0-9]{64}$/u.test(args[8]) || createHash('sha256').update(bytes).digest('hex') !== args[8]) throw new Error('request mismatch');
    const request = JSON.parse(bytes.toString('utf8'));
    campaign = await openCampaign(args[2], args[4], { resumeOnly: true });
    console.log(JSON.stringify(await campaign.reveal(request)));
  } catch {
    console.error('Export requires verified campaign, lock and reconciliation evidence.');
    process.exitCode = 1;
  } finally {
    if (campaign) { try { campaign.close(); } catch { console.error('Campaign driver claim requires reconciliation.'); process.exitCode = 1; } }
  }
} else if (args.length === 9 && args[0] === 'export-blind' && args[1] === '--campaign' && args[3] === '--sha256' && args[5] === '--output' && args[7] === '--mapping') {
  let campaign;
  try {
    campaign = await openCampaign(args[2], args[4], { resumeOnly: true });
    console.log(JSON.stringify(campaign.exportBlind({ outputDirectory: args[6], mappingFile: args[8] })));
  } catch (error) {
    console.error(error instanceof TreatmentLeakError ? JSON.stringify({ error: 'treatment_marker', affectedSheets: error.affectedSheets, hits: error.hits }) : error instanceof CampaignConfigurationError ? `Campaign configuration error: ${error.message}` : 'Blind export requires verified terminal campaign evidence.');
    process.exitCode = 1;
  } finally {
    if (campaign) { try { campaign.close(); } catch { console.error('Campaign driver claim requires reconciliation.'); process.exitCode = 1; } }
  }
} else if (args.length === 5 && ['run', 'release'].includes(args[0]) && args[1] === '--campaign' && args[3] === '--sha256') {
  let campaign;
  try {
    campaign = await openCampaign(args[2], args[4], { resumeOnly: args[0] === 'release' });
    if (args[0] === 'release') console.log(JSON.stringify({ action: 'released', prefixSHA256: campaign.releaseCheckpoint() }));
    else {
      let previous, repeats = 0;
      while (true) {
        const result = await campaign.step();
        console.log(JSON.stringify(result));
        if (['completed', 'paused'].includes(result.action)) break;
        if (['stop', 'reconcile'].includes(result.action)) { process.exitCode = 1; break; }
        if (result.action !== 'wait') {
          const current = `${result.action}:${campaign.progressFingerprint()}`;
          repeats = current === previous ? repeats + 1 : 0; previous = current;
          if (repeats >= 3) { campaign.stopNoProgress(); console.log(JSON.stringify({ action: 'stop', reason: 'no_progress' })); process.exitCode = 1; break; }
        } else { previous = undefined; repeats = 0; }
        if (result.action === 'wait') {
          const delay = Number.isSafeInteger(result.untilMs) ? Math.max(1, Math.min(15_000, result.untilMs - Date.now())) : 15_000;
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
  } catch (error) {
    console.error(error instanceof CampaignConfigurationError ? `Campaign configuration error: ${error.message}` : 'Campaign could not start or requires custody reconciliation.');
    process.exitCode = 1;
  } finally {
    if (campaign) {
      try { campaign.close(); } catch { console.error('Campaign driver claim requires reconciliation.'); process.exitCode = 1; }
    }
  }
} else {
  console.error('Usage: node evals/runner/main.mjs run-case --campaign <file> | run|release --campaign <file> --sha256 <hash> | export-blind --campaign <file> --sha256 <hash> --output <dir> --mapping <file> | reveal|score --campaign <file> --sha256 <hash> --request <file> --request-sha256 <hash>');
  process.exitCode = 2;
}
