import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { outsideCheckout, workerBounds } from './case.mjs';
import { CampaignLedger } from './ledger.mjs';
import { CampaignSupervisor } from './supervisor.mjs';
import { listEvidenceFiles, prepareAdmission } from './admission.mjs';
import { spawnAttempt } from './spawn-worker.mjs';
import { assertExpectedCalls } from './expected-calls.mjs';
import { reviewStageSelection } from './stage-binding.mjs';
import { RecoveredResetLimitError, validateTerminal } from './terminal.mjs';
import { assertIntegrity } from './integrity.mjs';
import { verifyAllEvidence } from './boundary.mjs';
import { exportFirstLock, revealPairing } from './blind-export.mjs';
import { assertBlindPrivateInputs, assertOutsideSources, normalizeOracleCase, validateBlindInputs } from './blind-inputs.mjs';
import { validateAdmissionAudit } from './admission-audit.mjs';
import { validatePacketTemplates, verifyPacketCalls } from './packet-templates.mjs';
import { assertInstructionBinding, validateInstructionArms } from './instruction-binding.mjs';
import { readCheckedFile } from './safe-read.mjs';
import { loadScoringBundle } from './score-bundle.mjs';
import { scoreCampaign } from './score.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const hash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const attemptPrefix = (slot, number) => `${slot}/attempt-${String(number).padStart(2, '0')}`;
const proofHash = (binding, slot, attempt, failure, probe) => sha(JSON.stringify({ binding, slot, attempt, failure, probe }));
const readBytes = (file) => { const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW); try { return readFileSync(fd); } finally { closeSync(fd); } };

function checkExisting(config, configSHA256) {
  const check = (file, schema, checkRow) => {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      for (const [table, columns] of Object.entries(schema)) {
        const found = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
        if (columns.some((column) => !found.has(column))) throw new Error('schema');
      }
      const rows = db.prepare('SELECT * FROM campaign').all();
      if (rows.length !== 1 || !checkRow(rows[0])) throw new Error('binding');
      if (schema.blind_export) { const rows = db.prepare('SELECT mapping_sha256,manifest_sha256,reconciliation_sha256 FROM blind_export WHERE id=1').all(); if (rows.length !== 1 || ((rows[0].mapping_sha256 === null) !== (rows[0].manifest_sha256 === null)) || (rows[0].mapping_sha256 !== null && (!hash(rows[0].mapping_sha256) || !hash(rows[0].manifest_sha256))) || (rows[0].reconciliation_sha256 !== null && (!hash(rows[0].reconciliation_sha256) || rows[0].mapping_sha256 === null))) throw new Error('blind export binding'); }
    } finally { db.close(); }
  };
  try {
    check(config.supervisorPath, {
      campaign: ['binding', 'schedule_sha256', 'config_sha256', 'receipt_directory', 'schema_version'],
      attempt: ['slot_id', 'attempt_no', 'state', 'receipt_sha256'],
      worker_claim: ['slot_id', 'attempt_no', 'config_sha256', 'token_sha256', 'activated', 'spawn_state', 'pid', 'host', 'process_start', 'pid_namespace'],
      outcome: ['slot_id', 'state', 'attempt_no', 'receipt_sha256'], retry_authorization: ['slot_id', 'attempt_no', 'failure_sha256', 'proof_sha256', 'probe_id'],
      exclusion: ['slot_id', 'first_attempt_no', 'first_sha256', 'second_attempt_no', 'second_sha256'],
      case_reset_event: ['slot_id', 'attempt_no', 'case_id', 'receipt_sha256', 'resets'],
      driver_claim: ['id', 'pid', 'host', 'process_start', 'pid_namespace', 'token_sha256'], release: ['prefix_sha256'], blind_export: ['id', 'mapping_sha256', 'manifest_sha256', 'reconciliation_sha256']
    }, (row) => row.schema_version === 1 && row.binding === config.binding && row.schedule_sha256 === config.scheduleSHA256 && row.config_sha256 === configSHA256 && row.receipt_directory === config.receiptDirectory);
    check(config.ledgerPath, {
      campaign: ['binding', 'limit_micros', 'reserve_micros', 'error_hold_micros', 'salt', 'meter_stale', 'stopped', 'schema_version'],
      physical: ['id', 'logical_id', 'kind', 'provider', 'health_boundary', 'health_purpose', 'retry_for', 'retry_failure_sha256', 'started_at_ms', 'settled_at_ms', 'state', 'charge', 'http_status', 'evidence_json', 'lower_bound', 'provider_cost_nanos', 'stream_terminal'],
      key_baseline: ['usage_micros', 'usage_nanos', 'evidence_sha256', 'key_fingerprint'],
      key_snapshot: ['usage_micros', 'usage_nanos', 'priced_floor_micros', 'priced_floor_nanos', 'observed_ms', 'evidence_sha256', 'fresh', 'boundary_id', 'physical_starts'],
      health_receipt: ['physical_id', 'outcome', 'observed_ms', 'evidence_sha256'], meter_poll: ['boundary_id', 'attempts', 'stale_count', 'next_ms', 'pending'],
      local_refusal: ['id', 'logical_id', 'reason'], logical: ['id', 'status']
    }, (row) => row.schema_version === 1 && row.binding === config.binding && row.limit_micros === config.limitMicros && row.reserve_micros === config.reserveMicros && row.error_hold_micros === config.errorHoldMicros);
  } catch { throw new Error('campaign database custody requires reconciliation'); }
}

