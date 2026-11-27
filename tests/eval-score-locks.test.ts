import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
// @ts-expect-error Development runner has no TypeScript declarations.
import { verifyPrimaryLocks } from '../evals/runner/blind-locks.mjs';

it('validates linked assertions, unresolved claims, and multi-hit reject consistency', () => {
 const dir = mkdtempSync(path.join(tmpdir(), 'score-lock-'));
 try {
  const id = 'a'.repeat(24), manifestSHA256 = 'b'.repeat(64);
  const manifest = { sheets: [{ id, role: 'negative-control', causes: [{ id: 'optional', optional: true }], rejects: [{ id: 'reject-1' }, { id: 'reject-2' }] }] };
  const sheets = [{ id, discovery: { findings: [] }, verification: [], published: { findings: [{ id: 'p1', severity: 'medium' }, { id: 'p2', severity: 'high' }], summaryOnly: [], attentionQuestions: [] } }];
  const cause = { causeId: 'optional', raised: 'finding', promotion: 'n/a', verification: 'n/a', publication: 'finding', earliestLoss: 'none', externalQuestion: false, readerVisible: true, needsConfirmation: false, items: [], candidateIds: [], publishedId: 'p1', evidence: 'source', attentionIndex: null };
  const grade: any = { id, causes: [cause], otherClaims: { published: [{ id: 'p2', class: 'unresolved', missingEvidence: 'contract', slug: 'claim', severity: 'high', summaryOnly: false }], survivingMediumPlus: [] }, assertions: [{ publishedId: 'p1', status: 'refuted', evidence: 'source' }], rejects: [{ rejectId: 'reject-1', publishedIds: ['p1'] }, { rejectId: 'reject-2', publishedIds: ['p1'] }] };
  const file = (name: string, value: unknown) => { const bytes = JSON.stringify(value), p = path.join(dir, name); writeFileSync(p, bytes); return { path: p, sha256: createHash('sha256').update(bytes).digest('hex') }; };
  const run = (g: any) => { const a = file('a', { analyst: 'a', manifestSHA256, grades: [g] }), b = file('b', { analyst: 'b', manifestSHA256, grades: [g] }); const reconciliation = file('r', { manifestSHA256, lockSHA256: [a.sha256, b.sha256], grades: [g] }); return verifyPrimaryLocks({ manifestSHA256, manifest, sheets, locks: [a, b], reconciliation }); };
  expect(run(grade)).toBeTruthy();
  const missingAssertions = structuredClone(grade); delete missingAssertions.assertions; expect(() => run(missingAssertions)).toThrow('assertions');
  const missing = structuredClone(grade); delete missing.otherClaims.published[0].missingEvidence; expect(() => run(missing)).toThrow();
  const unresolved = structuredClone(grade); unresolved.assertions = [{ publishedId: 'p1', status: 'unresolved', missingEvidence: 'contract' }]; unresolved.rejects = [{ rejectId: 'reject-1', publishedIds: [] }, { rejectId: 'reject-2', publishedIds: [] }]; expect(run(unresolved)).toBeTruthy();
  const inconsistent = structuredClone(grade); inconsistent.rejects[0].publishedIds = ['p2']; expect(() => run(inconsistent)).toThrow('reject');
  const twoIds = structuredClone(grade); twoIds.otherClaims.published[0] = { ...twoIds.otherClaims.published[0], class: 'wholly_false' }; twoIds.rejects[0].publishedIds = ['p1', 'p2']; expect(run(twoIds)).toBeTruthy();
 } finally { rmSync(dir, { recursive: true, force: true }); }
});
