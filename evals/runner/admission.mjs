import { createHash } from 'node:crypto';
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { outsideCheckout } from './case.mjs';
import { boundaryDecision } from './boundary.mjs';
import { applyKeyObservation, readConfiguredKeyUsage } from './key-meter.mjs';
import { runHealthProbe } from './health.mjs';

function receiptStore(directory) {
  const root = outsideCheckout(directory);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const files = () => Object.fromEntries(readdirSync(root).filter((name) => /^[a-f0-9]{64}$/u.test(name)).map((name) => [name, path.join(root, name)]));
  const seal = (bytes, hash) => {
    if (!Buffer.isBuffer(bytes) || !/^[a-f0-9]{64}$/u.test(hash) || createHash('sha256').update(bytes).digest('hex') !== hash) return false;
    const file = path.join(root, hash);
    try {
      const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
      return true;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const stat = lstatSync(file);
      return stat.isFile() && !stat.isSymbolicLink() && readFileSync(file).equals(bytes);
    }
  };
  return { files, seal };
}

// One invocation performs at most one key GET and one native health probe.
// The caller decides when an authorized boundary may invoke it.
export async function prepareAdmission({ ledger, boundaryId, receiptDirectory, attemptPrefix, purpose = 'admission', llmConfig, expected, fetchImpl = globalThis.fetch, models }) {
  if (typeof boundaryId !== 'string' || !boundaryId || !['admission', 'retry'].includes(purpose) || expected?.provider !== 'openrouter') throw new Error('invalid admission binding');
  ledger.assertRestartSafe();
  const store = receiptStore(receiptDirectory);
  const decision = () => boundaryDecision({ ledger, boundaryId, provider: 'openrouter', evidenceFiles: store.files() });
  let current;
  if (!ledger.db.prepare('SELECT 1 FROM key_baseline').get()) current = { source: 'key', action: 'snapshot' };
  else current = decision();
  if (current.source === 'key' && ['snapshot', 'wait'].includes(current.action)) {
    const reading = await readConfiguredKeyUsage({ ledger, fetchImpl, models });
    if (!ledger.db.prepare('SELECT 1 FROM key_baseline').get()) {
      const baseline = applyKeyObservation({ ledger, kind: 'baseline', reading, sealReceipt: store.seal });
      if (baseline.action !== 'recorded') return baseline;
    }
    const snapshot = applyKeyObservation({ ledger, kind: 'snapshot', reading, sealReceipt: store.seal, boundaryId });
    if (snapshot.action !== 'recorded') return snapshot;
    current = decision();
  }
  if (current.action === 'stop' || current.action === 'wait' || current.action === 'reconcile' || current.action === 'snapshot') return current;
  if (current.action === 'probe' || (purpose === 'retry' && current.action === 'admit')) {
    return runHealthProbe({ ledger, boundaryId, purpose, attemptPrefix, llmConfig, expected, fetchImpl, sealReceipt: store.seal });
  }
  return current;
}
