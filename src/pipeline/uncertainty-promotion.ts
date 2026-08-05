import type {
  CandidateFinding,
  Confidence,
  FindingCategory,
  PacketReviewResult,
  ReviewPacket,
  Severity
} from "../types.js";
import type { TelemetryRecorder } from "../telemetry/telemetry-recorder.js";
import { sha256Hex } from "../util/hashing.js";
import { scaleBudgetValue } from "../util/budget.js";
import { isPromotionTestPath } from "../util/path-roles.js";
import { escapeRegExp } from "../util/regex.js";
import { normalizeFollowUpQuestion, normalizedAttentionTerms, tokenJaccard } from "../util/text-similarity.js";

const MAX_PROMOTIONS = 4;
const MIN_PROMOTIONS_WHEN_AVAILABLE = 2;
const MAX_EVIDENCE_CHARS = 2400;
const MAX_RELATED_CONTEXT_EVIDENCE = 3;
const MAX_RELATED_CONTEXT_EVIDENCE_CHARS = 1200;
const MAX_RELATED_PROMOTION_SIGNALS = 8;

type PromotionInput = {
  packetResults: PacketReviewResult[];
  packets: ReviewPacket[];
  budgetBoost?: number;
};

export type UncertaintyPromotionSummary = {
  considered: number;
  promoted: number;
  laneLimited: number;
  representedRelatedSignals: number;
  unrepresentedLaneLimited: number;
  notPromoted: Record<string, number>;
  promotedCandidateIds: string[];
  decisions: PromotionDecision[];
};

export type PromotionDecision = {
  packetId: string;
  sourceKind: PromotionSourceKind;
  question: string;
  files: string[];
  symbols: string[];
  promoted: boolean;
  reason: string;
  rank?: number;
  promotionClass?: PromotionClass;
  localityScore?: number;
  selectedBy?: PromotionSelectionReason;
  candidateId?: string;
  relatedContextEvidenceCount?: number;
};

type PromotionSource = {
  packetResult: PacketReviewResult;
  packet: ReviewPacket;
  sourceKind: PromotionSourceKind;
  question: string;
  files: string[];
  symbols: string[];
  projectedSkillIds: string[];
  reason: string;
  confidence?: Confidence;
};

type PromotionSourceKind = "uncertainty" | "follow_up_hint";
type PromotionClass = "local_behavior_delta" | "broad_behavior_delta" | "test_boundary" | "security_boundary" | "other";
type PromotionSelectionReason = "rank" | "local_behavior_delta_reserve";
type RankedPromotionSource = {
  source: PromotionSource;
  rank: number;
  promotionClass: PromotionClass;
  localityScore: number;
};
type SelectedPromotionSource = RankedPromotionSource & { selectedBy: PromotionSelectionReason };
type RelatedPromotionSignal = NonNullable<NonNullable<CandidateFinding["provenance"]>["relatedSignals"]>[number];
type RelatedPromotionAssociation = {
  source: RankedPromotionSource;
  selected: SelectedPromotionSource;
  selectedIndex: number;
  exactQuestion: boolean;
  sharedTerms: number;
  similarity: number;
};

export async function promoteUncertaintiesForVerification(
  input: PromotionInput,
  telemetry: TelemetryRecorder
): Promise<{ packetResults: PacketReviewResult[]; summary: UncertaintyPromotionSummary }> {
  const packetsById = new Map(input.packets.map((packet) => [packet.id, packet]));
  const sources = input.packetResults.flatMap((result) => promotionSources(result, packetsById));
  const maxPromotions = promotionLimit(input.packetResults.length, input.budgetBoost ?? 1);
  const decisions: PromotionDecision[] = [];
  const promotedByPacket = new Map<string, CandidateFinding[]>();
  const notPromoted: Record<string, number> = {};

  const eligible = sources.flatMap((source): RankedPromotionSource[] => {
    const decision = promotionDecision(source);
    if (!decision.eligible) {
      decisions.push(baseDecision(source, false, decision.reason));
      notPromoted[decision.reason] = (notPromoted[decision.reason] ?? 0) + 1;
      return [];
    }
    return [rankPromotionSource(source)];
  }).sort((a, b) => b.rank - a.rank || a.source.question.localeCompare(b.source.question));

  const selected = selectPromotionSources(eligible, maxPromotions);
  const selectedSet = new Set(selected.map((item) => item.source));
  const unselected = eligible.filter((item) => !selectedSet.has(item.source));
  const relatedAssociations = associateRelatedPromotionSignals(unselected, selected);
  const laneLimited = unselected.filter((item) => !relatedAssociations.has(item.source));
  for (const unselectedItem of unselected) {
    const association = relatedAssociations.get(unselectedItem.source);
    decisions.push(association === undefined
      ? baseDecision(unselectedItem.source, false, "promotion_lane_limited", promotionDecisionMetadata(unselectedItem))
      : {
          ...baseDecision(unselectedItem.source, false, "represented_as_related_signal", promotionDecisionMetadata(unselectedItem)),
          candidateId: promotedCandidateId(association.selected.source, association.selectedIndex)
        });
  }

  selected.forEach((selectedItem, index) => {
    const { source } = selectedItem;
    const relatedSignals = relatedSignalsForSelected(index, relatedAssociations);
    const candidate = promotedCandidate(source, index, relatedSignals);
    const existing = promotedByPacket.get(source.packet.id) ?? [];
    existing.push(candidate);
    promotedByPacket.set(source.packet.id, existing);
    const relatedContextEvidenceCount = relatedContextEvidence(source).length;
    decisions.push({
      ...baseDecision(source, true, "promoted_for_verification", promotionDecisionMetadata(selectedItem)),
      candidateId: candidate.id,
      ...(relatedContextEvidenceCount > 0 ? { relatedContextEvidenceCount } : {})
    });
  });

  const packetResults = input.packetResults.map((result) => {
    const promoted = promotedByPacket.get(result.packetId);
    return promoted && promoted.length > 0
      ? { ...result, findings: [...result.findings, ...promoted] }
      : result;
  });
  const summary: UncertaintyPromotionSummary = {
    considered: sources.length,
    promoted: selected.length,
    laneLimited: laneLimited.length,
    representedRelatedSignals: relatedAssociations.size,
    unrepresentedLaneLimited: laneLimited.length,
    notPromoted,
    promotedCandidateIds: selected.map(({ source }, index) => promotedCandidateId(source, index)),
    decisions
  };

  await telemetry.writeArtifact("uncertainty-promotion.json", summary);
  telemetry.event({
    stage: 9,
    level: summary.promoted > 0 ? "info" : "debug",
    message: "uncertainty_promotion",
    data: {
      considered: summary.considered,
      promoted: summary.promoted,
      laneLimited: summary.laneLimited,
      representedRelatedSignals: summary.representedRelatedSignals,
      unrepresentedLaneLimited: summary.unrepresentedLaneLimited,
      maxPromotions,
      notPromoted: summary.notPromoted,
      promotedCandidateIds: summary.promotedCandidateIds
    }
  });

  return { packetResults, summary };
}