// Only schedule-derived bytes are written; a restart never replaces an existing
// worker config. The actual worker independently checks the same digest.
function publishConfig(directory, name, bytes) {
  const dest = path.join(directory, name), temp = path.join(directory, `.tmp-${randomBytes(16).toString('hex')}`);
  try {
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    try { linkSync(temp, dest); } catch (error) { if (error?.code !== 'EEXIST' || !readBytes(dest).equals(bytes)) throw new Error('worker config custody mismatch'); }
    const fdDir = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY);
    try { fsyncSync(fdDir); } finally { closeSync(fdDir); }
  } finally { try { unlinkSync(temp); } catch (error) { if (error?.code !== 'ENOENT') throw error; } }
  return dest;
}

// This entry is internal to the development-only runner. The caller must pin
// the complete campaign file hash; no model request is made during open.
export async function openCampaign(configFile, expectedSHA256, { fetchImpl = globalThis.fetch, models, resumeOnly = false, spawnWorker = spawnAttempt } = {}) {
  if (typeof spawnWorker !== 'function') throw new TypeError('invalid worker transport');
  const bytes = readBytes(configFile);
  if (!hash(expectedSHA256) || sha(bytes) !== expectedSHA256) throw new Error('campaign config digest mismatch');
  const config = JSON.parse(bytes.toString('utf8'));
  if (typeof config.binding !== 'string' || !config.binding || !hash(config.scheduleSHA256) || !config.health || config.health.expected?.provider !== 'openrouter' || config.health.llmConfig?.provider !== 'openrouter') throw new Error('invalid campaign config');
  for (const name of ['supervisorPath', 'ledgerPath', 'receiptDirectory', 'evidenceDirectory', 'workDirectory']) {
    if (typeof config[name] !== 'string' || !path.isAbsolute(config[name]) || outsideCheckout(config[name]) !== config[name]) throw new Error('invalid campaign path');
  }
  if (!Number.isSafeInteger(config.limitMicros) || config.limitMicros <= 0 || !Number.isSafeInteger(config.reserveMicros) || config.reserveMicros <= 0 || !Number.isSafeInteger(config.errorHoldMicros) || config.errorHoldMicros < 0 || config.errorHoldMicros > config.reserveMicros) throw new Error('invalid campaign caps');
  const scheduleBytes = readBytes(config.schedulePath);
  if (sha(scheduleBytes) !== config.scheduleSHA256) throw new Error('campaign schedule digest mismatch');
  const schedule = JSON.parse(scheduleBytes.toString('utf8'));
  if (!Array.isArray(schedule.slots) || !schedule.slots.length) throw new Error('invalid campaign schedule');
  const blindInputs = config.blind === undefined ? undefined : validateBlindInputs(config.blind, schedule.slots, { requireV2: !existsSync(config.supervisorPath) });
  const armSelections = config.blind?.stageSelections;
  const instructionArms = validateInstructionArms(config.blind);
  if (armSelections !== undefined && (!armSelections || typeof armSelections !== 'object' || Array.isArray(armSelections) ||
      Object.keys(armSelections).sort().join(',') !== 'control,treatment' || ['control', 'treatment'].some((arm) => {
        const value = armSelections[arm];
        return !value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'modelId,provider,reasoning' ||
          ['provider', 'modelId', 'reasoning'].some((field) => typeof value[field] !== 'string' || !value[field]);
      }))) throw new Error('invalid blind stage selections');
  const roots = new Map(), reviewInputRoots = [], suiteCases = new Map();
  let instructionPolicy;
  for (const slot of schedule.slots) {
    const wc = slot.workerConfig;
    if (instructionArms && !slot.blind) throw new Error('instruction arm binding missing');
    if (wc?.reviewOverride !== undefined) throw new Error('campaign review overrides are no longer supported');
    if (slot.blind !== undefined) {
      const packetCalls = wc?.expectedCalls?.filter((call) => call.stage === 7 && call.purpose !== 'location_clarification');
      if (!['control', 'treatment'].includes(slot.blind.arm) || !Array.isArray(packetCalls) || !packetCalls.some((call) => call.kind === 'initial') ||
          wc.expectedCalls.some((call) => call.stage === 7 && call.purpose === 'location_clarification' && call.templateVersion !== 'location-clarification-v1')) throw new Error('campaign packet template binding mismatch');
      validatePacketTemplates(wc.packetTemplates, slot.expectedPacketIds, { instructionSet: instructionArms?.[slot.blind.arm] ?? 'v1' });
    }
    if (!wc || slot.boundaryId === `final-${sha(config.binding)}` || typeof slot.caseId !== 'string' || !slot.caseId || !Array.isArray(slot.expectedPacketIds) || slot.provider !== 'openrouter' ||
        wc.supervisorPath !== config.supervisorPath || wc.ledgerPath !== config.ledgerPath || wc.ledgerBinding !== config.binding || wc.boundaryId !== slot.boundaryId ||
        wc.evidenceDirectory !== config.evidenceDirectory || wc.evidenceFiles !== undefined || wc.limitMicros !== config.limitMicros || wc.reserveMicros !== config.reserveMicros || wc.errorHoldMicros !== config.errorHoldMicros || !hash(wc.caseConfigSHA256) || typeof wc.caseConfig !== 'string' || !path.isAbsolute(wc.caseConfig) || outsideCheckout(wc.caseConfig) !== wc.caseConfig) throw new Error('worker schedule binding mismatch');
    const caseBytes = readBytes(wc.caseConfig);
    if (sha(caseBytes) !== wc.caseConfigSHA256) throw new Error('case config binding mismatch');
    const caseConfig = JSON.parse(caseBytes.toString('utf8'));
    if (typeof caseConfig.caseDir !== 'string' || wc.integrity?.suiteDir !== path.resolve(path.dirname(wc.caseConfig), caseConfig.caseDir) ||
        !wc.integrity?.build || Object.keys(wc.integrity.build).some((key) => wc.integrity.build[key] !== config.build?.[key]) || Object.keys(config.build ?? {}).length !== Object.keys(wc.integrity.build).length) throw new Error('case integrity binding mismatch');
    assertIntegrity(wc.integrity);
    const bounds = await workerBounds(wc.caseConfig, caseBytes, attemptPrefix(slot.id, 1), { resolveEffective: (armSelections !== undefined || instructionArms !== undefined) && slot.blind !== undefined });
    suiteCases.set(slot.caseId, bounds.suiteCase);
    if (blindInputs && !existsSync(config.supervisorPath)) {
      const location = blindInputs.locators.cases.find((item) => item.caseId === slot.caseId);
      const oracle = blindInputs.oracles.cases.find((item) => item.caseId === slot.caseId);
      const normalized = normalizeOracleCase(oracle, blindInputs.oracles.version);
      if (normalized.role === 'negative-control') {
        const auditBytes = readCheckedFile(location.admissionAudit.path);
        if (sha(auditBytes) !== location.admissionAudit.sha256) throw new Error('blind admission audit changed');
        const record = JSON.parse(auditBytes.toString('utf8'));
        validateAdmissionAudit({ record, case: oracle, locator: location, suiteCase: bounds.suiteCase, checkout: location.sourceRoot, role: normalized.role, causes: normalized.causes });
      }
    }
    if (bounds.effectiveConfig !== undefined) assertExpectedCalls(bounds.effectiveConfig, wc.expectedCalls);
    if (slot.blind !== undefined && bounds.suiteCase.llm?.stages !== undefined && armSelections === undefined) throw new Error('blind stage selections missing');
    if (slot.blind !== undefined && bounds.suiteCase.review?.stage7Instructions !== undefined && instructionArms === undefined) throw new Error('blind instruction selections missing');
    if (slot.blind !== undefined && armSelections !== undefined) {
      const actual = reviewStageSelection(bounds.effectiveConfig?.llm), expected = armSelections[slot.blind.arm];
      if (actual.provider !== expected.provider || actual.modelId !== expected.modelId || actual.reasoning !== expected.reasoning) throw new Error('blind arm stage selection mismatch');
    }
    if (instructionArms) {
      const actualPolicy = assertInstructionBinding(bounds.effectiveConfig, wc.expectedCalls, instructionArms[slot.blind.arm]);
      if (instructionPolicy !== undefined && instructionPolicy !== actualPolicy) throw new Error('instruction effort policy mismatch');
      instructionPolicy = actualPolicy;
    }
    if (slot.blind !== undefined && bounds.toolSurface !== 'current') throw new Error('campaign arm surface mismatch');
    roots.set(slot.id, path.dirname(bounds.outputDir));
    reviewInputRoots.push(...bounds.reviewInputRoots);
  }
  for (const slot of schedule.slots) assertOutsideSources(slot.workerConfig.integrity.suiteDir, reviewInputRoots);
  if (blindInputs) assertBlindPrivateInputs(config.blind, schedule.slots, blindInputs.locators, reviewInputRoots, { includeAudit: !existsSync(config.supervisorPath) });
  const protectedPaths = [config.supervisorPath, config.ledgerPath, config.receiptDirectory, config.evidenceDirectory, config.workDirectory];
  if (config.blind && protectedPaths.some((item) => config.blind.mappingFile === item || config.blind.mappingFile.startsWith(`${item}${path.sep}`) || item.startsWith(`${config.blind.mappingFile}${path.sep}`))) throw new Error('blind mapping overlaps campaign custody');
  for (const root of roots.values()) for (const protectedPath of [...protectedPaths, ...(config.blind ? [config.blind.mappingFile] : [])]) {
    if (root === protectedPath || root.startsWith(`${protectedPath}${path.sep}`) || protectedPath.startsWith(`${root}${path.sep}`)) throw new Error('campaign paths overlap attempt artifacts');
  }
  const runRootFor = (slot, attempt) => {
    if (!roots.has(slot) || !Number.isSafeInteger(attempt) || attempt < 1) throw new Error('invalid attempt root');
    return path.join(roots.get(slot), `attempt-${String(attempt).padStart(2, '0')}`);
  };
  const existing = existsSync(config.supervisorPath), ledgerExists = existsSync(config.ledgerPath);
  if (resumeOnly && !existing) throw new Error('campaign does not exist');
  if (existing !== ledgerExists) throw new Error('campaign ledger custody requires reconciliation');
  if (!existing && [config.receiptDirectory, config.evidenceDirectory, config.workDirectory, ...(config.blind ? [config.blind.mappingFile] : []), `${config.supervisorPath}-wal`, `${config.supervisorPath}-shm`, `${config.ledgerPath}-wal`, `${config.ledgerPath}-shm`, ...roots.values()].some((file) => existsSync(file))) throw new Error('campaign namespace requires reconciliation');
  if (existing && (!existsSync(config.receiptDirectory) || !existsSync(config.evidenceDirectory) || !existsSync(config.workDirectory))) throw new Error('campaign directory custody requires reconciliation');
  if (existing) checkExisting(config, expectedSHA256);
  if (!existing) {
    for (const directory of [path.dirname(config.supervisorPath), path.dirname(config.ledgerPath), config.evidenceDirectory, config.workDirectory]) mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  const supervisor = new CampaignSupervisor(config.supervisorPath, { binding: config.binding, configSHA256: expectedSHA256, scheduleBytes, scheduleSHA256: config.scheduleSHA256, receiptDirectory: config.receiptDirectory, runRootFor, initialize: !existing });
  let ledger, token;
  try {
    token = supervisor.claimDriver();
    ledger = new CampaignLedger(config.ledgerPath, { binding: config.binding, limitMicros: config.limitMicros, reserveMicros: config.reserveMicros, errorHoldMicros: config.errorHoldMicros, initialize: !existing });
  } catch (error) { if (token) supervisor.releaseDriver(token); supervisor.close(); throw error; }
  const files = () => listEvidenceFiles(config.evidenceDirectory);
  const verifyRetry = (slotId, attempt, failure, proof, probe) => {
    try {
      if (proof !== proofHash(config.binding, slotId, attempt, failure, probe)) return false;
      const slot = supervisor.slots.find((item) => item.id === slotId);
      const row = ledger.db.prepare('SELECT h.evidence_sha256 FROM health_receipt h WHERE h.physical_id=?').get(probe);
      const file = files()[row?.evidence_sha256], bytes = readBytes(file);
      if (sha(bytes) !== row.evidence_sha256) return false;
      const receipt = JSON.parse(bytes.toString('utf8'));
      return receipt.kind === 'health' && receipt.physicalId === probe && receipt.boundaryId === slot.boundaryId && receipt.provider === slot.provider && receipt.purpose === 'retry' && receipt.outcome === 'clean' && receipt.retryFor === attemptPrefix(slotId, attempt) && receipt.failureReceiptSHA256 === failure;
    } catch { return false; }
  };
  const verifyReceipt = supervisor.receipts.verify;
  const assertCase = (slot) => {
    assertIntegrity(slot.workerConfig.integrity);
    if (sha(readBytes(slot.workerConfig.caseConfig)) !== slot.workerConfig.caseConfigSHA256) throw new Error('case config binding mismatch');
  };
  const verifyFailure = (slot, attempt, receiptHash) => {
    const found = supervisor.receipts.find(slot, attempt);
    return found?.hash === receiptHash && found.receipt.status === 'error' && found.receipt.error === 'provider_failure' && typeof found.receipt.failureCallId === 'string';
  };
  const outcomeSummary = () => supervisor.checkedOutcomes(verifyReceipt, verifyRetry, ledger).map((row) => ({ receiptSHA256: row.receipt_sha256, outcome: row.state,
    ...(row.state === 'excluded' ? { firstReceiptSHA256: supervisor.db.prepare('SELECT first_sha256 FROM exclusion WHERE slot_id=?').get(row.slot_id).first_sha256 } : {}) }));
  const finish = (slot, attempt, result, receiptHash) => {
    const recorded = supervisor.recordCaseResets(slot.id, attempt, receiptHash, ledger);
    if (recorded.stop) { ledger.stop('case_reset_limit'); return { action: 'stop', reason: 'case_reset_limit', receiptSHA256: receiptHash, recoveredResets: recorded.total }; }
    if (result.status === 'error') {
      supervisor.sealFailure(slot.id, attempt, receiptHash, { ledger, verifyReceipt, verifyFailure, verifyRetry });
      const excluded = supervisor.db.prepare('SELECT first_sha256,second_sha256 FROM exclusion WHERE slot_id=?').get(slot.id);
      if (excluded) return { action: 'excluded', slot: slot.id, firstReceiptSHA256: excluded.first_sha256, receiptSHA256: excluded.second_sha256 };
      return { action: 'infrastructure_failure', slot: slot.id, receiptSHA256: receiptHash };
    }
    supervisor.seal(slot.id, attempt, receiptHash, verifyReceipt, verifyRetry, ledger);
    return { action: 'selected', slot: slot.id, receiptSHA256: receiptHash, recoveredResets: recorded.total };
  };
  const stepInternal = async () => {
    supervisor.assertDriver();
    try { ledger.assertAccounting(); }
    catch { ledger.stop('accounting_failed'); return { action: 'stop', reason: 'accounting_failed' }; }
    const stopped = ledger.totals().stopped;
    if (stopped) return { action: 'stop', reason: stopped };
    const next = supervisor.nextSlot(verifyReceipt, verifyRetry, ledger);
    if (next.action === 'reconcile') {
      const slot = supervisor.slots.find((item) => item.id === next.slot_id), found = supervisor.receipts.find(next.slot_id, next.attempt_no);
      const claim = supervisor.db.prepare('SELECT spawn_state FROM worker_claim WHERE slot_id=? AND attempt_no=?').get(next.slot_id, next.attempt_no);
      if (!claim) { if (found) throw new Error('receipt lacks worker custody'); return { action: 'recovered', ...supervisor.cancelUnclaimedStart(next.slot_id, next.attempt_no, ledger) }; }
      if (claim.spawn_state === 'claimed') supervisor.recordWorkerExit(next.slot_id, next.attempt_no, true);
      if (!supervisor.workerExited(next.slot_id, next.attempt_no)) return { action: 'wait', reason: 'worker_exit' };
      if (claim.spawn_state === 'started') supervisor.recordWorkerExit(next.slot_id, next.attempt_no);
      if (found?.receipt.status === 'stop') { ledger.stop('terminal_evidence'); return { action: 'stop', reason: 'terminal_evidence', receiptSHA256: found.hash }; }
      if (found) return finish(slot, next.attempt_no, found.receipt, found.hash);
      const prefix = `${attemptPrefix(next.slot_id, next.attempt_no)}/`;
      if (ledger.db.prepare('SELECT 1 FROM physical WHERE substr(id,1,?)=? LIMIT 1').get(prefix.length, prefix)) return { action: 'reconcile', reason: 'interrupted_physical_call', slot: next.slot_id };
      return { action: 'recovered', ...supervisor.reconcile(next.slot_id, next.attempt_no, { ledger, verifyWorkerExited: () => supervisor.workerExited(next.slot_id, next.attempt_no), findTerminalReceipt: () => supervisor.receipts.find(next.slot_id, next.attempt_no) }) };
    }
    ledger.assertRestartSafe();
    verifyAllEvidence(ledger, files());
    if (next.action === 'completed') {
      for (const slot of supervisor.slots) assertCase(slot);
      const final = await prepareAdmission({ ledger, boundaryId: `final-${sha(config.binding)}`, receiptDirectory: config.evidenceDirectory,
        attemptPrefix: 'health/final', purpose: 'admission', keyOnly: true, llmConfig: config.health.llmConfig,
        expected: config.health.expected, fetchImpl, ...(models ? { models } : {}) });
      if (ledger.totals().stopped) return { action: 'stop', reason: ledger.totals().stopped };
      return final.action === 'admit' ? { action: 'completed', physicalStarts: ledger.physicalPrefix(), receipts: outcomeSummary(), ledger: ledger.totals() } : final;
    }
    if (next.action === 'paused') {
      const outcomes = supervisor.checkedOutcomes(verifyReceipt, verifyRetry, ledger);
      const receipts = outcomeSummary();
      const held = ledger.db.prepare("SELECT COALESCE(SUM(charge),0) AS total FROM physical WHERE state='unknown'").get().total;
      const resets = supervisor.db.prepare('SELECT COALESCE(SUM(resets),0) AS total FROM case_reset_event').get().total;
      return { action: 'paused', prefixSHA256: supervisor.checkpointHash(outcomes), receipts, ledger: { ...ledger.totals(), unknownHeldMicros: held }, recoveredResets: resets };
    }
    if (next.action !== 'next') return next;
    const slot = next.slot;
    try { assertCase(slot); }
    catch { ledger.stop('binding_mismatch'); return { action: 'stop', reason: 'binding_mismatch' }; }
    const failed = supervisor.db.prepare("SELECT attempt_no,receipt_sha256 FROM attempt WHERE slot_id=? AND state IN ('interrupted','infrastructure_failure') ORDER BY attempt_no DESC LIMIT 1").get(slot.id);
    const auth = failed && supervisor.db.prepare('SELECT 1 FROM retry_authorization WHERE slot_id=?').get(slot.id);
    const purpose = failed && !auth ? 'retry' : 'admission';
    const healthOrdinal = ledger.db.prepare("SELECT COUNT(*) AS count FROM physical WHERE kind='health' AND health_boundary=? AND health_purpose=?").get(slot.boundaryId, purpose).count + 1;
    const admission = await prepareAdmission({ ledger, boundaryId: slot.boundaryId, receiptDirectory: config.evidenceDirectory,
      attemptPrefix: `health/${slot.id}/${purpose}-${healthOrdinal}`,
      purpose, ...(failed && !auth ? { retryFor: attemptPrefix(slot.id, failed.attempt_no), failureReceiptSHA256: failed.receipt_sha256 } : {}),
      llmConfig: config.health.llmConfig, expected: config.health.expected, fetchImpl, beforeProbe: () => { assertCase(slot); return true; }, ...(models ? { models } : {}) });
    const diagnostic = admission.diagnosticSHA256 === undefined ? {} : { diagnostic: admission.diagnostic, diagnosticSHA256: admission.diagnosticSHA256 };
    if (ledger.totals().stopped) return { action: 'stop', reason: ledger.totals().stopped, ...diagnostic };
    try { assertCase(slot); }
    catch { ledger.stop('binding_mismatch'); return { action: 'stop', reason: 'binding_mismatch' }; }
    if (failed && !auth && admission.status === 'clean') {
      const proof = proofHash(config.binding, slot.id, failed.attempt_no, failed.receipt_sha256, admission.physicalId);
      supervisor.authorizeRetry(slot.id, failed.attempt_no, proof, { ledger, retryProbeId: admission.physicalId, verifyReceipt, verifyFailure, verifyRetry });
      return { action: 'retry_authorized', slot: slot.id };
    }
    if (admission.action !== 'admit') return admission.status ? { action: 'health', status: admission.status, ...diagnostic } : admission;
    const started = supervisor.begin(slot.id, { ledger, evidenceFiles: files(), verifyReceipt, verifyRetry });
    if (started.action !== 'started') return started;
    const worker = Buffer.from(JSON.stringify({ ...slot.workerConfig, attemptPrefix: started.attemptPrefix }));
    let result;
    try {
      const file = publishConfig(config.workDirectory, `${slot.id}-${started.attempt}.json`, worker);
      result = await spawnWorker({ supervisor, slotId: slot.id, attemptNo: started.attempt, configFile: file, configSHA256: sha(worker) });
    } catch {
      try { assertCase(slot); }
      catch { ledger.stop('binding_mismatch'); return { action: 'stop', reason: 'binding_mismatch', slot: slot.id }; }
      return { action: 'reconcile', slot: slot.id };
    }
    if (result.status === 'worker_failed') return { action: 'reconcile', slot: slot.id, reason: result.error };
    let recoveredResets;
    try { recoveredResets = validateTerminal({ runDir: result.runDir, attemptPrefix: started.attemptPrefix, ledger, expectedPacketIds: slot.expectedPacketIds, expectedCalls: slot.workerConfig.expectedCalls,
      priorRecoveredResets: supervisor.caseResetCount(slot.caseId), ...(result.status === 'error' ? { failureCallId: result.failureCallId } : {}) }).recoveredResets; }
    catch (error) {
      if (error instanceof RecoveredResetLimitError) recoveredResets = error.recoveredResets;
      else {
        const receiptSHA256 = supervisor.receipts.sealStop(slot.id, started.attempt, { ...result, caseId: slot.caseId });
        ledger.stop('terminal_evidence');
        return { action: 'stop', reason: ledger.totals().stopped, slot: slot.id, receiptSHA256 };
      }
    }
    const receiptHash = supervisor.receipts.seal(slot.id, started.attempt, { ...result, caseId: slot.caseId, recoveredResets });
    return finish(slot, started.attempt, result, receiptHash);
  };
  let localStop;
  const step = async () => {
    if (localStop) return { action: 'stop', reason: localStop };
    try { return await stepInternal(); }
    catch {
      localStop = 'custody_refused';
      try { ledger.stop(localStop); } catch { localStop = 'accounting_failed'; }
      return { action: 'stop', reason: localStop };
    }
  };
  const selectedForBlind = () => {
    supervisor.assertDriver(); ledger.assertRestartSafe(); verifyAllEvidence(ledger, files());
    if (ledger.hasPendingMeter()) throw new Error('meter custody requires reconciliation');
    const stopped = ledger.totals().stopped;
    if (stopped === 'case_reset_limit') throw new Error('case reset stop requires reconciliation');
    const outcomes = supervisor.checkedOutcomes(verifyReceipt, verifyRetry, ledger, { historical: Boolean(stopped) });
    const started = supervisor.db.prepare("SELECT slot_id,attempt_no FROM attempt WHERE state='started'").all();
    if (started.length) {
      if (!stopped || stopped === 'case_reset_limit' || started.length !== 1) throw new Error('campaign attempt requires reconciliation');
      const attempt = started[0], slot = supervisor.slots.find((item) => item.id === attempt.slot_id);
      const claim = supervisor.db.prepare('SELECT activated,spawn_state FROM worker_claim WHERE slot_id=? AND attempt_no=?').get(attempt.slot_id, attempt.attempt_no);
      const receipt = supervisor.receipts.find(attempt.slot_id, attempt.attempt_no);
      if (!slot || !claim || claim.activated !== 1 || claim.spawn_state !== 'exited' || !supervisor.workerExited(attempt.slot_id, attempt.attempt_no) ||
          !receipt || receipt.receipt.status !== 'stop' || receipt.receipt.caseId !== slot.caseId) throw new Error('campaign attempt requires reconciliation');
    }
    if (!stopped) {
      if (outcomes.length !== supervisor.slots.length) throw new Error('campaign is not terminal');
      const finalBoundary = `final-${sha(config.binding)}`;
      const snapshot = ledger.db.prepare('SELECT physical_starts FROM key_snapshot WHERE fresh=1 AND boundary_id=? ORDER BY rowid DESC LIMIT 1').get(finalBoundary);
      if (!snapshot || snapshot.physical_starts !== ledger.physicalPrefix()) throw new Error('final key snapshot missing');
    }
    const binding = config.blind;
    const { locators, oracles } = validateBlindInputs(binding, supervisor.slots);
    const selected = outcomes.filter((row) => row.state === 'selected').map((row) => {
      const slot = supervisor.slots.find((item) => item.id === row.slot_id), location = locators.cases.find((item) => item.caseId === slot?.caseId);
      const found = supervisor.receipts.find(row.slot_id, row.attempt_no);
      if (!slot || !location || !found || found.hash !== row.receipt_sha256 || !['control', 'treatment'].includes(slot.blind?.arm) || !Number.isSafeInteger(slot.blind?.draw)) throw new Error('invalid selected blind binding');
      const root = path.join(found.receipt.runDir, 'telemetry');
      const read = (file) => JSON.parse(readBytes(path.join(root, file)).toString('utf8'));
      const run = read('run.json'), resolved = read('stages/01-input/resolved-input.json');
      const packetDir = path.join(root, 'stages/06-packets/packets');
      const hunkIdentifiers = new Set();
      const packetIdentifiers = readdirSync(packetDir).filter((name) => name.endsWith('.json')).flatMap((name) => {
        const packet = JSON.parse(readBytes(path.join(packetDir, name)).toString('utf8'));
        for (const hunk of packet.hunks ?? []) hunkIdentifiers.add(hunk.hunkId);
        return [packet.id, ...(Array.isArray(packet.hunks) ? packet.hunks.map((hunk) => hunk.hunkId) : [])];
      });
      if (resolved.headSha !== location.sourceRevision) throw new Error('blind source revision mismatch');
      const packetCalls = JSON.parse(readBytes(path.join(found.receipt.runDir, 'packet-calls.json')).toString('utf8'));
      const modelCalls = readBytes(path.join(root, 'model-calls.jsonl')).toString('utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
      verifyPacketCalls({ bindings: slot.workerConfig.packetTemplates, packetIds: slot.expectedPacketIds, calls: packetCalls, modelCalls,
        instructionSet: instructionArms?.[slot.blind.arm] ?? 'v1',
        readDebug: (callId) => {
          if (!/^mc-[A-Za-z0-9_-]+$/u.test(callId)) throw new Error('invalid model call id');
          return read(`debug/llm-calls/${callId}.request.json`);
        } });
      const oracleCase = normalizeOracleCase(oracles.cases.find((item) => item.caseId === slot.caseId), oracles.version);
      return { slotId: slot.id, attempt: row.attempt_no, receiptSHA256: row.receipt_sha256, arm: slot.blind.arm, draw: slot.blind.draw,
        caseId: location.label, sourceLocator: location.sourceLocator, oracleLocator: location.oracleLocator, causes: oracles.cases.find((item) => item.caseId === slot.caseId).causes,
        ...(oracles.version === 2 ? { role: oracleCase.role, rejects: oracleCase.rejects } : {}),
        evidence: { outcome: run.outcome?.status, hunkIdentifiers: [...hunkIdentifiers], privateIdentifiers: [run.runId, found.receipt.runDir, slot.workerConfig.caseConfig, location.sourceRoot, location.oraclePath, ...packetIdentifiers],
          candidates: read('stages/09-verification/candidate-findings.json'), promotion: read('stages/09-verification/uncertainty-promotion.json'),
          verification: read('stages/09-verification/verification.json'), finalReview: read('final-review.json') } };
    });
    return { selected, outcomes, stopped, binding };
  };
  const exportBlind = ({ outputDirectory, mappingFile }) => {
    const { selected, outcomes, stopped, binding } = selectedForBlind();
    if (typeof binding.mappingFile !== 'string' || mappingFile !== binding.mappingFile) throw new Error('blind mapping path mismatch');
    const prior = supervisor.db.prepare('SELECT mapping_sha256,manifest_sha256 FROM blind_export WHERE id=1').get();
    if (!prior) throw new Error('blind export custody failure');
    if (prior.mapping_sha256 !== null && !existsSync(mappingFile)) throw new Error('blind mapping custody failure');
    const result = exportFirstLock({ bindingSHA256: expectedSHA256, oracleManifestSHA256: binding.oracleManifestSHA256, selections: selected,
      excludedCount: outcomes.filter((row) => row.state === 'excluded').length, campaignState: stopped ? 'stopped' : 'completed', outputDirectory, mappingFile,
      ...(prior.mapping_sha256 !== null ? { expectedMappingSHA256: prior.mapping_sha256, expectedManifestSHA256: prior.manifest_sha256 } : {}),
      bindPrepared: (mappingSHA256, manifestSHA256) => { supervisor.bindBlindExport(mappingSHA256, manifestSHA256); return true; } });
    return result;
  };
  const reveal = async (request) => {
    const { selected, outcomes, stopped, binding } = selectedForBlind();
    if (request.mappingFile !== binding.mappingFile) throw new Error('blind mapping path mismatch');
    const authority = supervisor.db.prepare('SELECT mapping_sha256,manifest_sha256,reconciliation_sha256 FROM blind_export WHERE id=1').get();
    if (!authority || authority.manifest_sha256 !== request.manifestSHA256) throw new Error('blind export not bound');
    const bytes = readBytes(outsideCheckout(request.mappingFile)), mapping = JSON.parse(bytes.toString('utf8'));
    if (mapping.bindingSHA256 !== expectedSHA256 || mapping.oracleManifestSHA256 !== binding.oracleManifestSHA256 || mapping.campaignState !== (stopped ? 'stopped' : 'completed') || mapping.excludedCount !== outcomes.filter((row) => row.state === 'excluded').length || !Array.isArray(mapping.selections) || mapping.selections.length !== selected.length || mapping.selections.some((item, index) => {
      const current = selected[index];
      return !current || ['slotId', 'attempt', 'receiptSHA256', 'arm', 'draw', 'caseId', 'sourceLocator', 'oracleLocator'].some((key) => item[key] !== current[key]);
    })) throw new Error('blind cohort changed');
    return revealPairing({ ...request, ...(authority.reconciliation_sha256 !== null ? { expectedReconciliationSHA256: authority.reconciliation_sha256 } : {}),
      bindPrepared: (reconciliationSHA256) => supervisor.bindReconciliation(reconciliationSHA256) });
  };
  const score = async (request) => {
    const { outcomes } = selectedForBlind();
    if (!request || !Array.isArray(request.bundles) || !request.bundles.length) throw new Error('score bundles missing');
    const bound = validateBlindInputs(config.blind, supervisor.slots);
    const inventory = bound.oracles.cases.map((item) => ({ caseId: item.caseId,
      caseLabel: bound.locators.cases.find((location) => location.caseId === item.caseId).label,
      ...normalizeOracleCase(item, bound.oracles.version) }));
    const assignments = supervisor.slots.map((slot) => ({ slotId: slot.id, caseId: slot.caseId, arm: slot.blind.arm, draw: slot.blind.draw }));
    const candidates = new Map(outcomes.map((row) => [row.slot_id, [{ row, source: expectedSHA256 }]]));
    const attempted = new Set(supervisor.db.prepare('SELECT DISTINCT slot_id FROM attempt').all().map((row) => row.slot_id));
    const bundles = [];
    for (const descriptor of request.bundles) {
      const sourceFile = descriptor.campaignFile ?? configFile, sourceSHA256 = descriptor.campaignSHA256 ?? expectedSHA256;
      const isCurrent = sourceSHA256 === expectedSHA256 && path.resolve(sourceFile) === path.resolve(configFile);
      let other;
      try {
        other = isCurrent ? undefined : await openCampaign(sourceFile, sourceSHA256, { resumeOnly: true });
        const source = other ?? { supervisor, ledger, verifiedOutcomes: () => outcomes };
        const sourceConfig = isCurrent ? config : JSON.parse(readCheckedFile(sourceFile).toString('utf8'));
        source.ledger.assertRestartSafe();
        if (source.ledger.hasPendingMeter()) throw new Error('meter custody requires reconciliation');
        verifyAllEvidence(source.ledger, listEvidenceFiles(sourceConfig.evidenceDirectory));
        const sourceOutcomes = isCurrent ? outcomes : source.verifiedOutcomes();
        for (const row of source.supervisor.db.prepare('SELECT DISTINCT slot_id FROM attempt').all()) {
          if (!assignments.some((slot) => slot.slotId === row.slot_id)) throw new Error('foreign score attempt');
          attempted.add(row.slot_id);
        }
        const authority = source.supervisor.db.prepare('SELECT mapping_sha256,manifest_sha256,reconciliation_sha256 FROM blind_export WHERE id=1').get();
        const bundle = loadScoringBundle(descriptor);
        if (!authority || authority.manifest_sha256 !== descriptor.manifestSHA256 || authority.mapping_sha256 !== bundle.manifest.mappingSHA256 ||
            authority.reconciliation_sha256 !== descriptor.reconciliation.sha256 || bundle.mapping.bindingSHA256 !== sourceSHA256) throw new Error('score export authority mismatch');
        for (const item of bundle.mapping.selections) {
          const sourceSlot = source.supervisor.slots.find((slot) => slot.id === item.slotId);
          const original = assignments.find((slot) => slot.slotId === item.slotId);
          const originalSlot = supervisor.slots.find((slot) => slot.id === item.slotId);
          const row = sourceOutcomes.find((outcome) => outcome.slot_id === item.slotId);
          if (!sourceSlot || !original || !originalSlot || !row || row.state !== 'selected' || row.attempt_no !== item.attempt || row.receipt_sha256 !== item.receiptSHA256 ||
              sourceSlot.caseId !== original.caseId || sourceSlot.blind?.arm !== original.arm || sourceSlot.blind?.draw !== original.draw ||
              JSON.stringify(sourceSlot.expectedPacketIds) !== JSON.stringify(originalSlot.expectedPacketIds) ||
              ['packetTemplates', 'plannerReplayBinding', 'expectedCalls'].some((key) => JSON.stringify(sourceSlot.workerConfig[key]) !== JSON.stringify(originalSlot.workerConfig[key])) ||
              sourceSlot.workerConfig.integrity?.suiteSHA256 !== originalSlot.workerConfig.integrity?.suiteSHA256 ||
              JSON.stringify(sourceSlot.workerConfig.integrity?.build) !== JSON.stringify(originalSlot.workerConfig.integrity?.build)) throw new Error('score source outcome mismatch');
        }
        if (!isCurrent) for (const row of sourceOutcomes) {
          if (!assignments.some((slot) => slot.slotId === row.slot_id)) throw new Error('foreign score outcome');
          const list = candidates.get(row.slot_id) ?? [];
          list.push({ row, source: sourceSHA256 }); candidates.set(row.slot_id, list);
        }
        bundles.push(bundle);
      } finally { other?.close(); }
    }
    const dispositions = assignments.map((slot) => {
      const all = candidates.get(slot.slotId) ?? [], selected = all.filter(({ row }) => row.state === 'selected');
      if (selected.length > 1) throw new Error('duplicate selected outcome');
      if (!selected.length) {
        if (all.some(({ row }) => row.state === 'excluded')) return { ...slot, state: 'failed' };
        return { ...slot, state: attempted.has(slot.slotId) ? 'ungraded' : 'unrun' };
      }
      const outcome = selected[0].row;
      const matches = bundles.flatMap((bundle, bundleIndex) => bundle.mapping.selections.filter((item) => item.slotId === slot.slotId).map(() => bundleIndex));
      if (!matches.length) return { ...slot, state: 'ungraded' };
      if (matches.length !== 1) throw new Error('duplicate graded slot');
      return { ...slot, state: 'selected', bundleIndex: matches[0], attempt: outcome.attempt_no, receiptSHA256: outcome.receipt_sha256 };
    });
    const mixedAssertions = bundles.some((bundle) => bundle.reconciliation.grades.some((grade) => !Object.hasOwn(grade, 'assertions'))) ? 'unmeasured-class-only' : 'measured';
    const auditCoverage = inventory.filter((item) => item.role === 'negative-control').map((item) => {
      const location = bound.locators.cases.find((row) => row.caseId === item.caseId);
      try {
        if (bound.oracles.version !== 2 || !location.admissionAudit) throw new Error('audit unavailable');
        const bytes = readCheckedFile(location.admissionAudit.path);
        if (sha(bytes) !== location.admissionAudit.sha256) throw new Error('audit changed');
        return { caseId: item.caseId, ...validateAdmissionAudit({ record: JSON.parse(bytes.toString('utf8')),
          case: bound.oracles.cases.find((row) => row.caseId === item.caseId), locator: location, suiteCase: suiteCases.get(item.caseId), checkout: location.sourceRoot, role: item.role, causes: item.causes }) };
      } catch { return { caseId: item.caseId, status: 'unavailable' }; }
    });
    return { ...scoreCampaign({ schedule: assignments, inventory, dispositions, bundles }), mixedAssertions, auditCoverage, campaignSHA256: expectedSHA256,
      scheduleSHA256: config.scheduleSHA256, bundles: request.bundles.map((item) => ({ manifestSHA256: item.manifestSHA256,
        reconciliationSHA256: item.reconciliation.sha256, revealSHA256: item.revealSHA256 })) };
  };
  const progressFingerprint = () => sha(JSON.stringify({ totals: ledger.totals(),
    attempts: supervisor.db.prepare('SELECT slot_id,attempt_no,state FROM attempt ORDER BY slot_id,attempt_no').all(),
    outcomes: supervisor.db.prepare('SELECT slot_id,state,receipt_sha256 FROM outcome ORDER BY slot_id').all(),
    polls: ledger.db.prepare('SELECT boundary_id,attempts,pending FROM meter_poll ORDER BY boundary_id').all(),
    snapshots: ledger.db.prepare('SELECT COUNT(*) AS count FROM key_snapshot').get().count }));
  return { step, exportBlind, reveal, score, supervisor, ledger, progressFingerprint, stopNoProgress() { ledger.stop('no_progress'); }, verifiedOutcomes() {
    supervisor.assertDriver();
    return supervisor.checkedOutcomes(verifyReceipt, verifyRetry, ledger);
  }, releaseCheckpoint() {
    supervisor.assertDriver();
    if (ledger.totals().stopped) throw new Error('campaign stopped');
    ledger.assertRestartSafe(); verifyAllEvidence(ledger, files());
    return supervisor.releaseCheckpoint(verifyReceipt, verifyRetry, ledger);
  },
    close() { supervisor.releaseDriver(token); ledger.close(); supervisor.close(); } };
}
