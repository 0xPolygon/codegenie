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
  it('binds the complete schedule, gates each boundary, and never repeats an interrupted start', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'eval-supervisor-'));
    try {
      const file = path.join(dir, 'supervisor.db'), evidence = path.join(dir, 'evidence');
      writeFileSync(evidence, 'evidence');
      const evidenceHash = digest('evidence'), ledger = new CampaignLedger(path.join(dir, 'ledger.db'), { binding: 'b', limitMicros: 15_000_000 });
      ledger.bindKeyBaseline({ usageMicros: 0, evidenceSHA256: evidenceHash });
      ledger.recordKeySnapshot({ usageMicros: 0, observedMs: 1, evidenceSHA256: evidenceHash });
      const scheduleBytes = Buffer.from(JSON.stringify({ slots: [{ id: 'one', boundaryId: 'one', provider: 'openrouter' }, { id: 'two', boundaryId: 'two', provider: 'openrouter' }] }));
      const binding = { binding: 'b', scheduleBytes, scheduleSHA256: digest(scheduleBytes) };
      let supervisor = new CampaignSupervisor(file, binding);
      const verifyReceipt = vi.fn(() => true), args = { ledger, evidenceFiles: { [evidenceHash]: evidence }, nowMs: 2, verifyReceipt };
      expect(supervisor.begin('one', args)).toMatchObject({ action: 'probe' });
      ledger.reservePhysical({ id: 'health', logicalId: 'health', kind: 'health', provider: 'openrouter', healthBoundary: 'one' });
      ledger.settlePhysical({ id: 'health', httpStatus: 200, providerCostMicros: 0, costConfirmed: true });
      ledger.recordHealth({ physicalId: 'health', outcome: 'clean', observedMs: 1, evidenceSHA256: evidenceHash });
      expect(supervisor.begin('one', args)).toMatchObject({ action: 'started' });
      supervisor.close(); supervisor = new CampaignSupervisor(file, binding);
      expect(() => supervisor.begin('one', args)).toThrow('requires reconciliation');
      supervisor.seal('one', digest('receipt'), verifyReceipt);
      expect(supervisor.begin('two', args)).toMatchObject({ action: 'probe' });
      expect(verifyReceipt).toHaveBeenCalledWith('one', digest('receipt'));
      supervisor.close();
      const changed = Buffer.from(scheduleBytes.toString().replace('two', 'new'));
      expect(() => new CampaignSupervisor(file, { ...binding, scheduleBytes: changed, scheduleSHA256: digest(changed) })).toThrow('binding mismatch');
      ledger.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
