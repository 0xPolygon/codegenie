import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
// @ts-expect-error Development-only ESM has no emitted types.
import { CampaignSupervisor } from '../evals/runner/supervisor.mjs';
// @ts-expect-error Development-only ESM has no emitted types.
import { spawnAttempt } from '../evals/runner/spawn-worker.mjs';
const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');
beforeAll(() => { execFileSync('pnpm', ['build'], { stdio: 'pipe' }); }, 60_000);

describe('campaign worker spawn', () => {
  it('runs the existing fake eval through an actual bound child process', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'eval-spawn-child-'));
    vi.stubEnv('CODEGENIE_HOME', path.join(dir, 'home'));
    try {
      const caseFile = path.join(dir, 'case.json'), caseBytes = Buffer.from(JSON.stringify({ caseDir: path.join(process.cwd(), 'evals/fixtures'), caseName: 'fixture-core-lens', outputDir: path.join(dir, 'out') }));
      writeFileSync(caseFile, caseBytes);
      const base = { ledgerBinding: 'b', caseConfig: caseFile, caseConfigSHA256: digest(caseBytes), ledgerPath: path.join(dir, 'ledger'), limitMicros: 2_000_000, expectedCalls: [] };
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
      const base = { ledgerBinding: 'b', caseConfig: path.join(dir, 'case.json'), caseConfigSHA256: 'a'.repeat(64) };
      const bytes = Buffer.from(JSON.stringify({ slots: [{ id: 'one', boundaryId: 'one', provider: 'openrouter', workerConfig: base }] }));
      const supervisor = new CampaignSupervisor(path.join(dir, 'supervisor.db'), { binding: 'b', scheduleBytes: bytes, scheduleSHA256: digest(bytes) });
      const ledger = { assertRestartSafe() {}, keyDecision: () => ({ action: 'admit' }), healthDecision: () => ({ action: 'admit' }) };
      supervisor.begin('one', { ledger, evidenceFiles: {}, verifyReceipt: () => true });
      const file = path.join(dir, 'worker.json'), wrong = Buffer.from(JSON.stringify({ ...base, attemptPrefix: 'one/attempt-02' }));
      writeFileSync(file, wrong);
      const spawnImpl = vi.fn(() => {
        const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; kill(): void };
        child.stdout = new PassThrough(); child.kill = () => {};
        process.nextTick(() => { child.stdout.write(JSON.stringify({ caseName: 'fixture', status: 'fail', runDir: path.join(dir, 'run') })); child.stdout.end(); child.emit('close', 0); });
        return child;
      });
      await expect(spawnAttempt({ supervisor, slotId: 'one', attemptNo: 1, configFile: file, configSHA256: digest(wrong), spawnImpl })).rejects.toThrow('binding mismatch');
      expect(spawnImpl).not.toHaveBeenCalled();
      const correct = Buffer.from(JSON.stringify({ ...base, attemptPrefix: 'one/attempt-01' })); writeFileSync(file, correct);
      await expect(spawnAttempt({ supervisor, slotId: 'one', attemptNo: 1, configFile: file, configSHA256: digest(correct), spawnImpl })).resolves.toMatchObject({ caseName: 'fixture', status: 'fail' });
      await expect(spawnAttempt({ supervisor, slotId: 'one', attemptNo: 1, configFile: file, configSHA256: digest(correct), spawnImpl })).rejects.toThrow();
      expect(spawnImpl).toHaveBeenCalledTimes(1); supervisor.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
