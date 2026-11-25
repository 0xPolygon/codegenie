import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { createGitClient } from '../src/git/git-client.js';
import { stableJson } from '../src/util/json.js';
// @ts-expect-error Development-only ESM has no emitted types.
import { openCampaign } from '../evals/runner/campaign.mjs';
// @ts-expect-error Development-only ESM has no emitted types.
import { buildDigest, treeDigest } from '../evals/runner/integrity.mjs';
// @ts-expect-error Development-only ESM has no emitted types.
import { runCase, workerBounds } from '../evals/runner/case.mjs';
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
  it.each(['judge', 'timeout', 'artifacts', 'suite-overlap', 'case-before', 'case-during', 'case-after', 'health-error', 'normal'])('handles %s with bound admission and a network-blocked child', async (scenario) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'eval-driver-'));
    vi.stubEnv('CODEGENIE_HOME', path.join(dir, 'home')); vi.stubEnv('OPENROUTER_API_KEY', 'synthetic-key');
    const preload = path.join(dir, 'block.mjs'); writeFileSync(preload, 'globalThis.fetch = async () => { throw new Error("network blocked"); };\n');
    vi.stubEnv('NODE_OPTIONS', `--import=${preload}`); vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('unexpected network'); }));
    try {
      const suiteDir = scenario === 'suite-overlap' ? path.join(dir, 'model-repo', 'evaluation') : ['judge', 'timeout', 'artifacts'].includes(scenario) ? path.join(dir, 'suite') : path.join(process.cwd(), 'evals/fixtures');
      if (['judge', 'timeout', 'artifacts', 'suite-overlap'].includes(scenario)) {
        cpSync(path.join(process.cwd(), 'evals/fixtures'), suiteDir, { recursive: true });
        if (scenario === 'timeout') appendFileSync(path.join(suiteDir, 'core.yml'), '\n');
        if (scenario === 'timeout') { const yaml = path.join(suiteDir, 'core.yml'); writeFileSync(yaml, readFileSync(yaml, 'utf8').replace('review:\n', 'review:\n  maxTimeMinutes: 35787\n')); }
        if (scenario === 'suite-overlap') {
          const modelRoot = path.join(dir, 'model-repo');
          expect(spawnSync('git', ['-C', modelRoot, 'init', '-q']).status).toBe(0);
          const yaml = path.join(suiteDir, 'core.yml'); writeFileSync(yaml, readFileSync(yaml, 'utf8').replace('fixture: repos/core', `fixture: ${modelRoot}`));
        }
        if (scenario === 'artifacts') writeFileSync(path.join(suiteDir, 'core.yml'), 'name: fixture-core-lens\nartifacts:\n  path: /tmp/synthetic-artifacts\n');
        if (scenario === 'judge') appendFileSync(path.join(suiteDir, 'core.yml'), '\nrecommendationJudge:\n  provider: openrouter\n  model: openai/gpt-6-luna\n  reasoning: high\n  checks:\n    - id: safety\n      rubric: Test rubric.\n');
      }
      const caseFile = path.join(dir, 'case.json'), caseBytes = Buffer.from(JSON.stringify({ caseDir: suiteDir, caseName: 'fixture-core-lens', outputDir: path.join(dir, 'output') }));
      writeFileSync(caseFile, caseBytes);
      const build = buildDigest();
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
        posts++;
        if (scenario === 'health-error') {
          const event = JSON.stringify({ error: { code: 500, message: 'Resource temporarily blocked for synthetic-key' } });
          return new Response(`data: ${event}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
        }
        return healthResponse();
      });
      const models = { getAuth: async () => ({ auth: { apiKey: 'synthetic-key' } }) };
      await expect(openCampaign(file, '0'.repeat(64), { fetchImpl, models })).rejects.toThrow('config digest');
      if (scenario === 'judge') {
        await expect(openCampaign(file, sha(config), { fetchImpl, models })).rejects.toMatchObject({ code: 'config_error', context: { reason: 'unsupported_case_config' } });
        await expect(runCase(caseFile, { budgeted: true })).rejects.toMatchObject({ code: 'config_error', context: { reason: 'unsupported_case_config' } });
        const cli = spawnSync(process.execPath, [path.join(process.cwd(), 'evals/runner/main.mjs'), 'run', '--campaign', file, '--sha256', sha(config)], { encoding: 'utf8' });
        expect(cli.status).toBe(1); expect(cli.stderr).toContain('recommendationJudge is not supported');
        expect({ gets, posts }).toEqual({ gets: 0, posts: 0 });
        expect(existsSync(base.supervisorPath)).toBe(false); expect(existsSync(base.ledgerPath)).toBe(false); return;
      }
      if (scenario === 'suite-overlap') {
        await expect(openCampaign(file, sha(config), { fetchImpl, models })).rejects.toThrow('private input overlaps source checkout');
        expect({ gets, posts }).toEqual({ gets: 0, posts: 0 });
        expect(existsSync(base.supervisorPath)).toBe(false); expect(existsSync(base.ledgerPath)).toBe(false); return;
      }
      if (scenario === 'artifacts') {
        await expect(openCampaign(file, sha(config), { fetchImpl, models })).rejects.toMatchObject({ code: 'config_error', context: { reason: 'unsupported_case_config' } });
        expect({ gets, posts }).toEqual({ gets: 0, posts: 0 });
        expect(existsSync(base.supervisorPath)).toBe(false); expect(existsSync(base.ledgerPath)).toBe(false); return;
      }
      if (scenario === 'timeout') {
        await expect(openCampaign(file, sha(config), { fetchImpl, models })).rejects.toMatchObject({ code: 'config_error', context: { reason: 'unsupported_case_config' } });
        const yaml = path.join(suiteDir, 'core.yml');
        const tooLong = readFileSync(yaml, 'utf8'); writeFileSync(yaml, tooLong.replace('35787', '35786'));
        expect((await workerBounds(caseFile, caseBytes, 'one/attempt-01')).timeoutMs).toBe(35786 * 60_000);
        writeFileSync(yaml, tooLong);
        const cli = spawnSync(process.execPath, [path.join(process.cwd(), 'evals/runner/main.mjs'), 'run', '--campaign', file, '--sha256', sha(config)], { encoding: 'utf8' });
        expect(cli.status).toBe(1); expect(cli.stderr).toContain('watchdog limit');
        expect({ gets, posts }).toEqual({ gets: 0, posts: 0 }); expect(existsSync(base.supervisorPath)).toBe(false); return;
      }
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
      if (scenario === 'health-error') {
        const result = await campaign.step();
        const diagnostic = { source: 'error.message', message: 'Resource temporarily blocked for [redacted:secret]' };
        expect(result).toMatchObject({ action: 'stop', reason: 'health_failed', diagnostic, diagnosticSHA256: expect.stringMatching(/^[a-f0-9]{64}$/u) });
        const bytes = readFileSync(path.join(base.evidenceDirectory, result.diagnosticSHA256));
        expect(sha(bytes)).toBe(result.diagnosticSHA256);
        expect(JSON.parse(bytes.toString())).toMatchObject({ kind: 'health_diagnostic', httpStatus: 200, streamTerminal: 'provider_error_event', ...diagnostic });
        expect(campaign.ledger.db.prepare('SELECT COUNT(*) AS n FROM health_receipt').get()).toEqual({ n: 0 });
        expect(await campaign.step()).toEqual({ action: 'stop', reason: 'health_failed' });
        expect({ gets, posts }).toEqual({ gets: 1, posts: 1 }); campaign.close(); return;
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
  it.each(['single', 'positive', 'treatment', 'stopped', 'worker-stop', 'arms', 'checkpoint', 'quota'])('completes and reconciles a %s synthetic campaign through the real adapter and child', async (scenario) => {
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
      if (scenario !== 'checkpoint' && scenario !== 'arms') suiteYaml = suiteYaml.replace('verify: true', 'verify: false');
      const sharedCache = path.join(dir, 'shared-cache');
      if (scenario === 'checkpoint' || scenario === 'arms') {
        suiteYaml = suiteYaml.replace('cache: false', `cache: true\n  cacheDir: ${sharedCache}`);
      }
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
      if (['single', 'positive', 'treatment', 'stopped', 'worker-stop', 'arms'].includes(scenario)) suiteYaml = suiteYaml.replace('fixture: repos/core', `fixture: ${path.join(baseline.runDir, 'fixture-repo')}`);
      writeFileSync(yaml, suiteYaml);
      const preload = path.join(dir, 'synthetic.mjs');
      writeFileSync(preload, `globalThis.fetch = async (input, init) => {
        if (String(input) !== 'https://openrouter.ai/api/v1/chat/completions') throw new Error('network blocked');
        const body = JSON.parse(init.body); const names = body.tools.map(x => x.function.name);
        const name = ['submit_plan','submit_review','submit_verdict','submit_composition'].find(x => names.includes(x));
        if (!name) throw new Error('unexpected submit tool');
        if ((${scenario === 'quota'} || (${scenario === 'worker-stop'} && process.argv[2]?.includes('slot-02'))) && name === 'submit_plan') return new Response(JSON.stringify({error:{message:'quota exceeded',type:'insufficient_quota'}}), {status:400,headers:{'content-type':'application/json'}});
        let findings = [];
        if (name === 'submit_review' && ${scenario === 'checkpoint' || scenario === 'arms'}) {
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
      let blind;
      if (['single', 'positive', 'treatment', 'stopped', 'worker-stop'].includes(scenario)) {
        const sourceRoot = path.join(baseline.runDir, 'fixture-repo');
        const revision = spawnSync('git', ['-C', sourceRoot, 'rev-parse', 'feature'], { encoding: 'utf8' }).stdout.trim();
        const oraclePath = path.join(dir, 'oracle.txt'); writeFileSync(oraclePath, 'Synthetic oracle.');
        const oracleManifestPath = path.join(dir, 'oracle-manifest.json'); writeFileSync(oracleManifestPath, JSON.stringify({ cases: [{ caseId: 'case1', sha256: sha(readFileSync(oraclePath)), causes: scenario === 'positive' ? [{ id: 'required-cause', optional: false, anchors: [{ path: 'src/core.js', lineRange: [1, 1] }] }] : [] }] }));
        const locatorManifestPath = path.join(dir, 'locators.json');
        writeFileSync(locatorManifestPath, JSON.stringify({ cases: [{ caseId: 'case1', label: 'case-01', sourceLocator: 'source/case-01', oracleLocator: 'oracle/case-01', sourceRoot, sourceRevision: revision, oraclePath, oracleSHA256: sha(readFileSync(oraclePath)) }] }));
        blind = { locatorManifestPath, locatorManifestSHA256: sha(readFileSync(locatorManifestPath)), oracleManifestPath, oracleManifestSHA256: sha(readFileSync(oracleManifestPath)), mappingFile: path.join(dir, 'sealed', 'mapping.json') };
      }
      const build = buildDigest(), expected = { api: 'openai-completions', destination: 'https://openrouter.ai/api/v1/chat/completions', provider: 'openrouter', modelId: 'openai/gpt-6-luna', reasoningSelected: 'high', wireEffort: 'high' };
      const calls = [[5, 'p5.9'], [7, 'p7.16'], [9, 'p9.31'], [10, 'p10.25']].map(([stage, templateVersion]) => ({ ...expected, stage, kind: 'initial', templateVersion }));
      if (['single', 'positive', 'treatment', 'stopped', 'worker-stop'].includes(scenario)) calls.push({ ...expected, stage: 7, kind: 'initial', purpose: 'location_clarification', templateVersion: 'location-clarification-v1' } as typeof calls[number]);
      const base = { supervisorPath: path.join(dir, 'supervisor.db'), ledgerPath: path.join(dir, 'ledger.db'), ledgerBinding: 'campaign', boundaryId: 'case1', evidenceDirectory: path.join(dir, 'evidence'), limitMicros: 15_000_000, reserveMicros: 400_000, errorHoldMicros: 50_000, caseConfig: caseFile, caseConfigSHA256: sha(caseBytes), expectedCalls: calls, ...(plannerReplayBinding ? { plannerReplayBinding } : {}), integrity: { suiteDir, suiteSHA256: treeDigest(suiteDir), build } };
      const slots = Array.from({ length: scenario === 'checkpoint' ? 9 : scenario === 'arms' ? 4 : ['stopped', 'worker-stop'].includes(scenario) ? 2 : 1 }, (_, index) => {
        const id = `slot-${String(index + 1).padStart(2, '0')}`, boundaryId = `case${Math.floor(index / 4) + 1}`;
        const arm = scenario === 'treatment' || (['stopped', 'worker-stop'].includes(scenario) && index === 1) || (scenario === 'arms' && (index === 1 || index === 2)) ? 'treatment' : 'control';
        const blinded = ['single', 'positive', 'treatment', 'stopped', 'worker-stop', 'arms'].includes(scenario);
        const packetTemplates = packetIds.map((packetId: string) => ({ packetId, templates: Object.fromEntries(['initial', 'tool-continuation', 'repair', 'finalize'].map((kind) => [kind, 'p7.16'])) }));
        return { id, caseId: boundaryId, boundaryId, provider: 'openrouter', expectedPacketIds: packetIds, ...(blinded ? { blind: { arm, draw: scenario === 'arms' && index >= 2 ? 2 : 1 } } : {}), workerConfig: { ...base, boundaryId, ...(blinded ? { packetTemplates } : {}) } };
      });
      const schedule = Buffer.from(JSON.stringify({ ...(scenario === 'checkpoint' ? { pauseAfterSlot: 'slot-08' } : {}), slots }));
      const schedulePath = path.join(dir, 'schedule.json'); writeFileSync(schedulePath, schedule);
      const config = Buffer.from(JSON.stringify({ binding: 'campaign', schedulePath, scheduleSHA256: sha(schedule), supervisorPath: base.supervisorPath, ledgerPath: base.ledgerPath, evidenceDirectory: base.evidenceDirectory, receiptDirectory: path.join(dir, 'receipts'), workDirectory: path.join(dir, 'work'), limitMicros: base.limitMicros, reserveMicros: base.reserveMicros, errorHoldMicros: base.errorHoldMicros, build, ...(blind ? { blind } : {}), health: { expected: { ...expected, templateVersion: 'campaign-health.1' }, llmConfig: { provider: 'openrouter', model: 'openai/gpt-6-luna', reasoning: 'high', maxConcurrentCalls: 1 } } }));
      const file = path.join(dir, 'campaign.json'); writeFileSync(file, config);
      if (scenario === 'checkpoint') {
        const release = spawnSync(process.execPath, [path.join(process.cwd(), 'evals/runner/main.mjs'), 'release', '--campaign', file, '--sha256', sha(config)], { encoding: 'utf8' });
        expect(release.status).toBe(1);
        for (const item of [base.supervisorPath, base.ledgerPath, base.evidenceDirectory, path.join(dir, 'receipts'), path.join(dir, 'work')]) expect(existsSync(item)).toBe(false);
      }
      let gets = 0, healthPosts = 0;
      const fetchImpl = vi.fn(async (input: string) => {
        if (String(input) === 'https://openrouter.ai/api/v1/key') { gets++; return new Response(`{"data":{"usage":${gets === 1 ? 0 : (gets - 1) / 10}}}`); }
        healthPosts++; return healthResponse();
      });
      const models = { getAuth: async () => ({ auth: { apiKey: 'synthetic-key' } }) };
      if (scenario === 'treatment') {
        const swappedSchedule = JSON.parse(schedule.toString('utf8'));
        swappedSchedule.slots[0].workerConfig.packetTemplates[0].templates.initial = 'retired-template';
        const swappedBytes = Buffer.from(JSON.stringify(swappedSchedule)), swappedPath = path.join(dir, 'swapped-schedule.json'); writeFileSync(swappedPath, swappedBytes);
        const swappedConfig = { ...JSON.parse(config.toString('utf8')), schedulePath: swappedPath, scheduleSHA256: sha(swappedBytes) };
        const swappedConfigBytes = Buffer.from(JSON.stringify(swappedConfig)), swappedFile = path.join(dir, 'swapped-campaign.json'); writeFileSync(swappedFile, swappedConfigBytes);
        await expect(openCampaign(swappedFile, sha(swappedConfigBytes), { fetchImpl, models })).rejects.toThrow('packet template binding');
        expect({ gets, healthPosts }).toEqual({ gets: 0, healthPosts: 0 });
      }
      let campaign = await openCampaign(file, sha(config), { fetchImpl, models });
      let selectedCount = 0, restarted = false, paused = false;
      const stagePrompts = new Map<number, string[]>();
      const armPrompts = new Map<string, string[]>();
      while (true) {
        const outcome = await campaign.step();
        if (scenario === 'worker-stop' && outcome.action === 'stop') { expect(outcome.reason).toBe('provider_quota'); break; }
        if (scenario === 'quota' && outcome.action === 'stop') {
          expect(outcome).toMatchObject({ reason: 'provider_quota', slot: 'slot-01', receiptSHA256: expect.stringMatching(/^[a-f0-9]{64}$/) });
          expect(campaign.supervisor.receipts.find('slot-01', 1).hash).toBe(outcome.receiptSHA256);
          expect(campaign.ledger.totals()).toMatchObject({ starts: 2, unknown: 1, stopped: 'provider_quota' });
          const priorGets = gets, priorPosts = healthPosts; campaign.close();
          const reopened = await openCampaign(file, sha(config), { fetchImpl, models });
          expect(await reopened.step()).toMatchObject({ action: 'stop', reason: 'provider_quota' });
          expect({ gets, healthPosts }).toEqual({ gets: priorGets, healthPosts: priorPosts }); reopened.close(); return;
        }
        if (outcome.action === 'selected') {
          selectedCount++;
          if (scenario === 'stopped') { campaign.ledger.stop('budget_limit'); break; }
          expect(campaign.supervisor.receipts.find(outcome.slot, 1)).toMatchObject({ receipt: { status: 'fail', recoveredResets: 0 } });
          if (scenario === 'checkpoint' || scenario === 'arms') {
            const receipt = campaign.supervisor.receipts.find(outcome.slot, 1).receipt;
            const models = readFileSync(path.join(receipt.runDir, 'telemetry/model-calls.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
            if (scenario === 'checkpoint') expect(models.some((row: { stage: number }) => row.stage === 5)).toBe(false);
            for (const stage of [7, 9, 10]) {
              const calls = models.filter((row: { stage: number }) => row.stage === stage);
              expect(calls.length).toBeGreaterThan(0);
              for (const row of calls) {
                expect(row.cacheStatus).toBe('disabled');
                expect(campaign.ledger.db.prepare('SELECT COUNT(*) AS n FROM physical WHERE logical_id=?').get(`${outcome.slot}/attempt-01/${row.callId}`).n).toBeGreaterThan(0);
                if (stage === 9 || stage === 10) {
                  // promptHash hashes the canonical request used as the cache key.
                  const fingerprint = `${row.promptHash}:${row.provider}:${row.model}`;
                  stagePrompts.set(stage, [...(stagePrompts.get(stage) ?? []), fingerprint]);
                  if (scenario === 'arms') { const arm = slots.find((slot) => slot.id === outcome.slot)!.blind!.arm; const key = `${stage}:${arm}`; armPrompts.set(key, [...(armPrompts.get(key) ?? []), fingerprint]); }
                }
              }
            }
            expect(existsSync(sharedCache)).toBe(false);
            const verifierIds = models.filter((row: { stage: number }) => row.stage === 9).map((row: { callId: string }) => `${outcome.slot}/attempt-01/${row.callId}`);
            expect(verifierIds.length).toBeGreaterThanOrEqual(2);
            const starts = verifierIds.map((id: string) => campaign.ledger.db.prepare('SELECT started_at_ms,settled_at_ms FROM physical WHERE logical_id=?').get(id));
            expect(starts.some((left: { started_at_ms: number; settled_at_ms: number }, index: number) => starts.some((right: { started_at_ms: number; settled_at_ms: number }, other: number) => index !== other && left.started_at_ms <= right.started_at_ms && right.started_at_ms < left.settled_at_ms))).toBe(true);
            if (scenario === 'checkpoint') expect(readFileSync(path.join(receipt.runDir, 'telemetry/events.jsonl'), 'utf8')).toContain('planner_replayed');
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
          expect(outcome.receipts).toHaveLength(8); expect(outcome.ledger.starts).toBe(campaign.ledger.totals().starts);
          const premature = { outputDirectory: path.join(dir, 'premature-blind'), mappingFile: path.join(dir, 'premature-private', 'mapping.json') };
          expect(() => campaign.exportBlind(premature)).toThrow('campaign is not terminal');
          expect(existsSync(premature.mappingFile)).toBe(false);
          const evidenceHash = campaign.ledger.db.prepare('SELECT evidence_sha256 FROM key_baseline').get().evidence_sha256;
          const evidenceFile = path.join(base.evidenceDirectory, evidenceHash), originalEvidence = readFileSync(evidenceFile);
          campaign.close();
          const pausedRun = spawnSync(process.execPath, [path.join(process.cwd(), 'evals/runner/main.mjs'), 'run', '--campaign', file, '--sha256', sha(config)], { encoding: 'utf8' });
          expect(pausedRun.status).toBe(0);
          const operational = JSON.parse(pausedRun.stdout);
          expect(operational).toMatchObject({ action: 'paused', prefixSHA256: outcome.prefixSHA256 });
          expect(operational.receipts.every((row: Record<string, unknown>) => row.outcome === 'selected' && !('status' in row))).toBe(true);
          expect(pausedRun.stdout).not.toMatch(/"(?:pass|fail)"/);
          appendFileSync(evidenceFile, 'drift');
          const denied = spawnSync(process.execPath, [path.join(process.cwd(), 'evals/runner/main.mjs'), 'release', '--campaign', file, '--sha256', sha(config)], { encoding: 'utf8' });
          expect(denied.status).toBe(1); writeFileSync(evidenceFile, originalEvidence);
          const release = spawnSync(process.execPath, [path.join(process.cwd(), 'evals/runner/main.mjs'), 'release', '--campaign', file, '--sha256', sha(config)], { encoding: 'utf8' });
          expect(release.status).toBe(0);
          expect(JSON.parse(release.stdout)).toEqual({ action: 'released', prefixSHA256: outcome.prefixSHA256 });
          campaign = await openCampaign(file, sha(config), { fetchImpl, models }); paused = true;
        } else if (outcome.action === 'completed') break;
        else expect(outcome).toMatchObject({ action: 'health', status: 'clean' });
      }
      expect(selectedCount).toBe(['stopped', 'worker-stop'].includes(scenario) ? 1 : slots.length);
      if (scenario === 'checkpoint') expect({ restarted, paused }).toEqual({ restarted: true, paused: true });
      if (scenario === 'checkpoint' || scenario === 'arms') for (const stage of [9, 10]) { const prompts = stagePrompts.get(stage) ?? []; expect(new Set(prompts).size).toBeLessThan(prompts.length); }
      if (scenario === 'arms') for (const stage of [9, 10]) { const control = new Set(armPrompts.get(`${stage}:control`)); expect((armPrompts.get(`${stage}:treatment`) ?? []).some((value) => control.has(value))).toBe(true); }
      const starts = campaign.ledger.totals().starts, reads = gets;
      expect(starts).toBeGreaterThan(1);
      if (!['stopped', 'worker-stop'].includes(scenario)) expect(campaign.ledger.db.prepare('SELECT physical_starts FROM key_snapshot WHERE fresh=1 ORDER BY rowid DESC LIMIT 1').get()).toEqual({ physical_starts: starts });
      const probes = healthPosts; expect(probes).toBe(scenario === 'checkpoint' ? 3 : 1); campaign.close();
      let reopened = await openCampaign(file, sha(config), { fetchImpl, models });
      expect(await reopened.step()).toMatchObject(scenario === 'stopped' ? { action: 'stop', reason: 'budget_limit' } : scenario === 'worker-stop' ? { action: 'stop', reason: 'provider_quota' } : { action: 'completed' });
      expect(reopened.ledger.totals().starts).toBe(starts);
      expect({ healthPosts, gets }).toEqual({ healthPosts: probes, gets: reads });
      if (['single', 'positive', 'treatment', 'stopped', 'worker-stop'].includes(scenario)) {
        const exportArgs = { outputDirectory: path.join(dir, 'blind-output'), mappingFile: path.join(dir, 'sealed', 'mapping.json') };
        if (!['stopped', 'worker-stop'].includes(scenario)) {
          reopened.ledger.db.exec('BEGIN');
          reopened.ledger.db.prepare('DELETE FROM key_snapshot WHERE boundary_id LIKE ?').run('final-%');
          expect(() => reopened.exportBlind(exportArgs)).toThrow('final key snapshot');
          reopened.ledger.db.exec('ROLLBACK');
        }
        expect(existsSync(exportArgs.mappingFile)).toBe(false);
        if (scenario === 'worker-stop') {
          const receiptDir = path.join(dir, 'receipts');
          const receiptName = readdirSync(receiptDir).filter((name) => name.startsWith('attempt-')).find((name) => JSON.parse(readFileSync(path.join(receiptDir, name), 'utf8')).slot === 'slot-02')!;
          const receiptFile = path.join(receiptDir, receiptName), backup = `${receiptFile}.backup`;
          renameSync(receiptFile, backup); expect(() => reopened.exportBlind(exportArgs)).toThrow('reconciliation'); renameSync(backup, receiptFile);
          reopened.supervisor.db.exec('BEGIN');
          reopened.supervisor.db.prepare("UPDATE worker_claim SET spawn_state='claimed' WHERE slot_id='slot-02'").run();
          expect(() => reopened.exportBlind(exportArgs)).toThrow('reconciliation'); reopened.supervisor.db.exec('ROLLBACK');
          expect(existsSync(exportArgs.mappingFile)).toBe(false);
          reopened.ledger.db.exec('BEGIN');
          reopened.ledger.db.prepare("UPDATE campaign SET stopped='case_reset_limit'").run();
          expect(() => reopened.exportBlind(exportArgs)).toThrow('case reset stop requires reconciliation');
          reopened.ledger.db.exec('ROLLBACK');
        }
        const result = reopened.exportBlind(exportArgs);
        expect(result).toMatchObject({ sheetCount: 1, excludedCount: 0 });
        expect(reopened.exportBlind(exportArgs)).toEqual(result);
        reopened.close();
        const exported = spawnSync(process.execPath, [path.join(process.cwd(), 'evals/runner/main.mjs'), 'export-blind', '--campaign', file, '--sha256', sha(config), '--output', exportArgs.outputDirectory, '--mapping', exportArgs.mappingFile], { encoding: 'utf8' });
        expect(exported.status).toBe(0); expect(JSON.parse(exported.stdout)).toEqual(result);
        reopened = await openCampaign(file, sha(config), { fetchImpl, models });
        const mappingBackup = `${exportArgs.mappingFile}.backup`; renameSync(exportArgs.mappingFile, mappingBackup);
        expect(() => reopened.exportBlind(exportArgs)).toThrow('mapping custody');
        expect(existsSync(exportArgs.mappingFile)).toBe(false); renameSync(mappingBackup, exportArgs.mappingFile);
        const selectedReceipt = reopened.supervisor.receipts.find('slot-01', 1).receipt;
        const frozen = path.join(selectedReceipt.runDir, 'telemetry/final-review.json'), originalFinal = readFileSync(frozen);
        chmodSync(frozen, 0o600); writeFileSync(frozen, '{}');
        expect(() => reopened.exportBlind(exportArgs)).toThrow();
        writeFileSync(frozen, originalFinal); chmodSync(frozen, 0o400);
        const sourceRoot = path.join(baseline.runDir, 'fixture-repo');
        expect(spawnSync('git', ['-C', sourceRoot, 'checkout', '--detach', 'HEAD^']).status).toBe(0);
        expect(() => reopened.exportBlind(exportArgs)).toThrow('source or oracle changed');
        expect(spawnSync('git', ['-C', sourceRoot, 'checkout', 'feature']).status).toBe(0);
        const originalOracle = readFileSync(path.join(dir, 'oracle.txt')); writeFileSync(path.join(dir, 'oracle.txt'), 'changed');
        expect(() => reopened.exportBlind(exportArgs)).toThrow('source or oracle changed');
        writeFileSync(path.join(dir, 'oracle.txt'), originalOracle);
        const manifest = JSON.parse(readFileSync(path.join(exportArgs.outputDirectory, 'manifest.json'), 'utf8'));
        if (scenario === 'positive') expect(manifest.sheets[0].causes).toEqual([{ id: 'required-cause', optional: false }]);
        expect(manifest).toMatchObject({ campaignState: ['stopped', 'worker-stop'].includes(scenario) ? 'stopped' : 'completed', selectedCount: 1 });
        expect(JSON.parse(readFileSync(path.join(selectedReceipt.runDir, 'packet-calls.json'), 'utf8'))).toMatchObject([{ templateVersion: 'p7.16' }]);
        if (scenario === 'treatment') {
          const lock = (name: string, value: unknown) => { const bytes = Buffer.from(JSON.stringify(value)), dest = path.join(dir, name); writeFileSync(dest, bytes); return { path: dest, sha256: sha(bytes) }; };
          const sheetId = manifest.sheets[0].id;
          const grades = [{ id: sheetId, noApplicableCauses: true, causes: [], otherClaims: { survivingMediumPlus: [], published: [] } }];
          const a = lock('lock-a.json', { analyst: 'a', manifestSHA256: result.manifestSHA256, grades });
          const b = lock('lock-b.json', { analyst: 'b', manifestSHA256: result.manifestSHA256, grades });
          const reconciliation = lock('reconciliation.json', { manifestSHA256: result.manifestSHA256, lockSHA256: [a.sha256, b.sha256], grades });
          const reveal = { manifestFile: path.join(exportArgs.outputDirectory, 'manifest.json'), manifestSHA256: result.manifestSHA256, mappingFile: exportArgs.mappingFile, locks: [a, b], reconciliation, outputFile: path.join(dir, 'reveal', 'pairing.json') };
          await expect(reopened.reveal({ ...reveal, reconciliation: undefined })).rejects.toThrow();
          expect(existsSync(reveal.outputFile)).toBe(false);
          expect((await reopened.reveal(reveal)).reviewCount).toBe(1);
          const changedReconciliation = lock('changed-reconciliation.json', { manifestSHA256: result.manifestSHA256, lockSHA256: [a.sha256, b.sha256], grades, changed: true });
          reopened.close(); reopened = await openCampaign(file, sha(config), { fetchImpl, models });
          const changedOutput = path.join(dir, 'changed-reveal', 'pairing.json');
          await expect(reopened.reveal({ ...reveal, reconciliation: changedReconciliation, outputFile: changedOutput })).rejects.toThrow('reconciliation binding');
          expect(existsSync(changedOutput)).toBe(false);
          expect((await reopened.reveal(reveal)).reviewCount).toBe(1);
        }
        const alternate = { outputDirectory: path.join(dir, 'other-output'), mappingFile: path.join(dir, 'other', 'mapping.json') };
        expect(() => reopened.exportBlind(alternate)).toThrow('mapping path');
        expect(existsSync(alternate.mappingFile)).toBe(false);
      }
      if (scenario === 'single') reopened.ledger.db.prepare("UPDATE physical SET charge=0 WHERE id=(SELECT id FROM physical WHERE state='priced' AND charge>0 LIMIT 1)").run();
      reopened.close();
      if (scenario === 'single') {
        const drifted = await openCampaign(file, sha(config), { fetchImpl, models });
        expect(await drifted.step()).toMatchObject({ action: 'stop', reason: 'accounting_failed' });
        expect({ healthPosts, gets }).toEqual({ healthPosts: probes, gets: reads }); drifted.close();
      }
    } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); makeWritable(dir); rmSync(dir, { recursive: true, force: true }); }
  }, 90_000);

});
