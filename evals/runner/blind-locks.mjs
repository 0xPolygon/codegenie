import { createHash } from 'node:crypto';
import { readCheckedFile } from './safe-read.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const isHash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
function checkedJson(file, expected) {
  if (typeof file !== 'string' || !isHash(expected)) throw new Error('missing lock evidence');
  const bytes = readCheckedFile(file);
  if (hash(bytes) !== expected) throw new Error('lock evidence digest mismatch');
  const value = JSON.parse(bytes.toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid lock evidence');
  return value;
}

// Primary reconciliation is required even for a treatment-only mechanism
// export: presence in that export already reveals the treatment arm.
export function verifyPrimaryLocks({ manifestSHA256, locks, reconciliation }) {
  if (!isHash(manifestSHA256) || !Array.isArray(locks) || locks.length !== 2 || locks[0]?.sha256 === locks[1]?.sha256) throw new Error('two distinct locks required');
  const records = locks.map((lock) => checkedJson(lock.path, lock.sha256));
  if (records.some((record) => typeof record.analyst !== 'string' || !record.analyst.trim() || record.manifestSHA256 !== manifestSHA256) || records[0].analyst === records[1].analyst) throw new Error('analyst lock mismatch');
  const joined = checkedJson(reconciliation?.path, reconciliation?.sha256);
  if (joined.manifestSHA256 !== manifestSHA256 || !Array.isArray(joined.lockSHA256) || joined.lockSHA256.length !== 2 ||
      [...joined.lockSHA256].sort().join(',') !== locks.map((lock) => lock.sha256).sort().join(',')) throw new Error('reconciliation binding mismatch');
  return { manifestSHA256, lockSHA256: locks.map((lock) => lock.sha256).sort(), reconciliationSHA256: reconciliation.sha256 };
}

export function verifyMechanismFreeze({ mechanismManifestSHA256, coding }) {
  if (!isHash(mechanismManifestSHA256)) throw new Error('missing mechanism manifest');
  const record = checkedJson(coding?.path, coding?.sha256);
  if (record.mechanismManifestSHA256 !== mechanismManifestSHA256 || record.frozen !== true) throw new Error('mechanism coding is not frozen');
  return coding.sha256;
}
