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
      const dirfd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY);
      try { fsyncSync(dirfd); } finally { closeSync(dirfd); }
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
export async function prepareAdmission({ ledger, boundaryId, receiptDirectory, attemptPrefix, purpose = 'admission', retryFor, failureReceiptSHA256, llmConfig, expected, fetchImpl = globalThis.fetch, models }) {
  if (typeof boundaryId !== 'string' || !boundaryId || !['admission', 'retry'].includes(purpose) || expected?.provider !== 'openrouter') throw new Error('invalid admission binding');
  ledger.assertRestartSafe();
  const stop = ledger.totals().stopped;
  if (stop) return { action: 'stop', reason: stop };
  let failureEnd;
  if (purpose === 'retry') {
    if (typeof retryFor !== 'string' || !retryFor || !/^[a-f0-9]{64}$/u.test(failureReceiptSHA256 ?? '')) throw new Error('invalid retry binding');
    const prefix = `${retryFor}/`;
    const failed = ledger.db.prepare('SELECT COUNT(*) AS count, SUM(settled_at_ms IS NULL) AS open, MAX(settled_at_ms) AS last FROM physical WHERE substr(id,1,?)=?').get(prefix.length, prefix);
    if (!failed.count || failed.open) throw new Error('retry failure requires physical reconciliation');
    failureEnd = failed.last;
  }
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
  if (purpose === 'retry' && current.action === 'admit') {
    const prior = ledger.db.prepare(`SELECT p.id,p.started_at_ms,p.settled_at_ms,p.state,p.http_status,h.observed_ms,h.evidence_sha256 FROM physical p JOIN health_receipt h ON h.physical_id=p.id
      WHERE p.provider='openrouter' AND p.health_boundary=? AND p.health_purpose='retry' AND p.retry_for=? AND p.retry_failure_sha256=? AND h.outcome='clean'
      ORDER BY p.started_at_ms DESC`).all(boundaryId, retryFor, failureReceiptSHA256);
    if (prior.length) {
      const probe = prior[0];
      if (probe.started_at_ms <= failureEnd || probe.state === 'open' || probe.settled_at_ms === null || probe.http_status < 200 || probe.http_status >= 300 || probe.observed_ms < probe.settled_at_ms) throw new Error('retry health evidence requires reconciliation');
      return { status: 'clean', physicalId: probe.id, receiptSHA256: probe.evidence_sha256, reused: true };
    }
  }
  if (current.action === 'probe' || (purpose === 'retry' && current.action === 'admit')) {
    return runHealthProbe({ ledger, boundaryId, purpose, retryFor, failureReceiptSHA256, attemptPrefix, llmConfig, expected, fetchImpl, sealReceipt: store.seal });
  }
  return current;
}
