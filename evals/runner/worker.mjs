import { createHash } from 'node:crypto';
import { readFileSync, readSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { CampaignLedger } from './ledger.mjs';
import { boundaryDecision, boundaryRefusalReason, BoundaryBindingError } from './boundary.mjs';
import { makePhysicalTransport } from './physical-fetch.mjs';
import { outsideCheckout, runCase, workerBounds } from './case.mjs';
import { listEvidenceFiles } from './admission.mjs';
import { assertIntegrity } from './integrity.mjs';
const bindingError = () => Object.assign(new Error('binding mismatch'), { context: { reason: 'binding_mismatch' } });
function readWorkerToken() {
  const bytes = Buffer.alloc(65); let length = 0;
  while (length < bytes.length) {
    const count = readSync(0, bytes, length, bytes.length - length, null);
    if (count === 0) break;
    length += count;
    if (bytes[length - 1] === 10) break;
  }
  const value = bytes.subarray(0, length).toString('utf8').trim();
  return value === '' ? undefined : value;
}

function activateWorker({ supervisorPath, attemptPrefix, ledgerBinding, workerConfigSHA256, workerToken }) {
  const match = typeof attemptPrefix === 'string' ? /^([A-Za-z0-9._-]+)\/attempt-(\d{2,})$/u.exec(attemptPrefix) : null;
  if (!match || typeof supervisorPath !== 'string' || !/^[a-f0-9]{64}$/u.test(workerConfigSHA256 ?? '') || !/^[a-f0-9]{64}$/u.test(workerToken ?? '')) return false;
  const db = new DatabaseSync(outsideCheckout(supervisorPath));
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      const campaign = db.prepare('SELECT binding FROM campaign').get();
      const result = campaign?.binding === ledgerBinding ? db.prepare("UPDATE worker_claim SET activated=1 WHERE slot_id=? AND attempt_no=? AND config_sha256=? AND token_sha256=? AND activated=0 AND spawn_state='started' AND EXISTS (SELECT 1 FROM attempt WHERE attempt.slot_id=worker_claim.slot_id AND attempt.attempt_no=worker_claim.attempt_no AND attempt.state='started')").run(
        match[1], Number(match[2]), workerConfigSHA256, createHash('sha256').update(workerToken).digest('hex')) : { changes: 0 };
      db.exec('COMMIT'); return result.changes === 1;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  } finally { db.close(); }
}

export function operationalError(ledger, attemptPrefix, failure) {
  const stopped = ledger.totals().stopped;
  if (stopped) return boundaryRefusalReason(stopped);
  if (failure && ['config_error', 'budget_exhausted'].includes(failure.code) &&
      ['campaign_budget', 'binding_mismatch', 'provider_denied', 'accounting_failed', 'campaign_stopped', 'boundary_not_admitted'].includes(failure.reason)) return failure.reason;
  if (failure?.code === 'llm_call_failed' && ['transient_error', 'request_error'].includes(failure.reason) && typeof failure.callId === 'string') {
    const row = ledger.db.prepare('SELECT http_status,state FROM physical WHERE logical_id=? ORDER BY rowid DESC LIMIT 1').get(`${attemptPrefix}/${failure.callId}`);
    // Unknown is a billing state, not evidence that an HTTP-200 stream failed.
    // Until the physical terminal is recorded explicitly, reconcile those.
    if (row && row.http_status >= 400) return 'provider_failure';
  }
  return 'unclassified';
}

