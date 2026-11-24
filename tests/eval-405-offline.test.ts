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
    const sourceRoot = path.join(dir, 'source'); mkdirSync(sourceRoot);
    execFileSync('git', ['-C', sourceRoot, 'init', '-q']); execFileSync('git', ['-C', sourceRoot, 'config', 'user.name', 'Synthetic']); execFileSync('git', ['-C', sourceRoot, 'config', 'user.email', 'synthetic@example.test']);
    writeFileSync(path.join(sourceRoot, 'source.txt'), 'base'); execFileSync('git', ['-C', sourceRoot, 'add', '.']); execFileSync('git', ['-C', sourceRoot, 'commit', '-qm', 'base']);
    writeFileSync(path.join(sourceRoot, 'source.txt'), 'source'); execFileSync('git', ['-C', sourceRoot, 'add', '.']); execFileSync('git', ['-C', sourceRoot, 'commit', '-qm', 'synthetic']);
    const sourceBranch = execFileSync('git', ['-C', sourceRoot, 'branch', '--show-current'], { encoding: 'utf8' }).trim();
    const sourceRevision = execFileSync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const caseOracle = path.join(dir, 'oracle.txt'); writeFileSync(caseOracle, 'synthetic oracle');
    const oraclePath = path.join(dir, 'oracle-manifest.json'), oracleBytes = Buffer.from(JSON.stringify({ cases: caseIds.map((caseId) => ({ caseId, sha256: sha(readFileSync(caseOracle)), causes: [] })) })); writeFileSync(oraclePath, oracleBytes);
    const locatorPath = path.join(dir, 'locators.json'), locatorBytes = Buffer.from(JSON.stringify({ cases: caseIds.map((caseId) => ({ caseId, label: caseId, sourceLocator: `source/${caseId}`, oracleLocator: `oracle/${caseId}`, sourceRoot, sourceRevision, oraclePath: caseOracle, oracleSHA256: sha(readFileSync(caseOracle)) })) })); writeFileSync(locatorPath, locatorBytes);
    const diffPath = path.join(dir, 'diff.patch'), diffBytes = Buffer.from('diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new\n'); writeFileSync(diffPath, diffBytes);
    const diffSources = caseIds.map((caseId) => ({ caseId, path: diffPath, sha256: sha(diffBytes) }));
    const registrationFile = path.join(dir, 'registration.json'), registrationSHA256 = await seal405Registration({ file: registrationFile, caseIds, oracleManifestPath: oraclePath, oracleManifestSHA256: sha(oracleBytes), diffSources });
    const order = await generate405Order({ registrationFile, registrationSHA256 });
    const suiteDir = path.join(process.cwd(), 'evals/fixtures'), caseFile = path.join(dir, 'case.json');
    const caseBytes = Buffer.from(JSON.stringify({ caseDir: suiteDir, caseName: 'fixture-core-lens', outputDir: path.join(dir, 'output') })); writeFileSync(caseFile, caseBytes);
    const build = buildDigest(), integrity = { suiteDir, suiteSHA256: treeDigest(suiteDir), build };
    const capturePath = path.join(dir, 'planner.json'), plan = { diffUnderstanding: { declaredIntent: 'fixture', inferredBehavior: 'fixture' }, coverage: [] };
    const captureBytes = Buffer.from(JSON.stringify({ result: { plan, plannerCoverage: { submittedEntries: 0, acceptedEntries: 0, acceptedUniqueHunks: 0, rejectedUnknownHunk: 0 }, degradedPlanning: false, chunked: false }, telemetry: [{ kind: 'artifact', name: 'review-plan.json', data: plan }] })); writeFileSync(capturePath, captureBytes);
    const plannerReplayBinding = { capturePath, captureSHA256: sha(captureBytes), diffSHA256: sha(diffBytes), expectedDossierSHA256: 'd'.repeat(64), baseSHA: 'a'.repeat(40), headSHA: sourceRevision, hunks: [] };
    const base = { supervisorPath: path.join(dir, 'supervisor.db'), ledgerPath: path.join(dir, 'ledger.db'), ledgerBinding: 'campaign', evidenceDirectory: path.join(dir, 'evidence'), limitMicros: 15_000_000, reserveMicros: 400_000, errorHoldMicros: 50_000, caseConfig: caseFile, caseConfigSHA256: sha(caseBytes), integrity };
    const expected = { api: 'openai-completions', destination: 'https://openrouter.ai/api/v1/chat/completions', provider: 'openrouter', modelId: 'openai/gpt-6-luna', reasoningSelected: 'high', wireEffort: 'high' };
    const slots = order.slots.map((item: { caseId: string; arm: string; draw: number }, index: number) => {
      const id = `slot-${String(index + 1).padStart(2, '0')}`, assignedEffects = item.arm === 'treatment';
      return { id, caseId: item.caseId, boundaryId: item.caseId, provider: 'openrouter', expectedPacketIds: ['packet'], blind: { arm: item.arm, draw: item.draw },
        workerConfig: { ...base, boundaryId: item.caseId, assignedEffects, plannerReplayBinding, packetTemplates: [{ packetId: 'packet', templates: Object.fromEntries(['initial', 'tool-continuation', 'repair', 'finalize'].map((kind) => [kind, assignedEffects ? 'p7.16-assigned-effects.1' : 'p7.16'])) }], expectedCalls: ['initial', 'tool-continuation', 'repair', 'finalize'].flatMap((kind) => [{ ...expected, stage: 7, kind, templateVersion: assignedEffects ? 'p7.16-assigned-effects.1' : 'p7.16' }, { ...expected, stage: 7, kind, purpose: 'location_clarification', templateVersion: 'location-clarification-v1' }]) } };
    });
    const schedule = Buffer.from(JSON.stringify({ seed: ASSIGNED_EFFECTS_SEED, verifierConcurrency: 'native', pauseAfterSlot: slots[7].id, slots })), schedulePath = path.join(dir, 'schedule.json'); writeFileSync(schedulePath, schedule);
    const packetPath = path.join(dir, 'qualified-packet.json'), packetBytes = Buffer.from(JSON.stringify({ id: 'packet', hunks: [{ hunkId: 'h', lines: [], truncated: false }], prSummary: '', path: 'a', language: 'javascript', lenses: [], labels: [], contextText: '', relevantTests: [], toolBudget: 3 })); writeFileSync(packetPath, packetBytes);
    const inventoryFile = path.join(dir, 'qualified-packets.json'), inventoryBytes = Buffer.from(JSON.stringify({ results: caseIds.flatMap((caseId) => ['control', 'treatment'].map((mode) => ({ case: caseId, mode, exitCode: 0, providerAttempts: 0, stage7Boundary: true, targetBound: true, expectedParsed: true, capture: true, rawDiff: true, dossier: true, head: true, base: true, hunks: true, replayEvent: true, actualDossierSHA256: plannerReplayBinding.expectedDossierSHA256, rawDiffSHA256: plannerReplayBinding.diffSHA256, captureSHA256: plannerReplayBinding.captureSHA256, baseSHA: plannerReplayBinding.baseSHA, headSHA: plannerReplayBinding.headSHA, hunkInventorySHA256: sha('[]'), packetInventory: [{ id: 'packet', path: packetPath, sha256: sha(packetBytes), observedTemplate: mode === 'treatment' ? 'p7.16-assigned-effects.1' : 'p7.16' }] }))) })); writeFileSync(inventoryFile, inventoryBytes);
    const packetReceiptFile = path.join(dir, 'packet-receipt.json'), packetReceiptBytes = Buffer.from(JSON.stringify({ productDist: build.dist, runner: build.runner, total: 40, passed: 40, providerAttempts: 0, inventoryFile, inventorySHA256: sha(inventoryBytes) })); writeFileSync(packetReceiptFile, packetReceiptBytes);
    const config = Buffer.from(JSON.stringify({ binding: 'campaign', schedulePath, scheduleSHA256: sha(schedule), supervisorPath: base.supervisorPath, ledgerPath: base.ledgerPath, evidenceDirectory: base.evidenceDirectory, receiptDirectory: path.join(dir, 'receipts'), workDirectory: path.join(dir, 'work'), limitMicros: base.limitMicros, reserveMicros: base.reserveMicros, errorHoldMicros: base.errorHoldMicros, build,
      qualification405: { registrationFile, registrationSHA256, verifierConcurrency: 'native', packetReceiptFile, packetReceiptSHA256: sha(packetReceiptBytes) }, blind: { oracleManifestPath: oraclePath, oracleManifestSHA256: sha(oracleBytes), locatorManifestPath: locatorPath, locatorManifestSHA256: sha(locatorBytes), mappingFile: path.join(dir, 'sealed', 'mapping.json') },
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
    for (const variant of ['missing', 'duplicate']) {
      const badKinds = JSON.parse(schedule.toString('utf8'));
      const calls = badKinds.slots[0].workerConfig.expectedCalls;
      const index = calls.findIndex((call: { kind: string; purpose?: string }) => call.kind === 'repair' && !call.purpose);
      if (variant === 'missing') calls.splice(index, 1); else calls.push({ ...calls[index] });
      const bytes = Buffer.from(JSON.stringify(badKinds)), file = path.join(dir, `${variant}-kind.json`); writeFileSync(file, bytes);
      const changed = { ...JSON.parse(config.toString('utf8')), schedulePath: file, scheduleSHA256: sha(bytes) };
      const changedBytes = Buffer.from(JSON.stringify(changed)), changedPath = path.join(dir, `${variant}-kind-config.json`); writeFileSync(changedPath, changedBytes);
      await expect(openCampaign(changedPath, sha(changedBytes), dependencies)).rejects.toThrow('campaign arm binding');
      expect({ gets, probes, dispatches }).toEqual({ gets: 0, probes: 0, dispatches: 0 });
      expect(() => readFileSync(base.supervisorPath)).toThrow();
    }
    const wrongMap = JSON.parse(schedule.toString('utf8'));
    wrongMap.slots[0].workerConfig.packetTemplates[0].templates.initial = wrongMap.slots[0].blind.arm === 'control' ? 'p7.17' : 'p7.17-assigned-effects.1';
    const wrongMapBytes = Buffer.from(JSON.stringify(wrongMap)), wrongMapPath = path.join(dir, 'wrong-map.json'); writeFileSync(wrongMapPath, wrongMapBytes);
    const wrongMapConfig = { ...JSON.parse(config.toString('utf8')), schedulePath: wrongMapPath, scheduleSHA256: sha(wrongMapBytes) };
    const wrongMapConfigBytes = Buffer.from(JSON.stringify(wrongMapConfig)), wrongMapConfigPath = path.join(dir, 'wrong-map-config.json'); writeFileSync(wrongMapConfigPath, wrongMapConfigBytes);
    await expect(openCampaign(wrongMapConfigPath, sha(wrongMapConfigBytes), dependencies)).rejects.toThrow('405 packet qualification mismatch');
    expect({ gets, probes, dispatches }).toEqual({ gets: 0, probes: 0, dispatches: 0 });
    expect(() => readFileSync(base.supervisorPath)).toThrow();
    writeFileSync(packetPath, Buffer.from(JSON.stringify({ ...JSON.parse(packetBytes.toString('utf8')), substituted: true })));
    await expect(openCampaign(configFile, sha(config), dependencies)).rejects.toThrow('405 packet qualification mismatch');
    expect({ gets, probes, dispatches }).toEqual({ gets: 0, probes: 0, dispatches: 0 });
    expect(() => readFileSync(base.supervisorPath)).toThrow();
    writeFileSync(packetPath, packetBytes);
    const duplicateSchedule = JSON.parse(schedule.toString('utf8'));
    for (const slot of duplicateSchedule.slots.slice(0, 4)) {
      slot.expectedPacketIds = ['packet', 'second'];
      slot.workerConfig.packetTemplates.push({ ...slot.workerConfig.packetTemplates[0], packetId: 'second' });
    }
    const duplicateScheduleBytes = Buffer.from(JSON.stringify(duplicateSchedule)), duplicateSchedulePath = path.join(dir, 'duplicate-schedule.json'); writeFileSync(duplicateSchedulePath, duplicateScheduleBytes);
    const duplicateInventory = JSON.parse(inventoryBytes.toString('utf8'));
    const duplicateRow = duplicateInventory.results.find((item: { case: string; mode: string }) => item.case === duplicateSchedule.slots[0].caseId && item.mode === duplicateSchedule.slots[0].blind.arm);
    duplicateRow.packetInventory.push({ ...duplicateRow.packetInventory[0] });
    const duplicateInventoryBytes = Buffer.from(JSON.stringify(duplicateInventory)), duplicateInventoryPath = path.join(dir, 'duplicate-inventory.json'); writeFileSync(duplicateInventoryPath, duplicateInventoryBytes);
    const duplicateReceiptBytes = Buffer.from(JSON.stringify({ ...JSON.parse(packetReceiptBytes.toString('utf8')), inventoryFile: duplicateInventoryPath, inventorySHA256: sha(duplicateInventoryBytes) })), duplicateReceiptPath = path.join(dir, 'duplicate-receipt.json'); writeFileSync(duplicateReceiptPath, duplicateReceiptBytes);
    const duplicateConfig = JSON.parse(config.toString('utf8'));
    Object.assign(duplicateConfig, { schedulePath: duplicateSchedulePath, scheduleSHA256: sha(duplicateScheduleBytes) });
    Object.assign(duplicateConfig.qualification405, { packetReceiptFile: duplicateReceiptPath, packetReceiptSHA256: sha(duplicateReceiptBytes) });
    const duplicateConfigBytes = Buffer.from(JSON.stringify(duplicateConfig)), duplicateConfigPath = path.join(dir, 'duplicate-config.json'); writeFileSync(duplicateConfigPath, duplicateConfigBytes);
    await expect(openCampaign(duplicateConfigPath, sha(duplicateConfigBytes), dependencies)).rejects.toThrow('packet template binding');
    expect({ gets, probes, dispatches }).toEqual({ gets: 0, probes: 0, dispatches: 0 });
    expect(() => readFileSync(base.supervisorPath)).toThrow();
    const changedCapture = JSON.parse(captureBytes.toString('utf8'));
    changedCapture.result.plan.diffUnderstanding.declaredIntent = 'different captured plan';
    changedCapture.telemetry[0].data = changedCapture.result.plan;
    const changedBytes = Buffer.from(JSON.stringify(changedCapture)), changedPath = path.join(dir, 'other-planner.json'); writeFileSync(changedPath, changedBytes);
    for (const kind of ['capture', 'packets']) {
      const altered = JSON.parse(schedule.toString('utf8'));
      if (kind === 'capture') Object.assign(altered.slots[1].workerConfig.plannerReplayBinding, { capturePath: changedPath, captureSHA256: sha(changedBytes) });
      else altered.slots[1].expectedPacketIds = ['different-packet'];
      const scheduleBytes = Buffer.from(JSON.stringify(altered)), alteredPath = path.join(dir, `schedule-${kind}.json`); writeFileSync(alteredPath, scheduleBytes);
      const alteredConfig = { ...JSON.parse(config.toString('utf8')), schedulePath: alteredPath, scheduleSHA256: sha(scheduleBytes) };
      const configBytes = Buffer.from(JSON.stringify(alteredConfig)), alteredConfigPath = path.join(dir, `config-${kind}.json`); writeFileSync(alteredConfigPath, configBytes);
      await expect(openCampaign(alteredConfigPath, sha(configBytes), dependencies)).rejects.toThrow('sibling');
    }
    // Two requested IDs must never be represented by one NUL-containing ID.
    const collisionIds = `${caseIds[0]}\0${caseIds[1]}`;
    const collidingLocator = JSON.parse(locatorBytes.toString('utf8')), collidingOracle = JSON.parse(oracleBytes.toString('utf8'));
    for (const manifest of [collidingLocator, collidingOracle]) { manifest.cases[0].caseId = collisionIds; manifest.cases.splice(1, 1); }
    const locatorCollisionBytes = Buffer.from(JSON.stringify(collidingLocator)), oracleCollisionBytes = Buffer.from(JSON.stringify(collidingOracle));
    const locatorCollisionPath = path.join(dir, 'collision-locators.json'), oracleCollisionPath = path.join(dir, 'collision-oracles.json');
    writeFileSync(locatorCollisionPath, locatorCollisionBytes); writeFileSync(oracleCollisionPath, oracleCollisionBytes);
    const collisionConfig = JSON.parse(config.toString('utf8')); delete collisionConfig.qualification405;
    Object.assign(collisionConfig.blind, { locatorManifestPath: locatorCollisionPath, locatorManifestSHA256: sha(locatorCollisionBytes), oracleManifestPath: oracleCollisionPath, oracleManifestSHA256: sha(oracleCollisionBytes) });
    const collisionBytes = Buffer.from(JSON.stringify(collisionConfig)), collisionPath = path.join(dir, 'collision-config.json'); writeFileSync(collisionPath, collisionBytes);
    await expect(openCampaign(collisionPath, sha(collisionBytes), dependencies)).rejects.toThrow('blind case membership');
    // A clean reviewed repository must never contain oracle or suite inputs,
    // even if a locator reaches the repository through an aliased parent.
    const ignored = path.join(sourceRoot, 'private-testing'); mkdirSync(ignored);
    writeFileSync(path.join(sourceRoot, '.git/info/exclude'), 'private-testing/\n');
    const sourceAlias = path.join(dir, 'source-alias'); symlinkSync(sourceRoot, sourceAlias, 'dir');
    for (const kind of ['oracle', 'oracle-alias', 'locator-manifest', 'oracle-manifest', 'suite']) {
      const privateConfig = JSON.parse(config.toString('utf8')); delete privateConfig.qualification405;
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
    const otherCaseIndex = caseIds.findIndex((caseId) => caseId !== slots[0].caseId);
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
      const modelConfig = JSON.parse(config.toString('utf8')); delete modelConfig.qualification405;
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
      const privateConfig = JSON.parse(config.toString('utf8')); delete privateConfig.qualification405;
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