function promotionSources(result: PacketReviewResult, packetsById: Map<string, ReviewPacket>): PromotionSource[] {
  if (result.status !== "completed" && result.status !== "incomplete") {
    return [];
  }
  const packet = packetsById.get(result.packetId);
  if (!packet) {
    return [];
  }
  return [
    ...result.uncertainties.map((uncertainty): PromotionSource => ({
      packetResult: result,
      packet,
      sourceKind: "uncertainty",
      question: uncertainty.question,
      files: cleanStrings(uncertainty.files),
      symbols: cleanStrings(uncertainty.symbols),
      projectedSkillIds: [...uncertainty.projectedSkillIds],
      reason: "packet reviewer reported an unresolved uncertainty"
    })),
    ...result.followUpHints.map((hint): PromotionSource => ({
      packetResult: result,
      packet,
      sourceKind: "follow_up_hint",
      question: hint.question,
      files: cleanStrings(hint.files),
      symbols: cleanStrings(hint.symbols),
      projectedSkillIds: [...hint.projectedSkillIds],
      reason: hint.reason,
      confidence: hint.confidence
    }))
  ];
}

function promotionDecision(source: PromotionSource): { eligible: boolean; reason: string } {
  if (source.packetResult.findings.length > 0) {
    if (duplicateOfExistingFinding(source) || !pointsAtDistinctScope(source)) {
      return { eligible: false, reason: "covered_by_existing_candidate" };
    }
  }
  if (source.files.length === 0 && source.symbols.length === 0) {
    return { eligible: false, reason: "no_concrete_file_or_symbol" };
  }
  if (source.sourceKind === "follow_up_hint" && source.confidence === "low" && !isConcreteBehaviorDeltaSource(source)) {
    return { eligible: false, reason: "low_confidence_hint" };
  }
  if (!mentionsChangedScope(source)) {
    return { eligible: false, reason: "not_tied_to_changed_scope" };
  }
  const risk = riskProfile(source);
  const testScoped = isTestScopedSource(source);
  if (!risk.promotable) {
    return { eligible: false, reason: "weak_or_non_actionable_risk" };
  }
  if (isBroadFollowUpOnly(source, risk.category)) {
    return { eligible: false, reason: "broad_follow_up_only" };
  }
  if (!hasConcreteFailurePredicate(source, risk.category)) {
    return { eligible: false, reason: "no_concrete_failure_predicate" };
  }
  if (!hasChangedAnchorForPredicate(source)) {
    return { eligible: false, reason: "no_changed_anchor_for_predicate" };
  }
  if (!hasPromotionEvidence(source, risk.category)) {
    return { eligible: false, reason: "insufficient_promotion_evidence" };
  }
  if (risk.category === "testing" && testScoped && !mentionsChangedTestOrDeletedCoverage(source)) {
    return { eligible: false, reason: "test_risk_without_changed_test_or_deleted_coverage" };
  }
  if (risk.category === "testing" && testScoped && !mentionsNamedProductionScope(source)) {
    return { eligible: false, reason: "insufficient_promotion_evidence" };
  }
  if (!mentionsProductionImpact(source) && risk.category !== "testing") {
    return { eligible: false, reason: "no_production_impact" };
  }
  return { eligible: true, reason: "eligible" };
}

function selectPromotionSources(eligible: RankedPromotionSource[], maxPromotions: number): SelectedPromotionSource[] {
  if (maxPromotions <= 0 || eligible.length === 0) {
    return [];
  }
  const selected: SelectedPromotionSource[] = eligible.slice(0, maxPromotions)
    .map((item) => ({ ...item, selectedBy: "rank" }));
  const behaviorDelta = bestLocalBehaviorDelta(eligible);
  if (behaviorDelta === undefined || selected.some((item) => item.source === behaviorDelta.source)) {
    return selected;
  }
  if (selected.length < maxPromotions) {
    return [...selected, { ...behaviorDelta, selectedBy: "local_behavior_delta_reserve" }];
  }
  const replacementIndex = replacementIndexForLocalBehaviorDelta(selected, behaviorDelta);
  if (replacementIndex === -1) {
    return selected;
  }
  const updated = [...selected];
  updated[replacementIndex] = { ...behaviorDelta, selectedBy: "local_behavior_delta_reserve" };
  return updated;
}

