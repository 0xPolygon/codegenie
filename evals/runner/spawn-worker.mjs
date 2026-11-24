import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { outsideCheckout, workerBounds } from './case.mjs';

// The schedule-bound worker config is checked before spawning. The worker
// independently verifies the same bytes and the referenced case config.
export async function spawnAttempt({ supervisor, slotId, attemptNo, configFile, configSHA256, spawnImpl = spawn }) {
  const file = outsideCheckout(configFile), bytes = readFileSync(file);
  if (!/^[a-f0-9]{64}$/u.test(configSHA256 ?? '') || createHash('sha256').update(bytes).digest('hex') !== configSHA256) throw new Error('worker config digest mismatch');
  supervisor.verifyWorkerBinding(slotId, attemptNo, bytes, configSHA256);
  const config = JSON.parse(bytes.toString('utf8'));
  const caseBytes = readFileSync(outsideCheckout(config.caseConfig));
  if (!/^[a-f0-9]{64}$/u.test(config.caseConfigSHA256 ?? '') || createHash('sha256').update(caseBytes).digest('hex') !== config.caseConfigSHA256) throw new Error('case config binding mismatch');
  const bounds = await workerBounds(config.caseConfig, caseBytes, config.attemptPrefix);
  const token = supervisor.claimWorker(slotId, attemptNo, bytes, configSHA256);
  const executable = fileURLToPath(new URL('./worker.mjs', import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawnImpl(process.execPath, [executable, file, configSHA256], { stdio: ['pipe', 'pipe', 'ignore'] });
    child.stdin.on('error', () => {});
    child.stdin.end(`${token}\n`);
    let text = '', excessive = false;
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('worker timeout requires reconciliation')); }, bounds.timeoutMs + 300_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (text.length + chunk.length > 65_536) { excessive = true; child.kill(); return; }
      text += chunk;
    });
    child.once('error', () => { clearTimeout(timer); reject(new Error('worker start failed')); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (excessive) { reject(new Error('worker output exceeded limit')); return; }
      if (code !== 0) {
        try {
          const parsed = JSON.parse(text);
          const allowed = ['campaign_budget', 'binding_mismatch', 'provider_denied', 'accounting_failed', 'campaign_stopped', 'boundary_not_admitted', 'harness_exception'];
          if (allowed.includes(parsed.error)) { resolve({ status: 'worker_failed', error: parsed.error }); return; }
        } catch { /* malformed output is a harness failure */ }
        reject(new Error('worker did not complete')); return;
      }
      try {
        const result = JSON.parse(text);
        if (result.caseName !== bounds.caseName || !['pass', 'fail', 'error'].includes(result.status) || typeof result.runDir !== 'string') throw new Error('invalid');
        const runDir = outsideCheckout(result.runDir);
        if (!runDir.startsWith(bounds.outputDir + path.sep)) throw new Error('wrong attempt output');
        const allowed = ['campaign_budget', 'binding_mismatch', 'provider_denied', 'provider_failure', 'accounting_failed', 'campaign_stopped', 'boundary_not_admitted', 'unclassified'];
        if (result.status === 'error' && !allowed.includes(result.error)) throw new Error('missing operational error');
        resolve({ caseName: result.caseName, status: result.status, runDir, ...(result.status === 'error' ? { error: result.error } : {}) });
      } catch { reject(new Error('invalid worker result')); }
    });
  });
}
