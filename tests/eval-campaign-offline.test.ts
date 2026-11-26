import { createHash } from 'node:crypto';
import { chmodSync, cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
// @ts-expect-error Development-only ESM has no emitted types.
import { openCampaign } from '../evals/runner/campaign.mjs';
// @ts-expect-error Development-only ESM has no emitted types.
import { buildDigest, treeDigest } from '../evals/runner/integrity.mjs';
// @ts-expect-error Development-only ESM has no emitted types.
import { CampaignLedger } from '../evals/runner/ledger.mjs';
const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
function writable(dir: string) { const stat = lstatSync(dir); if (stat.isSymbolicLink()) return; chmodSync(dir, stat.isDirectory() ? 0o700 : 0o600); if (stat.isDirectory()) for (const entry of readdirSync(dir)) writable(path.join(dir, entry)); }
function healthResponse() {
  const base = { id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'openai/gpt-6-luna' };
  const chunks = [{ ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'submit', type: 'function', function: { name: 'submit_plan', arguments: '{"ok":true}' } }] }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.0001, is_byok: false } }];
  return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
}

it('runs an 80-slot synthetic bound campaign through pause, release and restart without duplicate starts', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'eval-campaign-offline-'));
  vi.stubEnv('CODEGENIE_HOME', path.join(dir, 'home')); vi.stubEnv('OPENROUTER_API_KEY', 'synthetic-key');
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('unexpected network'); }));
  try {
    const caseIds = Array.from({ length: 20 }, (_, index) => `fixture-${String(index + 1).padStart(2, '0')}`);
    const sourceRoot = path.join(dir, 'source'); mkdirSync(sourceRoot);
    execFileSync('git', ['-C', sourceRoot, 'init', '-q']); execFileSync('git', ['-C', sourceRoot, 'config', 'user.name', 'Synthetic']); execFileSync('git', ['-C', sourceRoot, 'config', 'user.email', 'synthetic@example.test']);
    writeFileSync(path.join(sourceRoot, 'source.txt'), 'base'); execFileSync('git', ['-C', sourceRoot, 'add', '.']); execFileSync('git', ['-C', sourceRoot, 'commit', '-qm', 'base']);
    writeFileSync(path.join(sourceRoot, 'source.txt'), 'source'); execFileSync('git', ['-C', sourceRoot, 'add', '.']); execFileSync('git', ['-C', sourceRoot, 'commit', '-qm', 'synthetic']);
    const sourceBranch = execFileSync('git', ['-C', sourceRoot, 'branch', '--show-current'], { encoding: 'utf8' }).trim();
    const sourceRevision = execFileSync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const caseOracle = path.join(dir, 'oracle.txt'); writeFileSync(caseOracle, 'synthetic oracle');
    const oraclePath = path.join(dir, 'oracle-manifest.json'), oracleBytes = Buffer.from(JSON.stringify({ cases: caseIds.map((caseId) => ({ caseId, sha256: sha(readFileSync(caseOracle)), causes: [] })) })); writeFileSync(oraclePath, oracleBytes);
    const locatorPath = path.join(dir, 'locators.json'), locatorBytes = Buffer.from(JSON.stringify({ cases: caseIds.map((caseId) => ({ caseId, label: caseId, sourceLocator: `source/${caseId}`, oracleLocator: `oracle/${caseId}`, sourceRoot, sourceRevision, oraclePath: caseOracle, oracleSHA256: sha(readFileSync(caseOracle)) })) })); writeFileSync(locatorPath, locatorBytes);
    const suiteDir = path.join(process.cwd(), 'evals/fixtures'), caseFile = path.join(dir, 'case.json');
    const caseBytes = Buffer.from(JSON.stringify({ caseDir: suiteDir, caseName: 'fixture-core-lens', outputDir: path.join(dir, 'output') })); writeFileSync(caseFile, caseBytes);
    const build = buildDigest(), integrity = { suiteDir, suiteSHA256: treeDigest(suiteDir), build };
    const base = { supervisorPath: path.join(dir, 'supervisor.db'), ledgerPath: path.join(dir, 'ledger.db'), ledgerBinding: 'campaign', evidenceDirectory: path.join(dir, 'evidence'), limitMicros: 15_000_000, reserveMicros: 400_000, errorHoldMicros: 50_000, caseConfig: caseFile, caseConfigSHA256: sha(caseBytes), integrity };
    const expected = { api: 'openai-completions', destination: 'https://openrouter.ai/api/v1/chat/completions', provider: 'openrouter', modelId: 'openai/gpt-6-luna', reasoningSelected: 'high', wireEffort: 'high' };
    const order = caseIds.flatMap((caseId) => ['control', 'treatment', 'treatment', 'control'].map((arm, index) => ({ caseId, arm, draw: index < 2 ? 1 : 2 })));
    const slots = order.map((item, index) => {
      const id = `slot-${String(index + 1).padStart(2, '0')}`;
      return { id, caseId: item.caseId, boundaryId: item.caseId, provider: 'openrouter', expectedPacketIds: ['packet'], blind: { arm: item.arm, draw: item.draw },
        workerConfig: { ...base, boundaryId: item.caseId, packetTemplates: [{ packetId: 'packet', templates: Object.fromEntries(['initial', 'tool-continuation', 'repair', 'finalize'].map((kind) => [kind, 'p7.16'])) }], expectedCalls: ['initial', 'tool-continuation', 'repair', 'finalize'].flatMap((kind) => [{ ...expected, stage: 7, kind, templateVersion: 'p7.16' }, { ...expected, stage: 7, kind, purpose: 'location_clarification', templateVersion: 'location-clarification-v1' }]) } };
    });
    const schedule = Buffer.from(JSON.stringify({ pauseAfterSlot: slots[7]!.id, slots })), schedulePath = path.join(dir, 'schedule.json'); writeFileSync(schedulePath, schedule);
    const config = Buffer.from(JSON.stringify({ binding: 'campaign', schedulePath, scheduleSHA256: sha(schedule), supervisorPath: base.supervisorPath, ledgerPath: base.ledgerPath, evidenceDirectory: base.evidenceDirectory, receiptDirectory: path.join(dir, 'receipts'), workDirectory: path.join(dir, 'work'), limitMicros: base.limitMicros, reserveMicros: base.reserveMicros, errorHoldMicros: base.errorHoldMicros, build,
      blind: { oracleManifestPath: oraclePath, oracleManifestSHA256: sha(oracleBytes), locatorManifestPath: locatorPath, locatorManifestSHA256: sha(locatorBytes), mappingFile: path.join(dir, 'sealed', 'mapping.json') },
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
      writeFileSync(path.join(runDir, 'info.json'), JSON.stringify({ effectiveConfig: { llm: { provider: 'openrouter', model: 'openai/gpt-6-luna', reasoning: 'high' } } }));
      writeFileSync(path.join(telemetry, 'run.json'), JSON.stringify({ runId, outcome: { status: 'completed_full' } }));
      writeFileSync(path.join(telemetry, 'telemetry.json'), JSON.stringify({ runId, events: 1, packets: { generated: 1 }, modelCalls: { totalRecords: 1 }, toolCalls: { totalCalls: 0 } }));
      writeFileSync(path.join(telemetry, 'model-calls.jsonl'), JSON.stringify({ runId, callId: 'mc-1', stage: 7, kind: 'initial', provider: 'openrouter', model: 'openai/gpt-6-luna', reasoningSelected: 'high', cacheStatus: 'disabled', status: 'ok', inputTokens: 1, outputTokens: 0, totalTokens: 1 }) + '\n');
      writeFileSync(path.join(telemetry, 'events.jsonl'), JSON.stringify({ runId, eventId: 'ev-1', stage: 7, message: 'structured_submission_accepted', data: { packetId: 'packet' } }) + '\n');
      writeFileSync(path.join(telemetry, 'stages/06-packets/packets/packet.json'), JSON.stringify({ id: 'packet' }));
      supervisor.recordWorkerExit(slotId, attemptNo); return { caseName: 'fixture-core-lens', status: 'fail', runDir };
    };
    const dependencies = { fetchImpl, models, spawnWorker };
    // Two requested IDs must never be represented by one NUL-containing ID.
    const collisionIds = `${caseIds[0]}\0${caseIds[1]}`;
    const collidingLocator = JSON.parse(locatorBytes.toString('utf8')), collidingOracle = JSON.parse(oracleBytes.toString('utf8'));
    for (const manifest of [collidingLocator, collidingOracle]) { manifest.cases[0].caseId = collisionIds; manifest.cases.splice(1, 1); }
    const locatorCollisionBytes = Buffer.from(JSON.stringify(collidingLocator)), oracleCollisionBytes = Buffer.from(JSON.stringify(collidingOracle));
    const locatorCollisionPath = path.join(dir, 'collision-locators.json'), oracleCollisionPath = path.join(dir, 'collision-oracles.json');
    writeFileSync(locatorCollisionPath, locatorCollisionBytes); writeFileSync(oracleCollisionPath, oracleCollisionBytes);
    const collisionConfig = JSON.parse(config.toString('utf8'));
    Object.assign(collisionConfig.blind, { locatorManifestPath: locatorCollisionPath, locatorManifestSHA256: sha(locatorCollisionBytes), oracleManifestPath: oracleCollisionPath, oracleManifestSHA256: sha(oracleCollisionBytes) });
    const collisionBytes = Buffer.from(JSON.stringify(collisionConfig)), collisionPath = path.join(dir, 'collision-config.json'); writeFileSync(collisionPath, collisionBytes);
    await expect(openCampaign(collisionPath, sha(collisionBytes), dependencies)).rejects.toThrow('blind case membership');
    // A clean reviewed repository must never contain oracle or suite inputs,
    // even if a locator reaches the repository through an aliased parent.
    const ignored = path.join(sourceRoot, 'private-testing'); mkdirSync(ignored);
    writeFileSync(path.join(sourceRoot, '.git/info/exclude'), 'private-testing/\n');
    const sourceAlias = path.join(dir, 'source-alias'); symlinkSync(sourceRoot, sourceAlias, 'dir');
    for (const kind of ['oracle', 'oracle-alias', 'locator-manifest', 'oracle-manifest', 'suite']) {
      const privateConfig = JSON.parse(config.toString('utf8'));
      if (kind === 'oracle' || kind === 'oracle-alias') {
        const leakedLocators = JSON.parse(locatorBytes.toString('utf8')), leakedOracles = JSON.parse(oracleBytes.toString('utf8'));
        leakedLocators.cases[0].oraclePath = path.join(kind === 'oracle' ? sourceRoot : sourceAlias, 'source.txt');
        leakedLocators.cases[0].oracleSHA256 = sha(readFileSync(path.join(sourceRoot, 'source.txt')));
        leakedOracles.cases[0].sha256 = leakedLocators.cases[0].oracleSHA256;
        const locBytes = Buffer.from(JSON.stringify(leakedLocators)), oraBytes = Buffer.from(JSON.stringify(leakedOracles));
        const locPath = path.join(dir, `leaked-${kind}-locators.json`), oraPath = path.join(dir, `leaked-${kind}-oracles.json`);
        writeFileSync(locPath, locBytes); writeFileSync(oraPath, oraBytes);
        Object.assign(privateConfig.blind, { locatorManifestPath: locPath, locatorManifestSHA256: sha(locBytes), oracleManifestPath: oraPath, oracleManifestSHA256: sha(oraBytes) });
      } else if (kind === 'locator-manifest' || kind === 'oracle-manifest') {
        const bytes = kind === 'locator-manifest' ? locatorBytes : oracleBytes, file = path.join(ignored, `${kind}.json`); writeFileSync(file, bytes);
        if (kind === 'locator-manifest') privateConfig.blind.locatorManifestPath = file;
        else privateConfig.blind.oracleManifestPath = file;
      } else {
        const privateSchedule = JSON.parse(schedule.toString('utf8')); privateSchedule.slots[0].workerConfig.integrity.suiteDir = ignored;
        const scheduleBytes = Buffer.from(JSON.stringify(privateSchedule)), file = path.join(dir, 'private-suite-schedule.json'); writeFileSync(file, scheduleBytes);
        privateConfig.schedulePath = file; privateConfig.scheduleSHA256 = sha(scheduleBytes);
      }
      const privateBytes = Buffer.from(JSON.stringify(privateConfig)), privateFile = path.join(dir, `private-${kind}.json`); writeFileSync(privateFile, privateBytes);
      await expect(openCampaign(privateFile, sha(privateBytes), dependencies)).rejects.toThrow('private input overlaps source checkout');
    }
    expect(execFileSync('git', ['-C', sourceRoot, 'status', '--porcelain'], { encoding: 'utf8' })).toBe('');
    // Reader and model roots can differ: fixture copies make files beneath
    // either base/ or feature/ available to repository tools in the child.
    const otherCaseIndex = caseIds.findIndex((caseId) => caseId !== slots[0]!.caseId);
    const modelSuite = path.join(dir, 'model-suite'); cpSync(suiteDir, modelSuite, { recursive: true });
    const modelCaseBytes = Buffer.from(JSON.stringify({ caseDir: modelSuite, caseName: 'fixture-core-lens', outputDir: path.join(dir, 'output') }));
    const modelCaseFile = path.join(dir, 'model-case.json'); writeFileSync(modelCaseFile, modelCaseBytes);
    for (const tree of ['base', 'feature']) {
      const marker = path.join(modelSuite, 'repos/core', tree, 'private-marker.txt'); mkdirSync(path.dirname(marker), { recursive: true }); writeFileSync(marker, 'oracle must not reach model');
      const leakedLocators = JSON.parse(locatorBytes.toString('utf8')), leakedOracles = JSON.parse(oracleBytes.toString('utf8'));
      leakedLocators.cases[otherCaseIndex].oraclePath = marker; leakedLocators.cases[otherCaseIndex].oracleSHA256 = sha(readFileSync(marker));
      leakedOracles.cases[otherCaseIndex].sha256 = leakedLocators.cases[otherCaseIndex].oracleSHA256;
      const locBytes = Buffer.from(JSON.stringify(leakedLocators)), oraBytes = Buffer.from(JSON.stringify(leakedOracles));
      const locPath = path.join(dir, `model-${tree}-locators.json`), oraPath = path.join(dir, `model-${tree}-oracles.json`);
      writeFileSync(locPath, locBytes); writeFileSync(oraPath, oraBytes);
      const modelSchedule = JSON.parse(schedule.toString('utf8'));
      Object.assign(modelSchedule.slots[0].workerConfig, { caseConfig: modelCaseFile, caseConfigSHA256: sha(modelCaseBytes), integrity: { ...integrity, suiteDir: modelSuite, suiteSHA256: treeDigest(modelSuite) } });
      const scheduleBytes = Buffer.from(JSON.stringify(modelSchedule)), scheduleFile = path.join(dir, `model-${tree}-schedule.json`); writeFileSync(scheduleFile, scheduleBytes);
      const modelConfig = JSON.parse(config.toString('utf8'));
      Object.assign(modelConfig, { schedulePath: scheduleFile, scheduleSHA256: sha(scheduleBytes) });
      Object.assign(modelConfig.blind, { locatorManifestPath: locPath, locatorManifestSHA256: sha(locBytes), oracleManifestPath: oraPath, oracleManifestSHA256: sha(oraBytes) });
      const modelBytes = Buffer.from(JSON.stringify(modelConfig)), modelFile = path.join(dir, `model-${tree}-config.json`); writeFileSync(modelFile, modelBytes);
      await expect(openCampaign(modelFile, sha(modelBytes), dependencies)).rejects.toThrow('private input overlaps source checkout');
    }
    const incompleteConfig = JSON.parse(config.toString('utf8')); delete incompleteConfig.blind.locatorManifestPath;
    const badConfig = Buffer.from(JSON.stringify(incompleteConfig)), badFile = path.join(dir, 'bad-campaign.json'); writeFileSync(badFile, badConfig);
    await expect(openCampaign(badFile, sha(badConfig), dependencies)).rejects.toThrow('blind manifest');
    writeFileSync(caseOracle, 'changed'); await expect(openCampaign(configFile, sha(config), dependencies)).rejects.toThrow('oracle changed'); writeFileSync(caseOracle, 'synthetic oracle');
    execFileSync('git', ['-C', sourceRoot, 'checkout', '--quiet', '--detach', 'HEAD^']);
    await expect(openCampaign(configFile, sha(config), dependencies)).rejects.toThrow('source or oracle changed');
    execFileSync('git', ['-C', sourceRoot, 'checkout', '--quiet', sourceBranch]);
    const modelRepo = path.join(dir, 'existing-model-repo'); cpSync(sourceRoot, modelRepo, { recursive: true });
    const originalYaml = readFileSync(path.join(modelSuite, 'core.yml'), 'utf8');
    for (const kind of ['git-fixture', 'external-target', 'locator-manifest', 'oracle-manifest']) {
      const isRepo = kind === 'git-fixture' || kind === 'external-target';
      const yaml = isRepo ? originalYaml.replace('fixture: repos/core', `${kind === 'git-fixture' ? 'fixture' : 'external'}: ${modelRepo}`) : originalYaml;
      writeFileSync(path.join(modelSuite, 'core.yml'), yaml);
      const repoCaseBytes = Buffer.from(JSON.stringify({ caseDir: modelSuite, caseName: 'fixture-core-lens', outputDir: path.join(dir, 'output'), ...(kind === 'external-target' ? { targetDir: modelRepo } : {}) }));
      const repoCaseFile = path.join(dir, `case-${kind}.json`); writeFileSync(repoCaseFile, repoCaseBytes);
      const privateConfig = JSON.parse(config.toString('utf8'));
      if (isRepo) {
        const leakedLocators = JSON.parse(locatorBytes.toString('utf8')), leakedOracles = JSON.parse(oracleBytes.toString('utf8'));
        leakedLocators.cases[otherCaseIndex].oraclePath = path.join(modelRepo, 'source.txt'); leakedLocators.cases[otherCaseIndex].oracleSHA256 = sha(readFileSync(path.join(modelRepo, 'source.txt')));
        leakedOracles.cases[otherCaseIndex].sha256 = leakedLocators.cases[otherCaseIndex].oracleSHA256;
        const locBytes = Buffer.from(JSON.stringify(leakedLocators)), oraBytes = Buffer.from(JSON.stringify(leakedOracles));
        const locPath = path.join(dir, `repo-${kind}-locators.json`), oraPath = path.join(dir, `repo-${kind}-oracles.json`); writeFileSync(locPath, locBytes); writeFileSync(oraPath, oraBytes);
        Object.assign(privateConfig.blind, { locatorManifestPath: locPath, locatorManifestSHA256: sha(locBytes), oracleManifestPath: oraPath, oracleManifestSHA256: sha(oraBytes) });
      } else {
        const file = path.join(modelSuite, 'repos/core/feature', `${kind}.json`), bytes = kind === 'locator-manifest' ? locatorBytes : oracleBytes; writeFileSync(file, bytes);
        if (kind === 'locator-manifest') privateConfig.blind.locatorManifestPath = file;
        else privateConfig.blind.oracleManifestPath = file;
      }
      const changed = JSON.parse(schedule.toString('utf8'));
      Object.assign(changed.slots[0].workerConfig, { caseConfig: repoCaseFile, caseConfigSHA256: sha(repoCaseBytes), integrity: { ...integrity, suiteDir: modelSuite, suiteSHA256: treeDigest(modelSuite) } });
      const scheduleBytes = Buffer.from(JSON.stringify(changed)), changedPath = path.join(dir, `repo-${kind}-schedule.json`); writeFileSync(changedPath, scheduleBytes);
      Object.assign(privateConfig, { schedulePath: changedPath, scheduleSHA256: sha(scheduleBytes) });
      const configBytes = Buffer.from(JSON.stringify(privateConfig)), changedConfig = path.join(dir, `repo-${kind}-config.json`); writeFileSync(changedConfig, configBytes);
      await expect(openCampaign(changedConfig, sha(configBytes), dependencies)).rejects.toThrow('private input overlaps source checkout');
    }
    expect({ gets, probes, dispatches }).toEqual({ gets: 0, probes: 0, dispatches: 0 });
    expect(() => readFileSync(base.supervisorPath)).toThrow(); expect(() => readFileSync(base.ledgerPath)).toThrow();
    let campaign = await openCampaign(configFile, sha(config), dependencies), paused: any;
    for (let steps = 0; steps < 30; steps++) { const next = await campaign.step(); if (next.action === 'paused') { paused = next; break; } expect(['health', 'selected']).toContain(next.action); }
    expect(paused?.receipts).toHaveLength(8); expect(dispatches).toBe(8); expect(probes).toBe(2);
    expect(campaign.ledger.db.prepare("SELECT COUNT(*) AS n FROM physical WHERE kind='health' AND health_boundary=?").get(caseIds[2]).n).toBe(0);
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
