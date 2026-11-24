import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error Development-only ESM has no emitted types.
import { CampaignLedger } from '../evals/runner/ledger.mjs';
// @ts-expect-error Development-only ESM has no emitted types.
import { runHealthProbe } from '../evals/runner/health.mjs';

const expected = { api: 'openai-completions', destination: 'https://openrouter.ai/api/v1/chat/completions', provider: 'openrouter', modelId: 'openai/gpt-6-luna', reasoningSelected: 'high', templateVersion: 'campaign-health.1', wireEffort: 'high' };
function response(usage: object = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.0001, is_byok: false }) {
  const base = { id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'openai/gpt-6-luna' };
  const chunks = [
    { ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'submit_plan', arguments: '{"ok":true}' } }] }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage }
  ];
  return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
describe('native campaign health probe', () => {
  it('classifies a typed HTTP-200 peak-load failure as capacity', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'eval-health-peak-'));
    vi.stubEnv('OPENROUTER_API_KEY', 'synthetic-key'); vi.stubEnv('CODEGENIE_HOME', path.join(dir, 'home'));
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('unexpected network'); }));
    try {
      const ledger = new CampaignLedger(path.join(dir, 'ledger'), { binding: 'health', limitMicros: 2_000_000 });
      const keyFingerprint = ledger.fingerprint('synthetic-key');
      ledger.bindKeyBaseline({ usageMicros: 0, keyFingerprint, evidenceSHA256: 'a'.repeat(64) });
      ledger.recordKeySnapshot({ boundaryId: 'boundary', usageMicros: 0, observedMs: 0, keyFingerprint, evidenceSHA256: 'b'.repeat(64) });
      const event = { error: { message: 'The request exceeds the maximum usage size allowed during peak load.', code: 500 } };
      const fetchImpl = vi.fn(async () => new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } }));
      const result = await runHealthProbe({ ledger, boundaryId: 'boundary', purpose: 'admission', attemptPrefix: 'health/attempt-01', expected,
        llmConfig: { provider: 'openrouter', model: 'openai/gpt-6-luna', reasoning: 'high', maxConcurrentCalls: 1 }, fetchImpl, sealReceipt: () => true });
      expect(result).toMatchObject({ status: 'capacity' }); expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(ledger.totals()).toMatchObject({ starts: 1, unknown: 1, chargedMicros: 400_000 }); ledger.close();
    } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); }
  }, 90_000);
  it.each(['no-submit', 'timeout'])('latches a %s health failure without a second POST', async (failure) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'eval-health-failure-'));
    vi.stubEnv('OPENROUTER_API_KEY', 'synthetic-key'); vi.stubEnv('CODEGENIE_HOME', path.join(dir, 'home'));
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('unexpected network'); }));
    try {
      const ledger = new CampaignLedger(path.join(dir, 'ledger'), { binding: 'health', limitMicros: 2_000_000 });
      const keyFingerprint = ledger.fingerprint('synthetic-key');
      ledger.bindKeyBaseline({ usageMicros: 0, keyFingerprint, evidenceSHA256: 'a'.repeat(64) });
      ledger.recordKeySnapshot({ boundaryId: 'boundary', usageMicros: 0, observedMs: 0, keyFingerprint, evidenceSHA256: 'b'.repeat(64) });
      const fetchImpl = vi.fn(async () => {
        if (failure === 'timeout') { const error = new Error('synthetic timeout'); error.name = 'TimeoutError'; throw error; }
        const chunk = { id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'openai/gpt-6-luna', choices: [{ index: 0, delta: { role: 'assistant', content: 'no submit' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0, is_byok: false } };
        return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
      });
      const result = await runHealthProbe({ ledger, boundaryId: 'boundary', purpose: 'admission', attemptPrefix: 'health/attempt-01', expected,
        llmConfig: { provider: 'openrouter', model: 'openai/gpt-6-luna', reasoning: 'high', maxConcurrentCalls: 1 }, fetchImpl, sealReceipt: () => true });
      expect(result).toEqual({ status: 'failed' }); expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(ledger.totals()).toMatchObject({ starts: 1, stopped: 'health_failed' });
      if (failure === 'no-submit') expect(ledger.db.prepare("SELECT COUNT(*) AS total FROM local_refusal WHERE reason='health_single_start'").get().total).toBeGreaterThan(0);
      ledger.close();
    } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); }
  }, 90_000);
  it.each([{}, { prompt_tokens: 1, completion_tokens: 2 }])('rejects an empty or partial provider usage block', async (usage) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'eval-health-usage-'));
    vi.stubEnv('OPENROUTER_API_KEY', 'synthetic-key'); vi.stubEnv('CODEGENIE_HOME', path.join(dir, 'home'));
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('unexpected network'); }));
    try {
      const ledger = new CampaignLedger(path.join(dir, 'ledger'), { binding: 'health', limitMicros: 2_000_000 });
      const keyFingerprint = ledger.fingerprint('synthetic-key');
      ledger.bindKeyBaseline({ usageMicros: 0, keyFingerprint, evidenceSHA256: 'a'.repeat(64) });
      ledger.recordKeySnapshot({ boundaryId: 'boundary', usageMicros: 0, observedMs: 0, keyFingerprint, evidenceSHA256: 'b'.repeat(64) });
      const fetchImpl = vi.fn(async () => response(usage)); const sealReceipt = vi.fn(() => true);
      const result = await runHealthProbe({ ledger, boundaryId: 'boundary', purpose: 'admission', attemptPrefix: 'health/attempt-01', expected,
        llmConfig: { provider: 'openrouter', model: 'openai/gpt-6-luna', reasoning: 'high', maxConcurrentCalls: 1 }, fetchImpl, sealReceipt });
      expect(result).toEqual({ status: 'failed' }); expect(fetchImpl).toHaveBeenCalledTimes(1); expect(sealReceipt).not.toHaveBeenCalled();
      expect(ledger.totals()).toMatchObject({ starts: 1, unknown: 1, chargedMicros: 400_000, stopped: 'accounting_failed' }); ledger.close();
    } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); }
  }, 90_000);
  it.each(['clean', 'zero', 'denied', 'capacity'])('makes at most one synthetic physical start for %s', async (scenario) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'eval-health-'));
    vi.stubEnv('OPENROUTER_API_KEY', 'synthetic-key'); vi.stubEnv('CODEGENIE_HOME', path.join(dir, 'home'));
    const globalFetch = vi.fn(async () => { throw new Error('unexpected network'); }); vi.stubGlobal('fetch', globalFetch);
    try {
      const ledger = new CampaignLedger(path.join(dir, 'ledger'), { binding: 'health', limitMicros: 2_000_000 });
      const keyFingerprint = ledger.fingerprint('synthetic-key');
      ledger.bindKeyBaseline({ usageMicros: 0, keyFingerprint, evidenceSHA256: 'a'.repeat(64) });
      ledger.recordKeySnapshot({ boundaryId: 'boundary', usageMicros: 0, observedMs: 0, keyFingerprint, evidenceSHA256: 'b'.repeat(64) });
      const fetchImpl = vi.fn(async () => scenario === 'clean' ? response() : scenario === 'zero'
        ? response({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost: 0, is_byok: false })
        : new Response('unavailable', { status: scenario === 'denied' ? 429 : 500 }));
      const receipts: Buffer[] = [];
      const result = await runHealthProbe({ ledger, boundaryId: 'boundary', purpose: 'admission', attemptPrefix: 'health/attempt-01', expected,
        llmConfig: { provider: 'openrouter', model: 'openai/gpt-6-luna', reasoning: 'high', maxConcurrentCalls: 1 }, fetchImpl,
        sealReceipt: (bytes: Buffer) => { receipts.push(bytes); return true; } });
      expect(fetchImpl).toHaveBeenCalledTimes(1); expect(globalFetch).not.toHaveBeenCalled();
      if (scenario === 'clean' || scenario === 'zero') {
        expect(result).toMatchObject({ status: 'clean' });
        expect(ledger.totals()).toMatchObject({ starts: 1, open: 0, chargedMicros: scenario === 'zero' ? 0 : 100 });
        expect(JSON.parse(receipts[0]!.toString())).toMatchObject({ kind: 'health', boundaryId: 'boundary', purpose: 'admission' });
        expect(receipts[0]!.toString()).not.toContain('synthetic-key');
      } else if (scenario === 'denied') {
        expect(result).toEqual({ status: 'failed' }); expect(receipts).toHaveLength(0);
        expect(ledger.totals()).toMatchObject({ starts: 1, stopped: 'provider_429' });
      } else {
        expect(result).toMatchObject({ status: 'capacity' });
        expect(ledger.totals()).toMatchObject({ starts: 1, unknown: 1, chargedMicros: 400_000 });
        expect(ledger.healthDecision({ boundaryId: 'boundary', provider: 'openrouter', nowMs: Date.now(), verifyEvidence: () => true })).toMatchObject({ action: 'wait' });
      }
      ledger.close();
    } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); }
  }, 90_000);
});
