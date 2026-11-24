import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
// @ts-expect-error Development-only ESM has no emitted types.
import { CampaignLedger } from '../evals/runner/ledger.mjs';
// @ts-expect-error Development-only ESM has no emitted types.
import { prepareAdmission } from '../evals/runner/admission.mjs';

beforeAll(() => { execFileSync('pnpm', ['build'], { stdio: 'pipe' }); }, 60_000);
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
      else { expect(result).toEqual({ action: 'wait' }); expect(ledger.totals().stopped).toBeNull(); }
      ledger.close();
    } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); }
  }, 90_000);
  it('uses sanitized key and native health evidence, then reuses it at the same boundary', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'eval-admission-'));
    vi.stubEnv('OPENROUTER_API_KEY', 'synthetic-key'); vi.stubEnv('CODEGENIE_HOME', path.join(dir, 'home'));
    const globalFetch = vi.fn(async () => { throw new Error('unexpected network'); }); vi.stubGlobal('fetch', globalFetch);
    try {
      const ledger = new CampaignLedger(path.join(dir, 'ledger'), { binding: 'campaign', limitMicros: 2_000_000 });
      let gets = 0, posts = 0;
      const fetchImpl = vi.fn(async (input: string) => {
        if (String(input) === 'https://openrouter.ai/api/v1/key') { gets++; return new Response(`{"data":{"usage":${gets === 1 ? 0 : 0.0001}}}`); }
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
      expect(await prepareAdmission({ ...args, boundaryId: 'two', attemptPrefix: 'health/two' })).toMatchObject({ status: 'clean' });
      expect({ gets, posts }).toEqual({ gets: 3, posts: 2 }); ledger.close();
    } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); }
  }, 90_000);
});