function pointsAtDistinctScope(source: PromotionSource): boolean {
  const packetPaths = new Set([source.packet.path, ...(source.packet.oldPath !== undefined ? [source.packet.oldPath] : [])]);
  if (source.files.some((file) => !packetPaths.has(file))) {
    return true;
  }
  if (source.symbols.length === 0) {
    return false;
  }
  return source.symbols.some((symbol) => !source.packet.symbolFacts.some((fact) =>
    symbolMatchesFact(symbol, fact.enclosingSymbol) || symbolMatchesFact(symbol, fact.signature)
  ));
}

function promotedCandidate(
  source: PromotionSource,
  index: number,
  relatedSignals: RelatedPromotionSignal[]
): CandidateFinding {
  const risk = riskProfile(source);
  const confidence = promotedConfidence(source, risk.category);
  const relatedCode = relatedEvidence(source);
  // Plan 81: no fabricated anchors. A promoted candidate never claims a
  // placement it did not establish — plan 76's gate-only representative
  // anchor proves on-diff-ness at verification, and only a verifier-revised
  // anchor may publish inline.
  return {
    id: promotedCandidateId(source, index),
    title: promotedTitle(source, risk.category),
    severity: promotedSeverity(risk.category),
    confidence,
    path: source.packet.path,
    modelAnchorSubmitted: false,
    changedLine: false,
    category: risk.category,
    evidence: {
      changedCode: truncate(referencedChangedCode(source), MAX_EVIDENCE_CHARS),
      ...(relatedCode.length > 0 ? { relatedCode } : {})
    },
    failureMode: promotedFailureMode(source, risk.category),
    whyThisMatters: promotedImpact(source, risk.category),
    suggestedTest: risk.category === "testing"
      ? "Verify the affected behavior through a production-path test or restore equivalent deleted coverage."
      : "Add or update a regression test that exercises the referenced changed path.",
    verification: `Promoted from ${source.sourceKind}; normal verifier must confirm the concrete failure mode before publication.`,
    producedBy: {
      kind: "packet",
      stage: 9,
      packetId: source.packet.id,
      lensId: source.packet.lenses[0] ?? "core/code-review",
      skillIds: [...source.projectedSkillIds]
    },
    provenance: {
      source: "uncertainty_promotion",
      sourceKind: source.sourceKind,
      sourcePacketId: source.packet.id,
      question: source.question.trim(),
      files: source.files,
      symbols: source.symbols,
      reason: source.reason.trim() || "promoted unresolved predicate for verification",
      ...(relatedSignals.length > 0
        ? {
            relatedSignals,
            crossPacketRelatedCount: new Set(relatedSignals
              .filter((signal) => signal.packetId !== source.packet.id)
              .map((signal) => signal.packetId)).size
          }
        : {})
    }
  };
}

function associateRelatedPromotionSignals(
  unselected: RankedPromotionSource[],
  selected: SelectedPromotionSource[]
): Map<PromotionSource, RelatedPromotionAssociation> {
  const proposed = unselected.flatMap((source): RelatedPromotionAssociation[] => {
    const matches = selected.flatMap((selectedItem, selectedIndex): RelatedPromotionAssociation[] => {
      const match = relatedPromotionAssociation(source, selectedItem, selectedIndex);
      return match === undefined ? [] : [match];
    }).sort(compareRelatedPromotionAssociations);
    return matches[0] === undefined ? [] : [matches[0]];
  });
  const accepted = new Map<PromotionSource, RelatedPromotionAssociation>();
  for (let selectedIndex = 0; selectedIndex < selected.length; selectedIndex += 1) {
    const forSelected = proposed
      .filter((association) => association.selectedIndex === selectedIndex)
      .sort(compareRelatedPromotionSignals)
      .slice(0, MAX_RELATED_PROMOTION_SIGNALS);
    for (const association of forSelected) {
      accepted.set(association.source.source, association);
    }
  }
  return accepted;
}

function relatedPromotionAssociation(
  source: RankedPromotionSource,
  selected: SelectedPromotionSource,
  selectedIndex: number
): RelatedPromotionAssociation | undefined {
  if (riskProfile(source.source).category !== riskProfile(selected.source).category ||
      source.promotionClass !== selected.promotionClass ||
      !normalizedValuesOverlap(source.source.files, selected.source.files) ||
      !normalizedValuesOverlap(source.source.symbols, selected.source.symbols)) {
    return undefined;
  }
  const sourceQuestion = normalizeFollowUpQuestion(source.source.question);
  const selectedQuestion = normalizeFollowUpQuestion(selected.source.question);
  const exactQuestion = sourceQuestion === selectedQuestion;
  const sourceTerms = normalizedAttentionTerms(sourceQuestion);
  const selectedTerms = normalizedAttentionTerms(selectedQuestion);
  const sharedTerms = setIntersectionCount(sourceTerms, selectedTerms);
  const similarity = tokenJaccard(sourceTerms, selectedTerms);
  if (!exactQuestion && sharedTerms < 3 && similarity < 0.24) {
    return undefined;
  }
  return { source, selected, selectedIndex, exactQuestion, sharedTerms, similarity };
}

