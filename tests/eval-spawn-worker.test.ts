import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error Development-only ESM has no emitted types.
import { CampaignSupervisor } from '../evals/runner/supervisor.mjs';
// @ts-expect-error Development-only ESM has no emitted types.
import { spawnAttempt } from '../evals/runner/spawn-worker.mjs';
// @ts-expect-error Development-only ESM has no emitted types.
import { CampaignLedger } from '../evals/runner/ledger.mjs';
// @ts-expect-error Development-only ESM has no emitted types.
import { createReceiptStore } from '../evals/runner/receipt.mjs';
const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');
function makeWritable(dir: string) {
  const stat = lstatSync(dir);
  if (stat.isSymbolicLink()) return;
  chmodSync(dir, stat.isDirectory() ? 0o700 : 0o600);
  if (stat.isDirectory()) for (const name of readdirSync(dir)) makeWritable(path.join(dir, name));
}

describe('campaign worker spawn', () => {
  it.each(['typed-failure', 'operational-error', 'foreign-output', 'wrong-case', 'timeout', 'spawn-error', 'custody-error'])('handles %s without accepting foreign artifacts', async (scenario) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'eval-spawn-failure-'));
    try {
      const caseFile = path.join(dir, 'case.json'), caseBytes = Buffer.from(JSON.stringify({ caseDir: path.join(process.cwd(), 'evals/fixtures'), caseName: 'fixture-core-lens', outputDir: path.join(dir, 'out') }));
      writeFileSync(caseFile, caseBytes);
      const base = { supervisorPath: path.join(dir, 'supervisor.db'), ledgerBinding: 'b', caseConfig: caseFile, caseConfigSHA256: digest(caseBytes) };
      const schedule = Buffer.from(JSON.stringify({ slots: [{ id: 'one', boundaryId: 'one', provider: 'openrouter', workerConfig: base }] }));
      const supervisor = new CampaignSupervisor(path.join(dir, 'supervisor.db'), { binding: 'b', scheduleBytes: schedule, scheduleSHA256: digest(schedule) });
      const ledger = { assertRestartSafe() {}, keyDecision: () => ({ action: 'admit' }), healthDecision: () => ({ action: 'admit' }) };
      supervisor.begin('one', { ledger, evidenceFiles: {}, verifyReceipt: () => true });
      const config = Buffer.from(JSON.stringify({ ...base, attemptPrefix: 'one/attempt-01' })), file = path.join(dir, 'worker.json'); writeFileSync(file, config);
      const kill = vi.fn();
      let notifySpawn = () => {}; const spawned = new Promise<void>((resolve) => { notifySpawn = resolve; });
      const spawnImpl = () => {
        if (scenario === 'spawn-error') throw new Error('synthetic spawn failure');
        const child = new EventEmitter() as EventEmitter & { pid: number; stdin: PassThrough; stdout: PassThrough; kill(): void };
        child.pid = process.pid; child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.kill = kill;
        notifySpawn();
        if (scenario !== 'timeout') process.nextTick(() => {
          child.stdout.write(JSON.stringify(scenario === 'typed-failure' ? { error: 'binding_mismatch' } : scenario === 'operational-error'
            ? { caseName: 'fixture-core-lens', status: 'error', error: 'provider_failure', runDir: path.join(dir, 'out/one/attempt-01/1') } : scenario === 'wrong-case'
            ? { caseName: 'different', status: 'pass', runDir: path.join(dir, 'out/one/attempt-01/1') }
            : { caseName: 'fixture-core-lens', status: 'pass', runDir: path.join(dir, 'other') }));
          child.stdout.end(); child.emit('close', scenario === 'typed-failure' ? 1 : 0);
        });
        return child;
      };
      if (scenario === 'custody-error') vi.spyOn(supervisor, 'recordWorkerStart').mockImplementation(() => { throw new Error('synthetic custody failure'); });
      if (scenario === 'timeout') vi.useFakeTimers();
      const pending = spawnAttempt({ supervisor, slotId: 'one', attemptNo: 1, configFile: file, configSHA256: digest(config), spawnImpl });
      if (scenario === 'typed-failure') await expect(pending).resolves.toEqual({ status: 'worker_failed', error: 'binding_mismatch' });
      else if (scenario === 'operational-error') await expect(pending).resolves.toMatchObject({ status: 'error', error: 'provider_failure' });
      else if (scenario === 'foreign-output' || scenario === 'wrong-case') await expect(pending).rejects.toThrow('invalid worker result');
      else if (scenario === 'spawn-error') { await expect(pending).rejects.toThrow('worker start failed'); expect(supervisor.workerExited('one', 1)).toBe(true); }
      else if (scenario === 'custody-error') { await expect(pending).rejects.toThrow('requires reconciliation'); expect(kill).toHaveBeenCalledWith('SIGKILL'); expect(supervisor.workerExited('one', 1)).toBe(false); }
      else {
        const assertion = expect(pending).rejects.toThrow('timeout requires reconciliation');
        await spawned;
        await vi.advanceTimersByTimeAsync(3_000_000); await assertion; expect(kill).toHaveBeenCalledWith('SIGKILL');
        expect(supervisor.workerExited('one', 1)).toBe(false);
        if (process.platform === 'linux') {
          supervisor.db.prepare("UPDATE worker_claim SET process_start='0' WHERE slot_id='one'").run();
          expect(supervisor.workerExited('one', 1)).toBe(true);
          supervisor.db.prepare("UPDATE worker_claim SET pid_namespace='different' WHERE slot_id='one'").run();
          expect(supervisor.workerExited('one', 1)).toBe(false);
          supervisor.db.prepare("UPDATE worker_claim SET process_start=NULL WHERE slot_id='one'").run();
          expect(supervisor.workerExited('one', 1)).toBe(false);
        }
      }
      expect(supervisor.db.prepare("SELECT state FROM attempt WHERE slot_id='one'").get()).toEqual({ state: 'started' }); supervisor.close();
    } finally { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); }
  }, 90_000);
  it('runs the existing fake eval through an actual bound child process', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'eval-spawn-child-'));
    vi.stubEnv('CODEGENIE_HOME', path.join(dir, 'home'));
    try {
      const caseFile = path.join(dir, 'case.json'), caseBytes = Buffer.from(JSON.stringify({ caseDir: path.join(process.cwd(), 'evals/fixtures'), caseName: 'fixture-core-lens', outputDir: path.join(dir, 'out') }));
      writeFileSync(caseFile, caseBytes);
      const base = { supervisorPath: path.join(dir, 'supervisor.db'), ledgerBinding: 'b', caseConfig: caseFile, caseConfigSHA256: digest(caseBytes), ledgerPath: path.join(dir, 'ledger'), limitMicros: 2_000_000, expectedCalls: [] };
      const bytes = Buffer.from(JSON.stringify({ slots: [{ id: 'one', boundaryId: 'one', provider: 'openrouter', workerConfig: base }] }));
      const binding = { binding: 'b', scheduleBytes: bytes, scheduleSHA256: digest(bytes) };
      let supervisor = new CampaignSupervisor(path.join(dir, 'supervisor.db'), binding);
      expect(supervisor.workerExited('one', 1)).toBe(false);
      const ledger = { assertRestartSafe() {}, keyDecision: () => ({ action: 'admit' }), healthDecision: () => ({ action: 'admit' }) };
      supervisor.begin('one', { ledger, evidenceFiles: {}, verifyReceipt: () => true });
      const config = Buffer.from(JSON.stringify({ ...base, attemptPrefix: 'one/attempt-01' })), file = path.join(dir, 'worker.json');
      writeFileSync(file, config);
      const result = await spawnAttempt({ supervisor, slotId: 'one', attemptNo: 1, configFile: file, configSHA256: digest(config) });
      expect(result).toMatchObject({ caseName: 'fixture-core-lens', status: 'pass' });
      const receipts = createReceiptStore({ directory: path.join(dir, 'receipts'), binding: 'b', runRootFor: (slot: string, attempt: number) => path.join(dir, 'out', slot, `attempt-${String(attempt).padStart(2, '0')}`) });
      const receiptHash = receipts.seal('one', 1, result);
      expect(supervisor.workerExited('one', 1)).toBe(true);
      // Simulate a crash after the child exited but before the parent persisted close.
      supervisor.db.prepare("UPDATE worker_claim SET spawn_state='started' WHERE slot_id='one'").run(); supervisor.close();
      supervisor = new CampaignSupervisor(path.join(dir, 'supervisor.db'), binding);
      expect(supervisor.workerExited('one', 1)).toBe(true);
      supervisor.recordWorkerExit('one', 1); supervisor.seal('one', 1, receiptHash, receipts.verify); supervisor.close();
      supervisor = new CampaignSupervisor(path.join(dir, 'supervisor.db'), binding);
      supervisor.recordWorkerExit('one', 1);
      expect(supervisor.db.prepare('SELECT COUNT(*) AS total FROM outcome').get()).toEqual({ total: 1 });
      expect(supervisor.db.prepare('SELECT COUNT(*) AS total FROM attempt').get()).toEqual({ total: 1 });
      expect(supervisor.checkedOutcomes(receipts.verify)).toHaveLength(1);
      makeWritable(result.runDir); writeFileSync(path.join(result.runDir, 'run.json'), 'tampered');
      expect(() => supervisor.checkedOutcomes(receipts.verify)).toThrow('receipt missing or changed');
      const campaign = new CampaignLedger(path.join(dir, 'ledger'), { binding: 'b', limitMicros: 2_000_000 });
      expect(campaign.totals().starts).toBe(0); campaign.close(); supervisor.close();
    } finally { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); }
  }, 90_000);
  it('requires the schedule-bound worker configuration before spawning', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'eval-spawn-'));
    try {
      const caseConfig = path.join(dir, 'case.json');
      const caseBytes = Buffer.from(JSON.stringify({ caseDir: path.join(process.cwd(), 'evals/fixtures'), caseName: 'fixture-core-lens', outputDir: path.join(dir, 'out') }));
      writeFileSync(caseConfig, caseBytes);
      const base = { supervisorPath: path.join(dir, 'supervisor.db'), ledgerBinding: 'b', caseConfig, caseConfigSHA256: digest(caseBytes) };
      const bytes = Buffer.from(JSON.stringify({ slots: [{ id: 'one', boundaryId: 'one', provider: 'openrouter', workerConfig: base }] }));
      const supervisor = new CampaignSupervisor(path.join(dir, 'supervisor.db'), { binding: 'b', scheduleBytes: bytes, scheduleSHA256: digest(bytes) });
      const ledger = { assertRestartSafe() {}, keyDecision: () => ({ action: 'admit' }), healthDecision: () => ({ action: 'admit' }) };
      supervisor.begin('one', { ledger, evidenceFiles: {}, verifyReceipt: () => true });
      const file = path.join(dir, 'worker.json'), wrong = Buffer.from(JSON.stringify({ ...base, attemptPrefix: 'one/attempt-02' }));
      writeFileSync(file, wrong);
      const spawnImpl = vi.fn(() => {
        const child = new EventEmitter() as EventEmitter & { pid: number; stdin: PassThrough; stdout: PassThrough; kill(): void };
        child.pid = process.pid; child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.kill = () => {};
        process.nextTick(() => { child.stdout.write(JSON.stringify({ caseName: 'fixture-core-lens', status: 'fail', runDir: path.join(dir, 'out/one/attempt-01/1') })); child.stdout.end(); child.emit('close', 0); });
        return child;
      });
      await expect(spawnAttempt({ supervisor, slotId: 'one', attemptNo: 1, configFile: file, configSHA256: digest(wrong), spawnImpl })).rejects.toThrow('binding mismatch');
      expect(spawnImpl).not.toHaveBeenCalled();
      const correct = Buffer.from(JSON.stringify({ ...base, attemptPrefix: 'one/attempt-01' })); writeFileSync(file, correct);
      await expect(spawnAttempt({ supervisor, slotId: 'one', attemptNo: 1, configFile: file, configSHA256: digest(correct), spawnImpl })).resolves.toMatchObject({ caseName: 'fixture-core-lens', status: 'fail' });
      await expect(spawnAttempt({ supervisor, slotId: 'one', attemptNo: 1, configFile: file, configSHA256: digest(correct), spawnImpl })).rejects.toThrow();
      expect(spawnImpl).toHaveBeenCalledTimes(1); supervisor.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
