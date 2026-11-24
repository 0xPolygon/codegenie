import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error Development-only ESM has no emitted types.
import { verifyPrimaryLocks, verifyMechanismFreeze } from '../evals/runner/blind-locks.mjs';
// @ts-expect-error Development-only ESM has no emitted types.
import { projectMechanism } from '../evals/runner/blind-mechanism.mjs';
const sha = (x: string) => createHash('sha256').update(x).digest('hex');
describe('blind export lock gate', () => {
  it('requires complete grades, two distinct locks, reconciliation and coding', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'eval-blind-locks-'));
    try {
      const file = (name: string, value: unknown) => { const bytes = JSON.stringify(value), dest = path.join(dir, name); writeFileSync(dest, bytes); return { path: dest, sha256: sha(bytes) }; };
      const manifestSHA256 = 'a'.repeat(64), mechanismManifestSHA256 = 'b'.repeat(64), id = 'c'.repeat(24);
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
      const coding = file('coding', { frozen: true, mechanismManifestSHA256, reviews: [{ id, noApplicableCauses: true, causes: [] }] });
      const binding = { mechanismManifestSHA256, manifest, mapping: { selections: [{ id, arm: 'treatment' }] }, mechanismReviews: [{ id, passes: [], diagnostics: [] }] };
      expect(() => verifyMechanismFreeze(binding)).toThrow();
      expect(verifyMechanismFreeze({ ...binding, coding })).toMatchObject({ codingSHA256: coding.sha256 });
      expect(() => verifyMechanismFreeze({ ...binding, mechanismManifestSHA256: 'd'.repeat(64), coding })).toThrow();
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

it('accepts a source-valid assigned caller row for a callee-anchored cause, but not an uncovered row', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'eval-mechanism-cause-'));
  try {
    const id = 'a'.repeat(24), mechanismManifestSHA256 = 'b'.repeat(64);
    const manifest = { sheets: [{ id, causes: [{ id: 'callee', optional: false }, { id: 'topical', optional: true }] }] };
    const mapping = { selections: [{ id, arm: 'treatment' }] };
    const packet = { id: 'packet', path: 'caller.ts', hunks: [{ hunkId: 'caller' }, { hunkId: 'uncovered' }] };
    const record = { packetId: 'packet', pass: 1, reviewStatus: 'incomplete', assignedHunkIds: ['caller', 'uncovered'], assignedEffects: [{ hunkId: 'caller', effect: 'removed callee check', kind: 'skipped_path', disposition: 'safe', basis: 'caller and callee source' }, { hunkId: 'caller', effect: 'topical only', kind: 'none', disposition: 'safe', basis: 'source' }] };
    const mechanismReviews = [projectMechanism({ id, packets: [packet], records: [record], anchorMappings: [{ id: 'callee', hunkIds: ['callee'], unmapped: false }, { id: 'topical', hunkIds: [], unmapped: true }] })];
    const citation = { packetId: 'packet', pass: 1, hunkId: 'caller', rowIndex: 0, sourceValid: true, sourceReason: 'The caller reaches the removed callee guard.' };
    const cause = (causeId: string, matchingEffect: boolean, citations: unknown[]) => ({ causeId, matchingEffect, citations, safetyBasis: 'supported', missingSupport: false, duplicateBoilerplate: false, note: 'Source reviewed.' });
    const write = (name: string, reviews: unknown[]) => { const bytes = JSON.stringify({ frozen: true, mechanismManifestSHA256, reviews }), file = path.join(dir, name); writeFileSync(file, bytes); return { path: file, sha256: sha(bytes) }; };
    const reviews = [{ id, causes: [cause('callee', true, [citation]), cause('topical', false, [{ ...citation, rowIndex: 1, sourceValid: false }])] }];
    expect(verifyMechanismFreeze({ mechanismManifestSHA256, manifest, mapping, mechanismReviews, coding: write('ok', reviews) })).toMatchObject({ derived: [{ causeId: 'callee', dispositions: ['safe'], mapping: 'mapped' }, { causeId: 'topical', dispositions: [], mapping: 'unmapped' }] });
    const noRow = [{ id, causes: [cause('callee', true, []), cause('topical', false, [])] }];
    expect(() => verifyMechanismFreeze({ mechanismManifestSHA256, manifest, mapping, mechanismReviews, coding: write('none', noRow) })).toThrow('source-valid');
    const uncovered = [{ id, causes: [cause('callee', true, [{ ...citation, hunkId: 'uncovered' }]), cause('topical', false, [])] }];
    expect(() => verifyMechanismFreeze({ mechanismManifestSHA256, manifest, mapping, mechanismReviews, coding: write('uncovered', uncovered) })).toThrow('citation');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
