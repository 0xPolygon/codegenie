import { DatabaseSync } from 'node:sqlite';

// Values are integer microdollars; no native estimate is treated as a bill.
export class CampaignLedger {
  constructor(file, { binding, limitMicros, reserveMicros = 400_000, errorHoldMicros = 50_000 }) {
    if (typeof binding !== 'string' || !binding || !Number.isSafeInteger(limitMicros) || limitMicros <= 0 ||
        !Number.isSafeInteger(reserveMicros) || reserveMicros <= 0 || !Number.isSafeInteger(errorHoldMicros) || errorHoldMicros < 0 || errorHoldMicros > reserveMicros) throw new TypeError('invalid ledger binding or cap');
    this.binding = binding;
    this.limit = limitMicros;
    this.reserve = reserveMicros;
    this.errorHold = errorHoldMicros;
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA busy_timeout=30000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS campaign(binding TEXT PRIMARY KEY, limit_micros INTEGER NOT NULL, reserve_micros INTEGER NOT NULL, error_hold_micros INTEGER NOT NULL, stopped TEXT);
      CREATE TABLE IF NOT EXISTS physical(id TEXT PRIMARY KEY, logical_id TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL, charge INTEGER NOT NULL, http_status INTEGER, evidence_json TEXT);
      CREATE TABLE IF NOT EXISTS local_refusal(id TEXT PRIMARY KEY, logical_id TEXT NOT NULL, reason TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS logical(id TEXT PRIMARY KEY, status TEXT NOT NULL);`);
    this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM campaign').get();
      if (!row) this.db.prepare('INSERT INTO campaign(binding,limit_micros,reserve_micros,error_hold_micros) VALUES(?,?,?,?)').run(binding, limitMicros, reserveMicros, errorHoldMicros);
      else if (row.binding !== binding || row.limit_micros !== limitMicros || row.reserve_micros !== reserveMicros || row.error_hold_micros !== errorHoldMicros) throw new Error('ledger binding mismatch');
    });
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  reservePhysical({ id, logicalId, kind }) {
    if (![id, logicalId, kind].every((x) => typeof x === 'string' && x)) throw new TypeError('invalid physical identity');
    return this.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM physical WHERE id=? UNION ALL SELECT 1 FROM local_refusal WHERE id=?').get(id, id)) throw new Error('duplicate attempt identity');
      if (this.db.prepare("SELECT 1 FROM logical WHERE id=? AND status='cache_hit'").get(logicalId)) throw new Error('cache hit cannot start a physical call');
      const campaign = this.db.prepare('SELECT stopped FROM campaign').get();
      const total = this.db.prepare('SELECT COALESCE(SUM(charge),0) AS total FROM physical').get().total;
      if (campaign.stopped || total + this.reserve > this.limit) {
        this.db.prepare('INSERT INTO local_refusal(id,logical_id,reason) VALUES(?,?,?)').run(id, logicalId, campaign.stopped ?? 'campaign_budget');
        return { admitted: false, reason: campaign.stopped ?? 'campaign_budget' };
      }
      this.db.prepare("INSERT INTO physical(id,logical_id,kind,state,charge) VALUES(?,?,?,'open',?)").run(id, logicalId, kind, this.reserve);
      return { admitted: true };
    });
  }
  recordRefusal({ id, logicalId, reason }) {
    if (![id, logicalId, reason].every((x) => typeof x === 'string' && x)) throw new TypeError('invalid refusal');
    this.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM physical WHERE id=?').get(id)) throw new Error('physical identity already started');
      this.db.prepare('INSERT INTO local_refusal(id,logical_id,reason) VALUES(?,?,?)').run(id, logicalId, reason);
    });
  }
  recordCacheHit(id) {
    if (typeof id !== 'string' || !id) throw new TypeError('invalid logical identity');
    this.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM physical WHERE logical_id=? UNION ALL SELECT 1 FROM local_refusal WHERE logical_id=?').get(id, id)) throw new Error('logical call already attempted transport');
      this.db.prepare("INSERT INTO logical(id,status) VALUES(?,'cache_hit')").run(id);
    });
  }
  settlePhysical({ id, httpStatus = null, providerCostMicros = null, costConfirmed = false, noUsageErrorEvidence = null, unconfirmedCostLowerBoundMicros = null, usageEvidence = null, quotaDenied = false }) {
    if (typeof id !== 'string' || !id || (httpStatus !== null && (!Number.isInteger(httpStatus) || httpStatus < 100 || httpStatus > 599)) ||
        (providerCostMicros !== null && (!Number.isSafeInteger(providerCostMicros) || providerCostMicros < 0)) ||
        typeof costConfirmed !== 'boolean' || typeof quotaDenied !== 'boolean' ||
        (unconfirmedCostLowerBoundMicros !== null && (!Number.isSafeInteger(unconfirmedCostLowerBoundMicros) || unconfirmedCostLowerBoundMicros < 0 || providerCostMicros !== null || noUsageErrorEvidence !== null)) ||
        (usageEvidence !== null && (typeof usageEvidence.usagePresent !== 'boolean' || typeof usageEvidence.costPresent !== 'boolean' || (usageEvidence.isByok !== undefined && typeof usageEvidence.isByok !== 'boolean'))) ||
        (providerCostMicros === null ? costConfirmed : !costConfirmed)) throw new TypeError('invalid settlement');
    if (noUsageErrorEvidence !== null && (providerCostMicros !== null || httpStatus === null ||
        (usageEvidence === null || usageEvidence.usagePresent !== true || usageEvidence.costPresent !== false) || noUsageErrorEvidence.terminal !== 'error' || noUsageErrorEvidence.usagePresent !== true || noUsageErrorEvidence.costPresent !== false || noUsageErrorEvidence.providerCostReported !== false ||
        noUsageErrorEvidence.inputTokens !== 0 || noUsageErrorEvidence.outputTokens !== 0 || noUsageErrorEvidence.totalTokens !== 0)) throw new TypeError('invalid no-usage error evidence');
    const state = providerCostMicros !== null ? 'priced' : noUsageErrorEvidence !== null ? 'qualified_error' : 'unknown';
    const charge = providerCostMicros ?? (noUsageErrorEvidence !== null ? this.errorHold : Math.max(this.reserve, unconfirmedCostLowerBoundMicros ?? 0));
    this.transaction(() => {
      const result = this.db.prepare("UPDATE physical SET state=?,charge=?,http_status=?,evidence_json=? WHERE id=? AND state='open'").run(state, charge, httpStatus, usageEvidence === null ? null : JSON.stringify(usageEvidence), id);
      if (result.changes !== 1) throw new Error('missing or already settled physical start');
      const total = this.db.prepare('SELECT COALESCE(SUM(charge),0) AS total FROM physical').get().total;
      const priced = this.db.prepare("SELECT COALESCE(SUM(charge),0) AS total FROM physical WHERE state='priced'").get().total;
      if (quotaDenied || [401, 402, 429].includes(httpStatus) || priced >= this.limit || total > this.limit || (unconfirmedCostLowerBoundMicros ?? 0) > this.reserve || (providerCostMicros ?? 0) > this.reserve) this.db.prepare('UPDATE campaign SET stopped=COALESCE(stopped,?)').run(priced >= this.limit || total > this.limit ? 'budget_limit' : (unconfirmedCostLowerBoundMicros ?? 0) > this.reserve ? 'unpriced_lower_bound' : (providerCostMicros ?? 0) > this.reserve ? 'charge_above_reservation' : quotaDenied ? 'provider_quota' : `provider_${httpStatus}`);
    });
  }
  stop(reason) {
    if (typeof reason !== 'string' || !reason) throw new TypeError('invalid stop reason');
    this.transaction(() => this.db.prepare('UPDATE campaign SET stopped=COALESCE(stopped, ?)').run(reason));
  }
  assertRestartSafe() {
    if (this.db.prepare("SELECT 1 FROM physical WHERE state='open' LIMIT 1").get()) throw new Error('unmatched physical start requires reconciliation');
  }
  totals() {
    const physical = this.db.prepare("SELECT COUNT(*) AS starts, COALESCE(SUM(charge),0) AS charged, SUM(state='open') AS open, SUM(state='unknown') AS unknown FROM physical").get();
    return { starts: physical.starts, chargedMicros: physical.charged, open: physical.open ?? 0, unknown: physical.unknown ?? 0, stopped: this.db.prepare('SELECT stopped FROM campaign').get().stopped };
  }
  close() { this.db.close(); }
}
