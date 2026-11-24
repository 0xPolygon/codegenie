import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { outsideCheckout } from './case.mjs';

// The schedule-bound worker config is checked before spawning. The worker
// independently verifies the same bytes and the referenced case config.
export async function spawnAttempt({ supervisor, slotId, attemptNo, configFile, configSHA256, spawnImpl = spawn }) {
  const file = outsideCheckout(configFile), bytes = readFileSync(file);
  if (!/^[a-f0-9]{64}$/u.test(configSHA256 ?? '') || createHash('sha256').update(bytes).digest('hex') !== configSHA256) throw new Error('worker config digest mismatch');
  supervisor.claimWorker(slotId, attemptNo, bytes, configSHA256);
  const executable = fileURLToPath(new URL('./worker.mjs', import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawnImpl(process.execPath, [executable, file, configSHA256], { stdio: ['ignore', 'pipe', 'ignore'] });
    let text = '', excessive = false;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (text.length + chunk.length > 65_536) { excessive = true; child.kill(); return; }
      text += chunk;
    });
    child.once('error', () => reject(new Error('worker start failed')));
    child.once('close', (code) => {
      if (excessive || code !== 0) { reject(new Error('worker did not complete')); return; }
      try {
        const result = JSON.parse(text);
        if (typeof result.caseName !== 'string' || !['pass', 'fail', 'error'].includes(result.status) || typeof result.runDir !== 'string') throw new Error('invalid');
        resolve({ caseName: result.caseName, status: result.status, runDir: outsideCheckout(result.runDir) });
      } catch { reject(new Error('invalid worker result')); }
    });
  });
}
