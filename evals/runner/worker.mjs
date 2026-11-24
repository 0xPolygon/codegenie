import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { CampaignLedger } from './ledger.mjs';
import { makePhysicalTransport } from './physical-fetch.mjs';
import { outsideCheckout, runCase } from './case.mjs';

// This internal worker receives paths and expected metadata only; provider
// credentials remain in the normal Codegenie home/environment.
export async function runWorker(options, { fetchImpl = globalThis.fetch } = {}) {
  const { caseConfig, ledgerPath, ledgerBinding, limitMicros, attemptPrefix, expectedCalls, boundaryId, evidenceFiles } = options;
  if (![caseConfig, ledgerPath, ledgerBinding, attemptPrefix].every((x) => typeof x === 'string' && x) || !Array.isArray(expectedCalls)) throw new TypeError('invalid worker binding');
  const { TransportAdmissionError } = await import('../../dist/llm/transport-admission.js');
  const ledger = new CampaignLedger(outsideCheckout(ledgerPath), { binding: ledgerBinding, limitMicros });
  try {
    // The campaign supervisor runs one review attempt at a time. An open row
    // at worker startup belongs to an interrupted attempt and requires custody
    // reconciliation before any new physical admission.
    ledger.assertRestartSafe();
    let boundaryVerified = false;
    const fetchForCall = (call) => {
      const matching = expectedCalls.filter((item) => item.stage === call.stage && item.kind === call.kind && (item.purpose ?? null) === (call.purpose ?? null));
      const expected = matching.length === 1 ? matching[0] : {};
      const transport = makePhysicalTransport({ ledger, call, expected, attemptPrefix, fetchImpl, AdmissionError: TransportAdmissionError });
      const preflight = () => {
        if (boundaryVerified) return;
        const id = `${attemptPrefix}/${call.callId}/preflight`;
        const verifyEvidence = (_kind, hash) => {
          const file = evidenceFiles?.[hash];
          if (typeof file !== 'string') return false;
          try { return createHash('sha256').update(readFileSync(file)).digest('hex') === hash; }
          catch { return false; }
        };
        let reason;
        try {
          if (typeof boundaryId !== 'string' || !boundaryId) reason = 'binding_mismatch';
          else {
            const key = ledger.keyDecision({ verifyEvidence });
            const health = ledger.healthDecision({ boundaryId, provider: call.provider, nowMs: Date.now(), verifyEvidence });
            if (key.action !== 'admit') reason = key.reason ?? `key_${key.action}`;
            else if (health.action !== 'admit') reason = health.reason ?? `health_${health.action}`;
          }
        } catch { reason = 'binding_mismatch'; }
        if (reason !== undefined) {
          try { ledger.recordRefusal({ id, logicalId: `${attemptPrefix}/${call.callId}`, reason }); }
          catch { try { ledger.stop('accounting_failed'); } catch {} throw new TransportAdmissionError('accounting_failed'); }
          throw new TransportAdmissionError(reason === 'binding_mismatch' ? 'binding_mismatch' : reason === 'budget_limit' ? 'campaign_budget' : 'campaign_stopped');
        }
        boundaryVerified = true;
      };
      return { ...transport, fetch: (input, init) => { preflight(); return transport.fetch(input, init); } };
    };
    return await runCase(caseConfig, { fetchForCall });
  } finally { ledger.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [file, expectedDigest] = process.argv.slice(2);
  try {
    if (!file || !/^[a-f0-9]{64}$/u.test(expectedDigest ?? '')) throw new Error('worker config and digest required');
    const raw = readFileSync(file);
    if (createHash('sha256').update(raw).digest('hex') !== expectedDigest) throw new Error('worker binding mismatch');
    const result = await runWorker(JSON.parse(raw.toString('utf8')));
    console.log(JSON.stringify({ caseName: result.caseName, status: result.status, runDir: result.runDir }));
    // A score failure is an observed outcome, not a harness failure.
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
