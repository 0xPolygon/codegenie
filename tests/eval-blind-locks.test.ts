import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error Development-only ESM has no emitted types.
import { verifyPrimaryLocks, verifyMechanismFreeze } from '../evals/runner/blind-locks.mjs';
const sha = (x: string) => createHash('sha256').update(x).digest('hex');
describe('blind export lock gate', () => {
  it('requires two distinct locks, matching reconciliation, and frozen mechanism coding', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'eval-blind-locks-'));
    try {
      const file = (name: string, value: unknown) => { const bytes = JSON.stringify(value), dest = path.join(dir, name); writeFileSync(dest, bytes); return { path: dest, sha256: sha(bytes) }; };
      const manifestSHA256 = 'a'.repeat(64), mechanismManifestSHA256 = 'b'.repeat(64);
      const a = file('a', { analyst: 'one', manifestSHA256 }), b = file('b', { analyst: 'two', manifestSHA256 });
      const reconciliation = file('reconciliation', { manifestSHA256, lockSHA256: [b.sha256, a.sha256] });
      expect(verifyPrimaryLocks({ manifestSHA256, locks: [a, b], reconciliation })).toMatchObject({ reconciliationSHA256: reconciliation.sha256 });
      expect(() => verifyPrimaryLocks({ manifestSHA256, locks: [a, b] })).toThrow();
      expect(() => verifyPrimaryLocks({ manifestSHA256, locks: [a, a], reconciliation })).toThrow();
      const same = file('same', { analyst: 'one', manifestSHA256 });
      expect(() => verifyPrimaryLocks({ manifestSHA256, locks: [a, same], reconciliation })).toThrow();
      const wrong = file('wrong', { analyst: 'two', manifestSHA256: 'c'.repeat(64) });
      expect(() => verifyPrimaryLocks({ manifestSHA256, locks: [a, wrong], reconciliation })).toThrow();
      expect(() => verifyMechanismFreeze({ mechanismManifestSHA256 })).toThrow();
      const coding = file('coding', { frozen: true, mechanismManifestSHA256 });
      expect(verifyMechanismFreeze({ mechanismManifestSHA256, coding })).toBe(coding.sha256);
      expect(() => verifyMechanismFreeze({ mechanismManifestSHA256: 'd'.repeat(64), coding })).toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
