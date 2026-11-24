import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, lstatSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error Development-only ESM has no emitted types.
import { openCampaign } from '../evals/runner/campaign.mjs';
// @ts-expect-error Development-only ESM has no emitted types.
import { buildDigest, treeDigest } from '../evals/runner/integrity.mjs';
const sha = (value: Buffer) => createHash('sha256').update(value).digest('hex');
function makeWritable(dir: string) {
  const stat = lstatSync(dir); if (stat.isSymbolicLink()) return;
  chmodSync(dir, stat.isDirectory() ? 0o700 : 0o600);
  if (stat.isDirectory()) for (const name of readdirSync(dir)) makeWritable(path.join(dir, name));
}

function healthResponse() {
  const base = { id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'openai/gpt-6-luna' };
  const chunks = [
    { ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'submit_plan', arguments: '{"ok":true}' } }] }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.0001, is_byok: false } }
  ];
  return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
}

describe('campaign driver', () => {
  it.each(['case-before', 'case-during', 'case-after', 'normal'])('handles %s with bound admission and a network-blocked child', async (scenario) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'eval-driver-'));
    vi.stubEnv('CODEGENIE_HOME', path.join(dir, 'home')); vi.stubEnv('OPENROUTER_API_KEY', 'synthetic-key');
    const preload = path.join(dir, 'block.mjs'); writeFileSync(preload, 'globalThis.fetch = async () => { throw new Error("network blocked"); };\n');
    vi.stubEnv('NODE_OPTIONS', `--import=${preload}`); vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('unexpected network'); }));
    try {
      const caseFile = path.join(dir, 'case.json'), caseBytes = Buffer.from(JSON.stringify({ caseDir: path.join(process.cwd(), 'evals/fixtures'), caseName: 'fixture-core-lens', outputDir: path.join(dir, 'output') }));
      writeFileSync(caseFile, caseBytes);
      const suiteDir = path.join(process.cwd(), 'evals/fixtures'), build = buildDigest();
      const base = { supervisorPath: path.join(dir, 'supervisor.db'), ledgerPath: path.join(dir, 'ledger.db'), ledgerBinding: 'campaign', boundaryId: 'one',
        evidenceDirectory: path.join(dir, 'evidence'), limitMicros: 2_000_000, reserveMicros: 400_000, errorHoldMicros: 50_000,
        caseConfig: caseFile, caseConfigSHA256: sha(caseBytes), expectedCalls: [], integrity: { suiteDir, suiteSHA256: treeDigest(suiteDir), build } };
      const schedule = Buffer.from(JSON.stringify({ slots: [{ id: 'one', caseId: 'fixture', boundaryId: 'one', provider: 'openrouter', expectedPacketIds: [], workerConfig: base }] }));
      const schedulePath = path.join(dir, 'schedule.json'); writeFileSync(schedulePath, schedule);
      const expected = { api: 'openai-completions', destination: 'https://openrouter.ai/api/v1/chat/completions', provider: 'openrouter', modelId: 'openai/gpt-6-luna', reasoningSelected: 'high', templateVersion: 'campaign-health.1', wireEffort: 'high' };
      const config = Buffer.from(JSON.stringify({ binding: 'campaign', schedulePath, scheduleSHA256: sha(schedule), supervisorPath: base.supervisorPath, ledgerPath: base.ledgerPath,
        evidenceDirectory: base.evidenceDirectory, receiptDirectory: path.join(dir, 'receipts'), workDirectory: path.join(dir, 'work'), limitMicros: base.limitMicros, reserveMicros: base.reserveMicros, errorHoldMicros: base.errorHoldMicros,
        build, health: { expected, llmConfig: { provider: 'openrouter', model: 'openai/gpt-6-luna', reasoning: 'high', maxConcurrentCalls: 1 } } }));
      const file = path.join(dir, 'campaign.json'); writeFileSync(file, config);
      let gets = 0, posts = 0;
      const fetchImpl = vi.fn(async (input: string) => {
        if (String(input) === 'https://openrouter.ai/api/v1/key') { gets++; if (scenario === 'case-during') appendFileSync(caseFile, ' '); return new Response(`{"data":{"usage":${gets === 1 ? 0 : 0.0001}}}`); }
        posts++; return healthResponse();
      });
      const models = { getAuth: async () => ({ auth: { apiKey: 'synthetic-key' } }) };
      await expect(openCampaign(file, '0'.repeat(64), { fetchImpl, models })).rejects.toThrow('config digest');
      const campaign = await openCampaign(file, sha(config), { fetchImpl, models });
      if (scenario === 'case-before') {
        appendFileSync(caseFile, ' ');
        expect(await campaign.step()).toMatchObject({ action: 'stop', reason: 'binding_mismatch' });
        expect({ gets, posts }).toEqual({ gets: 0, posts: 0 }); campaign.close(); return;
      }
      if (scenario === 'case-during') {
        expect(await campaign.step()).toMatchObject({ action: 'stop', reason: 'binding_mismatch' });
        expect({ gets, posts }).toEqual({ gets: 1, posts: 0 }); campaign.close(); return;
      }
      expect(await campaign.step()).toMatchObject({ action: 'health', status: 'clean' });
      if (scenario === 'case-after') {
        appendFileSync(caseFile, ' ');
        expect(await campaign.step()).toMatchObject({ action: 'stop', reason: 'binding_mismatch' });
        expect({ gets, posts }).toEqual({ gets: 1, posts: 1 }); campaign.close(); return;
      }
      expect(await campaign.step()).toMatchObject({ action: 'stop', reason: 'terminal_evidence' });
      const stopReceipt = campaign.supervisor.receipts.find('one', 1);
      expect(stopReceipt).toMatchObject({ receipt: { status: 'stop', reason: 'terminal_evidence' } });
      expect(lstatSync(stopReceipt.receipt.runDir).mode & 0o222).toBe(0);
      expect({ gets, posts }).toEqual({ gets: 2, posts: 1 });
      expect(campaign.ledger.totals().starts).toBe(1);
      expect(campaign.supervisor.db.prepare('SELECT COUNT(*) AS total FROM outcome').get()).toEqual({ total: 0 });
      expect(await campaign.step()).toMatchObject({ action: 'stop', reason: 'terminal_evidence' });
      campaign.close();
      const reopened = await openCampaign(file, sha(config), { fetchImpl, models });
      expect(await reopened.step()).toMatchObject({ action: 'stop', reason: 'terminal_evidence' });
      expect({ gets, posts }).toEqual({ gets: 2, posts: 1 }); reopened.close();
      renameSync(base.supervisorPath, `${base.supervisorPath}-moved`); renameSync(base.ledgerPath, `${base.ledgerPath}-moved`);
      await expect(openCampaign(file, sha(config), { fetchImpl, models })).rejects.toThrow('namespace requires reconciliation');
      expect({ gets, posts }).toEqual({ gets: 2, posts: 1 });
    } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); makeWritable(dir); rmSync(dir, { recursive: true, force: true }); }
  }, 90_000);
});