function compareRelatedPromotionAssociations(a: RelatedPromotionAssociation, b: RelatedPromotionAssociation): number {
  return Number(b.exactQuestion) - Number(a.exactQuestion) ||
    b.sharedTerms - a.sharedTerms ||
    b.similarity - a.similarity ||
    b.selected.rank - a.selected.rank ||
    a.selected.source.question.localeCompare(b.selected.source.question) ||
    a.selected.source.packet.id.localeCompare(b.selected.source.packet.id) ||
    a.selectedIndex - b.selectedIndex;
}

function compareRelatedPromotionSignals(a: RelatedPromotionAssociation, b: RelatedPromotionAssociation): number {
  return Number(b.exactQuestion) - Number(a.exactQuestion) ||
    b.sharedTerms - a.sharedTerms ||
    b.similarity - a.similarity ||
    a.source.source.question.localeCompare(b.source.source.question) ||
    a.source.source.packet.id.localeCompare(b.source.source.packet.id) ||
    a.source.source.sourceKind.localeCompare(b.source.source.sourceKind);
}

function relatedSignalsForSelected(
  selectedIndex: number,
  associations: Map<PromotionSource, RelatedPromotionAssociation>
): RelatedPromotionSignal[] {
  return [...associations.values()]
    .filter((association) => association.selectedIndex === selectedIndex)
    .sort(compareRelatedPromotionSignals)
    .map(({ source: { source } }) => ({
      packetId: source.packet.id,
      sourceKind: source.sourceKind,
      question: source.question.trim(),
      files: source.files,
      symbols: source.symbols
    }));
}

function normalizedValuesOverlap(left: string[], right: string[]): boolean {
  const leftValues = new Set(left.map(normalize).filter(Boolean));
  return right.some((value) => leftValues.has(normalize(value)));
}

function setIntersectionCount(left: Set<string>, right: Set<string>): number {
  let count = 0;
  for (const value of left) {
    if (right.has(value)) {
      count += 1;
    }
  }
  return count;
}

function promotedCandidateId(source: PromotionSource, index: number): string {
  return `${source.packet.id.slice(0, 8)}-u${index + 1}-${sha256Hex([
    source.sourceKind,
    source.question,
    source.files.join(","),
    source.symbols.join(",")
  ].join("\n")).slice(0, 8)}`;
}

// Plan 81: no template titles. The title is the hint's own predicate text
// (bounded), so scorer/category/title matching — and human readers — see the
// model's actual claim instead of promotion boilerplate.
function promotedTitle(source: PromotionSource, _category: FindingCategory): string {
  return truncate(source.question.trim().replace(/\s+/gu, " "), 140);
}

function promotedFailureMode(source: PromotionSource, category: FindingCategory): string {
  const predicate = promotedPredicateText(source);
  if (category === "testing") {
    return `${predicate} — if the changed or deleted test coverage no longer exercises the production path, a regression in that path can ship undetected.`;
  }
  return `${predicate} — if this predicate holds, the changed path produces incorrect caller-visible behavior.`;
}

function promotedImpact(source: PromotionSource, category: FindingCategory): string {
  const scope = mainScopeLabel(source);
  if (category === "testing") {
    return `The affected scope (${scope}) may lose regression coverage for behavior changed by this PR.`;
  }
  if (category === "security") {
    return `The affected scope (${scope}) may weaken a security-relevant path if the verifier confirms the predicate.`;
  }
  return `The affected scope (${scope}) is tied to changed code, so a confirmed predicate would be a real correctness regression.`;
}

function promotedPredicateText(source: PromotionSource): string {
  const question = source.question.trim().replace(/\s+/gu, " ");
  const reason = source.reason.trim().replace(/\s+/gu, " ");
  if (reason.length === 0 || normalize(question).includes(normalize(reason)) || normalize(reason).includes(normalize(question))) {
    return question;
  }
  return `${question} Reason: ${reason}`;
}

function promotedSeverity(category: FindingCategory): Severity {
  return category === "security" ? "high" : "medium";
}

function promotedConfidence(source: PromotionSource, category: FindingCategory): Confidence {
  if (category === "testing") {
    return "medium";
  }
  if (source.sourceKind === "follow_up_hint" && source.confidence === "high") {
    return "medium";
  }
  return "low";
}

