import { createHash } from 'node:crypto';
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
  const secret = 'synthetic-key';
  it.each([
    {
      name: 'upstream policy refusal', status: 200, outcome: 'failed', source: 'metadata.raw',
      body: { error: { code: 500, message: 'Provider returned error', metadata: { raw: JSON.stringify({ error: { message: 'This resource is temporarily blocked by content policy' } }), ignored: 'omit-this' } } },
      message: 'This resource is temporarily blocked by content policy',
    },
    {
      name: 'service unavailable', status: 503, outcome: 'capacity', source: 'error.message',
      body: { error: { message: 'Service unavailable' } }, message: 'Service unavailable',
    },
    {
      name: 'other provider error', status: 200, outcome: 'failed', source: 'error.message',
      body: { error: { message: 'The upstream model is not ready' } }, message: 'The upstream model is not ready',
    },
    {
      name: 'missing message', status: 200, outcome: 'failed',
      body: { error: { code: 500, metadata: { raw: 'opaque body, omit-this' } } },
    },
    {
      name: 'credential across the cap', status: 200, outcome: 'failed', source: 'error.message',
      body: { error: { message: `${secret}\n${'a'.repeat(274)} ${secret} ${'b'.repeat(400)}` } },
      message: `[redacted:secret] ${'a'.repeat(274)} [redac…`,
    },
  ])('projects a diagnostic only from the bound $name response', async ({ status, outcome, source, body, message }) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'eval-health-diagnostic-'));
    vi.stubEnv('OPENROUTER_API_KEY', secret); vi.stubEnv('CODEGENIE_HOME', path.join(dir, 'home'));
    const globalFetch = vi.fn(async () => { throw new Error('unexpected network'); }); vi.stubGlobal('fetch', globalFetch);
    const ledger = new CampaignLedger(path.join(dir, 'ledger'), { binding: 'health', limitMicros: 2_000_000 });
    try {
      const keyFingerprint = ledger.fingerprint(secret);
      ledger.bindKeyBaseline({ usageMicros: 0, keyFingerprint, evidenceSHA256: 'a'.repeat(64) });
      ledger.recordKeySnapshot({ boundaryId: 'boundary', usageMicros: 0, observedMs: 0, keyFingerprint, evidenceSHA256: 'b'.repeat(64) });
      const serialized = JSON.stringify(body);
      const fetchImpl = vi.fn(async () => status === 200
        ? new Response(`data: ${serialized}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
        : new Response(serialized, { status, headers: { 'content-type': 'application/json' } }));
      const receipts = new Map<string, Buffer>();
      const result = await runHealthProbe({ ledger, boundaryId: 'boundary', purpose: 'admission', attemptPrefix: 'health/attempt-01', expected,
        llmConfig: { provider: 'openrouter', model: 'openai/gpt-6-luna', reasoning: 'high', maxConcurrentCalls: 1 }, fetchImpl,
        sealReceipt: (bytes: Buffer, digest: string) => { receipts.set(digest, bytes); return true; } });
      const physical = ledger.db.prepare('SELECT id,http_status,stream_terminal,evidence_json FROM physical').get();
      const streamTerminal = status === 200 ? 'provider_error_event' : null;
      expect(physical).toMatchObject({ http_status: status, stream_terminal: streamTerminal, evidence_json: null });
      expect(fetchImpl).toHaveBeenCalledTimes(1); expect(globalFetch).not.toHaveBeenCalled();
      expect(result.status).toBe(outcome);
      expect(ledger.totals()).toMatchObject({ starts: 1, unknown: 1, chargedMicros: 400_000, stopped: outcome === 'failed' ? 'health_failed' : null });
      const health = ledger.db.prepare('SELECT outcome,evidence_sha256 FROM health_receipt').all();
      if (outcome === 'capacity') {
        expect(health).toEqual([{ outcome: 'capacity', evidence_sha256: result.receiptSHA256 }]);
        expect(JSON.parse(receipts.get(result.receiptSHA256)!.toString())).not.toHaveProperty('message');
      } else {
        expect(health).toEqual([]);
      }
      if (message === undefined) {
        expect(result).toEqual({ status: outcome });
        expect(receipts.size).toBe(0);
      } else {
        expect(result.diagnostic).toEqual({ source, message });
        const bytes = receipts.get(result.diagnosticSHA256)!;
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(result.diagnosticSHA256);
        expect(JSON.parse(bytes.toString())).toEqual({ kind: 'health_diagnostic', physicalId: physical.id, boundaryId: 'boundary', provider: 'openrouter',
          httpStatus: status, streamTerminal, source, message });
        expect(bytes.toString()).not.toContain(secret);
        expect(bytes.toString()).not.toContain('omit-this');
        expect(message.length).toBeLessThanOrEqual(300);
      }
    } finally { ledger.close(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); }
  }, 90_000);
  it('latches typed quota denial on an HTTP 400 and preserves its physical hold', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'eval-health-quota-'));
    vi.stubEnv('OPENROUTER_API_KEY', 'synthetic-key'); vi.stubEnv('CODEGENIE_HOME', path.join(dir, 'home'));
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('unexpected network'); }));
    try {
      const ledger = new CampaignLedger(path.join(dir, 'ledger'), { binding: 'health', limitMicros: 2_000_000 });
      const keyFingerprint = ledger.fingerprint('synthetic-key');
      ledger.bindKeyBaseline({ usageMicros: 0, keyFingerprint, evidenceSHA256: 'a'.repeat(64) });
      ledger.recordKeySnapshot({ boundaryId: 'boundary', usageMicros: 0, observedMs: 0, keyFingerprint, evidenceSHA256: 'b'.repeat(64) });
      const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'quota exceeded', type: 'insufficient_quota' } }), { status: 400, headers: { 'content-type': 'application/json' } }));
      expect(await runHealthProbe({ ledger, boundaryId: 'boundary', purpose: 'admission', attemptPrefix: 'health/attempt-01', expected,
        llmConfig: { provider: 'openrouter', model: 'openai/gpt-6-luna', reasoning: 'high', maxConcurrentCalls: 1 }, fetchImpl, sealReceipt: () => true }))
        .toMatchObject({ status: 'failed', diagnostic: { message: 'quota exceeded' } });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(ledger.totals()).toMatchObject({ starts: 1, unknown: 1, chargedMicros: 400_000, stopped: 'provider_quota' });
      expect(ledger.db.prepare('SELECT http_status FROM physical').get()).toEqual({ http_status: 400 });
      expect(ledger.reservePhysical({ id: 'later', logicalId: 'later', kind: 'initial' })).toEqual({ admitted: false, reason: 'provider_quota' }); ledger.close();
    } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); }
  }, 90_000);
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
