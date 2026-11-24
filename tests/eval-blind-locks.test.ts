import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error Development-only ESM has no emitted types.
import { verifyPrimaryLocks } from '../evals/runner/blind-locks.mjs';
const sha = (x: string) => createHash('sha256').update(x).digest('hex');
describe('blind export lock gate', () => {
  it('requires complete grades, two distinct locks, and reconciliation', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'eval-blind-locks-'));
    try {
      const file = (name: string, value: unknown) => { const bytes = JSON.stringify(value), dest = path.join(dir, name); writeFileSync(dest, bytes); return { path: dest, sha256: sha(bytes) }; };
      const manifestSHA256 = 'a'.repeat(64), id = 'c'.repeat(24);
      const manifest = { sheets: [{ id, causes: [] }] }, sheets = [{ id, discovery: { findings: [] }, verification: [], published: { findings: [], summaryOnly: [], attentionQuestions: [] } }];
      const grades = [{ id, noApplicableCauses: true, causes: [], otherClaims: { survivingMediumPlus: [], published: [] } }];
      const a = file('a', { analyst: 'one', manifestSHA256, grades }), b = file('b', { analyst: 'two', manifestSHA256, grades });
      const reconciliation = file('reconciliation', { manifestSHA256, lockSHA256: [b.sha256, a.sha256], grades });
      const args = { manifestSHA256, manifest, sheets, locks: [a, b], reconciliation };
      expect(verifyPrimaryLocks(args)).toMatchObject({ reconciliationSHA256: reconciliation.sha256 });
      expect(() => verifyPrimaryLocks({ ...args, reconciliation: undefined })).toThrow();
      expect(() => verifyPrimaryLocks({ ...args, locks: [a, a] })).toThrow();
      const same = file('same', { analyst: ' ONE ', manifestSHA256, grades });
      expect(() => verifyPrimaryLocks({ ...args, locks: [a, same] })).toThrow();
      const wrong = file('wrong', { analyst: 'two', manifestSHA256: 'c'.repeat(64), grades });
      expect(() => verifyPrimaryLocks({ ...args, locks: [a, wrong] })).toThrow();
      const header = file('header', { analyst: 'two', manifestSHA256 });
      expect(() => verifyPrimaryLocks({ ...args, locks: [a, header] })).toThrow('coverage');
      const controlWithFinding = [{ ...sheets[0], published: { findings: [{ id: 'f-1', severity: 'medium' }], summaryOnly: [], attentionQuestions: [] } }];
      expect(() => verifyPrimaryLocks({ ...args, sheets: controlWithFinding })).toThrow('other-claim');
      for (const severity of ['toString', 'constructor']) {
        const surviving = [{ ...sheets[0], verification: [{ candidateId: 'f-candidate', verdict: 'keep', finalSeverity: severity }] }];
        expect(() => verifyPrimaryLocks({ ...args, sheets: surviving })).toThrow('invalid graded item evidence');
        const published = [{ ...sheets[0], published: { findings: [{ id: 'f-1', severity }], summaryOnly: [], attentionQuestions: [] } }];
        expect(() => verifyPrimaryLocks({ ...args, sheets: published })).toThrow('invalid graded item evidence');
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

it('requires every published control claim and every required or optional cause to be graded', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'eval-grade-coverage-'));
  try {
    const file = (name: string, value: unknown) => { const bytes = JSON.stringify(value), dest = path.join(dir, name); writeFileSync(dest, bytes); return { path: dest, sha256: sha(bytes) }; };
    const manifestSHA256 = 'a'.repeat(64), id = 'b'.repeat(24), control = 'c'.repeat(24);
    const manifest = { sheets: [{ id, causes: [{ id: 'required', optional: false }, { id: 'optional', optional: true }] }, { id: control, causes: [] }] };
    const sheets = [{ id, discovery: { findings: [{ id: 'f-candidate' }] }, verification: [], published: { findings: [{ id: 'f-final', severity: 'medium' }], summaryOnly: [], attentionQuestions: [] } },
      { id: control, discovery: { findings: [] }, verification: [], published: { findings: [{ id: 'f-false', severity: 'medium' }], summaryOnly: [], attentionQuestions: [] } }];
    const cause = (causeId: string, published: boolean) => ({ causeId, raised: published ? 'finding' : 'none', items: [], candidateIds: published ? ['f-candidate'] : [], promotion: 'n/a', verification: 'n/a', publication: published ? 'finding' : 'none', publishedId: published ? 'f-final' : null, evidence: published ? 'source evidence' : '', earliestLoss: published ? 'none' : 'discovery', externalQuestion: false, readerVisible: false, needsConfirmation: false });
    const grades = [{ id, causes: [cause('required', true), cause('optional', false)], otherClaims: { survivingMediumPlus: [], published: [] } },
      { id: control, causes: [], noApplicableCauses: true, otherClaims: { survivingMediumPlus: [], published: [{ id: 'f-false', severity: 'medium', class: 'wholly_false', slug: 'false-claim', summaryOnly: false }] } }];
    const a = file('a', { analyst: 'one', manifestSHA256, grades }), b = file('b', { analyst: 'two', manifestSHA256, grades });
    const reconciliation = file('reconciliation', { manifestSHA256, lockSHA256: [a.sha256, b.sha256], grades });
    expect(verifyPrimaryLocks({ manifestSHA256, manifest, sheets, locks: [a, b], reconciliation })).toBeTruthy();
    const missing = structuredClone(grades); missing[0]!.causes.pop();
    const broken = file('broken', { analyst: 'two', manifestSHA256, grades: missing });
    expect(() => verifyPrimaryLocks({ manifestSHA256, manifest, sheets, locks: [a, broken], reconciliation })).toThrow('cause coverage');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
