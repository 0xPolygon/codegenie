import { createHash } from 'node:crypto';
import { scoreCampaign } from './score.mjs';
import { ROLES } from './blind-inputs.mjs';

// All inputs must already have been authenticated by the historical custodian.
// No old supervisor or worker is reopened, and no legacy bytes are rewritten.
export function scoreHistorical({ schedule, inventory, dispositions, bundles, componentHashes }) {
  if (!Array.isArray(componentHashes) || !componentHashes.length || componentHashes.some((value) => !/^[a-f0-9]{64}$/u.test(value))) throw new Error('historical component hashes missing');
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
