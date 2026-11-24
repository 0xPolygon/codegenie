// Decimal conversion rounds upward without floating-point over-rounding.
function costUnits(value, precision) {
  const [mantissa, expText = '0'] = value.toString().toLowerCase().split('e');
  const [whole, fraction = ''] = mantissa.split('.');
  const digits = BigInt(whole + fraction);
  const scale = precision + Number(expText) - fraction.length;
  const amount = scale >= 0 ? digits * 10n ** BigInt(scale) : (digits + 10n ** BigInt(-scale) - 1n) / 10n ** BigInt(-scale);
  const n = Number(amount);
  if (!Number.isSafeInteger(n)) throw new RangeError('provider cost exceeds safe integer range');
  return n;
}

// One closure per logical call; attemptPrefix uniquely binds campaign slot and
// review attempt. The caller supplies the normal fetch and typed error class.
export function makePhysicalTransport({ ledger, call, expected, attemptPrefix, fetchImpl, AdmissionError, healthBoundary, healthPurpose, retryFor, failureReceiptSHA256 }) {
  if (typeof fetchImpl !== 'function' || typeof AdmissionError !== 'function' || typeof attemptPrefix !== 'string' || !/^[A-Za-z0-9._/-]+$/u.test(attemptPrefix)) throw new TypeError('transport dependencies and attempt identity required');
  let ordinal = 0;
  let current;
  const logicalId = `${attemptPrefix}/${call.callId}`;
  const valid = expected.api === 'openai-completions' && ['provider', 'modelId', 'reasoningSelected', 'templateVersion'].every((key) => expected[key] === call[key]);
  function wireMatches(input, init) {
    try {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== expected.destination || (init?.method ?? 'GET').toUpperCase() !== 'POST' || typeof init?.body !== 'string') return false;
      const body = JSON.parse(init.body);
      return body.model === expected.modelId && body.reasoning?.effort === expected.wireEffort;
    } catch { return false; }
  }
  function credentialMatches(input, init) {
    if (!ledger.db.prepare('SELECT 1 FROM key_baseline').get()) return false;
    try {
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      const auth = headers.get('authorization');
      const match = typeof auth === 'string' ? /^Bearer\s+(.+)$/iu.exec(auth) : null;
      return match !== null && ledger.matchesBaselineKey(match[1]);
    } catch { return false; }
  }
  function stopAccounting() {
    try { ledger.stop('accounting_failed'); } catch { /* preserve open hold and require reconciliation */ }
    throw new AdmissionError('accounting_failed', current?.id);
  }
  function settleContradiction() {
    if (current && !current.settled) {
      ledger.settlePhysical({ id: current.id, httpStatus: current.httpStatus,
        unconfirmedCostLowerBoundMicros: current.lowerBoundMicros ?? 0, usageEvidence: current.evidence ?? null });
      current.settled = true;
    }
    stopAccounting();
  }
  function settleCurrent(terminal) {
    if (!current || current.settled) return;
    if (current.confirmedMicros !== undefined && current.lowerBoundMicros !== undefined && current.confirmedMicros < current.lowerBoundMicros) return settleContradiction();
    const options = { id: current.id, httpStatus: current.httpStatus, usageEvidence: current.evidence ?? null };
    if (current.confirmedMicros !== undefined) {
      options.providerCostMicros = current.confirmedMicros;
      options.providerCostNanos = current.confirmedNanos;
      options.costConfirmed = true;
    } else if (current.lowerBoundMicros !== undefined) {
      options.unconfirmedCostLowerBoundMicros = current.lowerBoundMicros;
    } else if (terminal === 'error' && current.zeroUsageEligible === true) {
      options.noUsageErrorEvidence = { terminal: 'error', usagePresent: true, costPresent: false, providerCostReported: false, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    }
    ledger.settlePhysical(options);
    current.settled = true;
  }
  return {
    async fetch(input, init) {
      const id = `${logicalId}/physical-${++ordinal}`;
      try {
        if (current && !current.settled) settleCurrent();
        const credentialValid = credentialMatches(input, init);
        if (!valid || !wireMatches(input, init) || !credentialValid) {
          ledger.recordRefusal({ id, logicalId, reason: 'binding_mismatch' });
          if (!credentialValid) ledger.stop('binding_mismatch');
          throw new AdmissionError('binding_mismatch');
        }
        const admission = ledger.reservePhysical({ id, logicalId, kind: healthBoundary === undefined ? call.kind : 'health', provider: call.provider, ...(healthBoundary !== undefined ? { healthBoundary, healthPurpose, retryFor, failureReceiptSHA256 } : {}) });
        if (!admission.admitted) {
          const reason = admission.reason;
          const mapped = reason.startsWith('provider_') ? 'provider_denied'
            : ['campaign_budget', 'budget_limit'].includes(reason) ? 'campaign_budget'
            : reason === 'binding_mismatch' ? 'binding_mismatch'
            : ['accounting_failed', 'unpriced_lower_bound', 'charge_above_reservation'].includes(reason) ? 'accounting_failed'
            : 'campaign_stopped';
          throw new AdmissionError(mapped);
        }
        current = { id, settled: false, usage: undefined, evidence: undefined, httpStatus: null };
      } catch (error) {
        if (error instanceof AdmissionError) throw error;
        return stopAccounting();
      }
      let response;
      try { response = await fetchImpl(input, init); }
      catch (error) {
        try { settleCurrent(); } catch { return stopAccounting(); }
        throw error;
      }
      current.httpStatus = response.status;
      if ([401, 402, 429].includes(response.status)) {
        try { settleCurrent(); } catch { return stopAccounting(); }
        throw new AdmissionError('provider_denied', id);
      }
      return response;
    },
    onUsage(observation) {
      if (observation.quotaDenied === true) {
        if (!current) return stopAccounting();
        try { ledger.stop('provider_quota'); } catch { return stopAccounting(); }
        return;
      }
      if (!current || current.settled) return;
      try {
        if (observation.source === 'provider_chunk') {
          if (observation.usagePresent !== true) {
            // A later provider chunk means an earlier zero may have been partial.
            if (current.zeroUsageEligible !== undefined) current.zeroUsageEligible = false;
            return;
          }
          current.usage = observation;
          const exactZero = observation.costPresent === false && observation.inputTokens === 0 &&
            observation.outputTokens === 0 && observation.totalTokens === 0;
          current.zeroUsageEligible = current.zeroUsageEligible === undefined ? exactZero : current.zeroUsageEligible && exactZero;
          current.evidence = { ...current.evidence, usagePresent: true,
            costPresent: current.evidence?.costPresent === true || observation.costPresent === true,
            ...(observation.isByok !== undefined ? { isByok: observation.isByok } : {}) };
          for (const field of ['inputTokens', 'outputTokens', 'totalTokens']) {
            delete current.evidence[field];
            if (Number.isSafeInteger(observation[field]) && observation[field] >= 0) current.evidence[field] = observation[field];
          }
          if (typeof observation.providerCost === 'number') current.evidence.providerReportedCostUSD = observation.providerCost;
          if (typeof observation.providerCostLowerBound === 'number') {
            current.lowerBoundMicros = Math.max(current.lowerBoundMicros ?? 0, costUnits(observation.providerCostLowerBound, 6));
            ledger.raiseLowerBound(current.id, current.lowerBoundMicros);
            current.evidence.knownBilledLowerBoundMicros = current.lowerBoundMicros;
          }
          if (typeof observation.providerBilledCost === 'number') {
            const amount = costUnits(observation.providerBilledCost, 6);
            if (current.confirmedMicros !== undefined && current.confirmedMicros !== amount) return settleContradiction();
            current.confirmedMicros = amount;
            current.confirmedNanos = costUnits(observation.providerBilledCost, 9);
            current.evidence.providerCostComplete = true;
            current.evidence.providerBilledCostUSD = observation.providerBilledCost;
          }
          return;
        }
        if (observation.source !== 'terminal') return;
        if (observation.costFromProvider === true && typeof observation.providerCost === 'number' && Number.isFinite(observation.providerCost) && observation.providerCost >= 0) {
          const amount = costUnits(observation.providerCost, 6);
          if (current.confirmedMicros !== undefined && current.confirmedMicros !== amount) return settleContradiction();
          current.confirmedMicros = amount;
          current.confirmedNanos = costUnits(observation.providerCost, 9);
        }
        settleCurrent(observation.terminal);
      } catch { stopAccounting(); }
    }
  };
}
