import { createHmac } from 'node:crypto';

// Project only grading evidence; neither operational records nor sidecars enter.
const marker = /\b(?:read_change|read_range|read_definition|find_usages|search_files|list_files|find_definition|find_symbol_mentions|read_symbol|read_diff_blocks|read_file_outline|find_likely_tests|six[-_ ]tool|nine[-_ ]tool|packet-first|arm\s+[abce]|draw[-_ ]+\d+|review\.assignedEffects|assignedEffects|assigned[-_ ]effects?|removed_guarantee|skipped_path|relied_guard|toolSurface|stage7Prompt|p[579]\.[\w.-]+|openrouter|openai-codex|gpt-6-luna)\b/giu;
const treatment = /(?:review\.assignedEffects|assignedEffects|assigned[-_ ]effects?|removed_guarantee|skipped_path|relied_guard|stage7Prompt|p7\.[\w.-]+|\b(?:control|treatment)[\s_-]+arm\b|\barm[\s:=_-]*(?:control|treatment|[ae])\b|\bblind\.arm\b|\\?["']arm\\?["'])/giu;
const adaptiveTreatment = /\b(?:adaptive(?:[\s_-]?(?:review|secondpass))?|second[\s_-]+pass|pass[\s_-]+2)\b/giu;
const codeShapedIdentifier = (token) => /(?:[a-z][A-Z]|_|\d|\.)/u.test(token);
const sourceHasPhrase = (source, phrase) => new RegExp(`(?<![\\p{L}\\p{N}_$.])${phrase.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?![\\p{L}\\p{N}_$.])`, 'u').test(source);
function attestedAdaptiveHits(sheet, attestation) {
  const sources = attestation?.phraseSources, excerpts = attestation?.changedCodeSources;
  if (!Array.isArray(sources) || !Array.isArray(excerpts) || [...sources, ...excerpts].some((source) => typeof source !== 'string')) return 0;
  let allowed = 0;
  const walk = (value, field) => {
    if (Array.isArray(value)) { for (const item of value) walk(item, field); return; }
    if (value && typeof value === 'object') { for (const [key, item] of Object.entries(value)) walk(item, key); return; }
    if (typeof value !== 'string') return;
    const encoded = JSON.stringify(value).slice(1, -1);
    const exactChangedCode = field === 'changedCode' && value.length > 0 && excerpts.some((source) => source.includes(value));
    for (const match of encoded.matchAll(adaptiveTreatment)) {
      if (!/^adaptive$/iu.test(match[0])) continue;
      if (exactChangedCode) { allowed++; continue; }
      const before = encoded.slice(0, match.index), after = encoded.slice(match.index + match[0].length);
      const left = before.match(/(?:^|[^\p{L}\p{N}_$.])([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)[ \t]+$/u), right = after.match(/^[ \t]+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)(?![\p{L}\p{N}_$.])/u);
      const candidates = [];
      if (left) candidates.push({ token: left[1], phrase: `${left[1]}${before.slice(-before.match(/[ \t]+$/u)[0].length)}${match[0]}` });
      if (right) candidates.push({ token: right[1], phrase: `${match[0]}${right[0]}` });
      if (candidates.some(({ token, phrase }) => codeShapedIdentifier(token) && sources.some((source) => sourceHasPhrase(source, phrase)))) allowed++;
    }
  };
  walk(sheet); return allowed;
}
const treatmentHits = (sheet, screenAdaptiveMarkers, sources) => {
  const text = JSON.stringify(sheet);
  const otherHits = [...text.matchAll(treatment)].length, adaptiveHits = screenAdaptiveMarkers ? [...text.matchAll(adaptiveTreatment)].length : 0;
  return otherHits + Math.max(0, adaptiveHits - (screenAdaptiveMarkers ? attestedAdaptiveHits(sheet, sources) : 0));
};
export class TreatmentLeakError extends Error {
  constructor(hits, affectedSheets = 1) { super('first-lock treatment markers require disposition'); this.hits = hits; this.affectedSheets = affectedSheets; }
}
const alias = (key, sheet, kind, value) => `${kind}-` + createHmac('sha256', key).update(`${sheet}\0${kind}\0${value}`).digest('hex').slice(0, 16);
const pick = (value, keys) => Object.fromEntries(keys.filter((key) => value?.[key] !== undefined).map((key) => {
  const item = value[key];
  if (item !== null && !['string', 'number', 'boolean'].includes(typeof item) && !(Array.isArray(item) && item.every((entry) => typeof entry === 'string'))) throw new Error('invalid grading field');
  return [key, item];
}));
const relative = (value) => typeof value === 'string' && value.length > 0 && !value.startsWith('/') && !/^[a-z]:/iu.test(value) && !value.includes('\\') && !value.split('/').includes('..');
const anchor = (value) => value && typeof value === 'object' ? pick(value, ['path', 'line', 'side']) : undefined;
function visible(value) {
  if (typeof value !== 'string') return value;
  return value.split(/<details\b/iu)[0].replace(/^\s*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\s*\1\s*$/gmu, '[code block]').trim();
}

export function projectBlindSheet({ id, caseId, outcome, candidates, promotion, verification, finalReview, key, hunkIdentifiers = [], screenAdaptiveMarkers = false, attestedSources }) {
  if (!/^[a-f0-9]{24}$/u.test(id ?? '') || typeof caseId !== 'string' || !caseId || !Buffer.isBuffer(key) || key.length !== 32 ||
      !['completed_full', 'completed_partial'].includes(outcome) || !Array.isArray(candidates) || !Array.isArray(promotion?.decisions) || !Array.isArray(verification) || !finalReview || typeof finalReview !== 'object') throw new Error('missing first-lock evidence');
  const candidate = (row) => ({ ...pick(row, ['id', 'path', 'changedLine', 'severity', 'confidence', 'behaviorChange', 'title', 'failureMode', 'whyThisMatters']),
    ...(row.anchor ? { anchor: anchor(row.anchor) } : {}), ...(row.evidence?.changedCode !== undefined ? pick(row.evidence, ['changedCode']) : {}) });
  const published = (row) => ({ ...pick(row, ['id', 'path', 'title', 'severity', 'confidence', 'behaviorChange', 'failureMode', 'whyThisMatters', 'mergedCandidateIds']),
    ...(row.anchor ? { anchor: anchor(row.anchor) } : {}), ...(row.finalBody !== undefined ? { visibleBody: visible(pick(row, ['finalBody']).finalBody) } : {}) });
  const isQuestion = (row) => row?.provenance?.source === 'uncertainty_promotion';
  const byId = new Map(candidates.filter((x) => typeof x?.id === 'string' && x.id).map((x) => [x.id, x]));
  if (byId.size !== candidates.length || verification.some((row) => typeof row?.candidateId !== 'string' || !byId.has(row.candidateId))) throw new Error('invalid candidate evidence');
  const questions = promotion.decisions.map((x) => ({ ...pick(x, ['packetId', 'sourceKind', 'question', 'files', 'symbols', 'promoted', 'candidateId']), ...(!x.promoted ? { dropReason: x.reason } : {}) }));
  const ver = verification.map((x) => { const verdict = x.verdict ?? {}; const source = byId.get(x.candidateId); return {
    ...pick(x, ['candidateId', 'gate', 'gateDecision', 'gateReason', 'verificationStatus']), ...(source?.severity ? { severity: source.severity } : {}), fromQuestion: isQuestion(source) || questions.some((q) => q.candidateId === x.candidateId),
    ...pick(verdict, ['verdict', 'reason', 'behaviorChange']), ...(verdict.proofAssessment?.status ? { proof: verdict.proofAssessment.status } : {}),
    ...(verdict.finalFinding?.severity ?? verdict.findingUpdates?.severity ?? verdict.severityRevision?.applied ? { finalSeverity: verdict.finalFinding?.severity ?? verdict.findingUpdates?.severity ?? verdict.severityRevision?.applied } : {}) }; });
  const sheet = { id, case: caseId, reviewComplete: outcome === 'completed_full', discovery: { findings: candidates.filter((x) => !isQuestion(x)).map(candidate), questions }, verification: ver,
    published: { ...(typeof finalReview.summary === 'string' ? { summary: finalReview.summary } : {}), findings: (finalReview.findings ?? []).map(published), summaryOnly: (finalReview.summaryOnlyFindings ?? []).map(published),
      attentionQuestions: (finalReview.needsHumanAttention ?? []).map((x) => pick(x, ['question', 'reason', 'files', 'symbols'])) } };
  const rawHits = treatmentHits(sheet, screenAdaptiveMarkers, attestedSources);
  if (rawHits) throw new TreatmentLeakError(rawHits);
  const hunkAliases = new Map(hunkIdentifiers.map((hunk) => {
    if (typeof hunk !== 'string' || !hunk) throw new Error('invalid registered hunk identifier');
    return [hunk, alias(key, id, 'h', hunk)];
  }));
  const alternatives = [...hunkAliases.keys()].sort((a, b) => b.length - a.length).map((value) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'));
  const hunkPattern = alternatives.length ? new RegExp(`(?<![\\p{L}\\p{N}_-])(?:${alternatives.join('|')})(?![\\p{L}\\p{N}_-])`, 'gu') : null;
  const ids = new Map();
  const gather = (v, field) => { if (Array.isArray(v)) { for (const item of v) gather(item, field); return; } if (v && typeof v === 'object') { for (const [k, x] of Object.entries(v)) gather(x, k); return; }
    if (typeof v === 'string' && ['id', 'candidateId', 'mergedCandidateIds', 'packetId'].includes(field) && !(field === 'id' && v === id)) ids.set(v, alias(key, id, field === 'packetId' ? 'p' : 'f', v)); };
  gather(sheet);
  const clean = (v, field) => { if (Array.isArray(v)) return v.map((x) => clean(x, field)); if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clean(x, k)]));
    if (typeof v !== 'string') return v;
    if (/(?:^|[^a-z0-9_])[a-z]:[\\/]/iu.test(v)) throw new Error('absolute source locator');
    if (['path', 'files'].includes(field)) { if (!relative(v)) throw new Error('non-relative source locator'); return v; }
    let result = v; for (const [old, replacement] of [...ids].sort((a, b) => b[0].length - a[0].length)) result = result.replaceAll(old, replacement);
    if (hunkPattern) result = result.replace(hunkPattern, (value) => hunkAliases.get(value));
    return result.replace(marker, '[redacted identifier]'); };
  const result = clean(sheet);
  const remainingHits = treatmentHits(result, screenAdaptiveMarkers, attestedSources);
  if (remainingHits) throw new TreatmentLeakError(remainingHits);
  return result;
}
