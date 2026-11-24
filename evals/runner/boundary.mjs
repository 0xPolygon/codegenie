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

// Both the supervisor and the attempt worker must verify the same evidence.
// Receipt contents stay outside the repository; SQLite holds only their hashes.
export function boundaryDecision({ ledger, boundaryId, provider, evidenceFiles, nowMs = Date.now() }) {
  if (typeof boundaryId !== 'string' || !boundaryId || typeof provider !== 'string' || !provider) throw new BoundaryBindingError('invalid admission boundary');
  const verifyEvidence = (_identity, hash) => {
    const file = evidenceFiles?.[hash];
    if (typeof file !== 'string') throw new BoundaryBindingError('evidence path missing');
    let safePath;
    try { safePath = outsideCheckout(file); }
    catch { throw new BoundaryBindingError('evidence path outside permitted root'); }
    if (createHash('sha256').update(readFileSync(safePath)).digest('hex') !== hash) throw new BoundaryBindingError('evidence digest mismatch');
    return true;
  };
  const key = ledger.keyDecision({ verifyEvidence });
  if (key.action !== 'admit') return { source: 'key', ...key };
  const health = ledger.healthDecision({ boundaryId, provider, nowMs, verifyEvidence });
  return { source: 'health', ...health };
}