function relatedEvidence(source: PromotionSource): NonNullable<CandidateFinding["evidence"]["relatedCode"]> {
  const symbolLines = source.packet.symbolFacts
    .map((fact) => [fact.enclosingSymbol, fact.signature].filter(Boolean).join(" | "))
    .filter((line) => line.trim().length > 0)
    .slice(0, 8)
    .join("\n");
  const entries: NonNullable<CandidateFinding["evidence"]["relatedCode"]> = [];
  if (symbolLines.trim().length > 0) {
    entries.push({
      path: source.packet.path,
      lines: symbolLines,
      whyRelevant: "Changed symbols attached to the unresolved predicate."
    });
  }
  for (const file of source.files.filter((file) => file !== source.packet.path).slice(0, 4)) {
    entries.push({
      path: file,
      lines: `Referenced by ${source.sourceKind}: ${source.question.trim()}`,
      whyRelevant: "The reviewer pointed at this related file as part of the unresolved predicate."
    });
  }
  const seen = new Set(entries.map((entry) => `${normalize(entry.path)}\0${normalize(entry.lines)}`));
  for (const entry of relatedContextEvidence(source)) {
    const key = `${normalize(entry.path)}\0${normalize(entry.lines)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    entries.push(entry);
  }
  return entries;
}

// Carry bounded related changed context already attached to the source packet into the
// promoted candidate's evidence when the hint's files/symbols/predicate text reference it.
// Structural match only (no semantic keywords), and no new repository tool calls.
function relatedContextEvidence(source: PromotionSource): NonNullable<CandidateFinding["evidence"]["relatedCode"]> {
  const referencedFiles = new Set(source.files.map((file) => normalize(file)));
  const referencedSymbols = new Set(source.symbols.map((symbol) => normalize(symbol)).filter((symbol) => symbol.length > 0));
  const predicateText = normalize([source.question, source.reason].join(" "));
  const entries: NonNullable<CandidateFinding["evidence"]["relatedCode"]> = [];
  const seen = new Set<string>();
  for (const context of source.packet.relatedChangedContext) {
    if (!relatedContextMatches(context, referencedFiles, referencedSymbols, predicateText)) {
      continue;
    }
    const lines = relatedContextEvidenceLines(context);
    if (lines.length === 0) {
      continue;
    }
    const key = `${normalize(context.path)}\0${normalize(lines)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    entries.push({
      path: context.path,
      lines,
      whyRelevant: "Attached related changed context matched the unresolved predicate by referenced symbol/path."
    });
    if (entries.length >= MAX_RELATED_CONTEXT_EVIDENCE) {
      break;
    }
  }
  return entries;
}

function relatedContextMatches(
  context: ReviewPacket["relatedChangedContext"][number],
  referencedFiles: Set<string>,
  referencedSymbols: Set<string>,
  predicateText: string
): boolean {
  if (referencedFiles.has(normalize(context.path))) {
    return true;
  }
  if (context.symbol !== undefined) {
    const symbol = normalize(context.symbol);
    if (symbol.length > 0 && (referencedSymbols.has(symbol) || predicateMentionsSymbol(predicateText, symbol))) {
      return true;
    }
  }
  return false;
}

function predicateMentionsSymbol(predicateText: string, normalizedSymbol: string): boolean {
  const parts = normalizedSymbol
    .split(/[^a-z0-9_]+/u)
    .filter((part) => part.length >= 3);
  return parts.some((part) => normalizedTermIncludes(predicateText, part));
}

function normalizedTermIncludes(text: string, term: string): boolean {
  const escaped = escapeRegExp(term);
  return new RegExp(`(^|[^a-z0-9_])${escaped}($|[^a-z0-9_])`, "u").test(text);
}

function relatedContextEvidenceLines(context: ReviewPacket["relatedChangedContext"][number]): string {
  const body = context.sourceSnippet ?? context.patchExcerpt ?? context.reason;
  return truncate(body ?? "", MAX_RELATED_CONTEXT_EVIDENCE_CHARS);
}

// Plan 81: evidence is scoped to the hunk(s) the predicate references (via
// its symbols), not the whole packet dump. Falls back to the first hunk when
// no symbol maps — never to the full packet.
function referencedChangedCode(source: PromotionSource): string {
  const referencedHunkIds = new Set(
    source.packet.symbolFacts
      .filter((fact) => source.symbols.some((symbol) =>
        symbolMatchesFact(symbol, fact.enclosingSymbol) || symbolMatchesFact(symbol, fact.signature)
      ))
      .map((fact) => fact.hunkId)
  );
  const referenced = source.packet.hunks.filter((hunk) => referencedHunkIds.has(hunk.hunkId));
  const hunks = referenced.length > 0 ? referenced : source.packet.hunks.slice(0, 1);
  return hunks.map((hunk) => hunk.contentWithLineNumbers).join("\n\n");
}

function firstChangedAnchor(packet: ReviewPacket): CandidateFinding["anchor"] | undefined {
  for (const hunk of packet.hunks) {
    const rightLine = hunk.changedNewLineNumbers[0];
    if (rightLine !== undefined) {
      return { path: packet.path, line: rightLine, side: "RIGHT", hunkId: hunk.hunkId };
    }
    const leftLine = hunk.changedOldLineNumbers[0];
    if (leftLine !== undefined) {
      return { path: packet.oldPath ?? packet.path, line: leftLine, side: "LEFT", hunkId: hunk.hunkId };
    }
  }
  return undefined;
}

function rankPromotionSource(source: PromotionSource): RankedPromotionSource {
  const localityScore = behaviorDeltaLocalityScore(source);
  return {
    source,
    rank: promotionRank(source),
    promotionClass: promotionClassForSource(source, localityScore),
    localityScore
  };
}

function promotionDecisionMetadata(item: RankedPromotionSource | SelectedPromotionSource): Pick<
  PromotionDecision,
  "rank" | "promotionClass" | "localityScore" | "selectedBy"
> {
  return {
    rank: item.rank,
    promotionClass: item.promotionClass,
    localityScore: item.localityScore,
    ...("selectedBy" in item ? { selectedBy: item.selectedBy } : {})
  };
}

function promotionRank(source: PromotionSource): number {
  const risk = riskProfile(source);
  return (source.sourceKind === "follow_up_hint" ? 8 : 4) +
    (source.confidence === "high" ? 8 : source.confidence === "medium" ? 4 : 0) +
    (risk.category === "security" ? 12 : risk.category === "correctness" || risk.category === "logic_bug" ? 8 : 6) +
    (source.packet.reviewPriority === "critical" ? 8 : source.packet.reviewPriority === "high" ? 4 : 0) +
    (source.symbols.length > 0 ? 2 : 0) +
    (mentionsChangedTestOrDeletedCoverage(source) ? 2 : 0);
}

function bestLocalBehaviorDelta(eligible: RankedPromotionSource[]): RankedPromotionSource | undefined {
  return eligible
    .filter((item) => isConcreteBehaviorDeltaSource(item.source))
    .sort((a, b) =>
      b.localityScore - a.localityScore ||
      b.rank - a.rank ||
      a.source.question.localeCompare(b.source.question)
    )[0];
}

function replacementIndexForLocalBehaviorDelta(
  selected: SelectedPromotionSource[],
  behaviorDelta: RankedPromotionSource
): number {
  const replacementCandidates = selected
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => !isStrongerLocalBehaviorDelta(item, behaviorDelta))
    .sort((a, b) =>
      a.item.rank - b.item.rank ||
      a.item.localityScore - b.item.localityScore ||
      a.index - b.index
    );
  return replacementCandidates[0]?.index ?? -1;
}

