const count = (x) => Number.isSafeInteger(x) && x >= 0;

export class RecoveredResetLimitError extends Error {
  constructor(recoveredResets) { super('too many recovered stream resets'); this.recoveredResets = recoveredResets; }
}

// Review and planner capture share the same transport checks. Only the
// acceptance evidence for a recovered reset differs: planner requests do not
// have a Stage 7 packet to submit.
export function validateTransportEvidence({ models, physical, events, attemptPrefix, ledger, acceptedPackets = new Set(), acceptance = 'packet', priorRecoveredResets = 0 }) {
  if (!Array.isArray(models) || !Array.isArray(physical) || !Array.isArray(events) || typeof attemptPrefix !== 'string' || !attemptPrefix ||
      !ledger?.db || !(acceptedPackets instanceof Set) || !['packet', 'structured-request'].includes(acceptance) || !count(priorRecoveredResets)) throw new Error('invalid transport evidence binding');
  if (models.some((row) => row.retryReason === 'usage_limit')) throw new Error('provider quota denial');
  const requestAccepted = (row) => acceptance === 'packet'
    ? typeof row.packetId === 'string' && acceptedPackets.has(row.packetId)
    : events.some((event) => event.stage === row.stage && event.message === 'structured_submission_accepted' && event.data?.structuredRequestId === row.structuredRequestId);
  let recoveredResets = 0;
  for (const [index, row] of models.entries()) {
    const starts = physical.filter((item) => item.logical_id === `${attemptPrefix}/${row.callId}`);
    if (row.cacheStatus === 'hit' ? starts.length !== 0 : starts.length === 0) throw new Error('logical and physical call mismatch');
    if (row.cacheStatus === 'hit' && ledger.db.prepare('SELECT status FROM logical WHERE id=?').get(`${attemptPrefix}/${row.callId}`)?.status !== 'cache_hit') throw new Error('cache hit missing ledger record');
    const limit = row.toolArgumentStreamLimit;
    const last = starts.at(-1);
    const abort = row.status === 'aborted' && row.errorCode === 'llm_call_failed' && row.retryReason === 'tool_argument_stream_limit' && limit && last?.state === 'unknown' && last.charge >= ledger.reserve &&
      ['whitespace_run', 'total_chars'].includes(limit.trigger) && ['limitChars', 'observedChars', 'toolArgumentChars', 'contentIndex'].every((key) => count(limit[key])) && limit.observedChars > limit.limitChars &&
      events.some((event) => event.message === 'model_tool_argument_stream_limit' && event.data?.callId === row.callId && event.stage === row.stage &&
        ['packetId', 'structuredRequestId'].every((key) => row[key] === undefined || event.data?.[key] === row[key]) &&
        ['trigger', 'limitChars', 'observedChars', 'toolArgumentChars', 'contentIndex'].every((key) => event.data?.[key] === limit[key]));
    const noUsage = [row.inputTokens, row.outputTokens, row.totalTokens].every((value) => value === undefined || value === null);
    const sameRequest = (next) => next.stage === row.stage && next.workerId === row.workerId && next.packetId === row.packetId && next.structuredRequestId === row.structuredRequestId;
    const next = models.slice(index + 1).find(sameRequest);
    const nextStart = next && physical.filter((item) => item.logical_id === `${attemptPrefix}/${next.callId}`).at(-1);
    const nextUsage = nextStart?.evidence_json ? JSON.parse(nextStart.evidence_json) : null;
    const reset = row.status === 'transient_error' && noUsage && typeof row.structuredRequestId === 'string' && row.structuredRequestId &&
      requestAccepted(row) && Number.isSafeInteger(row.attempt) && row.attempt > 0 &&
      starts.length === 1 && starts[0].http_status === 200 && starts[0].stream_terminal === 'body_reset' && starts[0].state === 'unknown' && starts[0].charge >= ledger.reserve &&
      next?.kind === row.kind && next.attempt === row.attempt + 1 && next.status === 'ok' && [next.inputTokens, next.outputTokens, next.totalTokens].every(count) &&
      nextStart && nextStart.http_status >= 200 && nextStart.http_status < 300 && nextUsage?.usagePresent === true &&
      ['inputTokens', 'outputTokens', 'totalTokens'].every((key) => count(nextUsage[key]) && nextUsage[key] === next[key]);
    if (reset) recoveredResets++;
    if (!abort && !reset && ![row.inputTokens, row.outputTokens, row.totalTokens].every(count)) throw new Error('model usage missing');
    for (const start of starts) {
      if ((start.http_status >= 200 && start.http_status < 300) || (start === last && start.http_status >= 500 && start.http_status < 600)) {
        const usage = start.evidence_json ? JSON.parse(start.evidence_json) : null;
        const complete = usage && usage.usagePresent === true && [usage.inputTokens, usage.outputTokens, usage.totalTokens].every(count);
        if (!complete && !(abort && start === last) && !reset) throw new Error('physical usage missing');
        if (complete && start === last && [row.inputTokens, row.outputTokens, row.totalTokens].every(count) && ['inputTokens', 'outputTokens', 'totalTokens'].some((key) => row[key] !== usage[key])) throw new Error('physical and native usage differ');
      }
    }
  }
  if (priorRecoveredResets + recoveredResets >= 3) throw new RecoveredResetLimitError(recoveredResets);
  return { recoveredResets };
}
