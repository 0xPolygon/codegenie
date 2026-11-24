import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { CampaignLedger } from './ledger.mjs';
import { boundaryDecision, boundaryRefusalReason, BoundaryBindingError } from './boundary.mjs';
import { makePhysicalTransport } from './physical-fetch.mjs';
import { outsideCheckout, runCase, workerBounds } from './case.mjs';
const bindingError = () => Object.assign(new Error('binding mismatch'), { context: { reason: 'binding_mismatch' } });

function activateWorker({ supervisorPath, attemptPrefix, ledgerBinding, workerConfigSHA256, workerToken }) {
  const match = typeof attemptPrefix === 'string' ? /^([A-Za-z0-9._-]+)\/attempt-(\d{2,})$/u.exec(attemptPrefix) : null;
  if (!match || typeof supervisorPath !== 'string' || !/^[a-f0-9]{64}$/u.test(workerConfigSHA256 ?? '') || !/^[a-f0-9]{64}$/u.test(workerToken ?? '')) return false;
  const db = new DatabaseSync(outsideCheckout(supervisorPath));
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      const campaign = db.prepare('SELECT binding FROM campaign').get();
      const result = campaign?.binding === ledgerBinding ? db.prepare("UPDATE worker_claim SET activated=1 WHERE slot_id=? AND attempt_no=? AND config_sha256=? AND token_sha256=? AND activated=0 AND EXISTS (SELECT 1 FROM attempt WHERE attempt.slot_id=worker_claim.slot_id AND attempt.attempt_no=worker_claim.attempt_no AND attempt.state='started')").run(
        match[1], Number(match[2]), workerConfigSHA256, createHash('sha256').update(workerToken).digest('hex')) : { changes: 0 };
      db.exec('COMMIT'); return result.changes === 1;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  } finally { db.close(); }
}

// This internal worker receives paths and expected metadata only; provider
// credentials remain in the normal Codegenie home/environment.
export async function runWorker(options, { fetchImpl = globalThis.fetch, workerConfigSHA256, workerToken } = {}) {
  const { caseConfig, caseConfigSHA256, supervisorPath, ledgerPath, ledgerBinding, limitMicros, reserveMicros, errorHoldMicros, attemptPrefix, expectedCalls, boundaryId, evidenceFiles } = options;
  if (![caseConfig, ledgerPath, ledgerBinding, attemptPrefix].every((x) => typeof x === 'string' && x) || !Array.isArray(expectedCalls)) throw new TypeError('invalid worker binding');
  const { TransportAdmissionError } = await import('../../dist/llm/transport-admission.js');
  const ledger = new CampaignLedger(outsideCheckout(ledgerPath), { binding: ledgerBinding, limitMicros, reserveMicros, errorHoldMicros });
  try {
    // The campaign supervisor runs one review attempt at a time. An open row
    // at worker startup belongs to an interrupted attempt and requires custody
    // reconciliation before any new physical admission.
    ledger.assertRestartSafe();
    const caseConfigBytes = readFileSync(outsideCheckout(caseConfig));
    if (!/^[a-f0-9]{64}$/u.test(caseConfigSHA256 ?? '') || createHash('sha256').update(caseConfigBytes).digest('hex') !== caseConfigSHA256) throw bindingError();
    const bounds = await workerBounds(caseConfig, caseConfigBytes, attemptPrefix);
    const authenticated = workerToken !== undefined || supervisorPath !== undefined
      ? activateWorker({ supervisorPath, attemptPrefix, ledgerBinding, workerConfigSHA256, workerToken }) : false;
    if ((workerToken !== undefined || supervisorPath !== undefined) && !authenticated) throw bindingError();
    let boundaryVerified = false;
    const fetchForCall = (call) => {
      const matching = expectedCalls.filter((item) => item.stage === call.stage && item.kind === call.kind && (item.purpose ?? null) === (call.purpose ?? null));
      const expected = matching.length === 1 ? matching[0] : {};
      const transport = makePhysicalTransport({ ledger, call, expected, attemptPrefix, fetchImpl, AdmissionError: TransportAdmissionError });
      const preflight = () => {
        if (boundaryVerified) return;
        const id = `${attemptPrefix}/${call.callId}/preflight`;
        let reason;
        try {
          if (!authenticated) reason = 'binding_mismatch';
          else {
            const decision = boundaryDecision({ ledger, boundaryId, provider: call.provider, evidenceFiles });
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
    return await runCase(caseConfig, { fetchForCall, caseConfigBytes, outputOverride: bounds.outputDir });
  } finally { ledger.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [file, expectedDigest] = process.argv.slice(2);
  try {
    if (!file || !/^[a-f0-9]{64}$/u.test(expectedDigest ?? '')) throw bindingError();
    const raw = readFileSync(file);
    if (createHash('sha256').update(raw).digest('hex') !== expectedDigest) throw bindingError();
    const workerToken = process.env.CODEGENIE_CAMPAIGN_WORKER_TOKEN;
    delete process.env.CODEGENIE_CAMPAIGN_WORKER_TOKEN;
    const result = await runWorker(JSON.parse(raw.toString('utf8')), { workerConfigSHA256: expectedDigest, workerToken });
    console.log(JSON.stringify({ caseName: result.caseName, status: result.status, runDir: result.runDir }));
    // A score failure is an observed outcome, not a harness failure.
  } catch (error) {
    const reason = error?.context?.reason;
    const safe = ['campaign_budget', 'binding_mismatch', 'provider_denied', 'accounting_failed', 'campaign_stopped', 'boundary_not_admitted'].includes(reason) ? reason : 'harness_exception';
    console.log(JSON.stringify({ error: safe }));
    process.exitCode = 1;
  }
}
