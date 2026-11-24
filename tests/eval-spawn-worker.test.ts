import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error Development-only ESM has no emitted types.
import { CampaignSupervisor } from '../evals/runner/supervisor.mjs';
// @ts-expect-error Development-only ESM has no emitted types.
import { spawnAttempt } from '../evals/runner/spawn-worker.mjs';
const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');

describe('campaign worker spawn', () => {
  it.each(['typed-failure', 'foreign-output', 'wrong-case', 'timeout'])('handles %s without accepting foreign artifacts', async (scenario) => {
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
        const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; kill(): void };
        child.stdout = new PassThrough(); child.kill = kill;
        notifySpawn();
        if (scenario !== 'timeout') process.nextTick(() => {
          child.stdout.write(JSON.stringify(scenario === 'typed-failure' ? { error: 'binding_mismatch' } : scenario === 'wrong-case'
            ? { caseName: 'different', status: 'pass', runDir: path.join(dir, 'out/one/attempt-01/1') }
            : { caseName: 'fixture-core-lens', status: 'pass', runDir: path.join(dir, 'other') }));
          child.stdout.end(); child.emit('close', scenario === 'typed-failure' ? 1 : 0);
        });
        return child;
      };
      if (scenario === 'timeout') vi.useFakeTimers();
      const pending = spawnAttempt({ supervisor, slotId: 'one', attemptNo: 1, configFile: file, configSHA256: digest(config), spawnImpl });
      if (scenario === 'typed-failure') await expect(pending).resolves.toEqual({ status: 'worker_failed', error: 'binding_mismatch' });
      else if (scenario === 'foreign-output' || scenario === 'wrong-case') await expect(pending).rejects.toThrow('invalid worker result');
      else {
        const assertion = expect(pending).rejects.toThrow('timeout requires reconciliation');
        await spawned;
        await vi.advanceTimersByTimeAsync(3_000_000); await assertion; expect(kill).toHaveBeenCalledWith('SIGKILL');
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
      const supervisor = new CampaignSupervisor(path.join(dir, 'supervisor.db'), { binding: 'b', scheduleBytes: bytes, scheduleSHA256: digest(bytes) });
      const ledger = { assertRestartSafe() {}, keyDecision: () => ({ action: 'admit' }), healthDecision: () => ({ action: 'admit' }) };
      supervisor.begin('one', { ledger, evidenceFiles: {}, verifyReceipt: () => true });
      const config = Buffer.from(JSON.stringify({ ...base, attemptPrefix: 'one/attempt-01' })), file = path.join(dir, 'worker.json');
      writeFileSync(file, config);
      await expect(spawnAttempt({ supervisor, slotId: 'one', attemptNo: 1, configFile: file, configSHA256: digest(config) })).resolves.toMatchObject({ caseName: 'fixture-core-lens', status: 'pass' });
      supervisor.close();
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
        const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; kill(): void };
        child.stdout = new PassThrough(); child.kill = () => {};
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
