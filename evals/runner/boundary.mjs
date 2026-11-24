import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { outsideCheckout } from './case.mjs';

export class BoundaryBindingError extends Error {}

export function boundaryRefusalReason(reason) {
  if (reason === 'binding_mismatch') return 'binding_mismatch';
  if (['budget_limit', 'campaign_budget'].includes(reason)) return 'campaign_budget';
  if (reason.startsWith('provider_')) return 'provider_denied';
  if (['accounting_failed', 'unpriced_lower_bound', 'charge_above_reservation'].includes(reason)) return 'accounting_failed';
  if (reason.startsWith('key_') || reason.startsWith('health_')) return 'boundary_not_admitted';
  return 'campaign_stopped';
}

function evidenceVerifier(evidenceFiles, boundaryId, provider) {
  return (identity, hash, values) => {
    const file = evidenceFiles?.[hash];
    if (typeof file !== 'string') throw new BoundaryBindingError('evidence path missing');
    let safePath;
    try { safePath = outsideCheckout(file); }
    catch { throw new BoundaryBindingError('evidence path outside permitted root'); }
    const bytes = readFileSync(safePath);
    if (createHash('sha256').update(bytes).digest('hex') !== hash) throw new BoundaryBindingError('evidence digest mismatch');
    let receipt;
    try { receipt = JSON.parse(bytes.toString('utf8')); }
    catch { throw new BoundaryBindingError('invalid evidence receipt'); }
    const valid = values.kind !== 'health' || (receipt?.physicalId === identity && receipt.boundaryId === boundaryId && receipt.provider === provider);
    if (!valid || Object.entries(values).some(([key, value]) => receipt[key] !== value)) throw new BoundaryBindingError('evidence identity mismatch');
    return true;
  };
}

// Verify all previously used evidence before another admission or release.
export function verifyAllEvidence(ledger, evidenceFiles) {
  const baseline = ledger.db.prepare('SELECT * FROM key_baseline').get();
  if (!baseline) {
    if (ledger.db.prepare('SELECT 1 FROM key_snapshot UNION ALL SELECT 1 FROM physical LIMIT 1').get()) throw new BoundaryBindingError('baseline missing');
    return true;
  }
  evidenceVerifier(evidenceFiles)('baseline', baseline.evidence_sha256, { kind: 'key_baseline', usageNanos: baseline.usage_nanos, fingerprint: baseline.key_fingerprint });
  for (const row of ledger.db.prepare('SELECT * FROM key_snapshot').all()) {
    evidenceVerifier(evidenceFiles)('snapshot', row.evidence_sha256, { kind: 'key_snapshot', usageNanos: row.usage_nanos, fingerprint: baseline.key_fingerprint,
      observedMs: row.observed_ms, boundaryId: row.boundary_id, physicalStarts: row.physical_starts });
  }
  const rows = ledger.db.prepare("SELECT p.id,p.provider,p.health_boundary,p.health_purpose,p.retry_for,p.retry_failure_sha256,p.state,h.outcome,h.observed_ms,h.evidence_sha256 FROM physical p LEFT JOIN health_receipt h ON h.physical_id=p.id WHERE p.kind='health'").all();
  for (const row of rows) {
    if (!row.evidence_sha256 || !row.outcome || row.state === 'open') throw new BoundaryBindingError('health evidence incomplete');
    evidenceVerifier(evidenceFiles, row.health_boundary, row.provider)(row.id, row.evidence_sha256, { kind: 'health', physicalId: row.id,
      boundaryId: row.health_boundary, provider: row.provider, purpose: row.health_purpose, outcome: row.outcome, observedMs: row.observed_ms,
      ...(row.health_purpose === 'retry' ? { retryFor: row.retry_for, failureReceiptSHA256: row.retry_failure_sha256 } : {}) });
  }
  return true;
}

// Both the supervisor and the attempt worker must verify the same evidence.
// Receipt contents stay outside the repository; SQLite holds only their hashes.
export function boundaryDecision({ ledger, boundaryId, provider, evidenceFiles, nowMs = Date.now() }) {
  if (typeof boundaryId !== 'string' || !boundaryId || typeof provider !== 'string' || !provider) throw new BoundaryBindingError('invalid admission boundary');
  const verifyEvidence = evidenceVerifier(evidenceFiles, boundaryId, provider);
  const key = ledger.keyDecision({ verifyEvidence, boundaryId });
  if (key.action !== 'admit') return { source: 'key', ...key };
  const health = ledger.healthDecision({ boundaryId, provider, nowMs, verifyEvidence });
  return { source: 'health', ...health };
}
