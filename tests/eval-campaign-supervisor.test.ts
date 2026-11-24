import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error Development-only ESM has no emitted types.
import { CampaignLedger } from '../evals/runner/ledger.mjs';
// @ts-expect-error Development-only ESM has no emitted types.
import { CampaignSupervisor, processStart } from '../evals/runner/supervisor.mjs';

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function makeWritable(dir: string) {
  const stat = lstatSync(dir); if (stat.isSymbolicLink()) return;
  chmodSync(dir, stat.isDirectory() ? 0o700 : 0o600);
  if (stat.isDirectory()) for (const name of readdirSync(dir)) makeWritable(path.join(dir, name));
}
const claim = (supervisor: { db: { prepare(sql: string): { run(...values: unknown[]): void } } }, slot: string, number: number) => supervisor.db.prepare("INSERT INTO worker_claim(slot_id,attempt_no,config_sha256,token_sha256,activated,spawn_state) VALUES(?,?,?,?,?,'exited')").run(slot, number, 'a'.repeat(64), 'b'.repeat(64), 1);
function prepareFailure(ledger: { reservePhysical(args: object): void; settlePhysical(args: object): void }) {
  ledger.reservePhysical({ id: 'one/attempt-01/mc-1/physical-1', logicalId: 'one/attempt-01/mc-1', kind: 'initial', provider: 'openrouter', startedAtMs: 50 });
  ledger.settlePhysical({ id: 'one/attempt-01/mc-1/physical-1', httpStatus: 500, settledAtMs: 100 });
}
function prepareProbe(ledger: { reservePhysical(args: object): void; settlePhysical(args: object): void; recordHealth(args: object): void }, id: string, purpose: string, startedAtMs: number) {
  ledger.reservePhysical({ id, logicalId: id, kind: 'health', provider: 'openrouter', healthBoundary: 'one', healthPurpose: purpose, startedAtMs,
    ...(purpose === 'retry' ? { retryFor: 'one/attempt-01', failureReceiptSHA256: digest('first') } : {}) });
  ledger.settlePhysical({ id, httpStatus: 200, providerCostMicros: 0, costConfirmed: true, settledAtMs: startedAtMs + 1 });
  ledger.recordHealth({ physicalId: id, outcome: 'clean', observedMs: startedAtMs + 1, evidenceSHA256: digest(id) });
}
describe('campaign admission custody', () => {
  it('keeps the in-memory driver token consistent when commit fails', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'eval-supervisor-commit-'));
    try {
      const scheduleBytes = Buffer.from(JSON.stringify({ slots: [{ id: 'one', boundaryId: 'one', provider: 'openrouter' }] }));
      const supervisor = new CampaignSupervisor(path.join(dir, 'supervisor.db'), { binding: 'b', scheduleBytes, scheduleSHA256: digest(scheduleBytes) });
      const original = supervisor.db.exec.bind(supervisor.db); let fail = true;
      const spy = vi.spyOn(supervisor.db, 'exec').mockImplementation((sql: string) => { if (sql === 'COMMIT' && fail) { fail = false; throw new Error('commit failed'); } return original(sql); });
      expect(() => supervisor.claimDriver()).toThrow('commit failed');
      expect(supervisor.driverToken).toBeUndefined();
      expect(supervisor.db.prepare('SELECT * FROM driver_claim').get()).toBeUndefined();
      const token = supervisor.claimDriver(); fail = true;
      expect(() => supervisor.releaseDriver(token)).toThrow('commit failed');
      expect(supervisor.driverToken).toBe(token);
      expect(supervisor.db.prepare('SELECT * FROM driver_claim').get()).toBeDefined();
      supervisor.releaseDriver(token); expect(supervisor.driverToken).toBeUndefined(); spy.mockRestore(); supervisor.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('allows one driver and conservatively recovers a verified stale claim', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'eval-supervisor-driver-'));
    try {
      const scheduleBytes = Buffer.from(JSON.stringify({ slots: [{ id: 'one', boundaryId: 'one', provider: 'openrouter' }] }));
      const binding = { binding: 'b', scheduleBytes, scheduleSHA256: digest(scheduleBytes) }, db = path.join(dir, 'supervisor.db');
      const first = new CampaignSupervisor(db, binding), second = new CampaignSupervisor(db, binding);
      const token = first.claimDriver();
      expect(() => second.claimDriver()).toThrow('already active');
      expect(() => second.releaseDriver('f'.repeat(64))).toThrow('claim mismatch');
      first.releaseDriver(token);
      const replacement = second.claimDriver(); second.releaseDriver(replacement);
      if (process.platform === 'linux') {
        first.claimDriver();
        first.db.prepare("UPDATE driver_claim SET process_start=NULL WHERE id=1").run();
        expect(() => second.claimDriver()).toThrow('requires reconciliation');
        first.db.prepare("UPDATE driver_claim SET process_start='0' WHERE id=1").run();
        const recovered = second.claimDriver(); second.releaseDriver(recovered);
      }
      first.close(); second.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('refuses transitions from another supervisor object or a stale driver token', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'eval-supervisor-owner-'));
    try {
      const scheduleBytes = Buffer.from(JSON.stringify({ slots: [{ id: 'one', boundaryId: 'one', provider: 'openrouter' }] }));
      const binding = { binding: 'b', scheduleBytes, scheduleSHA256: digest(scheduleBytes), receiptDirectory: path.join(dir, 'receipts'), runRootFor: () => path.join(dir, 'out') };
      const db = path.join(dir, 'supervisor.db'), first = new CampaignSupervisor(db, binding), second = new CampaignSupervisor(db, binding);
      const ledger = { assertRestartSafe() {}, keyDecision: () => ({ action: 'admit' }), healthDecision: () => ({ action: 'admit' }) };
      const token = first.claimDriver(), args = { ledger, evidenceFiles: {}, verifyReceipt: first.receipts.verify };
      expect(() => second.begin('one', args)).toThrow('driver claim required');
      expect(first.db.prepare('SELECT COUNT(*) AS total FROM attempt').get()).toEqual({ total: 0 });
      first.releaseDriver(token); const next = second.claimDriver();
      expect(() => first.begin('one', args)).toThrow('driver claim required');
      expect(first.db.prepare('SELECT COUNT(*) AS total FROM attempt').get()).toEqual({ total: 0 });
      second.releaseDriver(next); first.close(); second.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('retains a receipt-backed 503, authorizes one fresh retry and excludes a second failure', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'eval-supervisor-bound-retry-')), runs: string[] = [];
    try {
      const scheduleBytes = Buffer.from(JSON.stringify({ slots: [{ id: 'one', caseId: 'case', expectedPacketIds: ['packet'], boundaryId: 'one', provider: 'openrouter' }] }));
      const root = (slot: string, attempt: number) => path.join(dir, 'out', slot, `attempt-${attempt}`);
      const binding = { binding: 'b', scheduleBytes, scheduleSHA256: digest(scheduleBytes), receiptDirectory: path.join(dir, 'receipts'), runRootFor: root };
      const db = path.join(dir, 'supervisor.db'); let supervisor = new CampaignSupervisor(db, binding);
      let driver = supervisor.claimDriver();
      const ledger = new CampaignLedger(path.join(dir, 'ledger.db'), { binding: 'b', limitMicros: 5_000_000 });
      ledger.keyDecision = () => ({ action: 'admit' }); ledger.healthDecision = () => ({ action: 'admit' });
      const yes = () => true;
      const fail = (attempt: number) => {
        const prefix = `one/attempt-0${attempt}`, runId = `run-${attempt}`, runDir = path.join(root('one', attempt), 'run'), telemetry = path.join(runDir, 'telemetry');
        mkdirSync(telemetry, { recursive: true }); runs.push(runDir);
        writeFileSync(path.join(telemetry, 'run.json'), JSON.stringify({ runId, outcome: { status: 'failed' } }));
        writeFileSync(path.join(telemetry, 'telemetry.json'), JSON.stringify({ runId, events: 0, packets: { generated: 0 }, modelCalls: { totalRecords: 1 }, toolCalls: { totalCalls: 0 } }));
        writeFileSync(path.join(telemetry, 'model-calls.jsonl'), JSON.stringify({ runId, callId: 'mc-1', cacheStatus: 'disabled', status: 'transient_error', errorCode: 'llm_call_failed', inputTokens: 1, outputTokens: 0, totalTokens: 1 }) + '\n');
        const id = `${prefix}/mc-1/physical-1`;
        ledger.reservePhysical({ id, logicalId: `${prefix}/mc-1`, kind: 'initial', provider: 'openrouter', startedAtMs: attempt * 100 });
        ledger.settlePhysical({ id, httpStatus: 503, settledAtMs: attempt * 100 + 1, usageEvidence: { usagePresent: true, costPresent: false, inputTokens: 1, outputTokens: 0, totalTokens: 1 } });
        const hash = supervisor.receipts.seal('one', attempt, { caseName: 'case', caseId: 'case', recoveredResets: 0, status: 'error', error: 'provider_failure', failureCallId: 'mc-1', runDir });
        expect(supervisor.recordCaseResets('one', attempt, hash, ledger)).toEqual({ total: 0, stop: false });
        expect(() => supervisor.seal('one', attempt, hash, supervisor.receipts.verify, yes, ledger)).toThrow('not gradable');
        supervisor.sealFailure('one', attempt, hash, { ledger, verifyReceipt: supervisor.receipts.verify, verifyFailure: yes, verifyRetry: yes });
        return hash;
      };
      supervisor.begin('one', { ledger, evidenceFiles: {}, verifyReceipt: supervisor.receipts.verify, verifyRetry: yes }); claim(supervisor, 'one', 1);
      const first = fail(1), probe = 'health/retry/physical-1';
      supervisor.db.prepare("UPDATE attempt SET state='sealed' WHERE slot_id='one' AND attempt_no=1").run();
      supervisor.db.prepare("INSERT INTO outcome VALUES('one','selected',1,?)").run(first);
      expect(() => supervisor.checkedOutcomes(supervisor.receipts.verify, yes, ledger)).toThrow('not gradable');
      supervisor.db.prepare("DELETE FROM outcome WHERE slot_id='one'").run();
      supervisor.db.prepare("UPDATE attempt SET state='infrastructure_failure' WHERE slot_id='one' AND attempt_no=1").run();
      ledger.reservePhysical({ id: probe, logicalId: 'health/retry', kind: 'health', provider: 'openrouter', healthBoundary: 'one', healthPurpose: 'retry', retryFor: 'one/attempt-01', failureReceiptSHA256: first, startedAtMs: 150 });
      ledger.settlePhysical({ id: probe, httpStatus: 200, providerCostMicros: 0, costConfirmed: true, settledAtMs: 151 });
      ledger.recordHealth({ physicalId: probe, outcome: 'clean', observedMs: 151, evidenceSHA256: digest('health') });
      supervisor.authorizeRetry('one', 1, digest('proof'), { ledger, retryProbeId: probe, verifyReceipt: supervisor.receipts.verify, verifyFailure: yes, verifyRetry: yes });
      supervisor.releaseDriver(driver); supervisor.close(); supervisor = new CampaignSupervisor(db, binding); driver = supervisor.claimDriver();
      supervisor.begin('one', { ledger, evidenceFiles: {}, verifyReceipt: supervisor.receipts.verify, verifyRetry: yes }); claim(supervisor, 'one', 2);
      const second = fail(2);
      expect(supervisor.db.prepare('SELECT state,receipt_sha256 FROM outcome').get()).toEqual({ state: 'excluded', receipt_sha256: second });
      supervisor.releaseDriver(driver); supervisor.close(); supervisor = new CampaignSupervisor(db, binding); driver = supervisor.claimDriver();
      expect(supervisor.checkedOutcomes(supervisor.receipts.verify, yes, ledger)).toHaveLength(1);
      expect(ledger.totals().starts).toBe(3); supervisor.releaseDriver(driver); supervisor.close(); ledger.close();
    } finally { for (const run of runs) makeWritable(run); rmSync(dir, { recursive: true, force: true }); }
  });
  it('rejects an obsolete supervisor schema with a clear error', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'eval-supervisor-schema-'));
    try {
      const file = path.join(dir, 'supervisor.db'), old = new DatabaseSync(file);
      old.exec('CREATE TABLE campaign(binding TEXT, schedule_sha256 TEXT)'); old.close();
      const scheduleBytes = Buffer.from(JSON.stringify({ slots: [{ id: 'one', boundaryId: 'one', provider: 'openrouter' }] }));
      expect(() => new CampaignSupervisor(file, { binding: 'b', scheduleBytes, scheduleSHA256: digest(scheduleBytes) })).toThrow('unsupported campaign supervisor schema');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('persists recovered resets across slots and restart for the same case', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'eval-supervisor-resets-'));
    const runs: string[] = [];
    try {
      const scheduleBytes = Buffer.from(JSON.stringify({ slots: ['one', 'two', 'three'].map((id) => ({ id, caseId: 'case', expectedPacketIds: ['packet'], boundaryId: id, provider: 'openrouter' })) }));
      const root = (slot: string, attempt: number) => path.join(dir, 'out', slot, `attempt-${attempt}`);
      const binding = { binding: 'b', scheduleBytes, scheduleSHA256: digest(scheduleBytes), receiptDirectory: path.join(dir, 'receipts'), runRootFor: root };
      const db = path.join(dir, 'supervisor.db');
      let supervisor = new CampaignSupervisor(db, binding);
      let driver = supervisor.claimDriver();
      const ledger = new CampaignLedger(path.join(dir, 'ledger.db'), { binding: 'b', limitMicros: 5_000_000 });
      ledger.keyDecision = () => ({ action: 'admit' }); ledger.healthDecision = () => ({ action: 'admit' });
      for (const [index, slot] of ['one', 'two', 'three'].entries()) {
        supervisor.begin(slot, { ledger, evidenceFiles: {}, verifyReceipt: supervisor.receipts.verify }); claim(supervisor, slot, 1);
        const runDir = path.join(root(slot, 1), 'run'), telemetry = path.join(runDir, 'telemetry'); mkdirSync(path.join(telemetry, 'stages/06-packets/packets'), { recursive: true }); runs.push(runDir);
        const prefix = `${slot}/attempt-01`, runId = `run-${slot}`;
        writeFileSync(path.join(telemetry, 'run.json'), JSON.stringify({ runId, outcome: { status: 'completed_full' } }));
        writeFileSync(path.join(telemetry, 'stages/06-packets/packets/packet.json'), JSON.stringify({ id: 'packet' }));
        writeFileSync(path.join(telemetry, 'telemetry.json'), JSON.stringify({ runId, events: 1, packets: { generated: 1 }, modelCalls: { totalRecords: 2 }, toolCalls: { totalCalls: 0 } }));
        writeFileSync(path.join(telemetry, 'events.jsonl'), JSON.stringify({ runId, eventId: 'ev', stage: 7, message: 'structured_submission_accepted', data: { packetId: 'packet' } }) + '\n');
        const common = { runId, stage: 7, kind: 'initial', workerId: 'worker', packetId: 'packet', structuredRequestId: 'request', cacheStatus: 'disabled' };
        writeFileSync(path.join(telemetry, 'model-calls.jsonl'), [JSON.stringify({ ...common, callId: 'failed', attempt: 1, status: 'transient_error' }), JSON.stringify({ ...common, callId: 'success', attempt: 2, status: 'ok', inputTokens: 1, outputTokens: 2, totalTokens: 3 })].join('\n') + '\n');
        for (const [call, success] of [['failed', false], ['success', true]] as const) {
          const id = `${prefix}/${call}/physical-1`; ledger.reservePhysical({ id, logicalId: `${prefix}/${call}`, kind: 'initial', provider: 'openrouter' });
          ledger.settlePhysical(success ? { id, httpStatus: 200, providerCostMicros: 1, costConfirmed: true, usageEvidence: { usagePresent: true, costPresent: true, inputTokens: 1, outputTokens: 2, totalTokens: 3 } } : { id, httpStatus: 200 });
        }
        const hash = supervisor.receipts.seal(slot, 1, { caseName: 'case', caseId: 'case', recoveredResets: 1, status: 'pass', runDir });
        expect(supervisor.recordCaseResets(slot, 1, hash, ledger)).toEqual({ total: index + 1, stop: index === 2 });
        expect(supervisor.recordCaseResets(slot, 1, hash, ledger)).toEqual({ total: index + 1, stop: index === 2 });
        if (index < 2) supervisor.seal(slot, 1, hash, supervisor.receipts.verify);
        else expect(() => supervisor.seal(slot, 1, hash, supervisor.receipts.verify)).toThrow('case reset accounting requires stop');
        supervisor.releaseDriver(driver); supervisor.close(); supervisor = new CampaignSupervisor(db, binding); driver = supervisor.claimDriver();
        expect(supervisor.caseResetCount('case')).toBe(index + 1);
      }
      expect(supervisor.db.prepare("SELECT COUNT(*) AS total FROM outcome").get()).toEqual({ total: 2 });
      supervisor.releaseDriver(driver); supervisor.close();
      expect(() => new CampaignSupervisor(db, { binding: binding.binding, scheduleBytes, scheduleSHA256: binding.scheduleSHA256 })).toThrow('binding mismatch');
      supervisor = new CampaignSupervisor(db, binding);
      expect(supervisor.db.prepare("SELECT COUNT(*) AS total FROM outcome").get()).toEqual({ total: 2 }); supervisor.close();
      ledger.close();
    } finally { for (const run of runs) makeWritable(run); rmSync(dir, { recursive: true, force: true }); }
  });
  it('creates the receipt store only on first binding and refuses its loss on restart', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'eval-supervisor-store-'));
    try {
      const scheduleBytes = Buffer.from(JSON.stringify({ slots: [{ id: 'one', boundaryId: 'one', provider: 'openrouter' }] }));
      const binding = { binding: 'b', scheduleBytes, scheduleSHA256: digest(scheduleBytes), configSHA256: digest('config'), receiptDirectory: path.join(dir, 'receipts'), runRootFor: () => path.join(dir, 'out') };
      const db = path.join(dir, 'supervisor.db');
      const supervisor = new CampaignSupervisor(db, binding);
      expect(supervisor.receipts.find('one', 1)).toBeNull(); supervisor.close();
      expect(() => new CampaignSupervisor(db, { ...binding, configSHA256: digest('changed') })).toThrow('binding mismatch');
      rmSync(binding.receiptDirectory, { recursive: true });
      expect(() => new CampaignSupervisor(db, binding)).toThrow();
      expect(() => new CampaignSupervisor(db, binding)).toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('pins macOS process-start formatting across parent time-zone changes', () => {
    const run = vi.fn((_file: string, _args: string[], options: { env: Record<string, string> }) => `${options.env.TZ}/${options.env.LC_ALL}`);
    try {
      vi.stubEnv('TZ', 'America/Toronto'); const first = processStart(123, { platform: 'darwin', run });
      vi.stubEnv('TZ', 'Pacific/Auckland'); const second = processStart(123, { platform: 'darwin', run });
      expect(first).toBe('UTC0/C'); expect(second).toBe(first); expect(run).toHaveBeenCalledTimes(2);
    } finally { vi.unstubAllEnvs(); }
  });
  it('revalidates the first failed receipt after a successful retry on restart', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'eval-supervisor-successful-retry-'));
    try {
      const bytes = Buffer.from(JSON.stringify({ slots: [{ id: 'one', boundaryId: 'one', provider: 'openrouter' }, { id: 'two', boundaryId: 'two', provider: 'openrouter' }] }));
      const binding = { binding: 'b', scheduleBytes: bytes, scheduleSHA256: digest(bytes) };
      let supervisor = new CampaignSupervisor(path.join(dir, 'supervisor.db'), binding);
      const realLedger = new CampaignLedger(path.join(dir, 'ledger.db'), { binding: 'b', limitMicros: 15_000_000 });
      const ledger = { db: realLedger.db, assertRestartSafe: () => realLedger.assertRestartSafe(), keyDecision: () => ({ action: 'admit' }), healthDecision: () => ({ action: 'admit' }) };
      const yes = () => true, first = digest('first'), proof = digest('proof'), args = { ledger, evidenceFiles: {}, verifyReceipt: yes, verifyRetry: yes };
      supervisor.begin('one', args);
      claim(supervisor, 'one', 1);
      prepareFailure(realLedger); prepareProbe(realLedger, 'retry-probe', 'retry', 200);
      supervisor.sealFailure('one', 1, first, { verifyReceipt: yes, verifyFailure: yes, verifyRetry: yes });
      supervisor.authorizeRetry('one', 1, proof, { ledger, retryProbeId: 'retry-probe', verifyReceipt: yes, verifyFailure: yes, verifyRetry: yes });
      supervisor.begin('one', args); claim(supervisor, 'one', 2); supervisor.seal('one', 2, digest('success'), yes, yes, ledger);
      supervisor.close(); supervisor = new CampaignSupervisor(path.join(dir, 'supervisor.db'), binding);
      realLedger.db.prepare('DELETE FROM health_receipt WHERE physical_id=?').run('retry-probe');
      expect(() => supervisor.begin('two', args)).toThrow('retry probe');
      expect(supervisor.db.prepare("SELECT COUNT(*) AS total FROM attempt WHERE slot_id='two'").get()).toEqual({ total: 0 });
      realLedger.recordHealth({ physicalId: 'retry-probe', outcome: 'clean', observedMs: 201, evidenceSHA256: digest('retry-probe') });
      expect(() => supervisor.begin('two', { ...args, verifyReceipt: (_slot: string, _attempt: number, hash: string) => hash !== first })).toThrow('retry authorization');
      expect(supervisor.db.prepare("SELECT COUNT(*) AS total FROM attempt WHERE slot_id='two'").get()).toEqual({ total: 0 });
      supervisor.close(); realLedger.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('excludes after an interrupted retry while retaining its physical hold', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'eval-supervisor-second-interrupt-'));
    try {
      const bytes = Buffer.from(JSON.stringify({ slots: [{ id: 'one', boundaryId: 'one', provider: 'openrouter' }] }));
      const supervisor = new CampaignSupervisor(path.join(dir, 'supervisor.db'), { binding: 'b', scheduleBytes: bytes, scheduleSHA256: digest(bytes) });
      const realLedger = new CampaignLedger(path.join(dir, 'ledger.db'), { binding: 'b', limitMicros: 15_000_000 });
      const ledger = { db: realLedger.db, assertRestartSafe: () => realLedger.assertRestartSafe(), keyDecision: () => ({ action: 'admit' }), healthDecision: () => ({ action: 'admit' }) };
      const yes = () => true, args = { ledger, evidenceFiles: {}, verifyReceipt: yes, verifyRetry: yes };
      supervisor.begin('one', args);
      claim(supervisor, 'one', 1);
      prepareFailure(realLedger); prepareProbe(realLedger, 'retry-probe', 'retry', 200);
      supervisor.sealFailure('one', 1, digest('first'), { verifyReceipt: yes, verifyFailure: yes, verifyRetry: yes });
      supervisor.authorizeRetry('one', 1, digest('proof'), { ledger, retryProbeId: 'retry-probe', verifyReceipt: yes, verifyFailure: yes, verifyRetry: yes });
      supervisor.begin('one', args);
      claim(supervisor, 'one', 2);
      realLedger.reservePhysical({ id: 'one/attempt-02/mc-1/physical-1', logicalId: 'one/attempt-02/mc-1', kind: 'initial', provider: 'openrouter' });
      supervisor.reconcile('one', 2, { ledger, verifyWorkerExited: yes, findTerminalReceipt: () => null, sealInterrupted: () => digest('second'), verifyReceipt: yes, verifyRetry: yes });
      expect(supervisor.db.prepare('SELECT state FROM outcome').get()).toEqual({ state: 'excluded' });
      expect(realLedger.totals()).toMatchObject({ starts: 3, open: 1, chargedMicros: 800_000 });
      expect(() => supervisor.begin('one', args)).toThrow('next unadmitted');
      supervisor.close(); realLedger.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('allows one authenticated retry and preserves both failures on exclusion', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'eval-supervisor-retry-'));
    try {
      const scheduleBytes = Buffer.from(JSON.stringify({ slots: [{ id: 'one', boundaryId: 'one', provider: 'openrouter', workerConfig: { supervisorPath: path.join(dir, 'supervisor.db'), ledgerBinding: 'b' } }, { id: 'paired', boundaryId: 'paired', provider: 'openrouter' }] }));
      const supervisor = new CampaignSupervisor(path.join(dir, 'supervisor.db'), { binding: 'b', scheduleBytes, scheduleSHA256: digest(scheduleBytes) });
      const realLedger = new CampaignLedger(path.join(dir, 'ledger.db'), { binding: 'b', limitMicros: 15_000_000 });
      const ledger = { db: realLedger.db, assertRestartSafe: () => realLedger.assertRestartSafe(), keyDecision: () => ({ action: 'admit' }), healthDecision: () => ({ action: 'admit' }) };
      const verifyReceipt = vi.fn(() => true), verifyFailure = vi.fn(() => true), verifyRetry = vi.fn(() => true);
      const args = { ledger, evidenceFiles: {}, verifyReceipt, verifyRetry }, first = digest('first'), second = digest('second'), proof = digest('proof');
      expect(supervisor.begin('one', args)).toMatchObject({ attempt: 1 });
      claim(supervisor, 'one', 1);
      prepareProbe(realLedger, 'old-probe', 'admission', 10); prepareProbe(realLedger, 'early-retry', 'retry', 20); prepareFailure(realLedger); prepareProbe(realLedger, 'retry-probe', 'retry', 200);
      supervisor.sealFailure('one', 1, first, { verifyReceipt, verifyFailure, verifyRetry });
      expect(() => supervisor.begin('one', args)).toThrow('retry authorization');
      expect(() => supervisor.authorizeRetry('one', 1, proof, { ledger, retryProbeId: 'old-probe', verifyReceipt, verifyFailure, verifyRetry })).toThrow('fresh clean');
      expect(() => supervisor.authorizeRetry('one', 1, proof, { ledger, retryProbeId: 'early-retry', verifyReceipt, verifyFailure, verifyRetry })).toThrow('fresh clean');
      expect(() => supervisor.authorizeRetry('one', 1, proof, { ledger, retryProbeId: 'retry-probe', verifyReceipt, verifyFailure, verifyRetry: async () => false })).toThrow('retry evidence');
      supervisor.authorizeRetry('one', 1, proof, { ledger, retryProbeId: 'retry-probe', verifyReceipt, verifyFailure, verifyRetry });
      expect(supervisor.begin('one', args)).toMatchObject({ attempt: 2, attemptPrefix: 'one/attempt-02' });
      claim(supervisor, 'one', 2);
      const config = Buffer.from(JSON.stringify({ attemptPrefix: 'one/attempt-02', supervisorPath: path.join(dir, 'supervisor.db'), ledgerBinding: 'b' }));
      expect(supervisor.verifyWorkerBinding('one', 2, config, digest(config))).toBe(true);
      const wrongConfig = Buffer.from(JSON.stringify({ attemptPrefix: 'one/attempt-01', supervisorPath: path.join(dir, 'supervisor.db'), ledgerBinding: 'b' }));
      expect(() => supervisor.verifyWorkerBinding('one', 2, wrongConfig, digest(wrongConfig))).toThrow('binding mismatch');
      supervisor.sealFailure('one', 2, second, { ledger, verifyReceipt, verifyFailure, verifyRetry });
      expect(supervisor.db.prepare('SELECT state FROM outcome WHERE slot_id=?').get('one')).toEqual({ state: 'excluded' });
      expect(supervisor.db.prepare('SELECT first_sha256,second_sha256 FROM exclusion WHERE slot_id=?').get('one')).toEqual({ first_sha256: first, second_sha256: second });
      expect(supervisor.begin('paired', args)).toMatchObject({ action: 'started' });
      supervisor.db.prepare('DELETE FROM retry_authorization WHERE slot_id=?').run('one');
      expect(() => supervisor.begin('paired', args)).toThrow('retry authorization');
      supervisor.close(); realLedger.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('seals a physically started interruption and preserves its hold without re-admission', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'eval-supervisor-interrupted-'));
    try {
      const scheduleBytes = Buffer.from(JSON.stringify({ slots: [{ id: 'one', boundaryId: 'one', provider: 'openrouter' }] }));
      const supervisor = new CampaignSupervisor(path.join(dir, 'supervisor.db'), { binding: 'b', scheduleBytes, scheduleSHA256: digest(scheduleBytes) });
      const ledger = new CampaignLedger(path.join(dir, 'ledger.db'), { binding: 'b', limitMicros: 15_000_000 });
      supervisor.db.prepare("INSERT INTO attempt VALUES('one',1,'started',NULL)").run();
      claim(supervisor, 'one', 1);
      ledger.reservePhysical({ id: 'one/attempt-01/mc-1/physical-1', logicalId: 'one/attempt-01/mc-1', kind: 'initial', provider: 'openrouter' });
      const receiptHash = digest('interrupted');
      const sealInterrupted = vi.fn(() => receiptHash), verifyReceipt = vi.fn(() => true);
      expect(supervisor.reconcile('one', 1, { ledger, verifyWorkerExited: () => true, findTerminalReceipt: () => null, sealInterrupted, verifyReceipt })).toEqual({ state: 'interrupted', receiptSHA256: receiptHash });
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
      const ledger = new CampaignLedger(path.join(dir, 'ledger.db'), { binding: 'b', limitMicros: 15_000_000 });
      const fingerprint = ledger.fingerprint('synthetic-key');
      const baselineHash = evidence({ kind: 'key_baseline', usageNanos: 0, fingerprint }), snapshotHash = evidence({ kind: 'key_snapshot', usageNanos: 0, observedMs: 1, fingerprint, boundaryId: 'one' });
      const healthHash = evidence({ kind: 'health', purpose: 'admission', physicalId: 'health', boundaryId: 'one', provider: 'openrouter', outcome: 'clean', observedMs: 1 });
      ledger.bindKeyBaseline({ usageMicros: 0, keyFingerprint: fingerprint, evidenceSHA256: baselineHash });
      ledger.recordKeySnapshot({ boundaryId: 'one', usageMicros: 0, observedMs: 1, keyFingerprint: fingerprint, evidenceSHA256: snapshotHash });
      const scheduleBytes = Buffer.from(JSON.stringify({ pauseAfterSlot: 'one', slots: [{ id: 'one', boundaryId: 'one', provider: 'openrouter' }, { id: 'two', boundaryId: 'two', provider: 'openrouter' }] }));
      const binding = { binding: 'b', scheduleBytes, scheduleSHA256: digest(scheduleBytes) };
      let supervisor = new CampaignSupervisor(file, binding);
      const verifyReceipt = vi.fn(() => true), args = { ledger, evidenceFiles, nowMs: 2, verifyReceipt };
      expect(supervisor.nextSlot(verifyReceipt, undefined, ledger)).toMatchObject({ action: 'next', slot: { id: 'one' } });
      expect(supervisor.begin('one', args)).toMatchObject({ action: 'probe' });
      ledger.reservePhysical({ id: 'health', logicalId: 'health', kind: 'health', provider: 'openrouter', healthBoundary: 'one' });
      ledger.settlePhysical({ id: 'health', httpStatus: 200, providerCostMicros: 0, costConfirmed: true });
      ledger.recordHealth({ physicalId: 'health', outcome: 'clean', observedMs: 1, evidenceSHA256: healthHash });
      expect(supervisor.begin('one', args)).toMatchObject({ action: 'started' });
      expect(supervisor.nextSlot(verifyReceipt, undefined, ledger)).toMatchObject({ action: 'reconcile', slot_id: 'one' });
      supervisor.close(); supervisor = new CampaignSupervisor(file, binding);
      expect(() => supervisor.begin('one', args)).toThrow('requires reconciliation');
      expect(() => supervisor.reconcile('one', 1, { ledger, verifyWorkerExited: () => false })).toThrow('worker exit');
      expect(() => supervisor.reconcile('one', 1, { ledger, verifyWorkerExited: async () => false })).toThrow('worker exit');
      expect(() => supervisor.reconcile('one', 1, { ledger, verifyWorkerExited: () => true, findTerminalReceipt: () => ({}) })).toThrow('terminal receipt');
      expect(supervisor.reconcile('one', 1, { ledger, verifyWorkerExited: () => true, findTerminalReceipt: () => null })).toEqual({ state: 'no_start' });
      expect(supervisor.noStartCount('one')).toBe(1);
      expect(supervisor.begin('one', args)).toMatchObject({ action: 'started', attempt: 2, attemptPrefix: 'one/attempt-02' });
      claim(supervisor, 'one', 2);
      expect(() => supervisor.seal('one', 2, digest('receipt'), async () => false)).toThrow('receipt');
      expect(() => supervisor.begin('one', args)).toThrow('requires reconciliation');
      supervisor.seal('one', 2, digest('receipt'), verifyReceipt);
      expect(() => supervisor.begin('two', { ...args, verifyReceipt: async () => false })).toThrow('receipt');
      expect(supervisor.begin('two', args)).toMatchObject({ action: 'paused' });
      expect(supervisor.nextSlot(verifyReceipt, undefined, ledger)).toEqual({ action: 'paused' });
      supervisor.releaseCheckpoint(verifyReceipt);
      expect(supervisor.nextSlot(verifyReceipt, undefined, ledger)).toMatchObject({ action: 'next', slot: { id: 'two' } });
      supervisor.db.prepare('UPDATE outcome SET receipt_sha256=? WHERE slot_id=?').run(digest('changed'), 'one');
      supervisor.db.prepare('UPDATE attempt SET receipt_sha256=? WHERE slot_id=? AND attempt_no=2').run(digest('changed'), 'one');
      expect(supervisor.begin('two', args)).toMatchObject({ action: 'paused' });
      supervisor.db.prepare('UPDATE outcome SET receipt_sha256=? WHERE slot_id=?').run(digest('receipt'), 'one');
      supervisor.db.prepare('UPDATE attempt SET receipt_sha256=? WHERE slot_id=? AND attempt_no=2').run(digest('receipt'), 'one');
      expect(supervisor.begin('two', args)).toMatchObject({ action: 'snapshot' });
      expect(verifyReceipt).toHaveBeenCalledWith('one', 2, digest('receipt'));
      supervisor.close();
      const changed = Buffer.from(scheduleBytes.toString().replace('two', 'new'));
      expect(() => new CampaignSupervisor(file, { ...binding, scheduleBytes: changed, scheduleSHA256: digest(changed) })).toThrow('binding mismatch');
      ledger.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
