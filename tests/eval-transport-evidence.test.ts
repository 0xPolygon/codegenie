import { describe, expect, it } from 'vitest';
// @ts-expect-error Development-only ESM has no emitted types.
import { validateTransportEvidence } from '../evals/runner/transport-evidence.mjs';

const prefix = 'capture-case/attempt-01';
const ledger = { reserve: 400_000, db: { prepare: () => ({ get: () => undefined }) } };
const usage = { usagePresent: true, costPresent: true, inputTokens: 10, outputTokens: 5, totalTokens: 15 };
const call = (callId: string, status: string, attempt: number) => ({ stage: 5, callId, structuredRequestId: 'request', kind: 'initial', workerId: 'planner', attempt,
  cacheStatus: 'disabled', status, inputTokens: 10, outputTokens: 5, totalTokens: 15 });
const priced = (callId: string) => ({ id: `${prefix}/${callId}/physical-1`, logical_id: `${prefix}/${callId}`, state: 'priced', charge: 10,
  http_status: 200, stream_terminal: 'done', evidence_json: JSON.stringify(usage) });
const accepted = { stage: 5, message: 'structured_submission_accepted', data: { structuredRequestId: 'request' } };
const check = (models: object[], physical: object[], events: object[] = [], priorRecoveredResets = 0) =>
  validateTransportEvidence({ models, physical, events, ledger, attemptPrefix: prefix, acceptance: 'structured-request', priorRecoveredResets });

describe('shared campaign transport evidence', () => {
  it('accepts fully accounted schema-invalid planner calls followed by recovery or fallback', () => {
    const invalid = call('invalid', 'schema_invalid', 1), recovered = call('recovered', 'ok', 2);
    expect(check([invalid, recovered], [priced('invalid'), priced('recovered')], [accepted])).toEqual({ recoveredResets: 0 });
    expect(check([invalid], [priced('invalid')], [{ stage: 5, message: 'planner fallback used' }])).toEqual({ recoveredResets: 0 });
    expect(() => check([invalid], [{ ...priced('invalid'), evidence_json: null }])).toThrow('physical usage missing');
  });

  it('checks usage on nonfinal physical starts as well as the last start', () => {
    const first = priced('one'), second = { ...priced('one'), id: `${prefix}/one/physical-2` };
    expect(check([call('one', 'ok', 1)], [first, second])).toEqual({ recoveredResets: 0 });
    expect(() => check([call('one', 'ok', 1)], [{ ...first, evidence_json: null }, second])).toThrow('physical usage missing');
  });

  it('requires the correct Stage 5 accepted request for a recovered held body reset', () => {
    const failed = { ...call('failed', 'transient_error', 1), inputTokens: undefined, outputTokens: undefined, totalTokens: undefined };
    const recovered = call('recovered', 'ok', 2);
    const held = { ...priced('failed'), state: 'unknown', charge: 400_000, stream_terminal: 'body_reset', evidence_json: null };
    const physical = [held, priced('recovered')];
    expect(check([failed, recovered], physical, [accepted])).toEqual({ recoveredResets: 1 });
    expect(() => check([failed, recovered], physical)).toThrow('model usage missing');
    expect(() => check([failed, recovered], physical, [{ ...accepted, data: { structuredRequestId: 'other' } }])).toThrow('model usage missing');
    expect(() => check([failed, { ...recovered, attempt: 3 }], physical, [accepted])).toThrow('model usage missing');
    expect(() => check([failed, recovered], physical, [accepted], 2)).toThrow('too many recovered');
  });

  it('retains the existing typed local-abort rule for capture without inventing a retry', () => {
    const limit = { trigger: 'whitespace_run', limitChars: 4096, observedChars: 4097, toolArgumentChars: 4097, contentIndex: 0 };
    const aborted = { ...call('aborted', 'aborted', 1), inputTokens: undefined, outputTokens: undefined, totalTokens: undefined,
      errorCode: 'llm_call_failed', retryReason: 'tool_argument_stream_limit', toolArgumentStreamLimit: limit };
    const held = { ...priced('aborted'), state: 'unknown', charge: 400_000, stream_terminal: 'local_cancel', evidence_json: null };
    const event = { stage: 5, message: 'model_tool_argument_stream_limit', data: { callId: 'aborted', structuredRequestId: 'request', ...limit } };
    expect(check([aborted], [held], [event])).toEqual({ recoveredResets: 0 });
    expect(() => check([aborted], [held])).toThrow('model usage missing');
  });
});