function isStrongerLocalBehaviorDelta(
  selected: RankedPromotionSource,
  incoming: RankedPromotionSource
): boolean {
  return selected.promotionClass === "local_behavior_delta" &&
    (selected.localityScore > incoming.localityScore ||
      (selected.localityScore === incoming.localityScore && selected.rank >= incoming.rank));
}

function promotionClassForSource(source: PromotionSource, localityScore: number): PromotionClass {
  const risk = riskProfile(source);
  if (risk.category === "testing") {
    return "test_boundary";
  }
  if (isConcreteBehaviorDeltaSource(source)) {
    return isLocalBehaviorDeltaSource(source, localityScore) ? "local_behavior_delta" : "broad_behavior_delta";
  }
  if (risk.category === "security") {
    return "security_boundary";
  }
  return "other";
}

function behaviorDeltaLocalityScore(source: PromotionSource): number {
  const text = normalizedSourceText(source);
  let score = 0;

  if (sourceReferencesPacketPath(source)) {
    score += 8;
  } else if (source.files.some((file) => sameRoot(file, source.packet.path))) {
    score += 2;
  }
  if (sourceNamesChangedSymbol(source)) {
    score += 8;
  }
  if (changedHunkMentionsSourceSymbol(source)) {
    score += 4;
  }
  if (changedHunkMentionsPredicate(source)) {
    score += 3;
  }
  if (/\b(helper|guard|fallback|conversion|convert|validation|validate|boundary|contract|coercion|truncat(?:e|ion)|round(?:ing)?|precision|coverage|test)\b/u.test(text)) {
    score += 3;
  }
  if (/\b(old|previously|before|used to|now|new|removed|deleted|replaced|no longer|instead|after)\b/u.test(text)) {
    score += 4;
  }
  if (source.packet.intentSignals?.refactorLike === true || source.packet.intentSignals?.explicitlyBehaviorPreserving === true) {
    score += 2;
  }

  const packetPaths = new Set([source.packet.path, ...(source.packet.oldPath !== undefined ? [source.packet.oldPath] : [])]);
  const unrelatedFiles = source.files.filter((file) => !packetPaths.has(file) && !sameRoot(file, source.packet.path));
  score -= Math.min(6, Math.max(0, source.files.length - 2) * 2);
  score -= Math.min(6, unrelatedFiles.length * 2);
  if (/\b(across all|every route|all call sites|system-wide|system wide|cross-system|cross system)\b/u.test(text)) {
    score -= 8;
  }
  if (!sourceNamesChangedSymbol(source) && !changedHunkMentionsSourceSymbol(source)) {
    score -= 4;
  }

  return score;
}

function riskProfile(source: PromotionSource): { promotable: boolean; category: FindingCategory } {
  const text = normalizedSourceText(source);
  if (/\b(auth|authorization|authentication|permission|tenant|signature|token|secret|security|access control)\b/u.test(text)) {
    return { promotable: true, category: "security" };
  }
  const testScoped = isTestScopedSource(source);
  const testRisk = /\b(tests?|coverage|fixture|assert|expect|deleted test|missing test)\b/u.test(text);
  const correctnessRisk = /\b(bug|incorrect|wrong|break|broken|fail|failure|regression|behavior|semantic|contract|caller|invariant|fallback|default|zero|nil|null|panic|overflow|round|rounding|precision|truncat(?:e|es|ed|ion|ing)?|lossy|coercion|under-?report|under-?deliver|race|leak|retry|timeout|context|close|cleanup)\b/u.test(text);
  if (correctnessRisk) {
    return { promotable: true, category: text.includes("logic") ? "logic_bug" : "correctness" };
  }
  if (testScoped && testRisk) {
    return { promotable: true, category: "testing" };
  }
  if (testRisk) {
    return { promotable: true, category: "testing" };
  }
  return { promotable: false, category: "maintainability" };
}

function isBroadFollowUpOnly(source: PromotionSource, category: FindingCategory): boolean {
  const text = normalizedSourceText(source);
  if (category === "testing") {
    return /\b(needs?\s+tests?|add\s+tests?|test\s+coverage)\b/u.test(text) &&
      source.symbols.length === 0 &&
      !source.files.some((file) => !isPromotionTestPath(file));
  }
  const predicateText = text.replace(/\bwithout (?:a )?concrete failure mode\b/gu, "");
  const hasSpecificPredicate = /\b(if|whether|when|without|breaks?|regression|contract|auth|permission|zero|nil|null|panic|overflow|precision|fallback|default|timeout|leak|race|incorrect|wrong|lost|removed|missing|no longer)\b/u.test(predicateText);
  return /\b(check|verify|confirm|investigate|review)\b.*\b(safe|okay|ok|fine|acceptable|looks good|needs review)\b/u.test(text) &&
    !hasSpecificPredicate;
}

