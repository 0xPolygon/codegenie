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
    let child;
    try { child = spawnImpl(process.execPath, [executable, file, configSHA256], { stdio: ['pipe', 'pipe', 'ignore'] }); }
    catch { supervisor.recordWorkerExit(slotId, attemptNo, true); reject(new Error('worker start failed')); return; }
    let registered = false;
    child.stdin.on('error', () => {});
    let text = '', excessive = false;
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('worker timeout requires reconciliation')); }, bounds.timeoutMs + 300_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (text.length + chunk.length > 65_536) { excessive = true; child.kill(); return; }
      text += chunk;
    });
    child.once('error', () => {
      clearTimeout(timer);
      if (!registered) { try { supervisor.recordWorkerExit(slotId, attemptNo, true); } catch {} }
      reject(new Error('worker start failed'));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (!registered) { reject(new Error('worker start requires reconciliation')); return; }
      try { supervisor.recordWorkerExit(slotId, attemptNo); }
      catch { reject(new Error('worker exit requires reconciliation')); return; }
      if (excessive) { reject(new Error('worker output exceeded limit')); return; }
      if (code !== 0) {
        try {
          const parsed = JSON.parse(text);
          const allowed = ['campaign_budget', 'binding_mismatch', 'provider_denied', 'accounting_failed', 'campaign_stopped', 'boundary_not_admitted', 'unsupported_case_config', 'harness_exception'];
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
        if (result.failureCallId !== undefined && (result.status !== 'error' || result.error !== 'provider_failure' || typeof result.failureCallId !== 'string' || !/^[A-Za-z0-9._-]+$/u.test(result.failureCallId))) throw new Error('invalid failure identity');
        resolve({ caseName: result.caseName, status: result.status, runDir, ...(result.status === 'error' ? { error: result.error, ...(result.failureCallId !== undefined ? { failureCallId: result.failureCallId } : {}) } : {}) });
      } catch { reject(new Error('invalid worker result')); }
    });
    if (Number.isSafeInteger(child.pid) && child.pid > 0) {
      try { supervisor.recordWorkerStart(slotId, attemptNo, child.pid); registered = true; child.stdin.end(`${token}\n`); }
      catch { child.kill('SIGKILL'); clearTimeout(timer); reject(new Error('worker start requires reconciliation')); }
    }
  });
}
