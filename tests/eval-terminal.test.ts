import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error Development-only ESM has no emitted types.
import { CampaignLedger } from '../evals/runner/ledger.mjs';
// @ts-expect-error Development-only ESM has no emitted types.
import { validateTerminal } from '../evals/runner/terminal.mjs';

function fixture(dir: string) {
  const telemetry = path.join(dir, 'telemetry');
  mkdirSync(path.join(telemetry, 'stages/06-packets/packets'), { recursive: true });
  const runId = 'run-1', prefix = 'one/attempt-01';
  const events: Array<Record<string, unknown>> = [{ runId, eventId: 'ev-1', stage: 7, message: 'structured_submission_accepted', data: { packetId: 'packet' } }];
  const models: Array<Record<string, unknown>> = [{ runId, callId: 'mc-1', stage: 7, cacheStatus: 'disabled', status: 'ok', inputTokens: 1, outputTokens: 2, totalTokens: 3 }];
  const tools: Array<Record<string, unknown>> = [{ runId, toolCallId: 'tc-1', status: 'error', errorCode: 'invalid_args' }];
  writeFileSync(path.join(telemetry, 'run.json'), JSON.stringify({ runId, outcome: { status: 'completed_full' } }));
  writeFileSync(path.join(telemetry, 'stages/06-packets/packets/packet.json'), JSON.stringify({ id: 'packet' }));
  const ledger = new CampaignLedger(path.join(dir, 'ledger.sqlite'), { binding: 'b', limitMicros: 2_000_000 });
  ledger.reservePhysical({ id: `${prefix}/mc-1/physical-1`, logicalId: `${prefix}/mc-1`, kind: 'initial', provider: 'openrouter' });
  ledger.settlePhysical({ id: `${prefix}/mc-1/physical-1`, httpStatus: 200, providerCostMicros: 1, costConfirmed: true,
    usageEvidence: { usagePresent: true, costPresent: true, inputTokens: 1, outputTokens: 2, totalTokens: 3 } });
  const save = () => {
    writeFileSync(path.join(telemetry, 'telemetry.json'), JSON.stringify({ runId, events: events.length, packets: { generated: 1 }, modelCalls: { totalRecords: models.length }, toolCalls: { totalCalls: tools.length } }));
    for (const [name, rows] of [['events', events], ['model-calls', models], ['tool-calls', tools]] as const) writeFileSync(path.join(telemetry, `${name}.jsonl`), rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''));
  };
  return { events, models, tools, ledger, prefix, save, check: (priorRecoveredResets = 0) => validateTerminal({ runDir: dir, attemptPrefix: prefix, ledger, expectedPacketIds: ['packet'], priorRecoveredResets }) };
}

