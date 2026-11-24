import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, copyFileSync, cpSync, lstatSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { createGitClient } from '../src/git/git-client.js';
import { stableJson } from '../src/util/json.js';
// @ts-expect-error Development-only ESM has no emitted types.
import { openCampaign } from '../evals/runner/campaign.mjs';
// @ts-expect-error Development-only ESM has no emitted types.
import { buildDigest, treeDigest } from '../evals/runner/integrity.mjs';
// @ts-expect-error Development-only ESM has no emitted types.
import { runCase } from '../evals/runner/case.mjs';
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
      for (const dbPath of [base.ledgerPath, base.supervisorPath]) {
        const backup = `${dbPath}-backup`; renameSync(dbPath, backup); writeFileSync(dbPath, '');
        await expect(openCampaign(file, sha(config), { fetchImpl, models })).rejects.toThrow('database custody');
        rmSync(dbPath); copyFileSync(backup, dbPath);
        const db = new DatabaseSync(dbPath); db.exec('DELETE FROM campaign'); db.close();
        await expect(openCampaign(file, sha(config), { fetchImpl, models })).rejects.toThrow('database custody');
        rmSync(dbPath); renameSync(backup, dbPath);
        expect({ gets, posts }).toEqual({ gets: 2, posts: 1 });
        const preserved = await openCampaign(file, sha(config), { fetchImpl, models });
        expect(preserved.ledger.totals()).toMatchObject({ starts: 1, stopped: 'terminal_evidence' }); preserved.close();
      }
      renameSync(base.supervisorPath, `${base.supervisorPath}-moved`); renameSync(base.ledgerPath, `${base.ledgerPath}-moved`);
      await expect(openCampaign(file, sha(config), { fetchImpl, models })).rejects.toThrow('namespace requires reconciliation');
      expect({ gets, posts }).toEqual({ gets: 2, posts: 1 });
    } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); makeWritable(dir); rmSync(dir, { recursive: true, force: true }); }
  }, 90_000);
  it.each(['single', 'checkpoint'])('completes and reconciles a %s synthetic campaign through the real adapter and child', async (scenario) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'eval-driver-success-'));
    vi.stubEnv('CODEGENIE_HOME', path.join(dir, 'home')); vi.stubEnv('OPENROUTER_API_KEY', 'synthetic-key');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('unexpected network'); }));
    try {
      const suiteDir = path.join(dir, 'suite'); cpSync(path.join(process.cwd(), 'evals/fixtures'), suiteDir, { recursive: true });
      const baselineCase = path.join(dir, 'baseline.json');
      writeFileSync(baselineCase, JSON.stringify({ caseDir: suiteDir, caseName: 'fixture-core-lens', outputDir: path.join(dir, 'baseline') }));
      const baseline = await runCase(baselineCase);
      const packetDir = path.join(baseline.runDir, 'telemetry/stages/06-packets/packets');
      const packetIds = readdirSync(packetDir).filter((name) => name.endsWith('.json')).map((name) => JSON.parse(readFileSync(path.join(packetDir, name), 'utf8')).id);
      expect(packetIds.length).toBeGreaterThan(0);
      const yaml = path.join(suiteDir, 'core.yml');
      let suiteYaml = readFileSync(yaml, 'utf8').replace('provider: fake', 'provider: openrouter').replace('model: fake-model', 'model: openai/gpt-6-luna\n  reasoning: high\n  compositionReasoningStepDown: false\n  debug: true');
      if (scenario === 'single') suiteYaml = suiteYaml.replace('verify: true', 'verify: false');
      let plannerReplayBinding;
      if (scenario === 'checkpoint') {
        const repo = path.join(baseline.runDir, 'fixture-repo');
        const dossier = JSON.parse(readFileSync(path.join(baseline.runDir, 'telemetry/stages/05-planner/planner-dossier.json'), 'utf8'));
        const plan = JSON.parse(readFileSync(path.join(baseline.runDir, 'telemetry/stages/05-planner/review-plan.json'), 'utf8'));
        const { runId: _ignored, ...stableDossier } = dossier;
        const captured = Buffer.from(JSON.stringify({ result: { plan, plannerCoverage: { submittedEntries: 0, acceptedEntries: 0, acceptedUniqueHunks: 0, rejectedUnknownHunk: 0 }, degradedPlanning: false, chunked: false }, telemetry: [{ kind: 'artifact', name: 'review-plan.json', data: plan }] }));
        const capturePath = path.join(dir, 'planner-capture.json'); writeFileSync(capturePath, captured);
        const rawDiff = await createGitClient(repo).diff(dossier.target.mergeBase, dossier.target.headSha);
        plannerReplayBinding = { capturePath, captureSHA256: sha(captured), diffSHA256: sha(Buffer.from(rawDiff)), expectedDossierSHA256: sha(Buffer.from(stableJson(stableDossier))), baseSHA: dossier.target.mergeBase, headSHA: dossier.target.headSha,
          hunks: dossier.hunkIndex.flatMap((entry: { path: string; hunkIds: string[] }) => entry.hunkIds.map((hunkId) => ({ path: entry.path, hunkId }))) };
        suiteYaml = suiteYaml.replace('fixture: repos/core', `fixture: ${repo}`);
      }
      writeFileSync(yaml, suiteYaml);
      const preload = path.join(dir, 'synthetic.mjs');
      writeFileSync(preload, `globalThis.fetch = async (input, init) => {
        if (String(input) !== 'https://openrouter.ai/api/v1/chat/completions') throw new Error('network blocked');
        const body = JSON.parse(init.body); const names = body.tools.map(x => x.function.name);
        const name = ['submit_plan','submit_review','submit_verdict','submit_composition'].find(x => names.includes(x));
        if (!name) throw new Error('unexpected submit tool');
        let findings = [];
        if (name === 'submit_review' && ${scenario === 'checkpoint'}) {
          const prompt = body.messages.map(x => typeof x.content === 'string' ? x.content : (x.content || []).map(y => y.text || '').join('')).join('\\n');
          const marker = prompt.indexOf('untrusted-data label=review-packet'), start = prompt.indexOf('\\n', marker) + 1, end = prompt.indexOf('\\n'+String.fromCharCode(96).repeat(4), start);
          const packet = JSON.parse(prompt.slice(start, end));
          const hunk = packet.hunks.find(x => x.lines.some(y => y.kind === 'add' && y.newLine));
          const line = hunk.lines.find(x => x.kind === 'add' && x.newLine);
          findings = ['correctness','security'].map((category, i) => ({ title:'Synthetic issue '+i, severity:'medium', confidence:'high', path:packet.path, anchor:{path:packet.path,line:line.newLine,side:'RIGHT',hunkId:hunk.hunkId}, category, evidence:{changedCode:line.content}, failureMode:'Synthetic failure '+i, whyThisMatters:'Synthetic impact '+i, verification:'Synthetic evidence.' }));
        }
        const value = name === 'submit_plan' ? {diffUnderstanding:{declaredIntent:'fixture',inferredBehavior:'fixture'},coverage:[]} : name === 'submit_review' ? {reviewStatus:findings.length?'findings':'no_findings',...(findings.length?{}:{noFindingReason:'No issue found.'}),findings,followUpHints:[],uncertainties:[]} : name === 'submit_verdict' ? {verdict:'reject',reason:'Synthetic candidate is refuted.',requiredEvidencePresent:false,falsePositiveRisk:'high',proofAssessment:{status:'refuted',evidence:'Synthetic evidence.',assumptions:[]}} : {summary:'No findings.',composedFindings:[],attentionResolutions:[]};
        if (name === 'submit_verdict') await new Promise(resolve => setTimeout(resolve, 75));
        const base = {id:'fixture',object:'chat.completion.chunk',created:1,model:body.model};
        const chunks = [{...base,choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:'submit',type:'function',function:{name,arguments:JSON.stringify(value)}}]},finish_reason:null}]},{...base,choices:[{index:0,delta:{},finish_reason:'tool_calls'}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15,cost:0.0001,is_byok:false}}];
        return new Response(chunks.map(x => 'data: '+JSON.stringify(x)+'\\n\\n').join('')+'data: [DONE]\\n\\n',{headers:{'content-type':'text/event-stream'}});
      };`);
      vi.stubEnv('NODE_OPTIONS', `--import=${preload}`);
      const caseFile = path.join(dir, 'case.json'), caseBytes = Buffer.from(JSON.stringify({ caseDir: suiteDir, caseName: 'fixture-core-lens', outputDir: path.join(dir, 'output') }));
      writeFileSync(caseFile, caseBytes);
      const build = buildDigest(), expected = { api: 'openai-completions', destination: 'https://openrouter.ai/api/v1/chat/completions', provider: 'openrouter', modelId: 'openai/gpt-6-luna', reasoningSelected: 'high', wireEffort: 'high' };
      const calls = [[5, 'p5.9'], [7, 'p7.16'], [9, 'p9.31'], [10, 'p10.25']].map(([stage, templateVersion]) => ({ ...expected, stage, kind: 'initial', templateVersion }));
      const base = { supervisorPath: path.join(dir, 'supervisor.db'), ledgerPath: path.join(dir, 'ledger.db'), ledgerBinding: 'campaign', boundaryId: 'case1', evidenceDirectory: path.join(dir, 'evidence'), limitMicros: 15_000_000, reserveMicros: 400_000, errorHoldMicros: 50_000, caseConfig: caseFile, caseConfigSHA256: sha(caseBytes), expectedCalls: calls, ...(plannerReplayBinding ? { plannerReplayBinding } : {}), integrity: { suiteDir, suiteSHA256: treeDigest(suiteDir), build } };
      const slots = Array.from({ length: scenario === 'single' ? 1 : 9 }, (_, index) => {
        const id = `slot-${String(index + 1).padStart(2, '0')}`, boundaryId = `case${Math.floor(index / 4) + 1}`;
        return { id, caseId: boundaryId, boundaryId, provider: 'openrouter', expectedPacketIds: packetIds, workerConfig: { ...base, boundaryId } };
      });
      const schedule = Buffer.from(JSON.stringify({ ...(scenario === 'checkpoint' ? { pauseAfterSlot: 'slot-08' } : {}), slots }));
      const schedulePath = path.join(dir, 'schedule.json'); writeFileSync(schedulePath, schedule);
      const config = Buffer.from(JSON.stringify({ binding: 'campaign', schedulePath, scheduleSHA256: sha(schedule), supervisorPath: base.supervisorPath, ledgerPath: base.ledgerPath, evidenceDirectory: base.evidenceDirectory, receiptDirectory: path.join(dir, 'receipts'), workDirectory: path.join(dir, 'work'), limitMicros: base.limitMicros, reserveMicros: base.reserveMicros, errorHoldMicros: base.errorHoldMicros, build, health: { expected: { ...expected, templateVersion: 'campaign-health.1' }, llmConfig: { provider: 'openrouter', model: 'openai/gpt-6-luna', reasoning: 'high', maxConcurrentCalls: 1 } } }));
      const file = path.join(dir, 'campaign.json'); writeFileSync(file, config);
      let gets = 0, healthPosts = 0;
      const fetchImpl = vi.fn(async (input: string) => {
        if (String(input) === 'https://openrouter.ai/api/v1/key') { gets++; return new Response(`{"data":{"usage":${gets === 1 ? 0 : (gets - 1) / 10}}}`); }
        healthPosts++; return healthResponse();
      });
      const models = { getAuth: async () => ({ auth: { apiKey: 'synthetic-key' } }) };
      let campaign = await openCampaign(file, sha(config), { fetchImpl, models });
      let selectedCount = 0, restarted = false, paused = false;
      while (true) {
        const outcome = await campaign.step();
        if (outcome.action === 'selected') {
          selectedCount++;
          expect(campaign.supervisor.receipts.find(outcome.slot, 1)).toMatchObject({ receipt: { status: 'fail', recoveredResets: 0 } });
          if (scenario === 'checkpoint') {
            const receipt = campaign.supervisor.receipts.find(outcome.slot, 1).receipt;
            const models = readFileSync(path.join(receipt.runDir, 'telemetry/model-calls.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
            expect(models.some((row: { stage: number }) => row.stage === 5)).toBe(false);
            const verifierIds = models.filter((row: { stage: number }) => row.stage === 9).map((row: { callId: string }) => `${outcome.slot}/attempt-01/${row.callId}`);
            expect(verifierIds.length).toBeGreaterThanOrEqual(2);
            const starts = verifierIds.map((id: string) => campaign.ledger.db.prepare('SELECT started_at_ms,settled_at_ms FROM physical WHERE logical_id=?').get(id));
            expect(starts.some((left: { started_at_ms: number; settled_at_ms: number }, index: number) => starts.some((right: { started_at_ms: number; settled_at_ms: number }, other: number) => index !== other && left.started_at_ms <= right.started_at_ms && right.started_at_ms < left.settled_at_ms))).toBe(true);
            expect(readFileSync(path.join(receipt.runDir, 'telemetry/events.jsonl'), 'utf8')).toContain('planner_replayed');
          }
          if (scenario === 'checkpoint' && selectedCount === 4 && !restarted) {
            const startsBefore = campaign.ledger.totals().starts, readsBefore = gets;
            const receiptsBefore = campaign.supervisor.db.prepare('SELECT slot_id,receipt_sha256 FROM outcome ORDER BY slot_id').all();
            campaign.close(); campaign = await openCampaign(file, sha(config), { fetchImpl, models });
            expect(campaign.ledger.totals().starts).toBe(startsBefore); expect(gets).toBe(readsBefore);
            expect(campaign.supervisor.db.prepare('SELECT slot_id,receipt_sha256 FROM outcome ORDER BY slot_id').all()).toEqual(receiptsBefore); restarted = true;
          }
        } else if (outcome.action === 'paused') {
          expect(scenario).toBe('checkpoint'); expect(selectedCount).toBe(8);
          expect(campaign.ledger.totals().starts).toBeGreaterThanOrEqual(25);
          expect(campaign.ledger.db.prepare("SELECT COUNT(*) AS n FROM physical WHERE kind='health' AND health_boundary='case3'").get()).toEqual({ n: 0 });
          campaign.releaseCheckpoint(); paused = true;
        } else if (outcome.action === 'completed') break;
        else expect(outcome).toMatchObject({ action: 'health', status: 'clean' });
      }
      expect(selectedCount).toBe(slots.length);
      if (scenario === 'checkpoint') expect({ restarted, paused }).toEqual({ restarted: true, paused: true });
      const starts = campaign.ledger.totals().starts, reads = gets;
      expect(starts).toBeGreaterThan(1);
      expect(campaign.ledger.db.prepare('SELECT physical_starts FROM key_snapshot WHERE fresh=1 ORDER BY rowid DESC LIMIT 1').get()).toEqual({ physical_starts: starts });
      const probes = healthPosts; expect(probes).toBe(scenario === 'single' ? 1 : 3); campaign.close();
      const reopened = await openCampaign(file, sha(config), { fetchImpl, models });
      expect(await reopened.step()).toMatchObject({ action: 'completed' });
      expect(reopened.ledger.totals().starts).toBe(starts);
      expect({ healthPosts, gets }).toEqual({ healthPosts: probes, gets: reads }); reopened.close();
    } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); makeWritable(dir); rmSync(dir, { recursive: true, force: true }); }
  }, 90_000);

});
