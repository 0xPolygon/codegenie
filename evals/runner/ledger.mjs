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
      CREATE TABLE IF NOT EXISTS physical(id TEXT PRIMARY KEY, logical_id TEXT NOT NULL, kind TEXT NOT NULL, provider TEXT NOT NULL, health_case TEXT, state TEXT NOT NULL, charge INTEGER NOT NULL, http_status INTEGER, evidence_json TEXT, lower_bound INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS key_baseline(usage_micros INTEGER NOT NULL, evidence_sha256 TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS key_snapshot(usage_micros INTEGER NOT NULL, observed_ms INTEGER NOT NULL, evidence_sha256 TEXT NOT NULL, fresh INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS health_receipt(physical_id TEXT PRIMARY KEY, outcome TEXT NOT NULL, observed_ms INTEGER NOT NULL, evidence_sha256 TEXT NOT NULL);
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
  reservePhysical({ id, logicalId, kind, provider = 'openrouter', healthCase = null }) {
    if (![id, logicalId, kind, provider].every((x) => typeof x === 'string' && x)) throw new TypeError('invalid physical identity');
    if ((kind === 'health') !== (typeof healthCase === 'string' && healthCase.length > 0)) throw new TypeError('invalid health probe binding');
    return this.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM physical WHERE id=? UNION ALL SELECT 1 FROM local_refusal WHERE id=?').get(id, id)) throw new Error('duplicate attempt identity');
      if (this.db.prepare("SELECT 1 FROM logical WHERE id=? AND status='cache_hit'").get(logicalId)) throw new Error('cache hit cannot start a physical call');
      const campaign = this.db.prepare('SELECT stopped FROM campaign').get();
      const total = this.db.prepare('SELECT COALESCE(SUM(charge),0) AS total FROM physical').get().total;
      if (campaign.stopped || total + this.reserve > this.limit) {
        this.db.prepare('INSERT INTO local_refusal(id,logical_id,reason) VALUES(?,?,?)').run(id, logicalId, campaign.stopped ?? 'campaign_budget');
        return { admitted: false, reason: campaign.stopped ?? 'campaign_budget' };
      }
      this.db.prepare("INSERT INTO physical(id,logical_id,kind,provider,health_case,state,charge) VALUES(?,?,?,?,?,'open',?)").run(id, logicalId, kind, provider, healthCase, this.reserve);
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
  raiseLowerBound(id, boundMicros) {
    if (typeof id !== 'string' || !id || !Number.isSafeInteger(boundMicros) || boundMicros < 0) throw new TypeError('invalid lower bound');
    this.transaction(() => {
      const result = this.db.prepare("UPDATE physical SET charge=MAX(charge,?),lower_bound=MAX(lower_bound,?) WHERE id=? AND state='open'").run(boundMicros, boundMicros, id);
      if (result.changes !== 1) throw new Error('missing open physical start');
      if (boundMicros > this.reserve) this.db.prepare("UPDATE campaign SET stopped=COALESCE(stopped,'unpriced_lower_bound')").run();
    });
  }
  settlePhysical({ id, httpStatus = null, providerCostMicros = null, costConfirmed = false, noUsageErrorEvidence = null, unconfirmedCostLowerBoundMicros = null, usageEvidence = null, quotaDenied = false }) {
    if (typeof id !== 'string' || !id || (httpStatus !== null && (!Number.isInteger(httpStatus) || httpStatus < 100 || httpStatus > 599)) ||
        (providerCostMicros !== null && (!Number.isSafeInteger(providerCostMicros) || providerCostMicros < 0)) ||
        typeof costConfirmed !== 'boolean' || typeof quotaDenied !== 'boolean' ||
        (unconfirmedCostLowerBoundMicros !== null && (!Number.isSafeInteger(unconfirmedCostLowerBoundMicros) || unconfirmedCostLowerBoundMicros < 0 || providerCostMicros !== null || noUsageErrorEvidence !== null)) ||
        (usageEvidence !== null && (typeof usageEvidence.usagePresent !== 'boolean' || typeof usageEvidence.costPresent !== 'boolean' || (usageEvidence.isByok !== undefined && typeof usageEvidence.isByok !== 'boolean') || (usageEvidence.providerCostComplete !== undefined && typeof usageEvidence.providerCostComplete !== 'boolean') || (usageEvidence.providerReportedCostUSD !== undefined && (typeof usageEvidence.providerReportedCostUSD !== 'number' || !Number.isFinite(usageEvidence.providerReportedCostUSD) || usageEvidence.providerReportedCostUSD < 0)) || (usageEvidence.providerBilledCostUSD !== undefined && (typeof usageEvidence.providerBilledCostUSD !== 'number' || !Number.isFinite(usageEvidence.providerBilledCostUSD) || usageEvidence.providerBilledCostUSD < 0)) || (usageEvidence.knownBilledLowerBoundMicros !== undefined && (!Number.isSafeInteger(usageEvidence.knownBilledLowerBoundMicros) || usageEvidence.knownBilledLowerBoundMicros < 0)))) ||
        (providerCostMicros === null ? costConfirmed : !costConfirmed)) throw new TypeError('invalid settlement');
    const evidenceKeys = new Set(['usagePresent', 'costPresent', 'isByok', 'providerCostComplete', 'knownBilledLowerBoundMicros', 'providerReportedCostUSD', 'providerBilledCostUSD']);
    if (usageEvidence !== null && Object.keys(usageEvidence).some((key) => !evidenceKeys.has(key))) throw new TypeError('unsupported usage evidence');
    if (noUsageErrorEvidence !== null && (providerCostMicros !== null || httpStatus === null ||
        (usageEvidence === null || usageEvidence.usagePresent !== true || usageEvidence.costPresent !== false) || noUsageErrorEvidence.terminal !== 'error' || noUsageErrorEvidence.usagePresent !== true || noUsageErrorEvidence.costPresent !== false || noUsageErrorEvidence.providerCostReported !== false ||
        noUsageErrorEvidence.inputTokens !== 0 || noUsageErrorEvidence.outputTokens !== 0 || noUsageErrorEvidence.totalTokens !== 0)) throw new TypeError('invalid no-usage error evidence');
    const state = providerCostMicros !== null ? 'priced' : noUsageErrorEvidence !== null ? 'qualified_error' : 'unknown';
    const charge = providerCostMicros ?? (noUsageErrorEvidence !== null ? this.errorHold : Math.max(this.reserve, unconfirmedCostLowerBoundMicros ?? 0));
    const settled = this.transaction(() => {
      const prior = this.db.prepare("SELECT lower_bound FROM physical WHERE id=? AND state='open'").get(id);
      if (!prior) throw new Error('missing or already settled physical start');
      if ((providerCostMicros !== null && providerCostMicros < prior.lower_bound) || (noUsageErrorEvidence !== null && prior.lower_bound > 0)) {
        this.db.prepare("UPDATE physical SET state='unknown',charge=MAX(charge,lower_bound),http_status=?,evidence_json=? WHERE id=?").run(httpStatus, usageEvidence === null ? null : JSON.stringify(usageEvidence), id);
        this.db.prepare("UPDATE campaign SET stopped=COALESCE(stopped,'accounting_failed')").run();
        return false;
      }
      const result = this.db.prepare("UPDATE physical SET state=?,charge=?,http_status=?,evidence_json=? WHERE id=? AND state='open'").run(state, Math.max(charge, state === 'unknown' ? prior.lower_bound : 0), httpStatus, usageEvidence === null ? null : JSON.stringify(usageEvidence), id);
      if (result.changes !== 1) throw new Error('missing or already settled physical start');
      const total = this.db.prepare('SELECT COALESCE(SUM(charge),0) AS total FROM physical').get().total;
      const priced = this.db.prepare("SELECT COALESCE(SUM(charge),0) AS total FROM physical WHERE state='priced'").get().total;
      if (quotaDenied || [401, 402, 429].includes(httpStatus) || priced >= this.limit || total > this.limit || (unconfirmedCostLowerBoundMicros ?? 0) > this.reserve || (providerCostMicros ?? 0) > this.reserve) this.db.prepare('UPDATE campaign SET stopped=COALESCE(stopped,?)').run(priced >= this.limit || total > this.limit ? 'budget_limit' : (unconfirmedCostLowerBoundMicros ?? 0) > this.reserve ? 'unpriced_lower_bound' : (providerCostMicros ?? 0) > this.reserve ? 'charge_above_reservation' : quotaDenied ? 'provider_quota' : `provider_${httpStatus}`);
      return true;
    });
    if (!settled) throw new Error('confirmed cost contradicts a prior lower bound');
  }
  bindKeyBaseline({ usageMicros, evidenceSHA256 }) {
    if (!Number.isSafeInteger(usageMicros) || usageMicros < 0 || !/^[a-f0-9]{64}$/u.test(evidenceSHA256 ?? '')) throw new TypeError('invalid key baseline');
    this.transaction(() => {
      const previous = this.db.prepare('SELECT usage_micros,evidence_sha256 FROM key_baseline').get();
      if (previous) {
        if (previous.usage_micros !== usageMicros || previous.evidence_sha256 !== evidenceSHA256) throw new Error('key baseline drift');
      } else this.db.prepare('INSERT INTO key_baseline VALUES(?,?)').run(usageMicros, evidenceSHA256);
    });
  }
  recordKeySnapshot({ usageMicros, observedMs, evidenceSHA256 }) {
    if (!Number.isSafeInteger(usageMicros) || usageMicros < 0 || !Number.isSafeInteger(observedMs) || observedMs < 0 || !/^[a-f0-9]{64}$/u.test(evidenceSHA256 ?? '')) throw new TypeError('invalid key snapshot');
    return this.transaction(() => {
      const baseline = this.db.prepare('SELECT usage_micros FROM key_baseline').get();
      if (!baseline) throw new Error('key baseline missing');
      const last = this.db.prepare('SELECT usage_micros,observed_ms FROM key_snapshot ORDER BY rowid DESC LIMIT 1').get();
      const lastFresh = this.db.prepare('SELECT usage_micros FROM key_snapshot WHERE fresh=1 ORDER BY rowid DESC LIMIT 1').get();
      if (last && observedMs < last.observed_ms) throw new Error('key snapshot time reversed');
      const priced = this.db.prepare("SELECT COALESCE(SUM(charge),0) AS total FROM physical WHERE state='priced'").get().total;
      const fresh = usageMicros >= baseline.usage_micros + priced && (!lastFresh || usageMicros >= lastFresh.usage_micros);
      this.db.prepare('INSERT INTO key_snapshot VALUES(?,?,?,?)').run(usageMicros, observedMs, evidenceSHA256, fresh ? 1 : 0);
      if (usageMicros - baseline.usage_micros >= this.limit) this.db.prepare("UPDATE campaign SET stopped=COALESCE(stopped,'budget_limit')").run();
      return { fresh, actualMicros: Math.max(0, usageMicros - baseline.usage_micros) };
    });
  }
  keyDecision({ verifyEvidence }) {
    if (typeof verifyEvidence !== 'function') throw new TypeError('snapshot evidence verifier required');
    const stopped = this.db.prepare('SELECT stopped FROM campaign').get().stopped;
    if (stopped) return { action: 'stop', reason: stopped };
    const baseline = this.db.prepare('SELECT usage_micros,evidence_sha256 FROM key_baseline').get();
    if (!baseline || !verifyEvidence('baseline', baseline.evidence_sha256)) throw new Error('key baseline evidence missing or changed');
    const snapshot = this.db.prepare('SELECT usage_micros,evidence_sha256,fresh FROM key_snapshot ORDER BY rowid DESC LIMIT 1').get();
    if (!snapshot) return { action: 'snapshot' };
    if (!verifyEvidence('snapshot', snapshot.evidence_sha256)) throw new Error('key snapshot evidence changed');
    const priced = this.db.prepare("SELECT COALESCE(SUM(charge),0) AS total FROM physical WHERE state='priced'").get().total;
    return { action: snapshot.fresh === 1 && snapshot.usage_micros >= baseline.usage_micros + priced ? 'admit' : 'wait' };
  }
  recordHealth({ physicalId, outcome, observedMs, evidenceSHA256 }) {
    if (typeof physicalId !== 'string' || !physicalId || !['clean', 'capacity'].includes(outcome) ||
        !Number.isSafeInteger(observedMs) || observedMs < 0 || !/^[a-f0-9]{64}$/u.test(evidenceSHA256 ?? '')) throw new TypeError('invalid health receipt');
    this.transaction(() => {
      const row = this.db.prepare('SELECT kind,health_case,state,http_status FROM physical WHERE id=?').get(physicalId);
      if (!row || row.kind !== 'health' || !row.health_case || row.state === 'open' || row.http_status === null ||
          (outcome === 'clean' && (row.http_status < 200 || row.http_status >= 300))) throw new Error('health probe is not a settled physical result');
      this.db.prepare('INSERT INTO health_receipt VALUES(?,?,?,?)').run(physicalId, outcome, observedMs, evidenceSHA256);
    });
  }
  healthDecision({ caseId, provider, nowMs, verifyEvidence }) {
    if (typeof caseId !== 'string' || !caseId || typeof provider !== 'string' || !provider ||
        !Number.isSafeInteger(nowMs) || nowMs < 0 || typeof verifyEvidence !== 'function') throw new TypeError('invalid health decision');
    const stop = this.db.prepare('SELECT stopped FROM campaign').get().stopped;
    if (stop) return { action: 'stop', reason: stop };
    const rows = this.db.prepare(`SELECT p.id,p.state,h.outcome,h.observed_ms,h.evidence_sha256
      FROM physical p LEFT JOIN health_receipt h ON h.physical_id=p.id
      WHERE p.kind='health' AND p.health_case=? AND p.provider=? ORDER BY h.observed_ms,p.id`).all(caseId, provider);
    if (rows.some((row) => row.state === 'open' || row.outcome === null)) return { action: 'reconcile' };
    let recovery = false, clean = 0, last = 0;
    for (const row of rows) {
      if (!verifyEvidence(row.id, row.evidence_sha256)) throw new Error('health evidence mismatch');
      if (row.observed_ms > nowMs) throw new Error('health receipt is in the future');
      if (row.outcome === 'capacity') { recovery = true; clean = 0; } else clean++;
      last = row.observed_ms;
    }
    if (clean >= (recovery ? 2 : 1)) return { action: 'admit' };
    if (recovery && rows.at(-1)?.outcome === 'capacity' && nowMs < last + 900_000) return { action: 'wait', untilMs: last + 900_000 };
    return { action: 'probe' };
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
