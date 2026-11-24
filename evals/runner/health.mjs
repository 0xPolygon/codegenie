import { createHash } from 'node:crypto';
import { Type } from 'typebox';
import { makePhysicalTransport } from './physical-fetch.mjs';

function providerMessage(value) {
  const error = value?.error ?? value;
  const raw = error?.metadata?.raw;
  if (typeof raw === 'string') {
    try {
      const upstream = JSON.parse(raw);
      const message = (upstream?.error ?? upstream)?.message;
      if (typeof message === 'string' && message.trim()) return { message, source: 'metadata.raw' };
    } catch { /* An opaque upstream body is insufficient evidence. */ }
  }
  if (typeof error?.message === 'string' && error.message.trim()) return { message: error.message, source: 'error.message' };
}

// A probe is one logical structured call and at most one physical POST. The
// caller supplies its bound model metadata and seals sanitized receipt bytes.
export async function runHealthProbe({ ledger, boundaryId, purpose, retryFor, failureReceiptSHA256, attemptPrefix, llmConfig, expected, sealReceipt, fetchImpl = globalThis.fetch }) {
  if (typeof boundaryId !== 'string' || !boundaryId || !['admission', 'retry'].includes(purpose) || typeof sealReceipt !== 'function' ||
      expected?.provider !== 'openrouter' || llmConfig?.provider !== 'openrouter') throw new Error('invalid health binding');
  const [{ createPiRunner }, { TransportAdmissionError }, { observeOpenRouterResponse }, { redactThenTruncate, stripCredentialsAtSink }] = await Promise.all([
    import('../../dist/llm/pi-runner.js'), import('../../dist/llm/transport-admission.js'),
    import('../../dist/llm/openrouter-response-observer.js'), import('../../dist/telemetry/redaction.js'),
  ]);
  let starts = 0;
  let terminal = false;
  let diagnostic;
  const modelCalls = [];
  const prefix = `${attemptPrefix}/`;
  const physicalRows = () => ledger.db.prepare('SELECT id,state,http_status,evidence_json,stream_terminal FROM physical WHERE substr(id,1,?)=? ORDER BY id').all(prefix.length, prefix);
  const seal = (receipt) => {
    const bytes = Buffer.from(`${JSON.stringify(receipt)}\n`), digest = createHash('sha256').update(bytes).digest('hex');
    if (sealReceipt(bytes, digest) !== true) throw new Error('health receipt not sealed');
    return digest;
  };
  const sealHealth = (row, outcome) => {
    const model = modelCalls.find((call) => typeof call.callId === 'string' && row.id.includes(`/${call.callId}/`));
    const usage = row.evidence_json === null ? null : JSON.parse(row.evidence_json);
    const tokenCounts = usage && ['inputTokens', 'outputTokens', 'totalTokens'].every((field) => Number.isSafeInteger(usage[field]) && usage[field] >= 0)
      ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.totalTokens } : undefined;
    const receipt = { kind: 'health', physicalId: row.id, boundaryId, provider: 'openrouter', purpose, outcome, observedMs: Date.now(),
      ...(purpose === 'retry' ? { retryFor, failureReceiptSHA256 } : {}),
      ...(model ? { modelCallId: model.callId } : {}), ...(tokenCounts ? { usage: tokenCounts } : {}) };
    const digest = seal(receipt);
    ledger.recordHealth({ physicalId: row.id, outcome, observedMs: receipt.observedMs, evidenceSHA256: digest });
    return { status: outcome, receiptSHA256: digest, physicalId: row.id };
  };
  const withDiagnostic = (result, rows) => {
    if (diagnostic === undefined || rows.length !== 1 || rows[0].state === 'open') return result;
    const row = rows[0];
    try {
      const diagnosticSHA256 = seal({ kind: 'health_diagnostic', physicalId: row.id, boundaryId, provider: 'openrouter',
        httpStatus: row.http_status, streamTerminal: row.stream_terminal, ...diagnostic });
      return { ...result, diagnostic, diagnosticSHA256 };
    } catch {
      // Diagnostic evidence is advisory. Admission and accounting are already decided.
      return result;
    }
  };
  const telemetry = { runId: 'campaign-health', runDir: undefined, event() {}, recordModelCall(row) { modelCalls.push(row); },
    recordToolCall() { throw new Error('unexpected health tool execution'); }, async writeArtifact() {}, async writeDebug() {}, async flush() {} };
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  try {
    const runner = await createPiRunner({ llmConfig, telemetry, logger, runSignal: AbortSignal.timeout(60_000),
      hooks: { checkpoint: () => 'ok', onUsage() {} },
      fetchForCall(call) {
        const transport = makePhysicalTransport({ ledger, call, expected, attemptPrefix, fetchImpl, AdmissionError: TransportAdmissionError, healthBoundary: boundaryId, healthPurpose: purpose, retryFor, failureReceiptSHA256 });
        return { ...transport, fetch: async (input, init) => {
          if (++starts > 1) {
            try { ledger.recordRefusal({ id: `${attemptPrefix}/${call.callId}/health-refusal-${starts}`, logicalId: `${attemptPrefix}/${call.callId}`, reason: 'health_single_start' }); }
            catch { try { ledger.stop('accounting_failed'); } catch {} throw new TransportAdmissionError('accounting_failed'); }
            throw new TransportAdmissionError('campaign_stopped');
          }
          const response = await transport.fetch(input, init);
          return observeOpenRouterResponse(response, (value, failure) => {
            if (!failure || diagnostic !== undefined) return;
            const detail = providerMessage(value);
            if (detail === undefined) return;
            const safeText = stripCredentialsAtSink(detail.message).replace(/[\s\p{Cc}]+/gu, ' ').trim();
            const message = redactThenTruncate(safeText, 300, '…');
            if (message) diagnostic = { source: detail.source, message };
          });
        } };
      } });
    const result = await runner.runStructured({ stage: 5, prompt: 'Call the submit tool with ok set to true.',
      schema: Type.Object({ ok: Type.Literal(true) }, { additionalProperties: false }), templateVersion: 'campaign-health.1', timeoutMs: 60_000 });
    terminal = true;
    const rows = physicalRows();
    if (result?.ok !== true || starts !== 1 || rows.length !== 1 || rows[0].state === 'open' || rows[0].http_status !== 200 ||
        modelCalls.length !== 1 || modelCalls[0].status !== 'ok') throw new Error('health result incomplete');
    const usage = rows[0].evidence_json === null ? null : JSON.parse(rows[0].evidence_json);
    if (usage?.usagePresent !== true || ['inputTokens', 'outputTokens', 'totalTokens'].some((field) => !Number.isSafeInteger(usage[field]) || usage[field] < 0)) throw new Error('health usage missing');
    return sealHealth(rows[0], 'clean');
  } catch {
    // Use the existing ledger and model rows to decide the outcome. The
    // diagnostic is projected separately from the provider's response.
    try {
      const rows = physicalRows();
      const peakLoad = rows.length === 1 && rows[0].http_status === 200 && modelCalls.some((row) => row.status === 'transient_error' &&
        typeof row.callId === 'string' && rows[0].id.includes(`/${row.callId}/`) && typeof row.errorMessage === 'string' &&
        /maximum usage size allowed during peak load/iu.test(row.errorMessage));
      if (!terminal && rows.length === 1 && rows[0].state !== 'open' && (peakLoad || [500, 502, 503, 504].includes(rows[0].http_status))) {
        return withDiagnostic(sealHealth(rows[0], 'capacity'), rows);
      }
      ledger.stop(terminal ? 'accounting_failed' : 'health_failed');
      return withDiagnostic({ status: 'failed' }, rows);
    } catch { try { ledger.stop('accounting_failed'); } catch { /* retain any open hold */ } }
    return { status: 'failed' };
  }
}
