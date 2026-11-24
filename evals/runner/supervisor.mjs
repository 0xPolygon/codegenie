import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { outsideCheckout } from './case.mjs';
import { boundaryDecision } from './boundary.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const isHash = (value) => /^[a-f0-9]{64}$/u.test(value ?? '');
const prefixFor = (slot, number) => `${slot}/attempt-${String(number).padStart(2, '0')}`;
const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;

// Receipt and process verification are supplied by the campaign integration;
// this state machine never infers a stopped process from a timeout.
export class CampaignSupervisor {
  constructor(file, { binding, scheduleBytes, scheduleSHA256 }) {
    if (typeof binding !== 'string' || !binding || !Buffer.isBuffer(scheduleBytes) || !isHash(scheduleSHA256) || sha(scheduleBytes) !== scheduleSHA256) throw new Error('campaign schedule binding mismatch');
    const parsed = JSON.parse(scheduleBytes.toString('utf8'));
    if (!Array.isArray(parsed.slots) || parsed.slots.length === 0 || parsed.slots.some((s) =>
      typeof s.id !== 'string' || !/^[A-Za-z0-9._-]+$/u.test(s.id) || typeof s.boundaryId !== 'string' || !s.boundaryId || typeof s.provider !== 'string' || !s.provider) ||
      new Set(parsed.slots.map((s) => s.id)).size !== parsed.slots.length ||
      (parsed.pauseAfterSlot !== undefined && !parsed.slots.some((s) => s.id === parsed.pauseAfterSlot))) throw new Error('invalid campaign schedule');
    this.slots = parsed.slots;
    this.binding = binding;
    this.pauseAfterSlot = parsed.pauseAfterSlot;
    this.db = new DatabaseSync(outsideCheckout(file));
    this.db.exec(`PRAGMA busy_timeout=30000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS campaign(binding TEXT NOT NULL, schedule_sha256 TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attempt(slot_id TEXT NOT NULL, attempt_no INTEGER NOT NULL, state TEXT NOT NULL, receipt_sha256 TEXT, PRIMARY KEY(slot_id,attempt_no));
      CREATE TABLE IF NOT EXISTS outcome(slot_id TEXT PRIMARY KEY, state TEXT NOT NULL, attempt_no INTEGER NOT NULL, receipt_sha256 TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS retry_authorization(slot_id TEXT PRIMARY KEY, attempt_no INTEGER NOT NULL, failure_sha256 TEXT NOT NULL, proof_sha256 TEXT NOT NULL, probe_id TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS exclusion(slot_id TEXT PRIMARY KEY, first_attempt_no INTEGER NOT NULL, first_sha256 TEXT NOT NULL, second_attempt_no INTEGER NOT NULL, second_sha256 TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS release(prefix_sha256 TEXT NOT NULL);`);
    try {
      this.transaction(() => {
        const old = this.db.prepare('SELECT * FROM campaign').get();
        if (!old) this.db.prepare('INSERT INTO campaign VALUES(?,?)').run(binding, scheduleSHA256);
        else if (old.binding !== binding || old.schedule_sha256 !== scheduleSHA256) throw new Error('campaign schedule binding mismatch');
      });
    } catch (error) { this.db.close(); throw error; }
  }
  verifyWorkerBinding(slotId, attemptNo, configBytes, configSHA256) {
    if (!Buffer.isBuffer(configBytes) || !isHash(configSHA256) || sha(configBytes) !== configSHA256) throw new Error('worker config digest mismatch');
    const config = JSON.parse(configBytes.toString('utf8'));
    const row = this.db.prepare('SELECT state FROM attempt WHERE slot_id=? AND attempt_no=?').get(slotId, attemptNo);
    const slot = this.slots.find((item) => item.id === slotId);
    if (!row || row.state !== 'started' || !slot?.workerConfig || typeof slot.workerConfig !== 'object' || Array.isArray(slot.workerConfig) ||
        config.ledgerBinding !== this.binding || JSON.stringify(canonical(config)) !== JSON.stringify(canonical({ ...slot.workerConfig, attemptPrefix: prefixFor(slotId, attemptNo) }))) throw new Error('worker attempt binding mismatch');
    return true;
  }
  noStartCount(slotId) {
    if (!this.slots.some((slot) => slot.id === slotId)) throw new Error('unregistered slot');
    return this.db.prepare("SELECT COUNT(*) AS total FROM attempt WHERE slot_id=? AND state='no_start'").get(slotId).total;
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  assertRetryProbe(ledger, slotId, attemptNo, failureSHA256, probeId) {
    const slot = this.slots.find((s) => s.id === slotId);
    if (!slot || !ledger?.db || typeof probeId !== 'string' || !probeId) throw new Error('retry probe ledger binding missing');
    const prefix = `${prefixFor(slotId, attemptNo)}/`;
    const failed = ledger.db.prepare('SELECT COUNT(*) AS count, SUM(settled_at_ms IS NULL) AS open, MAX(settled_at_ms) AS last FROM physical WHERE substr(id,1,?)=?').get(prefix.length, prefix);
    const probe = ledger.db.prepare(`SELECT p.kind,p.provider,p.health_boundary,p.health_purpose,p.retry_for,p.retry_failure_sha256,p.started_at_ms,p.settled_at_ms,p.state,p.http_status,h.outcome,h.observed_ms
      FROM physical p LEFT JOIN health_receipt h ON h.physical_id=p.id WHERE p.id=?`).get(probeId);
    if (!failed.count || failed.open || !probe || probe.kind !== 'health' || probe.provider !== slot.provider || probe.health_boundary !== slot.boundaryId ||
        probe.health_purpose !== 'retry' || probe.retry_for !== prefixFor(slotId, attemptNo) || probe.retry_failure_sha256 !== failureSHA256 || probe.state === 'open' || probe.http_status < 200 || probe.http_status >= 300 || probe.outcome !== 'clean' ||
        probe.started_at_ms <= failed.last || probe.settled_at_ms === null || probe.observed_ms < probe.settled_at_ms) throw new Error('retry probe is not a fresh clean ledger result');
  }
  checkedOutcomes(verifyReceipt, verifyRetry, ledger) {
    const rows = this.db.prepare('SELECT slot_id,state,attempt_no,receipt_sha256 FROM outcome').all();
    const byId = new Map(rows.map((r) => [r.slot_id, r]));
    if (rows.length > this.slots.length || this.slots.slice(0, rows.length).some((s) => !byId.has(s.id))) throw new Error('non-prefix outcome custody');
    for (const slot of this.slots.slice(0, rows.length)) {
      const row = byId.get(slot.id);
      const attempt = this.db.prepare('SELECT state,receipt_sha256 FROM attempt WHERE slot_id=? AND attempt_no=?').get(row.slot_id, row.attempt_no);
      if (!attempt || attempt.receipt_sha256 !== row.receipt_sha256 || verifyReceipt(row.slot_id, row.attempt_no, row.receipt_sha256) !== true) throw new Error('attempt receipt missing or changed');
      const priorFailures = this.db.prepare("SELECT attempt_no,receipt_sha256 FROM attempt WHERE slot_id=? AND attempt_no<? AND state IN ('interrupted','infrastructure_failure') ORDER BY attempt_no").all(slot.id, row.attempt_no);
      if (priorFailures.length) {
        const auth = this.db.prepare('SELECT * FROM retry_authorization WHERE slot_id=?').get(slot.id);
        if (priorFailures.length !== 1 || verifyReceipt(slot.id, priorFailures[0].attempt_no, priorFailures[0].receipt_sha256) !== true ||
            !auth || auth.attempt_no !== priorFailures[0].attempt_no || auth.failure_sha256 !== priorFailures[0].receipt_sha256 ||
            typeof verifyRetry !== 'function' || verifyRetry(slot.id, auth.attempt_no, auth.failure_sha256, auth.proof_sha256, auth.probe_id) !== true) throw new Error('retry authorization missing or changed');
        this.assertRetryProbe(ledger, slot.id, auth.attempt_no, auth.failure_sha256, auth.probe_id);
      }
      if (row.state === 'selected' && attempt.state !== 'sealed') throw new Error('selected attempt missing');
      if (row.state === 'excluded') {
        const excluded = this.db.prepare('SELECT * FROM exclusion WHERE slot_id=?').get(slot.id);
        const first = excluded && this.db.prepare('SELECT state,receipt_sha256 FROM attempt WHERE slot_id=? AND attempt_no=?').get(slot.id, excluded.first_attempt_no);
        if (!excluded || !first || !['interrupted', 'infrastructure_failure'].includes(first.state) || first.receipt_sha256 !== excluded.first_sha256 ||
            !['interrupted', 'infrastructure_failure'].includes(attempt.state) || excluded.second_attempt_no !== row.attempt_no || excluded.second_sha256 !== row.receipt_sha256 ||
            verifyReceipt(slot.id, excluded.first_attempt_no, excluded.first_sha256) !== true) throw new Error('exclusion custody missing or changed');
      } else if (row.state !== 'selected') throw new Error('invalid outcome');
    }
    return this.slots.slice(0, rows.length).map((s) => byId.get(s.id));
  }
  checkpointHash(rows) {
    return sha(JSON.stringify(rows.map((r) => {
      const first = r.state === 'excluded' ? this.db.prepare('SELECT first_attempt_no,first_sha256 FROM exclusion WHERE slot_id=?').get(r.slot_id) : null;
      return [r.slot_id, r.state, r.attempt_no, r.receipt_sha256, first];
    })));
  }
  releaseCheckpoint(verifyReceipt, verifyRetry, ledger) {
    if (typeof verifyReceipt !== 'function' || this.pauseAfterSlot === undefined) throw new Error('checkpoint not configured');
    return this.transaction(() => {
      const rows = this.checkedOutcomes(verifyReceipt, verifyRetry, ledger);
      const count = this.slots.findIndex((s) => s.id === this.pauseAfterSlot) + 1;
      if (rows.length !== count) throw new Error('checkpoint prefix incomplete');
      const hash = this.checkpointHash(rows);
      const prior = this.db.prepare('SELECT prefix_sha256 FROM release').get();
      if (prior && prior.prefix_sha256 !== hash) throw new Error('checkpoint release drift');
      if (!prior) this.db.prepare('INSERT INTO release VALUES(?)').run(hash);
      return hash;
    });
  }
  begin(slotId, { ledger, evidenceFiles, verifyReceipt, verifyRetry, nowMs = Date.now() }) {
    if (typeof verifyReceipt !== 'function') throw new TypeError('receipt verifier required');
    return this.transaction(() => {
      const outcomes = this.checkedOutcomes(verifyReceipt, verifyRetry, ledger);
      const next = this.slots[outcomes.length];
      if (!next || next.id !== slotId) throw new Error('slot is not the next unadmitted boundary');
      if (this.pauseAfterSlot !== undefined) {
        const count = this.slots.findIndex((s) => s.id === this.pauseAfterSlot) + 1;
        if (outcomes.length >= count) {
          const release = this.db.prepare('SELECT prefix_sha256 FROM release').get();
          if (!release || release.prefix_sha256 !== this.checkpointHash(outcomes.slice(0, count))) return { action: 'paused' };
        }
      }
      const all = this.db.prepare('SELECT slot_id,attempt_no,state,receipt_sha256 FROM attempt ORDER BY slot_id,attempt_no').all();
      if (all.some((row) => !this.slots.some((s) => s.id === row.slot_id))) throw new Error('unregistered attempt');
      const allowed = new Set(this.slots.slice(0, outcomes.length + 1).map((s) => s.id));
      if (all.some((row) => !allowed.has(row.slot_id))) throw new Error('non-prefix attempt custody');
      if (all.some((row) => row.state === 'started')) throw new Error('started attempt requires reconciliation');
      const attempts = all.filter((row) => row.slot_id === slotId);
      const failures = attempts.filter((row) => ['interrupted', 'infrastructure_failure'].includes(row.state));
      if (attempts.some((row) => !['no_start', 'interrupted', 'infrastructure_failure'].includes(row.state)) || failures.length > 1) throw new Error('attempt requires reconciliation');
      if (failures.length === 1) {
        const auth = this.db.prepare('SELECT * FROM retry_authorization WHERE slot_id=?').get(slotId), failed = failures[0];
        if (!auth || auth.attempt_no !== failed.attempt_no || auth.failure_sha256 !== failed.receipt_sha256 ||
            verifyReceipt(slotId, failed.attempt_no, failed.receipt_sha256) !== true || typeof verifyRetry !== 'function' ||
            verifyRetry(slotId, failed.attempt_no, failed.receipt_sha256, auth.proof_sha256, auth.probe_id) !== true) throw new Error('attempt requires retry authorization');
        this.assertRetryProbe(ledger, slotId, failed.attempt_no, failed.receipt_sha256, auth.probe_id);
      }
      ledger.assertRestartSafe();
      const decision = boundaryDecision({ ledger, boundaryId: next.boundaryId, provider: next.provider, evidenceFiles, nowMs });
      if (decision.action !== 'admit') return decision;
      const number = attempts.length + 1;
      this.db.prepare("INSERT INTO attempt(slot_id,attempt_no,state) VALUES(?,?,'started')").run(slotId, number);
      return { action: 'started', slot: next, attempt: number, attemptPrefix: prefixFor(slotId, number) };
    });
  }
  reconcile(slotId, attemptNo, { ledger, verifyWorkerExited, findTerminalReceipt, sealInterrupted, verifyReceipt, verifyRetry }) {
    if (!Number.isSafeInteger(attemptNo) || attemptNo < 1 || typeof verifyWorkerExited !== 'function' || verifyWorkerExited(slotId, attemptNo) !== true) throw new Error('worker exit not verified');
    if (typeof findTerminalReceipt !== 'function' || findTerminalReceipt(slotId, attemptNo) !== null) throw new Error('terminal receipt requires sealing before reconciliation');
    return this.transaction(() => {
      const row = this.db.prepare('SELECT state FROM attempt WHERE slot_id=? AND attempt_no=?').get(slotId, attemptNo);
      if (!row || row.state !== 'started') throw new Error('attempt is not awaiting reconciliation');
      const prefix = `${prefixFor(slotId, attemptNo)}/`;
      const physical = ledger.db.prepare('SELECT id,state,charge FROM physical WHERE substr(id,1,?)=? ORDER BY id').all(prefix.length, prefix);
      if (physical.length === 0) {
        this.db.prepare("UPDATE attempt SET state='no_start' WHERE slot_id=? AND attempt_no=?").run(slotId, attemptNo);
        return { state: 'no_start' };
      }
      if (typeof sealInterrupted !== 'function' || typeof verifyReceipt !== 'function') throw new Error('interrupted attempt receipt required');
      const hash = sealInterrupted(slotId, attemptNo, physical);
      if (!isHash(hash) || verifyReceipt(slotId, attemptNo, hash) !== true) throw new Error('interrupted attempt receipt missing or changed');
      const failures = this.db.prepare("SELECT attempt_no,receipt_sha256 FROM attempt WHERE slot_id=? AND state IN ('interrupted','infrastructure_failure') ORDER BY attempt_no").all(slotId);
      if (failures.length > 1) throw new Error('retry limit exhausted');
      if (failures.length === 1) {
        const first = failures[0], auth = this.db.prepare('SELECT * FROM retry_authorization WHERE slot_id=?').get(slotId);
        if (!auth || auth.attempt_no !== first.attempt_no || auth.failure_sha256 !== first.receipt_sha256 ||
            verifyReceipt(slotId, first.attempt_no, first.receipt_sha256) !== true || typeof verifyRetry !== 'function' ||
            verifyRetry(slotId, first.attempt_no, first.receipt_sha256, auth.proof_sha256, auth.probe_id) !== true) throw new Error('retry authorization missing or changed');
        this.assertRetryProbe(ledger, slotId, first.attempt_no, first.receipt_sha256, auth.probe_id);
      }
      this.db.prepare("UPDATE attempt SET state='interrupted',receipt_sha256=? WHERE slot_id=? AND attempt_no=?").run(hash, slotId, attemptNo);
      if (failures.length === 1) {
        const first = failures[0];
        this.db.prepare('INSERT INTO exclusion VALUES(?,?,?,?,?)').run(slotId, first.attempt_no, first.receipt_sha256, attemptNo, hash);
        this.db.prepare("INSERT INTO outcome VALUES(?,'excluded',?,?)").run(slotId, attemptNo, hash);
      }
      return { state: 'interrupted', receiptSHA256: hash };
    });
  }
  authorizeRetry(slotId, attemptNo, proofSHA256, { ledger, retryProbeId, verifyReceipt, verifyFailure, verifyRetry }) {
    if (!isHash(proofSHA256) || typeof retryProbeId !== 'string' || !retryProbeId || typeof verifyReceipt !== 'function' || typeof verifyFailure !== 'function' || typeof verifyRetry !== 'function') throw new Error('invalid retry authorization');
    this.transaction(() => {
      const attempt = this.db.prepare('SELECT state,receipt_sha256 FROM attempt WHERE slot_id=? AND attempt_no=?').get(slotId, attemptNo);
      const failures = this.db.prepare("SELECT attempt_no FROM attempt WHERE slot_id=? AND state IN ('interrupted','infrastructure_failure')").all(slotId);
      if (!attempt || failures.length !== 1 || failures[0].attempt_no !== attemptNo || this.db.prepare('SELECT 1 FROM outcome WHERE slot_id=?').get(slotId) ||
          this.db.prepare("SELECT 1 FROM attempt WHERE slot_id=? AND state='started'").get(slotId) || !['interrupted', 'infrastructure_failure'].includes(attempt.state) ||
          verifyReceipt(slotId, attemptNo, attempt.receipt_sha256) !== true || verifyFailure(slotId, attemptNo, attempt.receipt_sha256) !== true ||
          verifyRetry(slotId, attemptNo, attempt.receipt_sha256, proofSHA256, retryProbeId) !== true) throw new Error('retry evidence missing or changed');
      this.assertRetryProbe(ledger, slotId, attemptNo, attempt.receipt_sha256, retryProbeId);
      this.db.prepare('INSERT INTO retry_authorization VALUES(?,?,?,?,?)').run(slotId, attemptNo, attempt.receipt_sha256, proofSHA256, retryProbeId);
    });
  }
  sealFailure(slotId, attemptNo, receiptSHA256, { ledger, verifyReceipt, verifyFailure, verifyRetry }) {
    if (!isHash(receiptSHA256) || typeof verifyReceipt !== 'function' || typeof verifyFailure !== 'function' ||
        verifyReceipt(slotId, attemptNo, receiptSHA256) !== true || verifyFailure(slotId, attemptNo, receiptSHA256) !== true) throw new Error('failure evidence missing or changed');
    this.transaction(() => {
      const failures = this.db.prepare("SELECT attempt_no,receipt_sha256 FROM attempt WHERE slot_id=? AND state IN ('interrupted','infrastructure_failure') ORDER BY attempt_no").all(slotId);
      if (failures.length > 1) throw new Error('retry limit exhausted');
      if (failures.length === 1) {
        const first = failures[0], auth = this.db.prepare('SELECT * FROM retry_authorization WHERE slot_id=?').get(slotId);
        if (!auth || auth.attempt_no !== first.attempt_no || auth.failure_sha256 !== first.receipt_sha256 ||
            verifyReceipt(slotId, first.attempt_no, first.receipt_sha256) !== true || typeof verifyRetry !== 'function' ||
            verifyRetry(slotId, first.attempt_no, first.receipt_sha256, auth.proof_sha256, auth.probe_id) !== true) throw new Error('retry authorization missing or changed');
        this.assertRetryProbe(ledger, slotId, first.attempt_no, first.receipt_sha256, auth.probe_id);
      }
      const updated = this.db.prepare("UPDATE attempt SET state='infrastructure_failure',receipt_sha256=? WHERE slot_id=? AND attempt_no=? AND state='started'").run(receiptSHA256, slotId, attemptNo);
      if (updated.changes !== 1) throw new Error('attempt is not awaiting a receipt');
      if (failures.length === 1) {
        const first = failures[0];
        this.db.prepare('INSERT INTO exclusion VALUES(?,?,?,?,?)').run(slotId, first.attempt_no, first.receipt_sha256, attemptNo, receiptSHA256);
        this.db.prepare("INSERT INTO outcome VALUES(?,'excluded',?,?)").run(slotId, attemptNo, receiptSHA256);
      }
    });
  }
  seal(slotId, attemptNo, receiptSHA256, verifyReceipt, verifyRetry, ledger) {
    if (!Number.isSafeInteger(attemptNo) || attemptNo < 1 || !isHash(receiptSHA256) || typeof verifyReceipt !== 'function' || verifyReceipt(slotId, attemptNo, receiptSHA256) !== true) throw new Error('attempt receipt missing or changed');
    this.transaction(() => {
      const failures = this.db.prepare("SELECT attempt_no,receipt_sha256 FROM attempt WHERE slot_id=? AND state IN ('interrupted','infrastructure_failure') ORDER BY attempt_no").all(slotId);
      if (failures.length) {
        const first = failures[0], auth = this.db.prepare('SELECT * FROM retry_authorization WHERE slot_id=?').get(slotId);
        if (failures.length !== 1 || !auth || auth.attempt_no !== first.attempt_no || auth.failure_sha256 !== first.receipt_sha256 ||
            verifyReceipt(slotId, first.attempt_no, first.receipt_sha256) !== true || typeof verifyRetry !== 'function' ||
            verifyRetry(slotId, first.attempt_no, first.receipt_sha256, auth.proof_sha256, auth.probe_id) !== true) throw new Error('retry authorization missing or changed');
        this.assertRetryProbe(ledger, slotId, first.attempt_no, first.receipt_sha256, auth.probe_id);
      }
      const result = this.db.prepare("UPDATE attempt SET state='sealed',receipt_sha256=? WHERE slot_id=? AND attempt_no=? AND state='started'").run(receiptSHA256, slotId, attemptNo);
      if (result.changes !== 1) throw new Error('attempt is not awaiting a receipt');
      this.db.prepare("INSERT INTO outcome VALUES(?,'selected',?,?)").run(slotId, attemptNo, receiptSHA256);
    });
  }
  close() { this.db.close(); }
}
