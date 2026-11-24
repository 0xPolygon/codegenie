import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error Development-only ESM has no emitted types.
import { CampaignLedger } from '../evals/runner/ledger.mjs';
// @ts-expect-error Development-only ESM has no emitted types.
import { listEvidenceFiles, prepareAdmission } from '../evals/runner/admission.mjs';

const expected = { api: 'openai-completions', destination: 'https://openrouter.ai/api/v1/chat/completions', provider: 'openrouter', modelId: 'openai/gpt-6-luna', reasoningSelected: 'high', templateVersion: 'campaign-health.1', wireEffort: 'high' };
function response() {
  const base = { id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'openai/gpt-6-luna' };
  const chunks = [
    { ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'submit_plan', arguments: '{"ok":true}' } }] }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.0001, is_byok: false } }
  ];
  return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
}
describe('campaign boundary preparation', () => {
  it('stops before auth or GET when a prior meter reader is still unresolved', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'eval-admission-pending-'));
    try {
      const ledger = new CampaignLedger(path.join(dir, 'ledger'), { binding: 'campaign', limitMicros: 2_000_000 });
      ledger.beginMeterPoll('one', Date.now());
      const getAuth = vi.fn(), fetchImpl = vi.fn();
      const result = await prepareAdmission({ ledger, boundaryId: 'one', receiptDirectory: path.join(dir, 'receipts'), attemptPrefix: 'health/one', expected,
        llmConfig: { provider: 'openrouter', model: 'openai/gpt-6-luna', reasoning: 'high', maxConcurrentCalls: 1 }, fetchImpl, models: { getAuth } });
      expect(result).toEqual({ action: 'reconcile' }); expect(getAuth).not.toHaveBeenCalled(); expect(fetchImpl).not.toHaveBeenCalled(); ledger.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('bounds stale key reads across restart and reports their count', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'eval-admission-stale-'));
    let now = 1000; const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const db = path.join(dir, 'ledger'), config = { binding: 'campaign', limitMicros: 2_000_000 };
      let ledger = new CampaignLedger(db, config);
      const fetchImpl = vi.fn(async () => new Response('unavailable', { status: 503 }));
      const args = { boundaryId: 'one', receiptDirectory: path.join(dir, 'receipts'), attemptPrefix: 'health/one', expected,
        llmConfig: { provider: 'openrouter', model: 'openai/gpt-6-luna', reasoning: 'high', maxConcurrentCalls: 1 }, fetchImpl,
        models: { getAuth: async () => ({ auth: { apiKey: 'synthetic-key' } }) } };
      for (let attempt = 1; attempt <= 20; attempt++) {
        const result = await prepareAdmission({ ...args, ledger });
        expect(result.action).toBe(attempt === 20 ? 'stop' : 'wait');
        expect(ledger.meterPollCount('one')).toBe(attempt);
        if (attempt === 1) { ledger.close(); ledger = new CampaignLedger(db, config); }
        if (attempt < 20) { expect((await prepareAdmission({ ...args, ledger })).action).toBe('wait'); expect(fetchImpl).toHaveBeenCalledTimes(attempt); now += 15_000; }
      }
      expect(ledger.totals().stopped).toBe('meter_stale');
      expect((await prepareAdmission({ ...args, ledger })).action).toBe('stop'); expect(fetchImpl).toHaveBeenCalledTimes(20); ledger.close();
    } finally { clock.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
  });
  it('reuses the bound post-failure retry probe after restart', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'eval-admission-retry-'));
    vi.stubEnv('OPENROUTER_API_KEY', 'synthetic-key'); vi.stubEnv('CODEGENIE_HOME', path.join(dir, 'home'));
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('unexpected network'); }));
    try {
      const db = path.join(dir, 'ledger'), config = { binding: 'campaign', limitMicros: 2_000_000 };
      let ledger = new CampaignLedger(db, config), gets = 0, posts = 0;
      const fetchImpl = vi.fn(async (input: string) => {
        if (String(input) === 'https://openrouter.ai/api/v1/key') { gets++; return new Response(`{"data":{"usage":${gets === 1 ? 0 : gets === 2 ? 0.0001 : 0.0002}}}`); }
        posts++; return response();
      });
      const models = { getAuth: async () => ({ auth: { apiKey: 'synthetic-key' } }) };
      const common = { boundaryId: 'one', receiptDirectory: path.join(dir, 'receipts'), expected,
        llmConfig: { provider: 'openrouter', model: 'openai/gpt-6-luna', reasoning: 'high', maxConcurrentCalls: 1 }, fetchImpl, models };
      const admission = { ...common, ledger, attemptPrefix: 'health/admission', purpose: 'admission' };
      expect(await prepareAdmission(admission)).toMatchObject({ status: 'clean' });
      expect(await prepareAdmission(admission)).toMatchObject({ action: 'admit' });
      ledger.reservePhysical({ id: 'one/attempt-01/mc-1/physical-1', logicalId: 'one/attempt-01/mc-1', kind: 'initial', provider: 'openrouter', startedAtMs: 1 });
      ledger.settlePhysical({ id: 'one/attempt-01/mc-1/physical-1', httpStatus: 500, settledAtMs: 2 });
      const retry = { ...common, ledger, attemptPrefix: 'health/retry', purpose: 'retry', retryFor: 'one/attempt-01', failureReceiptSHA256: 'f'.repeat(64) };
      const original = await prepareAdmission(retry);
      expect(original).toMatchObject({ status: 'clean' }); expect(posts).toBe(2);
      ledger.close(); ledger = new CampaignLedger(db, config);
      const recovered = await prepareAdmission({ ...retry, ledger });
      expect(recovered).toMatchObject({ status: 'clean', physicalId: original.physicalId, receiptSHA256: original.receiptSHA256, reused: true });
      expect({ gets, posts }).toEqual({ gets: 3, posts: 2 }); ledger.close();
    } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); }
  }, 90_000);
  it('does not repeat a denied key GET on re-entry', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'eval-admission-denied-'));
    try {
      const ledger = new CampaignLedger(path.join(dir, 'ledger'), { binding: 'campaign', limitMicros: 2_000_000 });
      const fetchImpl = vi.fn(async () => new Response('denied', { status: 401 }));
      const args = { ledger, boundaryId: 'one', receiptDirectory: path.join(dir, 'receipts'), attemptPrefix: 'health/one', expected,
        llmConfig: { provider: 'openrouter', model: 'openai/gpt-6-luna', reasoning: 'high', maxConcurrentCalls: 1 }, fetchImpl,
        models: { getAuth: async () => ({ auth: { apiKey: 'synthetic-key' } }) } };
      expect(await prepareAdmission(args)).toEqual({ action: 'stop' });
      expect(await prepareAdmission(args)).toEqual({ action: 'stop', reason: 'provider_401' });
      expect(fetchImpl).toHaveBeenCalledTimes(1); expect(ledger.totals().starts).toBe(0); ledger.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it.each(['key-drift', 'stale-meter'])('stops before a model POST on %s', async (scenario) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'eval-admission-deny-'));
    vi.stubEnv('OPENROUTER_API_KEY', 'key-b'); vi.stubEnv('CODEGENIE_HOME', path.join(dir, 'home'));
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('unexpected network'); }));
    try {
      const ledger = new CampaignLedger(path.join(dir, 'ledger'), { binding: 'campaign', limitMicros: 2_000_000 });
      let posts = 0;
      const fetchImpl = vi.fn(async (input: string) => {
        if (String(input) === 'https://openrouter.ai/api/v1/key') return scenario === 'stale-meter' ? new Response('unavailable', { status: 503 }) : new Response('{"data":{"usage":0}}');
        posts++; return response();
      });
      const result = await prepareAdmission({ ledger, boundaryId: 'one', receiptDirectory: path.join(dir, 'receipts'), attemptPrefix: 'health/one', purpose: 'admission', expected,
        llmConfig: { provider: 'openrouter', model: 'openai/gpt-6-luna', reasoning: 'high', maxConcurrentCalls: 1 }, fetchImpl,
        models: { getAuth: async () => ({ auth: { apiKey: 'key-a' } }) } });
      expect(posts).toBe(0); expect(ledger.totals().starts).toBe(0);
      if (scenario === 'key-drift') { expect(result).toEqual({ status: 'failed' }); expect(ledger.totals().stopped).toBe('binding_mismatch'); }
      else { expect(result).toMatchObject({ action: 'wait' }); expect(ledger.totals().stopped).toBeNull(); }
      ledger.close();
    } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); }
  }, 90_000);
  it('uses sanitized key and native health evidence, then reuses it at the same boundary', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'eval-admission-'));
    vi.stubEnv('OPENROUTER_API_KEY', 'synthetic-key'); vi.stubEnv('CODEGENIE_HOME', path.join(dir, 'home'));
    const globalFetch = vi.fn(async () => { throw new Error('unexpected network'); }); vi.stubGlobal('fetch', globalFetch);
    try {
      let ledger = new CampaignLedger(path.join(dir, 'ledger'), { binding: 'campaign', limitMicros: 2_000_000 });
      let gets = 0, posts = 0;
      const fetchImpl = vi.fn(async (input: string) => {
        if (String(input) === 'https://openrouter.ai/api/v1/key') { gets++; return new Response(`{"data":{"usage":${gets === 1 ? 0 : gets <= 3 ? 0.0001 : 0.0002}}}`); }
        posts++; return response();
      });
      const models = { getAuth: async () => ({ auth: { apiKey: 'synthetic-key' } }) };
      const args = { ledger, boundaryId: 'one', receiptDirectory: path.join(dir, 'receipts'), attemptPrefix: 'health/one', purpose: 'admission', expected,
        llmConfig: { provider: 'openrouter', model: 'openai/gpt-6-luna', reasoning: 'high', maxConcurrentCalls: 1 }, fetchImpl, models };
      expect(await prepareAdmission(args)).toMatchObject({ status: 'clean' });
      expect(await prepareAdmission(args)).toMatchObject({ action: 'admit' });
      expect(await prepareAdmission(args)).toMatchObject({ action: 'admit' });
      expect({ gets, posts }).toEqual({ gets: 2, posts: 1 }); expect(globalFetch).not.toHaveBeenCalled();
      for (const file of readdirSync(args.receiptDirectory)) expect(readFileSync(path.join(args.receiptDirectory, file), 'utf8')).not.toContain('synthetic-key');
      expect(Object.keys(listEvidenceFiles(args.receiptDirectory)).length).toBeGreaterThan(0);
      symlinkSync(path.join(dir, 'missing'), path.join(args.receiptDirectory, 'f'.repeat(64)));
      expect(() => listEvidenceFiles(args.receiptDirectory)).toThrow('invalid evidence');
      rmSync(path.join(args.receiptDirectory, 'f'.repeat(64)));
      expect(await prepareAdmission({ ...args, boundaryId: 'two', attemptPrefix: 'health/two' })).toMatchObject({ status: 'clean' });
      expect({ gets, posts }).toEqual({ gets: 3, posts: 2 });
      const final = { ...args, ledger, boundaryId: 'final', attemptPrefix: 'health/final', keyOnly: true };
      expect(await prepareAdmission(final)).toMatchObject({ action: 'admit' });
      expect({ gets, posts }).toEqual({ gets: 4, posts: 2 }); ledger.close();
      ledger = new CampaignLedger(path.join(dir, 'ledger'), { binding: 'campaign', limitMicros: 2_000_000 });
      expect(await prepareAdmission({ ...final, ledger })).toMatchObject({ action: 'admit' });
      expect({ gets, posts }).toEqual({ gets: 4, posts: 2 }); ledger.close();
    } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); }
  }, 90_000);
});