// Plan 92 layer 3 (T1): does a follow-up hint / uncertainty carry a concrete
// failure predicate tied to this packet's changed scope? Reuses the promotion
// lane's admission checks — the same concreteness bar that separates the
// run-50 near-miss hint from "verify X is fine" chaff.
export function isAdaptiveNearMissSignal(
  packet: ReviewPacket,
  signal: { question: string; files: string[]; symbols: string[]; reason: string }
): boolean {
  const source = {
    packet,
    sourceKind: "follow_up_hint",
    question: signal.question,
    files: signal.files,
    symbols: signal.symbols,
    reason: signal.reason
  } as PromotionSource;
  const risk = riskProfile(source);
  if (risk.promotable === false) {
    return false;
  }
  // Strict scope: the signal must reference the packet's own path or name a
  // changed symbol — mentionsChangedScope's sameRoot leniency triggered 19
  // adaptive passes in run 0c4d5213/52 (mostly producing nothing).
  if (sourceReferencesPacketPath(source) === false && sourceNamesChangedSymbol(source) === false) {
    return false;
  }
  if (isBroadFollowUpOnly(source, risk.category)) {
    return false;
  }
  return hasConcreteFailurePredicate(source, risk.category);
}

function hasConcreteFailurePredicate(source: PromotionSource, category: FindingCategory): boolean {
  const text = normalizedSourceText(source);
  if (category === "testing") {
    return /\b(deleted|removed|missing|lost|coverage|regression|production path|behavior|symbol|caller|contract)\b/u.test(text) &&
      mentionsNamedProductionScope(source);
  }
  return /\b(if|whether|when|without|allows?|fails?|breaks?|regression|contract|invariant|auth|permission|zero|nil|null|panic|overflow|precision|round(?:ing)?|truncat(?:e|es|ed|ion|ing)?|lossy|coercion|under-?report|under-?deliver|fallback|default|timeout|leak|race|incorrect|wrong|lost|removed|missing|no longer)\b/u.test(text);
}

function hasChangedAnchorForPredicate(source: PromotionSource): boolean {
  return firstChangedAnchor(source.packet) !== undefined && mentionsChangedScope(source);
}

function hasPromotionEvidence(source: PromotionSource, category: FindingCategory): boolean {
  if (source.files.includes(source.packet.path) || (source.packet.oldPath !== undefined && source.files.includes(source.packet.oldPath))) {
    return true;
  }
  if (source.symbols.some((symbol) => source.packet.symbolFacts.some((fact) =>
    symbolMatchesFact(symbol, fact.enclosingSymbol) || symbolMatchesFact(symbol, fact.signature)
  ))) {
    return true;
  }
  if (category === "testing" && mentionsNamedProductionScope(source) && mentionsChangedTestOrDeletedCoverage(source)) {
    return true;
  }
  return changedHunkMentionsPredicate(source);
}

function changedHunkMentionsPredicate(source: PromotionSource): boolean {
  const predicateTerms = predicateKeywords(normalizedSourceText(source));
  if (predicateTerms.size === 0) {
    return false;
  }
  const changedText = normalize(source.packet.hunks.flatMap((hunk) =>
    hunk.lines
      .filter((line) => line.kind === "add" || line.kind === "delete")
      .map((line) => line.content)
  ).join(" "));
  let matches = 0;
  for (const term of predicateTerms) {
    if (changedText.includes(term)) {
      matches += 1;
    }
  }
  return matches >= Math.min(2, predicateTerms.size);
}

function predicateKeywords(text: string): Set<string> {
  const stop = new Set([
    "check", "verify", "confirm", "whether", "should", "still", "this", "that", "with", "from", "through", "changed",
    "behavior", "contract", "caller", "production", "path", "risk", "issue", "bug", "fail", "failure"
  ]);
  return new Set(text.split(/\s+/u)
    .map((word) => word.replace(/[^a-z0-9_./:-]/gu, ""))
    .filter((word) => word.length >= 4 && !stop.has(word))
    .slice(0, 12));
}

function mentionsChangedScope(source: PromotionSource): boolean {
  if (source.files.includes(source.packet.path) || (source.packet.oldPath !== undefined && source.files.includes(source.packet.oldPath))) {
    return true;
  }
  if (source.symbols.length > 0 && source.packet.symbolFacts.some((fact) =>
    source.symbols.some((symbol) => symbolMatchesFact(symbol, fact.enclosingSymbol) || symbolMatchesFact(symbol, fact.signature))
  )) {
    return true;
  }
  return source.files.some((file) => sameRoot(file, source.packet.path));
}

function sourceReferencesPacketPath(source: PromotionSource): boolean {
  return source.files.includes(source.packet.path) || (source.packet.oldPath !== undefined && source.files.includes(source.packet.oldPath));
}

function sourceNamesChangedSymbol(source: PromotionSource): boolean {
  return source.symbols.some((symbol) => source.packet.symbolFacts.some((fact) =>
    symbolMatchesFact(symbol, fact.enclosingSymbol) || symbolMatchesFact(symbol, fact.signature)
  ));
}

function changedHunkMentionsSourceSymbol(source: PromotionSource): boolean {
  if (source.symbols.length === 0) {
    return false;
  }
  const changedText = normalize(source.packet.hunks.flatMap((hunk) =>
    hunk.lines
      .filter((line) => line.kind === "add" || line.kind === "delete")
      .map((line) => line.content)
  ).join(" "));
  return source.symbols.some((symbol) => {
    const normalizedSymbol = normalize(symbol);
    return normalizedSymbol.length > 0 && changedText.includes(normalizedSymbol);
  });
}

