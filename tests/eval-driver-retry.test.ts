import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error Development-only ESM has no emitted types.
import { openCampaign } from '../evals/runner/campaign.mjs';
// @ts-expect-error Development-only ESM has no emitted types.
import { buildDigest, treeDigest } from '../evals/runner/integrity.mjs';
// @ts-expect-error Development-only ESM has no emitted types.
import { CampaignLedger } from '../evals/runner/ledger.mjs';
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
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

describe('assembled campaign retry', () => {
  it.each(['retry', 'exclusion', 'missing-usage'])('handles %s across restart without a third attempt', async (scenario) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'eval-driver-retry-'));
    vi.stubEnv('CODEGENIE_HOME', path.join(dir, 'home')); vi.stubEnv('OPENROUTER_API_KEY', 'synthetic-key');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('unexpected network'); }));
    try {
      const suiteDir = path.join(process.cwd(), 'evals/fixtures'), caseFile = path.join(dir, 'case.json');
      const caseBytes = Buffer.from(JSON.stringify({ caseDir: suiteDir, caseName: 'fixture-core-lens', outputDir: path.join(dir, 'output') })); writeFileSync(caseFile, caseBytes);
      const build = buildDigest(), integrity = { suiteDir, suiteSHA256: treeDigest(suiteDir), build };
      const base = { supervisorPath: path.join(dir, 'supervisor.db'), ledgerPath: path.join(dir, 'ledger.db'), ledgerBinding: 'campaign', boundaryId: 'boundary', evidenceDirectory: path.join(dir, 'evidence'), limitMicros: 15_000_000, reserveMicros: 400_000, errorHoldMicros: 50_000, caseConfig: caseFile, caseConfigSHA256: sha(caseBytes), expectedCalls: [], integrity };
      const schedule = Buffer.from(JSON.stringify({ slots: ['sibling', 'one'].map((id) => ({ id, caseId: 'case', boundaryId: 'boundary', provider: 'openrouter', expectedPacketIds: ['packet'], workerConfig: base })) }));
      const schedulePath = path.join(dir, 'schedule.json'); writeFileSync(schedulePath, schedule);
      const expected = { api: 'openai-completions', destination: 'https://openrouter.ai/api/v1/chat/completions', provider: 'openrouter', modelId: 'openai/gpt-6-luna', reasoningSelected: 'high', templateVersion: 'campaign-health.1', wireEffort: 'high' };
      const config = Buffer.from(JSON.stringify({ binding: 'campaign', schedulePath, scheduleSHA256: sha(schedule), supervisorPath: base.supervisorPath, ledgerPath: base.ledgerPath, evidenceDirectory: base.evidenceDirectory, receiptDirectory: path.join(dir, 'receipts'), workDirectory: path.join(dir, 'work'), limitMicros: base.limitMicros, reserveMicros: base.reserveMicros, errorHoldMicros: base.errorHoldMicros, build, health: { expected, llmConfig: { provider: 'openrouter', model: 'openai/gpt-6-luna', reasoning: 'high', maxConcurrentCalls: 1 } } }));
      const file = path.join(dir, 'campaign.json'); writeFileSync(file, config);
      let gets = 0, posts = 0, dispatches = 0;
      const fetchImpl = vi.fn(async (input: string) => {
        if (String(input) === 'https://openrouter.ai/api/v1/key') { gets++; return new Response(`{"data":{"usage":${gets === 1 ? 0 : (gets - 1) / 10}}}`); }
        posts++; return healthResponse();
      });
      const models = { getAuth: async () => ({ auth: { apiKey: 'synthetic-key' } }) };
      const spawnWorker = async ({ supervisor, slotId, attemptNo, configFile, configSHA256 }: { supervisor: any; slotId: string; attemptNo: number; configFile: string; configSHA256: string }) => {
        dispatches++;
        const workerBytes = readFileSync(configFile), token = supervisor.claimWorker(slotId, attemptNo, workerBytes, configSHA256);
        supervisor.recordWorkerStart(slotId, attemptNo, process.pid);
        const activated = supervisor.db.prepare("UPDATE worker_claim SET activated=1 WHERE slot_id=? AND attempt_no=? AND token_sha256=? AND activated=0").run(slotId, attemptNo, sha(token));
        if (activated.changes !== 1) throw new Error('fixture claim mismatch');
        const worker = JSON.parse(workerBytes.toString('utf8'));
        const ledger = new CampaignLedger(worker.ledgerPath, { binding: worker.ledgerBinding, limitMicros: worker.limitMicros, reserveMicros: worker.reserveMicros, errorHoldMicros: worker.errorHoldMicros, initialize: false });
        const failed = slotId === 'one' && (attemptNo === 1 || scenario === 'exclusion'), missing = failed && scenario === 'missing-usage';
        const prefix = `${slotId}/attempt-${String(attemptNo).padStart(2, '0')}`, id = `${prefix}/mc-1/physical-1`, now = Date.now();
        ledger.reservePhysical({ id, logicalId: `${prefix}/mc-1`, kind: 'initial', provider: 'openrouter', startedAtMs: now - 10 });
        ledger.settlePhysical(missing ? { id, httpStatus: 503, settledAtMs: now - 5 } : { id, httpStatus: failed ? 503 : 200, settledAtMs: now - 5, providerCostMicros: 1, costConfirmed: true, usageEvidence: { usagePresent: true, costPresent: true, inputTokens: 1, outputTokens: 0, totalTokens: 1 } });
        ledger.close();
        const runDir = path.join(dir, 'output', slotId, `attempt-${String(attemptNo).padStart(2, '0')}`, 'run'), telemetry = path.join(runDir, 'telemetry'), runId = `run-${slotId}-${attemptNo}`;
        mkdirSync(telemetry, { recursive: true });
        const events = failed ? [] : [{ runId, eventId: 'ev-1', stage: 7, message: 'structured_submission_accepted', data: { packetId: 'packet' } }];
        const model = { runId, callId: 'mc-1', cacheStatus: 'disabled', status: failed ? 'transient_error' : 'ok', ...(failed ? { errorCode: 'llm_call_failed' } : {}), ...(missing ? {} : { inputTokens: 1, outputTokens: 0, totalTokens: 1 }) };
        writeFileSync(path.join(telemetry, 'run.json'), JSON.stringify({ runId, outcome: { status: failed ? 'failed' : 'completed_full' } }));
        writeFileSync(path.join(telemetry, 'telemetry.json'), JSON.stringify({ runId, events: events.length, packets: { generated: failed ? 0 : 1 }, modelCalls: { totalRecords: 1 }, toolCalls: { totalCalls: 0 } }));
        writeFileSync(path.join(telemetry, 'model-calls.jsonl'), JSON.stringify(model) + '\n');
        if (!failed) { mkdirSync(path.join(telemetry, 'stages/06-packets/packets'), { recursive: true }); writeFileSync(path.join(telemetry, 'stages/06-packets/packets/packet.json'), JSON.stringify({ id: 'packet' })); writeFileSync(path.join(telemetry, 'events.jsonl'), JSON.stringify(events[0]) + '\n'); }
        supervisor.recordWorkerExit(slotId, attemptNo);
        return { caseName: 'fixture-core-lens', status: failed ? 'error' : 'fail', runDir, ...(failed ? { error: 'provider_failure', failureCallId: 'mc-1' } : {}) };
      };
      const dependencies = { fetchImpl, models, spawnWorker };
      let campaign = await openCampaign(file, sha(config), dependencies);
      expect(await campaign.step()).toMatchObject({ action: 'health', status: 'clean' });
      const sibling = await campaign.step(); expect(sibling).toMatchObject({ action: 'selected', slot: 'sibling' });
      const first = await campaign.step();
      if (scenario === 'missing-usage') {
        expect(first).toMatchObject({ action: 'stop', reason: 'terminal_evidence' });
        expect(campaign.ledger.totals()).toMatchObject({ unknown: 1, stopped: 'terminal_evidence' });
        expect(campaign.ledger.db.prepare("SELECT state,charge FROM physical WHERE logical_id='one/attempt-01/mc-1'").get()).toEqual({ state: 'unknown', charge: 400_000 });
        expect(dispatches).toBe(2); campaign.close(); return;
      }
      expect(first).toMatchObject({ action: 'infrastructure_failure', slot: 'one' });
      const firstHash = first.receiptSHA256, siblingHash = sibling.receiptSHA256, postsBeforeRetry = posts;
      campaign.close(); campaign = await openCampaign(file, sha(config), dependencies);
      expect(await campaign.step()).toMatchObject({ action: 'retry_authorized', slot: 'one' });
      expect(posts).toBe(postsBeforeRetry + 1);
      const auth = campaign.supervisor.db.prepare("SELECT failure_sha256,probe_id FROM retry_authorization WHERE slot_id='one'").get();
      expect(auth.failure_sha256).toBe(firstHash);
      expect(campaign.ledger.db.prepare('SELECT health_purpose,retry_for,retry_failure_sha256 FROM physical WHERE id=?').get(auth.probe_id)).toEqual({ health_purpose: 'retry', retry_for: 'one/attempt-01', retry_failure_sha256: firstHash });
      const second = await campaign.step();
      if (scenario === 'retry') expect(second).toMatchObject({ action: 'selected', slot: 'one' });
      else expect(second).toMatchObject({ action: 'excluded', slot: 'one', firstReceiptSHA256: firstHash });
      expect(dispatches).toBe(3); expect(posts).toBe(2);
      expect(await campaign.step()).toMatchObject({ action: 'completed' });
      const starts = campaign.ledger.totals().starts, reads = gets; campaign.close();
      campaign = await openCampaign(file, sha(config), dependencies);
      const done = await campaign.step(); expect(done).toMatchObject({ action: 'completed' });
      expect(done.receipts[0].receiptSHA256).toBe(siblingHash);
      if (scenario === 'exclusion') expect(done.receipts[1]).toMatchObject({ outcome: 'excluded', firstReceiptSHA256: firstHash, receiptSHA256: second.receiptSHA256 });
      expect(campaign.supervisor.db.prepare("SELECT COUNT(*) AS n FROM attempt WHERE slot_id='one'").get()).toEqual({ n: 2 });
      expect(campaign.ledger.totals().starts).toBe(starts); expect(gets).toBe(reads); expect(posts).toBe(2); campaign.close();
    } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); makeWritable(dir); rmSync(dir, { recursive: true, force: true }); }
  }, 90_000);
});
