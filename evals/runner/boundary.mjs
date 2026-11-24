import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// Both the supervisor and the attempt worker must verify the same evidence.
// Receipt contents stay outside the repository; SQLite holds only their hashes.
export function boundaryDecision({ ledger, boundaryId, provider, evidenceFiles, nowMs = Date.now() }) {
  if (typeof boundaryId !== 'string' || !boundaryId || typeof provider !== 'string' || !provider) throw new TypeError('invalid admission boundary');
  const verifyEvidence = (_identity, hash) => {
    const file = evidenceFiles?.[hash];
    if (typeof file !== 'string') return false;
    try { return createHash('sha256').update(readFileSync(file)).digest('hex') === hash; }
    catch { return false; }
  };
  const key = ledger.keyDecision({ verifyEvidence });
  if (key.action !== 'admit') return { source: 'key', ...key };
  const health = ledger.healthDecision({ boundaryId, provider, nowMs, verifyEvidence });
  return { source: 'health', ...health };
}