// This internal worker receives paths and expected metadata only; provider
// credentials remain in the normal Codegenie home/environment.
export async function runWorker(options, { fetchImpl = globalThis.fetch, workerConfigSHA256, workerToken } = {}) {
  const { caseConfig, caseConfigSHA256, supervisorPath, ledgerPath, ledgerBinding, limitMicros, reserveMicros, errorHoldMicros, attemptPrefix, expectedCalls, boundaryId, evidenceFiles, evidenceDirectory, plannerReplayBinding, integrity } = options;
  if (![caseConfig, ledgerPath, ledgerBinding, attemptPrefix].every((x) => typeof x === 'string' && x) || !Array.isArray(expectedCalls)) throw new TypeError('invalid worker binding');
  const [{ TransportAdmissionError }, { isCodegenieError }] = await Promise.all([import('../../dist/llm/transport-admission.js'), import('../../dist/util/errors.js')]);
  const ledger = new CampaignLedger(outsideCheckout(ledgerPath), { binding: ledgerBinding, limitMicros, reserveMicros, errorHoldMicros, initialize: false });
  try {
    // The campaign supervisor runs one review attempt at a time. An open row
    // at worker startup belongs to an interrupted attempt and requires custody
    // reconciliation before any new physical admission.
    ledger.assertRestartSafe();
    const caseConfigBytes = readFileSync(outsideCheckout(caseConfig));
    if (!/^[a-f0-9]{64}$/u.test(caseConfigSHA256 ?? '') || createHash('sha256').update(caseConfigBytes).digest('hex') !== caseConfigSHA256) throw bindingError();
    if (integrity !== undefined) { try { assertIntegrity(integrity); } catch { throw bindingError(); } }
    let plannerReplay;
    if (plannerReplayBinding !== undefined) {
      if (!plannerReplayBinding || typeof plannerReplayBinding !== 'object' || typeof plannerReplayBinding.capturePath !== 'string') throw bindingError();
      const { capturePath, ...binding } = plannerReplayBinding;
      const bytes = readFileSync(outsideCheckout(capturePath)), capture = bytes.toString('utf8');
      if (!/^[a-f0-9]{64}$/u.test(binding.captureSHA256 ?? '') || createHash('sha256').update(bytes).digest('hex') !== binding.captureSHA256 || !Buffer.from(capture, 'utf8').equals(bytes)) throw bindingError();
      plannerReplay = { ...binding, capture };
    }
    const bounds = await workerBounds(caseConfig, caseConfigBytes, attemptPrefix);
    let failure;
    const authenticated = workerToken !== undefined || supervisorPath !== undefined
      ? activateWorker({ supervisorPath, attemptPrefix, ledgerBinding, workerConfigSHA256, workerToken }) : false;
    if ((workerToken !== undefined || supervisorPath !== undefined) && !authenticated) throw bindingError();
    let boundaryVerified = false;
    const fetchForCall = (call) => {
      const matching = expectedCalls.filter((item) => item.stage === call.stage && item.kind === call.kind && (item.purpose ?? null) === (call.purpose ?? null));
      const expected = matching.length === 1 ? matching[0] : {};
      const transport = makePhysicalTransport({ ledger, call, expected, attemptPrefix, fetchImpl, AdmissionError: TransportAdmissionError });
      const preflight = () => {
        if (integrity !== undefined) {
          try { assertIntegrity(integrity); }
          catch {
            try { ledger.recordRefusal({ id: `${attemptPrefix}/${call.callId}/integrity`, logicalId: `${attemptPrefix}/${call.callId}`, reason: 'binding_mismatch' }); ledger.stop('binding_mismatch'); }
            catch { try { ledger.stop('accounting_failed'); } catch {} throw new TransportAdmissionError('accounting_failed'); }
            throw new TransportAdmissionError('binding_mismatch');
          }
        }
        if (boundaryVerified) return;
        const id = `${attemptPrefix}/${call.callId}/preflight`;
        let reason;
        try {
          if (!authenticated) reason = 'binding_mismatch';
          else {
            if (evidenceDirectory !== undefined && evidenceFiles !== undefined) throw new BoundaryBindingError('ambiguous evidence binding');
            const files = evidenceDirectory === undefined ? evidenceFiles : listEvidenceFiles(evidenceDirectory);
            const decision = boundaryDecision({ ledger, boundaryId, provider: call.provider, evidenceFiles: files });
            if (decision.action !== 'admit') reason = decision.reason ?? `${decision.source}_${decision.action}`;
          }
        } catch (error) { reason = error instanceof BoundaryBindingError ? 'binding_mismatch' : 'accounting_failed'; }
        if (reason !== undefined) {
          try {
            ledger.recordRefusal({ id, logicalId: `${attemptPrefix}/${call.callId}`, reason });
            if (reason === 'accounting_failed') ledger.stop(reason);
          }
          catch { try { ledger.stop('accounting_failed'); } catch {} throw new TransportAdmissionError('accounting_failed'); }
          throw new TransportAdmissionError(boundaryRefusalReason(reason));
        }
        boundaryVerified = true;
      };
      return { ...transport, fetch: (input, init) => { preflight(); return transport.fetch(input, init); } };
    };
    const result = await runCase(caseConfig, { fetchForCall, plannerReplay, caseConfigBytes, outputOverride: bounds.outputDir, onFailure(error) {
      if (isCodegenieError(error)) failure = { code: error.code, reason: error.context?.reason, callId: error.context?.callId };
    } });
    if (result.status !== 'error') return result;
    const operational = operationalError(ledger, attemptPrefix, failure);
    return { ...result, operationalError: operational,
      ...(operational === 'provider_failure' && failure?.reason === 'transient_error' && typeof failure.callId === 'string' ? { failureCallId: failure.callId } : {}) };
  } finally { ledger.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [file, expectedDigest] = process.argv.slice(2);
  try {
    if (!file || !/^[a-f0-9]{64}$/u.test(expectedDigest ?? '')) throw bindingError();
    const raw = readFileSync(file);
    if (createHash('sha256').update(raw).digest('hex') !== expectedDigest) throw bindingError();
    const workerToken = readWorkerToken();
    const result = await runWorker(JSON.parse(raw.toString('utf8')), { workerConfigSHA256: expectedDigest, workerToken });
    console.log(JSON.stringify({ caseName: result.caseName, status: result.status, runDir: result.runDir,
      ...(result.status === 'error' ? { error: result.operationalError, ...(result.failureCallId ? { failureCallId: result.failureCallId } : {}) } : {}) }));
    // A score failure is an observed outcome, not a harness failure.
  } catch (error) {
    const reason = error?.context?.reason;
    const safe = ['campaign_budget', 'binding_mismatch', 'provider_denied', 'accounting_failed', 'campaign_stopped', 'boundary_not_admitted'].includes(reason) ? reason : 'harness_exception';
    console.log(JSON.stringify({ error: safe }));
    process.exitCode = 1;
  }
}
