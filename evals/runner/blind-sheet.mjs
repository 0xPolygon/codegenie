import { createHmac } from 'node:crypto';

// Project only grading evidence; neither operational records nor sidecars enter.
const marker = /\b(?:read_change|read_range|read_definition|find_usages|search_files|list_files|find_definition|find_symbol_mentions|read_symbol|read_diff_blocks|read_file_outline|find_likely_tests|six[-_ ]tool|nine[-_ ]tool|packet-first|arm\s+[abce]|draw[-_ ]+\d+|review\.assignedEffects|assignedEffects|assigned[-_ ]effects?|removed_guarantee|skipped_path|relied_guard|toolSurface|stage7Prompt|p[579]\.[\w.-]+|openrouter|openai-codex|gpt-6-luna)\b/giu;
const treatment = /(?:review\.assignedEffects|assignedEffects|assigned[-_ ]effects?|removed_guarantee|skipped_path|relied_guard|stage7Prompt|p7\.[\w.-]+)/iu;
const alias = (key, sheet, kind, value) => `${kind}-` + createHmac('sha256', key).update(`${sheet}\0${kind}\0${value}`).digest('hex').slice(0, 16);
const pick = (value, keys) => Object.fromEntries(keys.filter((key) => value?.[key] !== undefined).map((key) => [key, value[key]]));
const relative = (value) => typeof value === 'string' && value.length > 0 && !value.startsWith('/') && !value.includes('\\') && !value.split('/').includes('..');
const anchor = (value) => value && typeof value === 'object' ? pick(value, ['path', 'line', 'side']) : undefined;
function visible(value) {
  if (typeof value !== 'string') return value;
  return value.split(/<details\b/iu)[0].replace(/^\s*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\s*\1\s*$/gmu, '[code block]').trim();
}

export function projectBlindSheet({ id, caseId, outcome, candidates, promotion, verification, finalReview, key }) {
  if (!/^[a-f0-9]{24}$/u.test(id ?? '') || typeof caseId !== 'string' || !caseId || !Buffer.isBuffer(key) || key.length !== 32 ||
      !['completed_full', 'completed_partial'].includes(outcome) || !Array.isArray(candidates) || !Array.isArray(promotion?.decisions) || !Array.isArray(verification) || !finalReview || typeof finalReview !== 'object') throw new Error('missing first-lock evidence');
  const candidate = (row) => ({ ...pick(row, ['id', 'path', 'changedLine', 'severity', 'confidence', 'title', 'failureMode', 'whyThisMatters']),
    ...(row.anchor ? { anchor: anchor(row.anchor) } : {}), ...(row.evidence?.changedCode !== undefined ? { changedCode: row.evidence.changedCode } : {}) });
  const published = (row) => ({ ...pick(row, ['id', 'path', 'title', 'severity', 'confidence', 'failureMode', 'whyThisMatters', 'mergedCandidateIds']),
    ...(row.anchor ? { anchor: anchor(row.anchor) } : {}), ...(row.finalBody !== undefined ? { visibleBody: visible(row.finalBody) } : {}) });
  const isQuestion = (row) => row?.provenance?.source === 'uncertainty_promotion';
  const byId = new Map(candidates.filter((x) => typeof x?.id === 'string').map((x) => [x.id, x]));
  const questions = promotion.decisions.map((x) => ({ ...pick(x, ['packetId', 'sourceKind', 'question', 'files', 'symbols', 'promoted', 'candidateId']), ...(!x.promoted ? { dropReason: x.reason } : {}) }));
  const ver = verification.map((x) => { const verdict = x.verdict ?? {}; const source = byId.get(x.candidateId); return {
    ...pick(x, ['candidateId', 'gate', 'gateDecision', 'gateReason', 'verificationStatus']), fromQuestion: isQuestion(source) || questions.some((q) => q.candidateId === x.candidateId),
    ...pick(verdict, ['verdict', 'reason']), ...(verdict.proofAssessment?.status ? { proof: verdict.proofAssessment.status } : {}),
    ...(verdict.finalFinding?.severity ?? verdict.findingUpdates?.severity ? { finalSeverity: verdict.finalFinding?.severity ?? verdict.findingUpdates?.severity } : {}) }; });
  const sheet = { id, case: caseId, reviewComplete: outcome === 'completed_full', discovery: { findings: candidates.filter((x) => !isQuestion(x)).map(candidate), questions }, verification: ver,
    published: { findings: (finalReview.findings ?? []).map(published), summaryOnly: (finalReview.summaryOnlyFindings ?? []).map(published),
      attentionQuestions: (finalReview.needsHumanAttention ?? []).map((x) => pick(x, ['question', 'reason', 'files', 'symbols'])) } };
  const ids = new Map();
  const gather = (v, field) => { if (Array.isArray(v)) { for (const item of v) gather(item, field); return; } if (v && typeof v === 'object') { for (const [k, x] of Object.entries(v)) gather(x, k); return; }
    if (typeof v === 'string' && ['id', 'candidateId', 'mergedCandidateIds', 'packetId'].includes(field) && !(field === 'id' && v === id)) ids.set(v, alias(key, id, field === 'packetId' ? 'p' : 'f', v)); };
  gather(sheet);
  const clean = (v, field) => { if (Array.isArray(v)) return v.map((x) => clean(x, field)); if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clean(x, k)]));
    if (typeof v !== 'string') return v;
    if (['path', 'files', 'changedCode', 'symbols'].includes(field)) { if (['path', 'files'].includes(field) && !relative(v)) throw new Error('non-relative source locator'); return v; }
    let result = v; for (const [old, replacement] of [...ids].sort((a, b) => b[0].length - a[0].length)) result = result.replaceAll(old, replacement);
    return result.replace(marker, '[redacted identifier]'); };
  const result = clean(sheet);
  if (treatment.test(JSON.stringify(result))) throw new Error('first-lock treatment marker');
  return result;
}
