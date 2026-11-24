import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
      const hash = store.seal('one', 1, result);
      expect(store.seal('one', 1, result)).toBe(hash);
      const reopened = createReceiptStore(options);
      expect(reopened.verify('one', 1, hash)).toBe(true);
      expect(reopened.find('one', 1)).toMatchObject({ hash, receipt: { slot: 'one', attempt: 1, status: 'pass' } });
      expect(reopened.find('one', 2)).toBeNull();
      expect(reopened.verify('one', 2, hash)).toBe(false);
      expect(createReceiptStore({ ...options, binding: 'other' }).verify('one', 1, hash)).toBe(false);
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
      const runDir = path.join(dir, 'elsewhere'); mkdirSync(runDir);
      const store = createReceiptStore({ directory: path.join(dir, 'receipts'), binding: 'b', runRootFor: () => path.join(dir, 'attempt') });
      expect(() => store.seal('one', 1, { caseName: 'case', status: 'pass', runDir })).toThrow('outside attempt');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
