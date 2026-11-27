import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { outsideCheckout } from './case.mjs';
import { readCheckedFile } from './safe-read.mjs';
import { verifyPrimaryBundle } from './blind-export.mjs';
import { verifyPrimaryLocks } from './blind-locks.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const read = (file, expected) => {
  if (typeof file !== 'string' || outsideCheckout(file) !== file || !/^[a-f0-9]{64}$/u.test(expected ?? '')) throw new Error('invalid score evidence');
  const bytes = readCheckedFile(file); if (digest(bytes) !== expected) throw new Error('score evidence changed');
  return JSON.parse(bytes.toString('utf8'));
};
export function loadScoringBundle(request) {
  const manifest = read(request.manifestFile, request.manifestSHA256);
  if ((lstatSync(request.mappingFile).mode & 0o077) !== 0) throw new Error('mapping permissions too broad');
  const mapping = read(request.mappingFile, manifest.mappingSHA256);
  const sheets = verifyPrimaryBundle(request.manifestFile, manifest, mapping);
  const reconciliation = read(request.reconciliation?.path, request.reconciliation?.sha256);
  verifyPrimaryLocks({ manifestSHA256: request.manifestSHA256, locks: request.locks, reconciliation: request.reconciliation, manifest, sheets });
  const reveal = read(request.revealFile, request.revealSHA256);
  if (reveal.manifestSHA256 !== request.manifestSHA256 || reveal.reconciliationSHA256 !== request.reconciliation.sha256 || !Array.isArray(reveal.reviews) || reveal.reviews.length !== mapping.selections.length || mapping.selections.some((item) => {
    const matches = reveal.reviews.filter((row) => row.id === item.id);
    return matches.length !== 1 || matches[0].case !== item.caseId || matches[0].arm !== item.arm || matches[0].draw !== item.draw;
  })) throw new Error('score reveal binding mismatch');
  return { manifest, mapping, reconciliation, reveal, sheets };
}
