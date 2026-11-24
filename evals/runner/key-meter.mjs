import { createHash } from 'node:crypto';
const KEY_URL = 'https://openrouter.ai/api/v1/key';
const numericUsage = Symbol('provider numeric usage');

// Preserve the provider's decimal spelling instead of rounding a binary float
// into evidence that a key reading covers more spending than it actually does.
function floorNanos(text) {
  const match = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/u.exec(text);
  if (!match) throw new Error('invalid usage');
  const digits = BigInt(match[1] + (match[2] ?? ''));
  const scale = 9 + Number(match[3] ?? 0) - (match[2]?.length ?? 0);
  if (!Number.isSafeInteger(scale) || Math.abs(scale) > 100) throw new Error('invalid usage');
  const value = scale >= 0 ? digits * 10n ** BigInt(scale) : digits / 10n ** BigInt(-scale);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('invalid usage');
  return Number(value);
}

// The resolved key exists only in memory. Errors never contain the request,
// response body, or underlying transport exception.
export async function readKeyUsage({ key, ledger, fetchImpl = globalThis.fetch }) {
  if (typeof key !== 'string' || !key || typeof fetchImpl !== 'function') return { status: 'malformed' };
  let response;
  try {
    response = await fetchImpl(KEY_URL, { method: 'GET', headers: { authorization: `Bearer ${key}`, 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(30_000) });
  } catch { return { status: 'stale' }; }
  if ([401, 403, 429].includes(response.status)) return { status: 'denied', httpStatus: response.status };
  if (response.status >= 500) return { status: 'stale' };
  if (!response.ok) return { status: 'malformed', httpStatus: response.status };
  let text;
  try { text = await response.text(); } catch { return { status: 'stale' }; }
  try {
    const body = JSON.parse(text, (name, value, context) => name === 'usage' && typeof value === 'number'
      ? { [numericUsage]: true, source: context?.source, value } : value);
    const usage = body?.data?.usage;
    if (usage?.[numericUsage] !== true || typeof usage.value !== 'number' || !Number.isFinite(usage.value) || usage.value < 0 || typeof usage.source !== 'string') return { status: 'malformed' };
    const usageNanos = floorNanos(usage.source);
    return { status: 'ok', usageMicros: Math.floor(usageNanos / 1000), usageNanos, observedMs: Date.now(), fingerprint: ledger.fingerprint(key) };
  } catch { return { status: 'malformed' }; }
}

// Resolve credentials through the same Pi provider store used by the runner.
// No auth object or key is returned to the supervisor or written to disk.
export async function readConfiguredKeyUsage({ ledger, fetchImpl = globalThis.fetch, models }) {
  try {
    if (models === undefined) {
      const [{ getCodegeniePaths }, { createFileAuthStorage, createPiCredentialStore }, { getCodegeniePiModels }] = await Promise.all([
        import('../../dist/config/paths.js'), import('../../dist/provider/provider-services.js'), import('../../dist/provider/pi-ai-models.js')
      ]);
      models = getCodegeniePiModels(createPiCredentialStore(createFileAuthStorage(getCodegeniePaths())));
    }
    const resolved = await models.getAuth('openrouter');
    if (typeof resolved?.auth?.apiKey !== 'string' || !resolved.auth.apiKey) return { status: 'denied' };
    return await readKeyUsage({ key: resolved.auth.apiKey, ledger, fetchImpl });
  } catch { return { status: 'stale' }; }
}

// The caller persists the supplied sanitized bytes outside the checkout and
// confirms the exact hash. No live reading can advance the ledger without it.
export function applyKeyObservation({ ledger, kind, reading, sealReceipt, boundaryId, completePoll = false, physicalStarts }) {
  if (!['baseline', 'snapshot'].includes(kind) || !reading || typeof sealReceipt !== 'function') throw new TypeError('invalid key observation');
  if (reading.status === 'stale') { ledger.markKeyStale(); return { action: 'wait' }; }
  if (reading.status === 'denied' || reading.status === 'malformed') {
    ledger.markKeyStale(); ledger.stop(reading.status === 'denied' ? `provider_${reading.httpStatus ?? 'denied'}` : 'accounting_failed');
    return { action: 'stop' };
  }
  if (reading.status !== 'ok' || !Number.isSafeInteger(reading.usageNanos) || reading.usageNanos < 0 ||
      !Number.isSafeInteger(reading.observedMs) || reading.observedMs < 0 || !/^[a-f0-9]{64}$/u.test(reading.fingerprint ?? '')) {
    ledger.markKeyStale(); ledger.stop('accounting_failed'); return { action: 'stop' };
  }
  if (kind === 'snapshot' && (typeof boundaryId !== 'string' || !boundaryId)) throw new TypeError('snapshot boundary required');
  if (kind === 'snapshot' && physicalStarts === undefined) physicalStarts = ledger.physicalPrefix();
  const receipt = { kind: `key_${kind}`, usageNanos: reading.usageNanos, fingerprint: reading.fingerprint, ...(kind === 'snapshot' ? { observedMs: reading.observedMs, boundaryId, physicalStarts } : {}) };
  const bytes = Buffer.from(`${JSON.stringify(receipt)}\n`), hash = createHash('sha256').update(bytes).digest('hex');
  try {
    if (sealReceipt(bytes, hash) !== true) throw new Error('receipt not sealed');
    if (kind === 'baseline') ledger.bindKeyBaseline({ usageMicros: Math.floor(reading.usageNanos / 1000), usageNanos: reading.usageNanos, keyFingerprint: reading.fingerprint, evidenceSHA256: hash });
    else {
      const result = ledger.recordKeySnapshot({ usageMicros: Math.ceil(reading.usageNanos / 1000), usageNanos: reading.usageNanos, observedMs: reading.observedMs, keyFingerprint: reading.fingerprint, evidenceSHA256: hash, boundaryId, completePoll, physicalStarts });
      if (result.bindingMismatch) return { action: 'stop' };
      if (result.pollStop) return { action: 'stop', reason: 'meter_stale', pollCompleted: true };
      if (!result.fresh) return { action: 'wait', receiptSHA256: hash, ...(result.pollCompleted ? { pollCompleted: true } : {}) };
      if (result.pollCompleted) return { action: 'recorded', receiptSHA256: hash, pollCompleted: true };
    }
    return { action: 'recorded', receiptSHA256: hash };
  } catch { ledger.markKeyStale(); ledger.stop('accounting_failed'); return { action: 'stop' }; }
}