describe('campaign terminal evidence', () => {
  it('requires each packet submit and accounts typed tool errors without stopping', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'eval-terminal-'));
    const f = fixture(dir);
    try {
      f.save(); expect(f.check()).toMatchObject({ packets: 1, physicalStarts: 1 });
      f.tools[0]!.errorCode = 'budget_exhausted'; f.save(); expect(f.check()).toMatchObject({ packets: 1 });
      f.tools[0]!.errorCode = 'unavailable'; f.save(); expect(f.check()).toMatchObject({ packets: 1 });
      rmSync(path.join(dir, 'telemetry/stages/06-packets/packets/packet.json'));
      expect(() => f.check()).toThrow('packet inventory');
      writeFileSync(path.join(dir, 'telemetry/stages/06-packets/packets/packet.json'), JSON.stringify({ id: 'packet' }));
      f.models[0]!.outputTokens = 20; f.models[0]!.totalTokens = 21; f.save();
      expect(() => f.check()).toThrow('usage differ');
      f.models[0]!.outputTokens = 2; f.models[0]!.totalTokens = 3;
      f.tools[0]!.errorCode = 'timeout'; f.save(); expect(() => f.check()).toThrow('tool failure');
      f.tools[0]!.errorCode = 'invalid_args'; f.events.length = 0; f.save(); expect(() => f.check()).toThrow('packet submit missing');
    } finally { f.ledger.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  it('stops on missing telemetry or usage and permits only a linked typed harness abort', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'eval-terminal-usage-'));
    const f = fixture(dir);
    try {
      f.save(); writeFileSync(path.join(dir, 'telemetry/tool-calls.jsonl'), ''); expect(() => f.check()).toThrow('row count');
      f.models[0]!.totalTokens = undefined; f.save(); expect(() => f.check()).toThrow('model usage');
      const limit = { trigger: 'whitespace_run', limitChars: 4096, observedChars: 4097, toolArgumentChars: 4097, contentIndex: 0 };
      Object.assign(f.models[0]!, { status: 'aborted', errorCode: 'llm_call_failed', retryReason: 'tool_argument_stream_limit', toolArgumentStreamLimit: limit });
      f.ledger.db.prepare("UPDATE physical SET state='unknown',charge=400000,evidence_json=NULL WHERE logical_id=?").run(`${f.prefix}/mc-1`);
      f.events.push({ runId: 'run-1', eventId: 'ev-2', stage: 7, message: 'model_tool_argument_stream_limit', data: { callId: 'mc-1', ...limit } });
      f.save(); expect(f.check()).toMatchObject({ modelCalls: 1 });
      f.ledger.db.prepare("UPDATE physical SET charge=0 WHERE logical_id=?").run(`${f.prefix}/mc-1`);
      expect(() => f.check()).toThrow('model usage');
      f.ledger.db.prepare("UPDATE physical SET charge=400000 WHERE logical_id=?").run(`${f.prefix}/mc-1`);
      f.models[0]!.packetId = 'packet'; f.models[0]!.structuredRequestId = 'request';
      f.save(); expect(() => f.check()).toThrow('model usage');
      f.events[1]!.data = { callId: 'mc-1', packetId: 'packet', structuredRequestId: 'request', ...limit };
      f.save(); expect(f.check()).toMatchObject({ modelCalls: 1 });
      f.events[1]!.data = { callId: 'other' }; f.save(); expect(() => f.check()).toThrow('model usage');
    } finally { f.ledger.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  it('accepts a recovered held stream reset, but stops on failed retry or three resets', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'eval-terminal-reset-'));
    const f = fixture(dir);
    try {
      f.models.length = 0;
      f.ledger.db.prepare('DELETE FROM physical').run();
      const addReset = (index: number) => {
        const request = `request-${index}`, failed = `reset-${index}`, good = `success-${index}`;
        f.models.push({ runId: 'run-1', stage: 7, kind: 'initial', workerId: 'worker', packetId: 'packet', structuredRequestId: request, attempt: 1, callId: failed, cacheStatus: 'disabled', status: 'transient_error' });
        f.models.push({ runId: 'run-1', stage: 7, kind: 'initial', workerId: 'worker', packetId: 'packet', structuredRequestId: request, attempt: 2, callId: good, cacheStatus: 'disabled', status: 'ok', inputTokens: 1, outputTokens: 2, totalTokens: 3 });
        for (const [call, success] of [[failed, false], [good, true]] as const) {
          const id = `${f.prefix}/${call}/physical-1`;
          f.ledger.reservePhysical({ id, logicalId: `${f.prefix}/${call}`, kind: 'initial', provider: 'openrouter' });
          f.ledger.settlePhysical(success ? { id, httpStatus: 200, providerCostMicros: 1, costConfirmed: true, usageEvidence: { usagePresent: true, costPresent: true, inputTokens: 1, outputTokens: 2, totalTokens: 3 } } : { id, httpStatus: 200 });
        }
      };
      addReset(1); f.save(); expect(f.check()).toMatchObject({ recoveredResets: 1 });
      expect(() => f.check(2)).toThrow('too many recovered');
      f.models.splice(1, 0, { runId: 'run-1', stage: 7, kind: 'repair', workerId: 'worker', packetId: 'packet', structuredRequestId: 'request-1', attempt: 1, callId: 'intervening', cacheStatus: 'disabled', status: 'ok', inputTokens: 1, outputTokens: 2, totalTokens: 3 });
      const intervening = `${f.prefix}/intervening/physical-1`;
      f.ledger.reservePhysical({ id: intervening, logicalId: `${f.prefix}/intervening`, kind: 'repair', provider: 'openrouter' });
      f.ledger.settlePhysical({ id: intervening, httpStatus: 200, providerCostMicros: 1, costConfirmed: true, usageEvidence: { usagePresent: true, costPresent: true, inputTokens: 1, outputTokens: 2, totalTokens: 3 } });
      f.save(); expect(() => f.check()).toThrow('model usage missing');
      f.models.splice(1, 1); f.ledger.db.prepare('DELETE FROM physical WHERE id=?').run(intervening); f.save();
      const successRow = f.ledger.db.prepare('SELECT * FROM physical WHERE logical_id=?').get(`${f.prefix}/success-1`);
      f.ledger.db.prepare("UPDATE physical SET http_status=503,state='unknown',charge=400000,evidence_json=NULL WHERE logical_id=?").run(`${f.prefix}/success-1`);
      expect(() => f.check()).toThrow('model usage missing');
      f.ledger.db.prepare('UPDATE physical SET http_status=?,state=?,charge=?,evidence_json=? WHERE logical_id=?').run(successRow.http_status, successRow.state, successRow.charge, successRow.evidence_json, `${f.prefix}/success-1`);
      f.models[1]!.status = 'transient_error'; f.save(); expect(() => f.check()).toThrow('model usage missing');
      f.models[1]!.status = 'ok'; addReset(2); f.save(); expect(f.check()).toMatchObject({ recoveredResets: 2 });
      addReset(3); f.save(); expect(() => f.check()).toThrow('too many recovered');
    } finally { f.ledger.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