function isLocalBehaviorDeltaSource(source: PromotionSource, localityScore: number): boolean {
  return localityScore > 0 &&
    (sourceReferencesPacketPath(source) || sourceNamesChangedSymbol(source) || changedHunkMentionsSourceSymbol(source));
}

function mentionsChangedTestOrDeletedCoverage(source: PromotionSource): boolean {
  return isPromotionTestPath(source.packet.path) ||
    source.packet.fileStatus === "deleted" ||
    source.packet.isDeletedContent ||
    source.files.some(isPromotionTestPath) ||
    /\b(deleted|removed|drop|missing|coverage)\b/u.test(normalizedSourceText(source));
}

function mentionsNamedProductionScope(source: PromotionSource): boolean {
  return source.symbols.length > 0 ||
    source.files.some((file) => !isPromotionTestPath(file)) ||
    /\b(production|prod|handler|service|worker|client|api|caller|symbol|function|method|behavior)\b/u.test(normalizedSourceText(source));
}

function mentionsProductionImpact(source: PromotionSource): boolean {
  return !isPromotionTestPath(source.packet.path) || source.files.some((file) => !isPromotionTestPath(file));
}

function isConcreteBehaviorDeltaSource(source: PromotionSource): boolean {
  if (!hasChangedAnchorForPredicate(source)) {
    return false;
  }
  if (source.files.length === 0 && source.symbols.length === 0) {
    return false;
  }
  const risk = riskProfile(source);
  if (!risk.promotable || !hasConcreteFailurePredicate(source, risk.category)) {
    return false;
  }
  const text = normalizedSourceText(source);
  const refactorLike = source.packet.intentSignals?.refactorLike === true ||
    source.packet.intentSignals?.explicitlyBehaviorPreserving === true ||
    /\b(refactor|behavior-preserving|preserve(?:s|d)? behavior|same behavior|equivalent|no behavior change|cleanup|consolidat(?:e|ion))\b/u.test(text);
  const changedBoundary = /\b(validation|validate|guard|predicate|fallback|default|contract|boundary|conversion|convert|coercion|truncat(?:e|ion)|round(?:ing)?|precision|overflow|coverage|test|helper)\b/u.test(text);
  const oldNewPredicate = /\b(previously|before|old|used to|now|new|no longer|removed|deleted|replaced|changed|instead|after)\b/u.test(text);
  const impact = risk.category === "testing" ? mentionsChangedTestOrDeletedCoverage(source) : mentionsProductionImpact(source);
  return impact && changedBoundary && (refactorLike || oldNewPredicate);
}

function isTestScopedSource(source: PromotionSource): boolean {
  return isPromotionTestPath(source.packet.path) ||
    source.files.some(isPromotionTestPath) ||
    source.packet.lenses.some((lens) => /(^|[/_-])tests?($|[/_-])/iu.test(lens));
}

function duplicateOfExistingFinding(source: PromotionSource): boolean {
  const question = normalize(source.question);
  return source.packetResult.findings.some((finding) => {
    const text = normalize([finding.title, finding.failureMode, finding.whyThisMatters].join(" "));
    return text.length > 0 && (text.includes(question) || question.includes(text.slice(0, 80)));
  });
}

function baseDecision(
  source: PromotionSource,
  promoted: boolean,
  reason: string,
  metadata?: Pick<PromotionDecision, "rank" | "promotionClass" | "localityScore" | "selectedBy">
): PromotionDecision {
  const decision: PromotionDecision = {
    packetId: source.packet.id,
    sourceKind: source.sourceKind,
    question: source.question.trim(),
    files: source.files,
    symbols: source.symbols,
    promoted,
    reason
  };
  return metadata === undefined ? decision : { ...decision, ...metadata };
}

function promotionLimit(packetResultCount: number, budgetBoost: number): number {
  const base = Math.min(MAX_PROMOTIONS, Math.max(MIN_PROMOTIONS_WHEN_AVAILABLE, Math.ceil(packetResultCount * 0.03)));
  return scaleBudgetValue(base, budgetBoost);
}

function mainScopeLabel(source: PromotionSource): string {
  return source.symbols[0] ?? source.files[0] ?? source.packet.path;
}

function symbolMatchesFact(symbol: string, factValue: string | undefined): boolean {
  if (!factValue) {
    return false;
  }
  const normalizedSymbol = normalize(symbol);
  const normalizedFact = normalize(factValue);
  return normalizedFact === normalizedSymbol || normalizedFact.includes(normalizedSymbol);
}

function sameRoot(left: string, right: string): boolean {
  const leftParts = left.split("/").filter(Boolean);
  const rightParts = right.split("/").filter(Boolean);
  if (leftParts.length === 0 || rightParts.length === 0) {
    return false;
  }
  return leftParts[0] === rightParts[0] && (leftParts[1] === undefined || rightParts[1] === undefined || leftParts[1] === rightParts[1]);
}

function normalizedSourceText(source: PromotionSource): string {
  return normalize([
    source.question,
    source.reason,
    source.files.join(" "),
    source.symbols.join(" ")
  ].join(" "));
}

function normalize(input: string): string {
  return input.toLowerCase().replace(/[`"'’]/gu, "").replace(/[^a-z0-9_./:-]+/gu, " ").replace(/\s+/gu, " ").trim();
}

function cleanStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))].sort();
}

function truncate(input: string, maxChars: number): string {
  const trimmed = input.trim();
  return trimmed.length <= maxChars ? trimmed : `${trimmed.slice(0, maxChars - 3)}...`;
}
