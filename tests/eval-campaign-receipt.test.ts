import { chmodSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
// @ts-expect-error Development-only ESM has no emitted types.
import { createReceiptStore } from '../evals/runner/receipt.mjs';

describe('campaign receipt custody', () => {
  it('rechecks the selected attempt and every artifact after reopening', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'eval-receipt-'));
    try {
      const root = (slot: string, attempt: number) => path.join(dir, 'outputs', slot, `attempt-${attempt}`);
      const runDir = path.join(root('one', 1), 'run');
      mkdirSync(path.join(runDir, 'debug'), { recursive: true });
      writeFileSync(path.join(runDir, 'run.json'), '{"status":"completed"}');
      writeFileSync(path.join(runDir, 'debug', 'call.json'), 'original');
      const options = { directory: path.join(dir, 'receipts'), binding: 'campaign', runRootFor: root };
      const store = createReceiptStore(options);
      const result = { caseName: 'case', status: 'pass', runDir };
      writeFileSync(path.join(dir, 'receipts', '.tmp-interrupted'), 'partial');
      const hash = store.seal('one', 1, result);
      expect(store.seal('one', 1, result)).toBe(hash);
      expect(() => createReceiptStore(options).seal('one', 1, { ...result, status: 'fail' })).toThrow('conflicting receipt');
      const otherReceipt = { ...JSON.parse(readFileSync(path.join(dir, 'receipts', hash), 'utf8')), status: 'fail' };
      const otherHash = createHash('sha256').update(JSON.stringify(otherReceipt)).digest('hex');
      expect(store.verify('one', 1, otherHash)).toBe(false);
      expect(statSync(runDir).mode & 0o222).toBe(0);
      expect(statSync(path.join(runDir, 'debug', 'call.json')).mode & 0o222).toBe(0);
      const reopened = createReceiptStore(options);
      expect(reopened.verify('one', 1, hash)).toBe(true);
      renameSync(runDir, `${runDir}-moved`); symlinkSync(`${runDir}-moved`, runDir);
      expect(reopened.verify('one', 1, hash)).toBe(false);
      rmSync(runDir); renameSync(`${runDir}-moved`, runDir);
      const attemptRoot = root('one', 1);
      renameSync(attemptRoot, `${attemptRoot}-moved`); symlinkSync(`${attemptRoot}-moved`, attemptRoot);
      expect(reopened.verify('one', 1, hash)).toBe(false);
      rmSync(attemptRoot); renameSync(`${attemptRoot}-moved`, attemptRoot);
      expect(reopened.find('one', 1)).toMatchObject({ hash, receipt: { slot: 'one', attempt: 1, status: 'pass' } });
      expect(reopened.find('one', 2)).toBeNull();
      expect(reopened.verify('one', 2, hash)).toBe(false);
      expect(() => createReceiptStore({ ...options, binding: 'other' })).toThrow('conflicting receipt');
      chmodSync(runDir, 0o700); chmodSync(path.join(runDir, 'debug'), 0o700); chmodSync(path.join(runDir, 'debug', 'call.json'), 0o600);
      writeFileSync(path.join(runDir, 'debug', 'call.json'), 'changed');
      expect(reopened.verify('one', 1, hash)).toBe(false);
      expect(() => reopened.find('one', 1)).toThrow('receipt missing or changed');
      writeFileSync(path.join(runDir, 'debug', 'call.json'), 'original');
      writeFileSync(path.join(runDir, 'extra.json'), '{}');
      expect(reopened.verify('one', 1, hash)).toBe(false);
      rmSync(path.join(runDir, 'extra.json'));
      symlinkSync(path.join(dir, 'outside'), path.join(runDir, 'debug', 'linked'));
      expect(reopened.verify('one', 1, hash)).toBe(false);
      expect(() => reopened.seal('one', 1, result)).toThrow('symlink');
      expect(readFileSync(path.join(dir, 'receipts', hash), 'utf8')).not.toContain('original');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('refuses artifacts outside the attempt root', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'eval-receipt-outside-'));
    try {
      const runDir = path.join(dir, 'elsewhere'); mkdirSync(runDir); mkdirSync(path.join(dir, 'attempt'));
      const store = createReceiptStore({ directory: path.join(dir, 'receipts'), binding: 'b', runRootFor: () => path.join(dir, 'attempt') });
      expect(() => store.seal('one', 1, { caseName: 'case', status: 'pass', runDir })).toThrow('outside attempt');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
