import { createHash } from 'node:crypto';
import { readCheckedFile } from './safe-read.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const isHash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const classes = new Set(['introduced_real_defect', 'policy_or_reachability', 'pre_existing', 'wholly_false']);
const severityRank = { low: 0, medium: 1, high: 2, critical: 3 };
const validSeverity = (value) => typeof value === 'string' && Object.hasOwn(severityRank, value);
function checkedJson(file, expected) {
  if (typeof file !== 'string' || !isHash(expected)) throw new Error('missing lock evidence');
  const bytes = readCheckedFile(file);
  if (hash(bytes) !== expected) throw new Error('lock evidence digest mismatch');
  const value = JSON.parse(bytes.toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid lock evidence');
  return value;
}
function sameIds(actual, expected) {
  return actual.length === expected.length && new Set(actual).size === actual.length && [...actual].sort().join('\0') === [...expected].sort().join('\0');
}
function verifyGrades(grades, manifest, sheets) {
  if (!Array.isArray(grades) || !Array.isArray(manifest?.sheets) || !Array.isArray(sheets) || !sameIds(grades.map((item) => item?.id), manifest.sheets.map((item) => item.id))) throw new Error('grade sheet coverage mismatch');
  for (const entry of manifest.sheets) {
    const grade = grades.find((item) => item.id === entry.id), sheet = sheets.find((item) => item.id === entry.id);
    if (!sheet || !Array.isArray(entry.causes) || !Array.isArray(grade.causes) || !sameIds(grade.causes.map((cause) => cause?.causeId), entry.causes.map((cause) => cause.id)) ||
        (entry.causes.length === 0 && grade.noApplicableCauses !== true) || (entry.causes.length > 0 && grade.noApplicableCauses === true) ||
        !Array.isArray(grade.otherClaims?.survivingMediumPlus) || !Array.isArray(grade.otherClaims?.published)) throw new Error('grade cause coverage mismatch');
    const inline = sheet.published?.findings ?? [], summary = sheet.published?.summaryOnly ?? [], questions = sheet.published?.attentionQuestions ?? [];
    if ([...inline, ...summary].some((item) => typeof item.id !== 'string' || !validSeverity(item.severity)) ||
        (sheet.verification ?? []).some((row) => ['keep', 'revise'].includes(row.verdict) && (typeof row.candidateId !== 'string' || !validSeverity(row.finalSeverity ?? row.severity)))) throw new Error('invalid graded item evidence');
    const referenced = new Set(), linkedCandidates = new Set();
    for (const cause of grade.causes) {
      if (!['finding', 'question', 'none'].includes(cause.raised) || !['promoted', 'dropped', 'n/a'].includes(cause.promotion) ||
          !['kept', 'rejected', 'gate_suppressed', 'n/a'].includes(cause.verification) || !['finding', 'summary_only', 'attention_question', 'none'].includes(cause.publication) ||
          !['none', 'discovery', 'promotion', 'verification', 'composition'].includes(cause.earliestLoss) || typeof cause.externalQuestion !== 'boolean' || typeof cause.readerVisible !== 'boolean' ||
          typeof cause.needsConfirmation !== 'boolean' || !Array.isArray(cause.items) || cause.items.some((item) => typeof item !== 'string') ||
          !Array.isArray(cause.candidateIds) || cause.candidateIds.some((id) => typeof id !== 'string')) throw new Error('incomplete cause judgment');
      for (const id of cause.candidateIds) {
        if (!(sheet.verification ?? []).some((row) => row.candidateId === id) && !(sheet.discovery?.findings ?? []).some((row) => row.id === id)) throw new Error('foreign candidate judgment');
        linkedCandidates.add(id);
      }
      if (cause.publication === 'finding' || cause.publication === 'summary_only') {
        const source = cause.publication === 'finding' ? inline : summary;
        if (typeof cause.publishedId !== 'string' || !source.some((item) => item.id === cause.publishedId) || typeof cause.evidence !== 'string' || !cause.evidence.trim()) throw new Error('publication reference missing');
        referenced.add(cause.publishedId);
      } else if (cause.publishedId !== null) throw new Error('invalid publication reference');
      if (cause.publication === 'attention_question' && (!Number.isSafeInteger(cause.attentionIndex) || cause.attentionIndex < 0 || cause.attentionIndex >= questions.length)) throw new Error('attention reference missing');
    }
    const expectedPublished = [...inline.map((item) => ({ ...item, summaryOnly: false })), ...summary.map((item) => ({ ...item, summaryOnly: true }))].filter((item) => !referenced.has(item.id));
    const published = grade.otherClaims.published;
    if (!sameIds(published.map((item) => item?.id), expectedPublished.map((item) => item.id)) || published.some((item) => {
      const expected = expectedPublished.find((candidate) => candidate.id === item.id);
      return !expected || !classes.has(item.class) || typeof item.slug !== 'string' || !item.slug.trim() || item.severity !== expected.severity || item.summaryOnly !== expected.summaryOnly;
    })) throw new Error('published other-claim coverage mismatch');
    const surviving = (sheet.verification ?? []).filter((row) => ['keep', 'revise'].includes(row.verdict) && (severityRank[row.finalSeverity ?? row.severity] ?? -1) >= 1 && !linkedCandidates.has(row.candidateId));
    const other = grade.otherClaims.survivingMediumPlus;
    if (!sameIds(other.map((item) => item?.candidateId), surviving.map((row) => row.candidateId)) || other.some((item) => {
      const expected = surviving.find((row) => row.candidateId === item.candidateId);
      return !expected || !classes.has(item.class) || typeof item.slug !== 'string' || !item.slug.trim() || item.severity !== (expected.finalSeverity ?? expected.severity);
    })) throw new Error('surviving other-claim coverage mismatch');
  }
}

export function verifyPrimaryLocks({ manifestSHA256, locks, reconciliation, manifest, sheets }) {
  if (!isHash(manifestSHA256) || !Array.isArray(locks) || locks.length !== 2 || locks[0]?.sha256 === locks[1]?.sha256) throw new Error('two distinct locks required');
  const records = locks.map((lock) => checkedJson(lock.path, lock.sha256));
  if (records.some((record) => typeof record.analyst !== 'string' || !record.analyst.trim() || record.manifestSHA256 !== manifestSHA256) || records[0].analyst.trim().toLowerCase() === records[1].analyst.trim().toLowerCase()) throw new Error('analyst lock mismatch');
  for (const record of records) verifyGrades(record.grades, manifest, sheets);
  const joined = checkedJson(reconciliation?.path, reconciliation?.sha256);
  if (joined.manifestSHA256 !== manifestSHA256 || !Array.isArray(joined.lockSHA256) || joined.lockSHA256.length !== 2 ||
      [...joined.lockSHA256].sort().join(',') !== locks.map((lock) => lock.sha256).sort().join(',')) throw new Error('reconciliation binding mismatch');
  verifyGrades(joined.grades, manifest, sheets);
  return { manifestSHA256, lockSHA256: locks.map((lock) => lock.sha256).sort(), reconciliationSHA256: reconciliation.sha256 };
}
