import { createHash } from 'node:crypto';
import { Type } from 'typebox';
import { makePhysicalTransport } from './physical-fetch.mjs';

// A probe is one logical structured call and at most one physical POST. The
// caller supplies its bound model metadata and seals sanitized receipt bytes.
export async function runHealthProbe({ ledger, boundaryId, purpose, attemptPrefix, llmConfig, expected, sealReceipt, fetchImpl = globalThis.fetch }) {
  if (typeof boundaryId !== 'string' || !boundaryId || !['admission', 'retry'].includes(purpose) || typeof sealReceipt !== 'function' ||
      expected?.provider !== 'openrouter' || llmConfig?.provider !== 'openrouter') throw new Error('invalid health binding');
  const [{ createPiRunner }, { TransportAdmissionError }] = await Promise.all([
    import('../../dist/llm/pi-runner.js'), import('../../dist/llm/transport-admission.js')
  ]);
  let starts = 0;
  let terminal = false;
  const modelCalls = [];
  const prefix = `${attemptPrefix}/`;
  const physicalRows = () => ledger.db.prepare('SELECT id,state,http_status,evidence_json FROM physical WHERE substr(id,1,?)=? ORDER BY id').all(prefix.length, prefix);
  const sealHealth = (row, outcome) => {
    const receipt = { kind: 'health', physicalId: row.id, boundaryId, provider: 'openrouter', purpose, outcome, observedMs: Date.now() };
    const bytes = Buffer.from(`${JSON.stringify(receipt)}\n`), digest = createHash('sha256').update(bytes).digest('hex');
    if (sealReceipt(bytes, digest) !== true) throw new Error('health receipt not sealed');
    ledger.recordHealth({ physicalId: row.id, outcome, observedMs: receipt.observedMs, evidenceSHA256: digest });
    return { status: outcome, receiptSHA256: digest, physicalId: row.id };
  };
  const telemetry = { runId: 'campaign-health', runDir: undefined, event() {}, recordModelCall(row) { modelCalls.push(row); },
    recordToolCall() { throw new Error('unexpected health tool execution'); }, async writeArtifact() {}, async writeDebug() {}, async flush() {} };
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  try {
    const runner = await createPiRunner({ llmConfig, telemetry, logger, runSignal: AbortSignal.timeout(60_000),
      hooks: { checkpoint: () => 'ok', onUsage() {} },
      fetchForCall(call) {
        const transport = makePhysicalTransport({ ledger, call, expected, attemptPrefix, fetchImpl, AdmissionError: TransportAdmissionError, healthBoundary: boundaryId, healthPurpose: purpose });
        return { ...transport, fetch: (input, init) => {
          if (++starts > 1) throw new TransportAdmissionError('campaign_stopped');
          return transport.fetch(input, init);
        } };
      } });
    const result = await runner.runStructured({ stage: 5, prompt: 'Call the submit tool with ok set to true.',
      schema: Type.Object({ ok: Type.Literal(true) }, { additionalProperties: false }), templateVersion: 'campaign-health.1', timeoutMs: 60_000 });
    terminal = true;
    const rows = physicalRows();
    if (result?.ok !== true || starts !== 1 || rows.length !== 1 || rows[0].state === 'open' || rows[0].http_status !== 200 ||
        modelCalls.length !== 1 || modelCalls[0].status !== 'ok') throw new Error('health result incomplete');
    const usage = rows[0].evidence_json === null ? null : JSON.parse(rows[0].evidence_json);
    if (usage?.usagePresent !== true) throw new Error('health usage missing');
    return sealHealth(rows[0], 'clean');
  } catch {
    // Provider errors and accounting denials are already in the physical ledger.
    // Never retain the exception or response body in the health receipt.
    try {
      const rows = physicalRows();
      if (!terminal && rows.length === 1 && rows[0].state !== 'open' && [500, 502, 503, 504].includes(rows[0].http_status)) return sealHealth(rows[0], 'capacity');
      if (terminal) ledger.stop('accounting_failed');
    } catch { try { ledger.stop('accounting_failed'); } catch { /* retain any open hold */ } }
    return { status: 'failed' };
  }
}
