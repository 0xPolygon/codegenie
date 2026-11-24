import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
// @ts-expect-error Development-only ESM has no emitted types.
import { openCampaign } from '../evals/runner/campaign.mjs';
// @ts-expect-error Development-only ESM has no emitted types.
import { buildDigest, treeDigest } from '../evals/runner/integrity.mjs';
// @ts-expect-error Development-only ESM has no emitted types.
import { CampaignLedger } from '../evals/runner/ledger.mjs';
// @ts-expect-error Development-only ESM has no emitted types.
import { seal405Registration, generate405Order, ASSIGNED_EFFECTS_SEED } from '../evals/runner/qualification-405.mjs';
const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
function writable(dir: string) { const stat = lstatSync(dir); if (stat.isSymbolicLink()) return; chmodSync(dir, stat.isDirectory() ? 0o700 : 0o600); if (stat.isDirectory()) for (const entry of readdirSync(dir)) writable(path.join(dir, entry)); }
function healthResponse() {
  const base = { id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'openai/gpt-6-luna' };
  const chunks = [{ ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'submit', type: 'function', function: { name: 'submit_plan', arguments: '{"ok":true}' } }] }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.0001, is_byok: false } }];
  return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
}

it('runs an 80-slot synthetic bound campaign through pause, release and restart without duplicate starts', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'eval-405-offline-'));
  vi.stubEnv('CODEGENIE_HOME', path.join(dir, 'home')); vi.stubEnv('OPENROUTER_API_KEY', 'synthetic-key');
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('unexpected network'); }));
  try {
    const caseIds = Array.from({ length: 20 }, (_, index) => `fixture-${String(index + 1).padStart(2, '0')}`);
    const oraclePath = path.join(dir, 'oracle-manifest.json'), oracleBytes = Buffer.from(JSON.stringify({ cases: caseIds.map((caseId) => ({ caseId, sha256: 'a'.repeat(64) })) })); writeFileSync(oraclePath, oracleBytes);
    const registrationFile = path.join(dir, 'registration.json'), registrationSHA256 = await seal405Registration({ file: registrationFile, caseIds, oracleManifestSHA256: sha(oracleBytes) });
    const order = await generate405Order({ registrationFile, registrationSHA256 });
    const suiteDir = path.join(process.cwd(), 'evals/fixtures'), caseFile = path.join(dir, 'case.json');
    const caseBytes = Buffer.from(JSON.stringify({ caseDir: suiteDir, caseName: 'fixture-core-lens', outputDir: path.join(dir, 'output') })); writeFileSync(caseFile, caseBytes);
    const build = buildDigest(), integrity = { suiteDir, suiteSHA256: treeDigest(suiteDir), build };
    const base = { supervisorPath: path.join(dir, 'supervisor.db'), ledgerPath: path.join(dir, 'ledger.db'), ledgerBinding: 'campaign', evidenceDirectory: path.join(dir, 'evidence'), limitMicros: 15_000_000, reserveMicros: 400_000, errorHoldMicros: 50_000, caseConfig: caseFile, caseConfigSHA256: sha(caseBytes), integrity };
    const expected = { api: 'openai-completions', destination: 'https://openrouter.ai/api/v1/chat/completions', provider: 'openrouter', modelId: 'openai/gpt-6-luna', reasoningSelected: 'high', wireEffort: 'high' };
    const slots = order.slots.map((item: { caseId: string; arm: string; draw: number }, index: number) => {
      const id = `slot-${String(index + 1).padStart(2, '0')}`, assignedEffects = item.arm === 'treatment';
      return { id, caseId: item.caseId, boundaryId: item.caseId, provider: 'openrouter', expectedPacketIds: ['packet'], blind: { arm: item.arm, draw: item.draw },
        workerConfig: { ...base, boundaryId: item.caseId, assignedEffects, expectedCalls: [{ ...expected, stage: 7, kind: 'initial', templateVersion: assignedEffects ? 'p7.16-assigned-effects.1' : 'p7.16' }] } };
    });
    const schedule = Buffer.from(JSON.stringify({ seed: ASSIGNED_EFFECTS_SEED, verifierConcurrency: 'native', pauseAfterSlot: slots[7].id, slots })), schedulePath = path.join(dir, 'schedule.json'); writeFileSync(schedulePath, schedule);
    const config = Buffer.from(JSON.stringify({ binding: 'campaign', schedulePath, scheduleSHA256: sha(schedule), supervisorPath: base.supervisorPath, ledgerPath: base.ledgerPath, evidenceDirectory: base.evidenceDirectory, receiptDirectory: path.join(dir, 'receipts'), workDirectory: path.join(dir, 'work'), limitMicros: base.limitMicros, reserveMicros: base.reserveMicros, errorHoldMicros: base.errorHoldMicros, build,
      qualification405: { registrationFile, registrationSHA256, verifierConcurrency: 'native' }, blind: { oracleManifestPath: oraclePath, oracleManifestSHA256: sha(oracleBytes) },
      health: { expected: { ...expected, templateVersion: 'campaign-health.1' }, llmConfig: { provider: 'openrouter', model: 'openai/gpt-6-luna', reasoning: 'high', maxConcurrentCalls: 1 } } }));
    const configFile = path.join(dir, 'campaign.json'); writeFileSync(configFile, config);
    let gets = 0, probes = 0, dispatches = 0;
    const fetchImpl = async (input: string) => { if (String(input).endsWith('/api/v1/key')) { gets++; return new Response(`{"data":{"usage":${(gets - 1) / 100}}}`); } probes++; return healthResponse(); };
    const models = { getAuth: async () => ({ auth: { apiKey: 'synthetic-key' } }) };
    const spawnWorker = async ({ supervisor, slotId, attemptNo, configFile: workerFile, configSHA256 }: { supervisor: any; slotId: string; attemptNo: number; configFile: string; configSHA256: string }) => {
      dispatches++; const workerBytes = readFileSync(workerFile), token = supervisor.claimWorker(slotId, attemptNo, workerBytes, configSHA256);
      supervisor.recordWorkerStart(slotId, attemptNo, process.pid);
      expect(supervisor.db.prepare('UPDATE worker_claim SET activated=1 WHERE slot_id=? AND attempt_no=? AND token_sha256=? AND activated=0').run(slotId, attemptNo, sha(token)).changes).toBe(1);
      const worker = JSON.parse(workerBytes.toString('utf8')), ledger = new CampaignLedger(worker.ledgerPath, { binding: worker.ledgerBinding, limitMicros: worker.limitMicros, reserveMicros: worker.reserveMicros, errorHoldMicros: worker.errorHoldMicros, initialize: false });
      const prefix = `${slotId}/attempt-01`, physical = `${prefix}/mc-1/physical-1`, now = Date.now();
      expect(ledger.reservePhysical({ id: physical, logicalId: `${prefix}/mc-1`, kind: 'initial', provider: 'openrouter', startedAtMs: now - 1 }).admitted).toBe(true);
      ledger.settlePhysical({ id: physical, httpStatus: 200, settledAtMs: now, providerCostMicros: 1, costConfirmed: true, usageEvidence: { usagePresent: true, costPresent: true, inputTokens: 1, outputTokens: 0, totalTokens: 1 } }); ledger.close();
      const runDir = path.join(dir, 'output', slotId, 'attempt-01', 'run'), telemetry = path.join(runDir, 'telemetry'), runId = `run-${slotId}`;
      mkdirSync(path.join(telemetry, 'stages/06-packets/packets'), { recursive: true });
      writeFileSync(path.join(telemetry, 'run.json'), JSON.stringify({ runId, outcome: { status: 'completed_full' } }));
      writeFileSync(path.join(telemetry, 'telemetry.json'), JSON.stringify({ runId, events: 1, packets: { generated: 1 }, modelCalls: { totalRecords: 1 }, toolCalls: { totalCalls: 0 } }));
      writeFileSync(path.join(telemetry, 'model-calls.jsonl'), JSON.stringify({ runId, callId: 'mc-1', cacheStatus: 'disabled', status: 'ok', inputTokens: 1, outputTokens: 0, totalTokens: 1 }) + '\n');
      writeFileSync(path.join(telemetry, 'events.jsonl'), JSON.stringify({ runId, eventId: 'ev-1', stage: 7, message: 'structured_submission_accepted', data: { packetId: 'packet' } }) + '\n');
      writeFileSync(path.join(telemetry, 'stages/06-packets/packets/packet.json'), JSON.stringify({ id: 'packet' }));
      supervisor.recordWorkerExit(slotId, attemptNo); return { caseName: 'fixture-core-lens', status: 'fail', runDir };
    };
    const dependencies = { fetchImpl, models, spawnWorker };
    let campaign = await openCampaign(configFile, sha(config), dependencies), paused: any;
    for (let steps = 0; steps < 30; steps++) { const next = await campaign.step(); if (next.action === 'paused') { paused = next; break; } expect(['health', 'selected']).toContain(next.action); }
    expect(paused?.receipts).toHaveLength(8); expect(dispatches).toBe(8); expect(probes).toBe(2);
    expect(campaign.ledger.db.prepare("SELECT COUNT(*) AS n FROM physical WHERE kind='health' AND health_boundary=?").get(order.caseIds[2]).n).toBe(0);
    const startsAtPause = campaign.ledger.totals().starts, getsAtPause = gets, hashes = paused.receipts.map((row: { receiptSHA256: string }) => row.receiptSHA256); campaign.close();
    campaign = await openCampaign(configFile, sha(config), dependencies); expect((await campaign.step()).action).toBe('paused');
    expect(campaign.ledger.totals().starts).toBe(startsAtPause); expect(gets).toBe(getsAtPause); expect(campaign.releaseCheckpoint()).toBe(paused.prefixSHA256);
    let done: any;
    for (let steps = 0; steps < 250; steps++) { const next = await campaign.step(); if (next.action === 'completed') { done = next; break; } expect(['health', 'selected']).toContain(next.action); }
    expect(done?.receipts).toHaveLength(80); expect(done.receipts.slice(0, 8).map((row: { receiptSHA256: string }) => row.receiptSHA256)).toEqual(hashes);
    expect(dispatches).toBe(80); expect(probes).toBe(20);
    const finalStarts = campaign.ledger.totals().starts, finalGets = gets; campaign.close();
    campaign = await openCampaign(configFile, sha(config), dependencies); expect((await campaign.step()).action).toBe('completed');
    expect(campaign.ledger.totals().starts).toBe(finalStarts); expect(gets).toBe(finalGets); expect(dispatches).toBe(80); campaign.close();
  } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); writable(dir); rmSync(dir, { recursive: true, force: true }); }
}, 300_000);
