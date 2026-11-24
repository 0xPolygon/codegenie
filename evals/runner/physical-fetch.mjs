// Decimal conversion rounds upward without floating-point over-rounding.
function costMicros(value) {
  const [mantissa, expText = '0'] = value.toString().toLowerCase().split('e');
  const [whole, fraction = ''] = mantissa.split('.');
  const digits = BigInt(whole + fraction);
  const scale = 6 + Number(expText) - fraction.length;
  const amount = scale >= 0 ? digits * 10n ** BigInt(scale) : (digits + 10n ** BigInt(-scale) - 1n) / 10n ** BigInt(-scale);
  const n = Number(amount);
  if (!Number.isSafeInteger(n)) throw new RangeError('provider cost exceeds safe integer range');
  return n;
}

// One closure per logical call; attemptPrefix uniquely binds campaign slot and
// review attempt. The caller supplies the normal fetch and typed error class.
export function makePhysicalTransport({ ledger, call, expected, attemptPrefix, fetchImpl, AdmissionError }) {
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
  function stopAccounting() {
    try { ledger.stop('accounting_failed'); } catch { /* preserve open hold and require reconciliation */ }
    throw new AdmissionError('accounting_failed', current?.id);
  }
  function settleCurrent(terminal) {
    if (!current || current.settled) return;
    const options = { id: current.id, httpStatus: current.httpStatus, usageEvidence: current.evidence ?? null };
    if (current.confirmedMicros !== undefined) {
      options.providerCostMicros = current.confirmedMicros;
      options.costConfirmed = true;
    } else if (current.lowerBoundMicros !== undefined) {
      options.unconfirmedCostLowerBoundMicros = current.lowerBoundMicros;
    } else if (terminal === 'error' && current.usage?.usagePresent === true && current.usage.costPresent === false &&
               current.usage.inputTokens === 0 && current.usage.outputTokens === 0 && current.usage.totalTokens === 0) {
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
        if (!valid || !wireMatches(input, init)) {
          ledger.recordRefusal({ id, logicalId, reason: 'binding_mismatch' });
          throw new AdmissionError('binding_mismatch');
        }
        const admission = ledger.reservePhysical({ id, logicalId, kind: call.kind });
        if (!admission.admitted) {
          const reason = admission.reason;
          throw new AdmissionError(reason.startsWith('provider_') ? 'provider_denied' : ['campaign_budget', 'budget_limit'].includes(reason) ? 'campaign_budget' : 'accounting_failed');
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
      if (!current || current.settled) return;
      try {
        if (observation.source === 'provider_chunk') {
          current.usage = observation;
          current.evidence = { usagePresent: observation.usagePresent, costPresent: observation.costPresent,
            ...(observation.isByok !== undefined ? { isByok: observation.isByok } : {}) };
          if (typeof observation.providerCost === 'number') current.lowerBoundMicros = Math.max(current.lowerBoundMicros ?? 0, costMicros(observation.providerCost));
          if (typeof observation.providerBilledCost === 'number') {
            const amount = costMicros(observation.providerBilledCost);
            if (current.confirmedMicros !== undefined && current.confirmedMicros !== amount) return stopAccounting();
            current.confirmedMicros = amount;
          }
          return;
        }
        if (observation.source !== 'terminal') return;
        if (observation.costFromProvider === true && typeof observation.providerCost === 'number' && Number.isFinite(observation.providerCost) && observation.providerCost >= 0) {
          const amount = costMicros(observation.providerCost);
          if (current.confirmedMicros !== undefined && current.confirmedMicros !== amount) return stopAccounting();
          current.confirmedMicros = amount;
        }
        settleCurrent(observation.terminal);
      } catch { stopAccounting(); }
    }
  };
}
