import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { outsideCheckout, workerBounds } from './case.mjs';
import { CampaignLedger } from './ledger.mjs';
import { CampaignSupervisor } from './supervisor.mjs';
import { listEvidenceFiles, prepareAdmission } from './admission.mjs';
import { spawnAttempt } from './spawn-worker.mjs';
import { RecoveredResetLimitError, validateTerminal } from './terminal.mjs';
import { assertIntegrity } from './integrity.mjs';
import { verifyAllEvidence } from './boundary.mjs';

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
      driver_claim: ['id', 'pid', 'host', 'process_start', 'pid_namespace', 'token_sha256'], release: ['prefix_sha256']
    }, (row) => row.schema_version === 1 && row.binding === config.binding && row.schedule_sha256 === config.scheduleSHA256 && row.config_sha256 === configSHA256 && row.receipt_directory === config.receiptDirectory);
    check(config.ledgerPath, {
      campaign: ['binding', 'limit_micros', 'reserve_micros', 'error_hold_micros', 'salt', 'meter_stale', 'stopped', 'schema_version'],
      physical: ['id', 'logical_id', 'kind', 'provider', 'health_boundary', 'health_purpose', 'retry_for', 'retry_failure_sha256', 'started_at_ms', 'settled_at_ms', 'state', 'charge', 'http_status', 'evidence_json', 'lower_bound', 'provider_cost_nanos'],
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
  const roots = new Map();
  for (const slot of schedule.slots) {
    const wc = slot.workerConfig;
    if (!wc || slot.boundaryId === `final-${sha(config.binding)}` || typeof slot.caseId !== 'string' || !slot.caseId || !Array.isArray(slot.expectedPacketIds) || slot.provider !== 'openrouter' ||
        wc.supervisorPath !== config.supervisorPath || wc.ledgerPath !== config.ledgerPath || wc.ledgerBinding !== config.binding || wc.boundaryId !== slot.boundaryId ||
        wc.evidenceDirectory !== config.evidenceDirectory || wc.evidenceFiles !== undefined || wc.limitMicros !== config.limitMicros || wc.reserveMicros !== config.reserveMicros || wc.errorHoldMicros !== config.errorHoldMicros || !hash(wc.caseConfigSHA256) || typeof wc.caseConfig !== 'string' || !path.isAbsolute(wc.caseConfig) || outsideCheckout(wc.caseConfig) !== wc.caseConfig) throw new Error('worker schedule binding mismatch');
    const caseBytes = readBytes(wc.caseConfig);
    if (sha(caseBytes) !== wc.caseConfigSHA256) throw new Error('case config binding mismatch');
    const caseConfig = JSON.parse(caseBytes.toString('utf8'));
    if (typeof caseConfig.caseDir !== 'string' || wc.integrity?.suiteDir !== path.resolve(path.dirname(wc.caseConfig), caseConfig.caseDir) ||
        !wc.integrity?.build || Object.keys(wc.integrity.build).some((key) => wc.integrity.build[key] !== config.build?.[key]) || Object.keys(config.build ?? {}).length !== Object.keys(wc.integrity.build).length) throw new Error('case integrity binding mismatch');
    assertIntegrity(wc.integrity);
    const bounds = await workerBounds(wc.caseConfig, caseBytes, attemptPrefix(slot.id, 1));
    roots.set(slot.id, path.dirname(bounds.outputDir));
  }
  const protectedPaths = [config.supervisorPath, config.ledgerPath, config.receiptDirectory, config.evidenceDirectory, config.workDirectory];
  for (const root of roots.values()) for (const protectedPath of protectedPaths) {
    if (root === protectedPath || root.startsWith(`${protectedPath}${path.sep}`) || protectedPath.startsWith(`${root}${path.sep}`)) throw new Error('campaign paths overlap attempt artifacts');
  }
  const runRootFor = (slot, attempt) => {
    if (!roots.has(slot) || !Number.isSafeInteger(attempt) || attempt < 1) throw new Error('invalid attempt root');
    return path.join(roots.get(slot), `attempt-${String(attempt).padStart(2, '0')}`);
  };
  const existing = existsSync(config.supervisorPath), ledgerExists = existsSync(config.ledgerPath);
  if (resumeOnly && !existing) throw new Error('campaign does not exist');
  if (existing !== ledgerExists) throw new Error('campaign ledger custody requires reconciliation');
  if (!existing && [config.receiptDirectory, config.evidenceDirectory, config.workDirectory, `${config.supervisorPath}-wal`, `${config.supervisorPath}-shm`, `${config.ledgerPath}-wal`, `${config.ledgerPath}-shm`, ...roots.values()].some((file) => existsSync(file))) throw new Error('campaign namespace requires reconciliation');
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
    if (ledger.totals().stopped) return { action: 'stop', reason: ledger.totals().stopped };
    try { assertCase(slot); }
    catch { ledger.stop('binding_mismatch'); return { action: 'stop', reason: 'binding_mismatch' }; }
    if (failed && !auth && admission.status === 'clean') {
      const proof = proofHash(config.binding, slot.id, failed.attempt_no, failed.receipt_sha256, admission.physicalId);
      supervisor.authorizeRetry(slot.id, failed.attempt_no, proof, { ledger, retryProbeId: admission.physicalId, verifyReceipt, verifyFailure, verifyRetry });
      return { action: 'retry_authorized', slot: slot.id };
    }
    if (admission.action !== 'admit') return admission.status ? { action: 'health', status: admission.status } : admission;
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
    try { recoveredResets = validateTerminal({ runDir: result.runDir, attemptPrefix: started.attemptPrefix, ledger, expectedPacketIds: slot.expectedPacketIds, priorRecoveredResets: supervisor.caseResetCount(slot.caseId), ...(result.status === 'error' ? { failureCallId: result.failureCallId } : {}) }).recoveredResets; }
    catch (error) {
      if (error instanceof RecoveredResetLimitError) recoveredResets = error.recoveredResets;
      else {
        const receiptSHA256 = supervisor.receipts.sealStop(slot.id, started.attempt, { ...result, caseId: slot.caseId });
        ledger.stop('terminal_evidence');
        return { action: 'stop', reason: 'terminal_evidence', slot: slot.id, receiptSHA256 };
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
  const progressFingerprint = () => sha(JSON.stringify({ totals: ledger.totals(),
    attempts: supervisor.db.prepare('SELECT slot_id,attempt_no,state FROM attempt ORDER BY slot_id,attempt_no').all(),
    outcomes: supervisor.db.prepare('SELECT slot_id,state,receipt_sha256 FROM outcome ORDER BY slot_id').all(),
    polls: ledger.db.prepare('SELECT boundary_id,attempts,pending FROM meter_poll ORDER BY boundary_id').all(),
    snapshots: ledger.db.prepare('SELECT COUNT(*) AS count FROM key_snapshot').get().count }));
  return { step, supervisor, ledger, progressFingerprint, stopNoProgress() { ledger.stop('no_progress'); }, releaseCheckpoint() {
    supervisor.assertDriver();
    if (ledger.totals().stopped) throw new Error('campaign stopped');
    ledger.assertRestartSafe(); verifyAllEvidence(ledger, files());
    return supervisor.releaseCheckpoint(verifyReceipt, verifyRetry, ledger);
  },
    close() { supervisor.releaseDriver(token); ledger.close(); supervisor.close(); } };
}
