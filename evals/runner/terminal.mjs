import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { outsideCheckout } from './case.mjs';

const guided = new Set(['invalid_args', 'budget_exhausted', 'file_missing', 'path_outside_repo', 'not_found']);
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
export function validateTerminal({ runDir, attemptPrefix, ledger }) {
  if (typeof attemptPrefix !== 'string' || !attemptPrefix || !ledger?.db) throw new Error('invalid terminal binding');
  const root = outsideCheckout(runDir), run = json(path.join(root, 'run.json')), summary = json(path.join(root, 'telemetry.json'));
  if (typeof run.runId !== 'string' || !run.runId || summary.runId !== run.runId || !['completed_full', 'completed_partial'].includes(run.outcome?.status)) throw new Error('terminal review missing or failed');
  const events = jsonl(path.join(root, 'events.jsonl'), summary.events);
  const models = jsonl(path.join(root, 'model-calls.jsonl'), summary.modelCalls?.totalRecords);
  const tools = jsonl(path.join(root, 'tool-calls.jsonl'), summary.toolCalls?.totalCalls);
  if ([...events, ...models, ...tools].some((row) => row.runId !== run.runId)) throw new Error('telemetry run mismatch');
  if (new Set(events.map((row) => row.eventId)).size !== events.length || new Set(models.map((row) => row.callId)).size !== models.length || new Set(tools.map((row) => row.toolCallId)).size !== tools.length ||
      events.some((row) => typeof row.eventId !== 'string') || models.some((row) => typeof row.callId !== 'string') || tools.some((row) => typeof row.toolCallId !== 'string')) throw new Error('telemetry identity mismatch');
  for (const row of tools) {
    if (['internal', 'timeout', 'unknown'].includes(row.errorCode)) throw new Error('tool failure requires stop');
    if (['error', 'rejected'].includes(row.status) && !guided.has(row.errorCode)) throw new Error('tool failure requires stop');
    if (!['ok', 'error', 'rejected', 'skipped'].includes(row.status)) throw new Error('invalid tool status');
  }
  const packetDir = path.join(root, 'stages/06-packets/packets');
  const packetIds = readdirSync(packetDir).filter((name) => name.endsWith('.json')).map((name) => json(path.join(packetDir, name)).id);
  if (packetIds.some((id) => typeof id !== 'string' || !id) || new Set(packetIds).size !== packetIds.length) throw new Error('invalid packet inventory');
  const accepted = new Set(events.filter((event) => event.stage === 7 && event.message === 'structured_submission_accepted').map((event) => event.data?.packetId));
  if (packetIds.some((id) => !accepted.has(id))) throw new Error('packet submit missing');
  const prefix = `${attemptPrefix}/`;
  const physical = ledger.db.prepare('SELECT id,logical_id,state,http_status,evidence_json FROM physical WHERE substr(id,1,?)=? ORDER BY rowid').all(prefix.length, prefix);
  if (physical.some((row) => row.state === 'open' || [401, 402, 429].includes(row.http_status))) throw new Error('physical call requires reconciliation');
  const byCall = new Map(models.map((row) => [`${attemptPrefix}/${row.callId}`, row]));
  if (physical.some((row) => !byCall.has(row.logical_id))) throw new Error('physical call missing telemetry');
  for (const row of models) {
    const starts = physical.filter((item) => item.logical_id === `${attemptPrefix}/${row.callId}`);
    if (row.cacheStatus === 'hit' ? starts.length !== 0 : starts.length === 0) throw new Error('logical and physical call mismatch');
    if (row.cacheStatus === 'hit' && ledger.db.prepare('SELECT status FROM logical WHERE id=?').get(`${attemptPrefix}/${row.callId}`)?.status !== 'cache_hit') throw new Error('cache hit missing ledger record');
    const limit = row.toolArgumentStreamLimit;
    const abort = row.status === 'aborted' && row.retryReason === 'tool_argument_stream_limit' && limit &&
      ['whitespace_run', 'total_chars'].includes(limit.trigger) && ['limitChars', 'observedChars', 'toolArgumentChars', 'contentIndex'].every((key) => count(limit[key])) && limit.observedChars > limit.limitChars &&
      events.some((event) => event.message === 'model_tool_argument_stream_limit' && event.data?.callId === row.callId && event.stage === row.stage &&
        ['trigger', 'limitChars', 'observedChars', 'toolArgumentChars', 'contentIndex'].every((key) => event.data?.[key] === limit[key]));
    if (!abort && ![row.inputTokens, row.outputTokens, row.totalTokens].every(count)) throw new Error('model usage missing');
    for (const start of starts) {
      if (start.http_status >= 200 && start.http_status < 300) {
        const usage = start.evidence_json ? JSON.parse(start.evidence_json) : null;
        if ((!usage || usage.usagePresent !== true || ![usage.inputTokens, usage.outputTokens, usage.totalTokens].every(count)) && !abort) throw new Error('physical usage missing');
      }
    }
  }
  const stopped = ledger.totals().stopped;
  if (stopped) throw new Error('campaign stop is latched');
  return { status: run.outcome.status, packets: packetIds.length, modelCalls: models.length, physicalStarts: physical.length };
}
