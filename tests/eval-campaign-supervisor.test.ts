import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error Development-only ESM has no emitted types.
import { CampaignLedger } from '../evals/runner/ledger.mjs';
// @ts-expect-error Development-only ESM has no emitted types.
import { CampaignSupervisor } from '../evals/runner/supervisor.mjs';

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
describe('campaign admission custody', () => {
  it('seals a physically started interruption and preserves its hold without re-admission', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'eval-supervisor-interrupted-'));
    try {
      const scheduleBytes = Buffer.from(JSON.stringify({ slots: [{ id: 'one', boundaryId: 'one', provider: 'openrouter' }] }));
      const supervisor = new CampaignSupervisor(path.join(dir, 'supervisor.db'), { binding: 'b', scheduleBytes, scheduleSHA256: digest(scheduleBytes) });
      const ledger = new CampaignLedger(path.join(dir, 'ledger.db'), { binding: 'b', limitMicros: 15_000_000 });
      supervisor.db.prepare("INSERT INTO attempt VALUES('one',1,'started',NULL)").run();
      ledger.reservePhysical({ id: 'one/attempt-01/mc-1/physical-1', logicalId: 'one/attempt-01/mc-1', kind: 'initial', provider: 'openrouter' });
      const receiptHash = digest('interrupted');
      const sealInterrupted = vi.fn(() => receiptHash), verifyReceipt = vi.fn(() => true);
      expect(supervisor.reconcile('one', 1, { ledger, verifyWorkerExited: () => true, sealInterrupted, verifyReceipt })).toEqual({ state: 'interrupted', receiptSHA256: receiptHash });
      expect(sealInterrupted).toHaveBeenCalledWith('one', 1, [{ id: 'one/attempt-01/mc-1/physical-1', state: 'open', charge: 400_000 }]);
      expect(ledger.totals()).toMatchObject({ starts: 1, open: 1, chargedMicros: 400_000 });
      expect(() => supervisor.begin('one', { ledger, evidenceFiles: {}, verifyReceipt })).toThrow('retry authorization');
      ledger.close(); supervisor.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('binds the complete schedule, gates each boundary, and never repeats an interrupted start', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'eval-supervisor-'));
    try {
      const file = path.join(dir, 'supervisor.db');
      const evidenceFiles: Record<string, string> = {};
      const evidence = (value: object) => { const text = JSON.stringify(value), hash = digest(text), name = path.join(dir, hash); writeFileSync(name, text); evidenceFiles[hash] = name; return hash; };
      const baselineHash = evidence({ kind: 'key_baseline', usageNanos: 0 }), snapshotHash = evidence({ kind: 'key_snapshot', usageNanos: 0, observedMs: 1 });
      const healthHash = evidence({ kind: 'health', physicalId: 'health', boundaryId: 'one', provider: 'openrouter', outcome: 'clean', observedMs: 1 });
      const ledger = new CampaignLedger(path.join(dir, 'ledger.db'), { binding: 'b', limitMicros: 15_000_000 });
      ledger.bindKeyBaseline({ usageMicros: 0, evidenceSHA256: baselineHash });
      ledger.recordKeySnapshot({ usageMicros: 0, observedMs: 1, evidenceSHA256: snapshotHash });
      const scheduleBytes = Buffer.from(JSON.stringify({ pauseAfterSlot: 'one', slots: [{ id: 'one', boundaryId: 'one', provider: 'openrouter' }, { id: 'two', boundaryId: 'two', provider: 'openrouter' }] }));
      const binding = { binding: 'b', scheduleBytes, scheduleSHA256: digest(scheduleBytes) };
      let supervisor = new CampaignSupervisor(file, binding);
      const verifyReceipt = vi.fn(() => true), args = { ledger, evidenceFiles, nowMs: 2, verifyReceipt };
      expect(supervisor.begin('one', args)).toMatchObject({ action: 'probe' });
      ledger.reservePhysical({ id: 'health', logicalId: 'health', kind: 'health', provider: 'openrouter', healthBoundary: 'one' });
      ledger.settlePhysical({ id: 'health', httpStatus: 200, providerCostMicros: 0, costConfirmed: true });
      ledger.recordHealth({ physicalId: 'health', outcome: 'clean', observedMs: 1, evidenceSHA256: healthHash });
      expect(supervisor.begin('one', args)).toMatchObject({ action: 'started' });
      supervisor.close(); supervisor = new CampaignSupervisor(file, binding);
      expect(() => supervisor.begin('one', args)).toThrow('requires reconciliation');
      expect(() => supervisor.reconcile('one', 1, { ledger, verifyWorkerExited: () => false })).toThrow('worker exit');
      expect(() => supervisor.reconcile('one', 1, { ledger, verifyWorkerExited: async () => false })).toThrow('worker exit');
      expect(supervisor.reconcile('one', 1, { ledger, verifyWorkerExited: () => true })).toEqual({ state: 'no_start' });
      expect(supervisor.begin('one', args)).toMatchObject({ action: 'started', attempt: 2, attemptPrefix: 'one/attempt-02' });
      expect(() => supervisor.seal('one', 2, digest('receipt'), async () => false)).toThrow('receipt');
      expect(() => supervisor.begin('one', args)).toThrow('requires reconciliation');
      supervisor.seal('one', 2, digest('receipt'), verifyReceipt);
      expect(() => supervisor.begin('two', { ...args, verifyReceipt: async () => false })).toThrow('receipt');
      expect(supervisor.begin('two', args)).toMatchObject({ action: 'paused' });
      supervisor.releaseCheckpoint(verifyReceipt);
      supervisor.db.prepare('UPDATE outcome SET receipt_sha256=? WHERE slot_id=?').run(digest('changed'), 'one');
      supervisor.db.prepare('UPDATE attempt SET receipt_sha256=? WHERE slot_id=? AND attempt_no=2').run(digest('changed'), 'one');
      expect(supervisor.begin('two', args)).toMatchObject({ action: 'paused' });
      supervisor.db.prepare('UPDATE outcome SET receipt_sha256=? WHERE slot_id=?').run(digest('receipt'), 'one');
      supervisor.db.prepare('UPDATE attempt SET receipt_sha256=? WHERE slot_id=? AND attempt_no=2').run(digest('receipt'), 'one');
      expect(supervisor.begin('two', args)).toMatchObject({ action: 'probe' });
      expect(verifyReceipt).toHaveBeenCalledWith('one', 2, digest('receipt'));
      supervisor.close();
      const changed = Buffer.from(scheduleBytes.toString().replace('two', 'new'));
      expect(() => new CampaignSupervisor(file, { ...binding, scheduleBytes: changed, scheduleSHA256: digest(changed) })).toThrow('binding mismatch');
      ledger.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
