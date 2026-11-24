// Convert a finite USD number to microdollars without floating-point over-rounding.
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
// One closure per logical call. The caller supplies the ordinary provider fetch
// and the built product's TransportAdmissionError; no credentials are stored.
export function makePhysicalTransport({ ledger, call, expected, fetchImpl, AdmissionError }) {
  if (typeof fetchImpl !== 'function' || typeof AdmissionError !== 'function') throw new TypeError('transport dependencies required');
  let ordinal = 0;
  let current;
  const valid = ['provider', 'modelId', 'reasoningSelected', 'templateVersion'].every((key) => expected[key] === call[key]);
  function wireMatches(input, init) {
    try {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== expected.destination || (init?.method ?? 'GET').toUpperCase() !== 'POST') return false;
      if (typeof init?.body !== 'string') return false;
      const body = JSON.parse(init.body);
      return body.model === expected.modelId && body.reasoning?.effort === expected.wireEffort;
    } catch { return false; }
  }
  function stopAccounting(error) {
    try { ledger.stop('accounting_failed'); } catch { /* retain the open hold; caller must reconcile */ }
    throw new AdmissionError('accounting_failed', current?.id);
  }
  function settleUnknown() {
    if (!current || current.settled) return;
    ledger.settlePhysical({ id: current.id, httpStatus: current.httpStatus ?? null });
    current.settled = true;
  }
  return {
    async fetch(input, init) {
      const id = `${call.callId}/physical-${++ordinal}`;
      try {
        if (current && !current.settled) settleUnknown();
        if (!valid || !wireMatches(input, init)) {
          ledger.recordRefusal({ id, logicalId: call.callId, reason: 'binding_mismatch' });
          throw new AdmissionError('binding_mismatch');
        }
        if (!ledger.reservePhysical({ id, logicalId: call.callId, kind: call.kind })) throw new AdmissionError('campaign_budget');
        current = { id, settled: false, usage: undefined, httpStatus: null };
      } catch (error) {
        if (error instanceof AdmissionError) throw error;
        return stopAccounting(error);
      }
      let response;
      try { response = await fetchImpl(input, init); }
      catch (error) {
        try { settleUnknown(); } catch (failure) { return stopAccounting(failure); }
        throw error;
      }
      current.httpStatus = response.status;
      if ([401, 402, 429].includes(response.status)) {
        try { settleUnknown(); } catch (error) { return stopAccounting(error); }
        throw new AdmissionError('provider_denied', id);
      }
      return response;
    },
    onUsage(observation) {
      if (!current || current.settled) return;
      if (observation.source === 'provider_chunk') { current.usage = observation; return; }
      if (observation.source !== 'terminal') return;
      try {
        const options = { id: current.id, httpStatus: current.httpStatus };
        if (observation.costFromProvider === true && typeof observation.providerCost === 'number' && Number.isFinite(observation.providerCost) && observation.providerCost >= 0) {
          options.providerCostMicros = costMicros(observation.providerCost);
          options.costConfirmed = true;
        } else if (observation.terminal === 'error' && current.usage?.usagePresent && !current.usage.costPresent &&
                   current.usage.inputTokens === 0 && current.usage.outputTokens === 0 && current.usage.totalTokens === 0) {
          options.noUsageErrorEvidence = { terminal: 'error', providerCostReported: false, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
        }
        ledger.settlePhysical(options);
        current.settled = true;
      } catch (error) { stopAccounting(error); }
    }
  };
}
