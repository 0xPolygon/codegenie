import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
// @ts-expect-error Development runner has no TypeScript declarations.
import { validateAdmissionAudit } from '../evals/runner/admission-audit.mjs';

it('binds the audit to the suite revisions, changed scope, distinct reviewers and optional defect', () => {
  const checkout = mkdtempSync(path.join(tmpdir(), 'audit-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', checkout, ...args]);
  try {
    git('init', '-q'); git('config', 'user.name', 'test'); git('config', 'user.email', 'test@example.invalid');
    writeFileSync(path.join(checkout, 'a.txt'), 'old\n'); git('add', 'a.txt'); git('commit', '-qm', 'base'); const base = git('rev-parse', 'HEAD').toString().trim();
    writeFileSync(path.join(checkout, 'a.txt'), 'new\n'); git('commit', '-qam', 'head'); const head = git('rev-parse', 'HEAD').toString().trim();
    const diffSHA256 = createHash('sha256').update(git('diff', '--binary', base, head, '--')).digest('hex');
    const record = { version: 1, caseId: 'case', baseRevision: base, headRevision: head, diffSHA256, analyst: 'one', curator: 'two', disposition: 'negative-control', oracleSHA256: 'a'.repeat(64), scope: [{ path: 'a.txt', side: 'head', coverage: 'changed_hunks' }], findings: [] };
    const args = { record, case: { caseId: 'case' }, locator: { sourceRevision: head, oracleSHA256: 'a'.repeat(64) }, suiteCase: { command: { base, head } }, checkout, role: 'negative-control', causes: [{ id: 'optional', optional: true }] };
    expect(validateAdmissionAudit(args)).toEqual({ uncoveredChangedPaths: 0 });
    expect(() => validateAdmissionAudit({ ...args, record: { ...record, scope: [] } })).toThrow();
    expect(() => validateAdmissionAudit({ ...args, record: { ...record, scope: [{ ...record.scope[0], path: 'unrelated' }] } })).toThrow();
    expect(() => validateAdmissionAudit({ ...args, record: { ...record, analyst: 'TWO' } })).toThrow();
    expect(() => validateAdmissionAudit({ ...args, record: { ...record, findings: [{ ref: 'finding', verified: true }] } })).toThrow();
    expect(validateAdmissionAudit({ ...args, record: { ...record, findings: [{ ref: 'finding', verified: true, causeId: 'optional' }] } })).toEqual({ uncoveredChangedPaths: 0 });
    expect(() => validateAdmissionAudit({ ...args, suiteCase: { command: { base: head, head } } })).toThrow();
  } finally { rmSync(checkout, { recursive: true, force: true }); }
});
