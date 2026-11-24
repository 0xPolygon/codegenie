import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { outsideCheckout } from './case.mjs';
import { boundaryDecision } from './boundary.mjs';

// The caller supplies sealed schedule bytes and verifies receipt bytes. The
// supervisor database is separate from the per-physical accounting ledger.
export class CampaignSupervisor {
  constructor(file, { binding, scheduleBytes, scheduleSHA256 }) {
    if (typeof binding !== 'string' || !binding || !Buffer.isBuffer(scheduleBytes) || !/^[a-f0-9]{64}$/u.test(scheduleSHA256 ?? '') ||
        createHash('sha256').update(scheduleBytes).digest('hex') !== scheduleSHA256) throw new Error('campaign schedule binding mismatch');
    const parsed = JSON.parse(scheduleBytes.toString('utf8'));
    if (!Array.isArray(parsed.slots) || parsed.slots.length === 0 || parsed.slots.some((s) =>
      typeof s.id !== 'string' || !s.id || typeof s.boundaryId !== 'string' || !s.boundaryId || typeof s.provider !== 'string' || !s.provider) ||
      new Set(parsed.slots.map((s) => s.id)).size !== parsed.slots.length) throw new Error('invalid campaign schedule');
    this.slots = parsed.slots;
    this.db = new DatabaseSync(outsideCheckout(file));
    this.db.exec(`PRAGMA busy_timeout=30000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS campaign(binding TEXT NOT NULL, schedule_sha256 TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attempt(slot_id TEXT PRIMARY KEY, state TEXT NOT NULL, receipt_sha256 TEXT);`);
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
  // Verification precedes the admission decision and any backend action.
  begin(slotId, { ledger, evidenceFiles, verifyReceipt, nowMs = Date.now() }) {
    if (typeof verifyReceipt !== 'function') throw new TypeError('receipt verifier required');
    return this.transaction(() => {
      const rows = this.db.prepare('SELECT slot_id,state,receipt_sha256 FROM attempt').all();
      const byId = new Map(rows.map((r) => [r.slot_id, r]));
      if (rows.some((r) => !this.slots.some((s) => s.id === r.slot_id))) throw new Error('unregistered slot');
      if (this.slots.some((s, i) => i >= rows.length && byId.has(s.id)) || this.slots.slice(0, rows.length).some((s) => !byId.has(s.id))) throw new Error('non-prefix attempt custody');
      for (const row of rows) {
        if (row.state === 'started') throw new Error('started attempt requires reconciliation');
        if (row.state !== 'sealed' || !verifyReceipt(row.slot_id, row.receipt_sha256)) throw new Error('attempt receipt missing or changed');
      }
      const next = this.slots.find((s) => !byId.has(s.id));
      if (!next || next.id !== slotId) throw new Error('slot is not the next unadmitted boundary');
      ledger.assertRestartSafe();
      const decision = boundaryDecision({ ledger, boundaryId: next.boundaryId, provider: next.provider, evidenceFiles, nowMs });
      if (decision.action !== 'admit') return decision;
      this.db.prepare("INSERT INTO attempt(slot_id,state) VALUES(?,'started')").run(slotId);
      return { action: 'started', slot: next };
    });
  }
  seal(slotId, receiptSHA256, verifyReceipt) {
    if (!/^[a-f0-9]{64}$/u.test(receiptSHA256 ?? '') || typeof verifyReceipt !== 'function' || !verifyReceipt(slotId, receiptSHA256)) throw new Error('attempt receipt missing or changed');
    this.transaction(() => {
      const result = this.db.prepare("UPDATE attempt SET state='sealed',receipt_sha256=? WHERE slot_id=? AND state='started'").run(receiptSHA256, slotId);
      if (result.changes !== 1) throw new Error('attempt is not awaiting a receipt');
    });
  }
  close() { this.db.close(); }
}
