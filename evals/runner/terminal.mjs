import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { outsideCheckout } from './case.mjs';
import { validateTransportEvidence } from './transport-evidence.mjs';
import { assertStageBinding } from './stage-binding.mjs';
export { RecoveredResetLimitError } from './transport-evidence.mjs';

const guided = new Set(['invalid_args', 'budget_exhausted', 'file_missing', 'path_outside_repo', 'not_found', 'unavailable']);
const count = (x) => Number.isSafeInteger(x) && x >= 0;
const json = (file) => JSON.parse(readFileSync(file, 'utf8'));
function jsonl(file, expected) {
  let text;
  try { text = readFileSync(file, 'utf8'); }
  catch (error) { if (error?.code === 'ENOENT' && expected === 0) return []; throw error; }
  if (text && !text.endsWith('\n')) throw new Error('incomplete telemetry stream');
  const rows = text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  if (!count(expected) || rows.length !== expected) throw new Error('telemetry row count mismatch');
  return rows;
}

// Check terminal evidence before a receipt becomes selectable. No error text,
// model prose, or tool arguments are used to classify a row.
export function validateTerminal({ runDir, attemptPrefix, ledger, expectedPacketIds, expectedCalls = [], priorRecoveredResets = 0, failureCallId, historical = false }) {
  if (typeof attemptPrefix !== 'string' || !attemptPrefix || !ledger?.db || !Array.isArray(expectedPacketIds) || expectedPacketIds.some((id) => typeof id !== 'string' || !id) || new Set(expectedPacketIds).size !== expectedPacketIds.length || !count(priorRecoveredResets)) throw new Error('invalid terminal binding');
  const root = path.join(outsideCheckout(runDir), 'telemetry'), run = json(path.join(root, 'run.json')), summary = json(path.join(root, 'telemetry.json'));
  const failureMode = typeof failureCallId === 'string' && /^[A-Za-z0-9._-]+$/u.test(failureCallId);
  if (typeof run.runId !== 'string' || !run.runId || summary.runId !== run.runId || (failureMode ? run.outcome?.status !== 'failed' : !['completed_full', 'completed_partial'].includes(run.outcome?.status))) throw new Error('terminal review missing or failed');
  const events = jsonl(path.join(root, 'events.jsonl'), summary.events);
  const models = jsonl(path.join(root, 'model-calls.jsonl'), summary.modelCalls?.totalRecords);
  if (expectedCalls.some((call) => call.stage === 7)) {
    const info = json(path.join(outsideCheckout(runDir), 'info.json'));
    assertStageBinding(info.effectiveConfig?.llm, expectedCalls, models, (callId) => {
      if (typeof callId !== 'string' || !/^mc-[A-Za-z0-9_-]+$/u.test(callId)) throw new Error('invalid model call id');
      return json(path.join(root, 'debug/llm-calls', `${callId}.request.json`));
    });
  }
  const tools = jsonl(path.join(root, 'tool-calls.jsonl'), summary.toolCalls?.totalCalls);
  if ([...events, ...models, ...tools].some((row) => row.runId !== run.runId)) throw new Error('telemetry run mismatch');
  if (new Set(events.map((row) => row.eventId)).size !== events.length || new Set(models.map((row) => row.callId)).size !== models.length || new Set(tools.map((row) => row.toolCallId)).size !== tools.length ||
      events.some((row) => typeof row.eventId !== 'string') || models.some((row) => typeof row.callId !== 'string') || tools.some((row) => typeof row.toolCallId !== 'string')) throw new Error('telemetry identity mismatch');
  if (models.some((row) => row.retryReason === 'usage_limit')) throw new Error('provider quota denial');
  for (const row of tools) {
    if (['internal', 'timeout', 'unknown'].includes(row.errorCode)) throw new Error('tool failure requires stop');
    if (['error', 'rejected'].includes(row.status) && !guided.has(row.errorCode)) throw new Error('tool failure requires stop');
    if (!['ok', 'error', 'rejected', 'skipped'].includes(row.status)) throw new Error('invalid tool status');
  }
  const packetDir = path.join(root, 'stages/06-packets/packets');
  let packetFiles;
  try { packetFiles = readdirSync(packetDir); } catch (error) { if (failureMode && error?.code === 'ENOENT') packetFiles = []; else throw error; }
  const packetIds = packetFiles.filter((name) => name.endsWith('.json')).map((name) => json(path.join(packetDir, name)).id);
  if (packetIds.some((id) => typeof id !== 'string' || !id) || new Set(packetIds).size !== packetIds.length || summary.packets?.generated !== packetIds.length || packetIds.some((id) => !expectedPacketIds.includes(id)) || (!failureMode && (expectedPacketIds.length !== packetIds.length || expectedPacketIds.some((id) => !packetIds.includes(id))))) throw new Error('invalid packet inventory');
  const accepted = new Set(events.filter((event) => event.stage === 7 && event.message === 'structured_submission_accepted' && typeof event.data?.packetId === 'string').map((event) => event.data.packetId));
  if ((!failureMode && packetIds.some((id) => !accepted.has(id))) || [...accepted].some((id) => !packetIds.includes(id))) throw new Error('packet submit missing');
  const prefix = `${attemptPrefix}/`;
  const physical = ledger.db.prepare('SELECT id,logical_id,state,charge,http_status,evidence_json,stream_terminal FROM physical WHERE substr(id,1,?)=? ORDER BY rowid').all(prefix.length, prefix);
  if (physical.some((row) => row.state === 'open' || [401, 402, 429].includes(row.http_status))) throw new Error('physical call requires reconciliation');
  const byCall = new Map(models.map((row) => [`${attemptPrefix}/${row.callId}`, row]));
  if (physical.some((row) => !byCall.has(row.logical_id))) throw new Error('physical call missing telemetry');
  if (failureMode) {
    const row = models.find((item) => item.callId === failureCallId), starts = physical.filter((item) => item.logical_id === `${attemptPrefix}/${failureCallId}`), last = starts.at(-1);
    if (!row || row.errorCode !== 'llm_call_failed' || row.status !== 'transient_error' || !last || !((last.http_status >= 500 && last.http_status < 600) || (last.http_status === 200 && ['provider_error_event', 'body_reset'].includes(last.stream_terminal))) || last.state === 'open') throw new Error('transient failure evidence missing');
  }
  const { recoveredResets } = validateTransportEvidence({ models, physical, events, attemptPrefix, ledger, acceptedPackets: accepted, priorRecoveredResets });
  const stopped = ledger.totals().stopped;
  if (stopped && !historical) throw new Error('campaign stop is latched');
  return { status: run.outcome.status, packets: packetIds.length, modelCalls: models.length, physicalStarts: physical.length, recoveredResets };
}
