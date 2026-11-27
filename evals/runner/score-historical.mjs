import { createHash } from 'node:crypto';
import { scoreCampaign } from './score.mjs';
import { ROLES } from './blind-inputs.mjs';

// All inputs must already have been authenticated by the historical custodian.
// No old supervisor or worker is reopened, and no legacy bytes are rewritten.
export function scoreHistorical({ schedule, inventory, dispositions, bundles, componentHashes }) {
  if (!Array.isArray(componentHashes) || !componentHashes.length || componentHashes.some((value) => !/^[a-f0-9]{64}$/u.test(value))) throw new Error('historical component hashes missing');
  if (!Array.isArray(bundles) || !bundles.length || bundles.some((bundle) => {
    const locks = bundle?.reconciliation?.lockSHA256;
    return !Array.isArray(bundle?.reconciliation?.grades) || !Array.isArray(locks) || locks.length !== 2 || locks[0] === locks[1] || locks.some((hash) => !/^[a-f0-9]{64}$/u.test(hash));
  })) throw new Error('historical grade locks unavailable');
  let roleAmbiguous = false;
  const normalized = inventory.map((item) => {
    const role = item.role ?? item.registeredRole;
    if (role !== undefined && !ROLES.includes(role)) throw new Error('invalid historical role');
    if (role === undefined) roleAmbiguous = true;
    return { ...item, role: role ?? (item.causes.length ? 'positive' : 'negative-control'), rejects: item.rejects ?? [] };
  });
  const unmeasured = bundles.some((bundle) => bundle.reconciliation.grades.some((grade) => !Object.hasOwn(grade, 'assertions')));
  const result = scoreCampaign({ schedule, inventory: normalized, dispositions, bundles });
  return { ...result, source: 'historical-adapter', componentSHA256: createHash('sha256').update(JSON.stringify(componentHashes)).digest('hex'), roleAmbiguous, mixedAssertions: unmeasured ? 'unmeasured-class-only' : 'measured' };
}

// A missing or incompatible study must remain visible and cannot be scored as
// a completed zero. The inputs of scored studies are still preverified by the
// historical custodian; this wrapper does not authenticate old artifacts.
export function scoreHistoricalStudies(studies) {
  if (!Array.isArray(studies) || new Set(studies.map((study) => study?.studyId)).size !== studies.length || studies.some((study) => typeof study?.studyId !== 'string' || !study.studyId.trim())) throw new Error('invalid historical study list');
  return { studies: studies.map(({ studyId, unavailable, ...inputs }) => {
    if (unavailable !== undefined) {
      if (Object.keys(inputs).length || typeof unavailable?.reason !== 'string' || !unavailable.reason.trim()) throw new Error('invalid historical unavailability');
      return { studyId, status: 'unavailable', reason: unavailable.reason };
    }
    try { return { studyId, status: 'scored', result: scoreHistorical(inputs) }; }
    catch { return { studyId, status: 'unavailable', reason: 'historical evidence missing or incompatible' }; }
  }) };
}
