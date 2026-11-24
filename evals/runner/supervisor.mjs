import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { outsideCheckout } from './case.mjs';
import { boundaryDecision } from './boundary.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const isHash = (value) => /^[a-f0-9]{64}$/u.test(value ?? '');
const prefixFor = (slot, number) => `${slot}/attempt-${String(number).padStart(2, '0')}`;

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
    this.pauseAfterSlot = parsed.pauseAfterSlot;
    this.db = new DatabaseSync(outsideCheckout(file));
    this.db.exec(`PRAGMA busy_timeout=30000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS campaign(binding TEXT NOT NULL, schedule_sha256 TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attempt(slot_id TEXT NOT NULL, attempt_no INTEGER NOT NULL, state TEXT NOT NULL, receipt_sha256 TEXT, PRIMARY KEY(slot_id,attempt_no));
      CREATE TABLE IF NOT EXISTS outcome(slot_id TEXT PRIMARY KEY, state TEXT NOT NULL, attempt_no INTEGER NOT NULL, receipt_sha256 TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS release(prefix_sha256 TEXT NOT NULL);`);
    try {
      this.transaction(() => {
        const old = this.db.prepare('SELECT * FROM campaign').get();
        if (!old) this.db.prepare('INSERT INTO campaign VALUES(?,?)').run(binding, scheduleSHA256);
        else if (old.binding !== binding || old.schedule_sha256 !== scheduleSHA256) throw new Error('campaign schedule binding mismatch');
      });
    } catch (error) { this.db.close(); throw error; }
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  checkedOutcomes(verifyReceipt) {
    const rows = this.db.prepare('SELECT slot_id,state,attempt_no,receipt_sha256 FROM outcome').all();
    const byId = new Map(rows.map((r) => [r.slot_id, r]));
    if (rows.length > this.slots.length || this.slots.slice(0, rows.length).some((s) => !byId.has(s.id))) throw new Error('non-prefix outcome custody');
    for (const slot of this.slots.slice(0, rows.length)) {
      const row = byId.get(slot.id);
      const attempt = this.db.prepare('SELECT state,receipt_sha256 FROM attempt WHERE slot_id=? AND attempt_no=?').get(row.slot_id, row.attempt_no);
      if (row.state !== 'selected' || !attempt || attempt.state !== 'sealed' || attempt.receipt_sha256 !== row.receipt_sha256 ||
          verifyReceipt(row.slot_id, row.attempt_no, row.receipt_sha256) !== true) throw new Error('attempt receipt missing or changed');
    }
    return this.slots.slice(0, rows.length).map((s) => byId.get(s.id));
  }
  checkpointHash(rows) { return sha(JSON.stringify(rows.map((r) => [r.slot_id, r.state, r.attempt_no, r.receipt_sha256]))); }
  releaseCheckpoint(verifyReceipt) {
    if (typeof verifyReceipt !== 'function' || this.pauseAfterSlot === undefined) throw new Error('checkpoint not configured');
    return this.transaction(() => {
      const rows = this.checkedOutcomes(verifyReceipt);
      const count = this.slots.findIndex((s) => s.id === this.pauseAfterSlot) + 1;
      if (rows.length !== count) throw new Error('checkpoint prefix incomplete');
      const hash = this.checkpointHash(rows);
      const prior = this.db.prepare('SELECT prefix_sha256 FROM release').get();
      if (prior && prior.prefix_sha256 !== hash) throw new Error('checkpoint release drift');
      if (!prior) this.db.prepare('INSERT INTO release VALUES(?)').run(hash);
      return hash;
    });
  }
  begin(slotId, { ledger, evidenceFiles, verifyReceipt, nowMs = Date.now() }) {
    if (typeof verifyReceipt !== 'function') throw new TypeError('receipt verifier required');
    return this.transaction(() => {
      const outcomes = this.checkedOutcomes(verifyReceipt);
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
      // Retry authorization and interrupted-attempt receipt verification are
      // integrated separately. Never silently substitute another attempt.
      if (attempts.some((row) => row.state !== 'no_start')) throw new Error('attempt requires retry authorization');
      ledger.assertRestartSafe();
      const decision = boundaryDecision({ ledger, boundaryId: next.boundaryId, provider: next.provider, evidenceFiles, nowMs });
      if (decision.action !== 'admit') return decision;
      const number = attempts.length + 1;
      this.db.prepare("INSERT INTO attempt(slot_id,attempt_no,state) VALUES(?,?,'started')").run(slotId, number);
      return { action: 'started', slot: next, attempt: number, attemptPrefix: prefixFor(slotId, number) };
    });
  }
  reconcile(slotId, attemptNo, { ledger, verifyWorkerExited, sealInterrupted, verifyReceipt }) {
    if (!Number.isSafeInteger(attemptNo) || attemptNo < 1 || typeof verifyWorkerExited !== 'function' || verifyWorkerExited(slotId, attemptNo) !== true) throw new Error('worker exit not verified');
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
      this.db.prepare("UPDATE attempt SET state='interrupted',receipt_sha256=? WHERE slot_id=? AND attempt_no=?").run(hash, slotId, attemptNo);
      return { state: 'interrupted', receiptSHA256: hash };
    });
  }
  seal(slotId, attemptNo, receiptSHA256, verifyReceipt) {
    if (!Number.isSafeInteger(attemptNo) || attemptNo < 1 || !isHash(receiptSHA256) || typeof verifyReceipt !== 'function' || verifyReceipt(slotId, attemptNo, receiptSHA256) !== true) throw new Error('attempt receipt missing or changed');
    this.transaction(() => {
      const result = this.db.prepare("UPDATE attempt SET state='sealed',receipt_sha256=? WHERE slot_id=? AND attempt_no=? AND state='started'").run(receiptSHA256, slotId, attemptNo);
      if (result.changes !== 1) throw new Error('attempt is not awaiting a receipt');
      this.db.prepare("INSERT INTO outcome VALUES(?,'selected',?,?)").run(slotId, attemptNo, receiptSHA256);
    });
  }
  close() { this.db.close(); }
}
