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

const MAX_PROMOTIONS = 4;
const MIN_PROMOTIONS_WHEN_AVAILABLE = 2;
const MAX_EVIDENCE_CHARS = 2400;

type PromotionInput = {
  packetResults: PacketReviewResult[];
  packets: ReviewPacket[];
  budgetMultiplier?: number;
};

export type UncertaintyPromotionSummary = {
  considered: number;
  promoted: number;
  laneLimited: number;
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
};

type PromotionSource = {
  packetResult: PacketReviewResult;
  packet: ReviewPacket;
  sourceKind: PromotionSourceKind;
  question: string;
  questionId?: string;
  files: string[];
  symbols: string[];
  reason: string;
  confidence?: Confidence;
  materialConcern?: NonNullable<NonNullable<PacketReviewResult["answeredQuestions"]>[number]["materialConcern"]>;
};

type PromotionSourceKind = "uncertainty" | "follow_up_hint" | "unresolved_question" | "material_concern";
type PromotionClass = "local_behavior_delta" | "broad_behavior_delta" | "test_boundary" | "security_boundary" | "other";
type PromotionSelectionReason = "rank" | "local_behavior_delta_reserve";
type RankedPromotionSource = {
  source: PromotionSource;
  rank: number;
  promotionClass: PromotionClass;
  localityScore: number;
};
type SelectedPromotionSource = RankedPromotionSource & { selectedBy: PromotionSelectionReason };

export async function promoteUncertaintiesForVerification(
  input: PromotionInput,
  telemetry: TelemetryRecorder
): Promise<{ packetResults: PacketReviewResult[]; summary: UncertaintyPromotionSummary }> {
  const packetsById = new Map(input.packets.map((packet) => [packet.id, packet]));
  const sources = input.packetResults.flatMap((result) => promotionSources(result, packetsById));
  const maxPromotions = promotionLimit(input.packetResults.length, input.budgetMultiplier ?? 1);
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
  const laneLimited = eligible.filter((item) => !selectedSet.has(item.source));
  for (const limited of laneLimited) {
    decisions.push(baseDecision(limited.source, false, "promotion_lane_limited", promotionDecisionMetadata(limited)));
  }

  selected.forEach((selectedItem, index) => {
    const { source } = selectedItem;
    const candidate = promotedCandidate(source, index);
    const existing = promotedByPacket.get(source.packet.id) ?? [];
    existing.push(candidate);
    promotedByPacket.set(source.packet.id, existing);
    decisions.push({
      ...baseDecision(source, true, "promoted_for_verification", promotionDecisionMetadata(selectedItem)),
      candidateId: candidate.id
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
  const unresolvedSymbols = packet.symbolFacts
    .map((fact) => fact.enclosingSymbol ?? fact.signature)
    .filter((symbol): symbol is string => symbol !== undefined && symbol.trim().length > 0);
  const questionsById = new Map((packet.reviewQuestions ?? []).map((question) => [question.id, question]));
  const coveredQuestionIds = new Set(result.findings.flatMap((finding) => finding.reviewQuestionIds ?? []));
  return [
    ...(result.answeredQuestions ?? [])
      .filter((answer) =>
        answer.outcome === "partial" &&
        answer.materialConcern !== undefined &&
        !coveredQuestionIds.has(answer.questionId)
      )
      .map((answer): PromotionSource => {
        const concern = answer.materialConcern as NonNullable<typeof answer.materialConcern>;
        const question = questionsById.get(answer.questionId);
        return {
          packetResult: result,
          packet,
          sourceKind: "material_concern",
          question: concern.title,
          questionId: answer.questionId,
          files: cleanStrings([
            concern.changedPath,
            ...answer.evidence.map((entry) => entry.path),
            ...(question?.files ?? [])
          ]),
          symbols: cleanStrings(question?.symbols ?? []),
          reason: [
            `Partial answer to review question ${answer.questionId}: ${answer.answer}`,
            `Failure mode: ${concern.failureMode}`,
            `Evidence: ${concern.evidence}`,
            `Verifier predicate: ${concern.suggestedVerification}`,
            ...(answer.evidenceTrace !== undefined ? [`Trace: ${answer.evidenceTrace}`] : [])
          ].join("\n"),
          confidence: answer.confidence,
          materialConcern: concern
        };
      }),
    ...result.uncertainties.map((uncertainty): PromotionSource => ({
      packetResult: result,
      packet,
      sourceKind: "uncertainty",
      question: uncertainty.question,
      files: cleanStrings(uncertainty.files),
      symbols: cleanStrings(uncertainty.symbols),
      reason: "packet reviewer reported an unresolved uncertainty"
    })),
    ...result.followUpHints.map((hint): PromotionSource => ({
      packetResult: result,
      packet,
      sourceKind: "follow_up_hint",
      question: hint.question,
      files: cleanStrings(hint.files),
      symbols: cleanStrings(hint.symbols),
      reason: hint.reason,
      confidence: hint.confidence
    })),
    ...(result.unresolvedQuestions ?? []).map((question): PromotionSource => ({
      packetResult: result,
      packet,
      sourceKind: "unresolved_question",
      question,
      files: cleanStrings([packet.path, ...(packet.oldPath !== undefined ? [packet.oldPath] : [])]),
      symbols: cleanStrings(unresolvedSymbols),
      reason: "packet reviewer reported an unresolved closeout question"
    }))
  ];
}

function promotionDecision(source: PromotionSource): { eligible: boolean; reason: string } {
  if (source.packetResult.findings.length > 0) {
    if (duplicateOfExistingFinding(source) || (source.sourceKind !== "material_concern" && !pointsAtDistinctScope(source))) {
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
  if (source.sourceKind === "material_concern") {
    if (!hasChangedAnchorForPredicate(source)) {
      return { eligible: false, reason: "no_changed_anchor_for_predicate" };
    }
    return { eligible: true, reason: "eligible" };
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

function promotedCandidate(source: PromotionSource, index: number): CandidateFinding {
  const risk = riskProfile(source);
  const anchor = source.materialConcern !== undefined
    ? materialConcernAnchor(source.packet, source.materialConcern)
    : firstChangedAnchor(source.packet);
  const confidence = promotedConfidence(source, risk.category);
  const changedCode = source.packet.hunks.map((hunk) => hunk.contentWithLineNumbers).join("\n\n");
  const relatedCode = relatedEvidence(source);
  return {
    id: promotedCandidateId(source, index),
    title: source.materialConcern?.title ?? promotedTitle(source, risk.category),
    severity: promotedSeverity(risk.category),
    confidence,
    path: anchor?.path ?? source.packet.path,
    ...(anchor !== undefined ? { anchor } : {}),
    changedLine: anchor !== undefined,
    category: risk.category,
    evidence: {
      changedCode: truncate(changedCode, MAX_EVIDENCE_CHARS),
      ...(relatedCode.length > 0 ? { relatedCode } : {})
    },
    failureMode: source.materialConcern?.failureMode ?? promotedFailureMode(source, risk.category),
    whyThisMatters: source.materialConcern !== undefined
      ? materialConcernImpact(source, risk.category)
      : promotedImpact(source, risk.category),
    suggestedTest: risk.category === "testing"
      ? "Verify the affected behavior through a production-path test or restore equivalent deleted coverage."
      : "Add or update a regression test that exercises the referenced changed path.",
    verification: source.materialConcern?.suggestedVerification ??
      `Promoted from ${source.sourceKind}; normal verifier must confirm the concrete failure mode before publication.`,
    ...(source.questionId !== undefined ? { reviewQuestionIds: [source.questionId] } : {}),
    producedBy: {
      kind: "packet",
      stage: 9,
      packetId: source.packet.id,
      lensId: source.packet.lenses[0] ?? "core/code-review",
      skillIds: []
    },
    provenance: {
      source: "uncertainty_promotion",
      sourceKind: source.sourceKind,
      sourcePacketId: source.packet.id,
      question: source.question.trim(),
      files: source.files,
      symbols: source.symbols,
      reason: source.reason.trim() || "promoted unresolved review question for verification"
    }
  };
}

function promotedCandidateId(source: PromotionSource, index: number): string {
  return `${source.packet.id.slice(0, 8)}-u${index + 1}-${sha256Hex([
    source.sourceKind,
    source.questionId ?? "",
    source.question,
    source.files.join(","),
    source.symbols.join(",")
  ].join("\n")).slice(0, 8)}`;
}

function promotedTitle(source: PromotionSource, category: FindingCategory): string {
  if (category === "testing") {
    return "Verify changed coverage still exercises the production path";
  }
  if (category === "security") {
    return "Verify the changed path preserves the security boundary";
  }
  return `Verify ${mainScopeLabel(source)} behavior after this change`;
}

function promotedFailureMode(source: PromotionSource, category: FindingCategory): string {
  const question = source.question.trim().replace(/\s+/gu, " ");
  if (category === "testing") {
    return `The review raised a concrete coverage question: ${question}. If the changed or deleted test coverage no longer exercises the production path, a regression in that path can ship undetected.`;
  }
  return `The review raised a concrete unresolved behavior question: ${question}. If this predicate is true, the changed path can produce incorrect caller-visible behavior.`;
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

function materialConcernImpact(source: PromotionSource, category: FindingCategory): string {
  const scope = mainScopeLabel(source);
  if (category === "testing") {
    return `The reviewer identified a concrete unresolved coverage boundary for ${scope}; if verified, the changed tests no longer protect a live production path.`;
  }
  if (category === "security") {
    return `The reviewer identified a concrete unresolved security boundary for ${scope}; if verified, the changed path can weaken a protected operation.`;
  }
  return `The reviewer identified a concrete unresolved behavior boundary for ${scope}; if verified, the changed path can produce incorrect caller-visible behavior.`;
}

function promotedSeverity(category: FindingCategory): Severity {
  return category === "security" ? "high" : "medium";
}

function promotedConfidence(source: PromotionSource, category: FindingCategory): Confidence {
  if (source.sourceKind === "material_concern") {
    return source.confidence === "low" ? "low" : "medium";
  }
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
  if (source.materialConcern !== undefined) {
    entries.push({
      path: source.materialConcern.changedPath,
      lines: truncate(source.materialConcern.evidence, MAX_EVIDENCE_CHARS),
      whyRelevant: "Material concern evidence captured from the packet review answer."
    });
  }
  if (symbolLines.trim().length > 0) {
    entries.push({
      path: source.packet.path,
      lines: symbolLines,
      whyRelevant: "Changed symbols attached to the unresolved review question."
    });
  }
  for (const file of source.files.filter((file) => file !== source.packet.path).slice(0, 4)) {
    entries.push({
      path: file,
      lines: `Referenced by ${source.sourceKind}: ${source.question.trim()}`,
      whyRelevant: "The reviewer pointed at this related file as part of the unresolved predicate."
    });
  }
  return entries;
}

function materialConcernAnchor(
  packet: ReviewPacket,
  concern: NonNullable<PromotionSource["materialConcern"]>
): CandidateFinding["anchor"] | undefined {
  const changedPath = concern.changedPath.trim();
  if (concern.anchorLine !== undefined) {
    for (const hunk of packet.hunks) {
      if (changedPath === packet.path && hunk.changedNewLineNumbers.includes(concern.anchorLine)) {
        return { path: packet.path, line: concern.anchorLine, side: "RIGHT", hunkId: hunk.hunkId };
      }
      if ((changedPath === (packet.oldPath ?? packet.path)) && hunk.changedOldLineNumbers.includes(concern.anchorLine)) {
        return { path: packet.oldPath ?? packet.path, line: concern.anchorLine, side: "LEFT", hunkId: hunk.hunkId };
      }
    }
  }
  return changedPath === packet.path || changedPath === (packet.oldPath ?? packet.path)
    ? firstChangedAnchor(packet)
    : undefined;
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
  return (source.sourceKind === "material_concern" ? 14 : source.sourceKind === "follow_up_hint" ? 8 : source.sourceKind === "unresolved_question" ? 3 : 4) +
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
  const correctnessRisk = /\b(bug|incorrect|wrong|break|broken|fail|failure|regression|behavior|semantic|contract|caller|invariant|fallback|default|zero|nil|null|panic|overflow|round|precision|race|leak|retry|timeout|context|close|cleanup)\b/u.test(text);
  if (testScoped && testRisk) {
    return { promotable: true, category: "testing" };
  }
  if (correctnessRisk) {
    return { promotable: true, category: text.includes("logic") ? "logic_bug" : "correctness" };
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
      !source.files.some((file) => !isTestPath(file));
  }
  const predicateText = text.replace(/\bwithout (?:a )?concrete failure mode\b/gu, "");
  const hasSpecificPredicate = /\b(if|whether|when|without|breaks?|regression|contract|auth|permission|zero|nil|null|panic|overflow|precision|fallback|default|timeout|leak|race|incorrect|wrong|lost|removed|missing|no longer)\b/u.test(predicateText);
  return /\b(check|verify|confirm|investigate|review)\b.*\b(safe|okay|ok|fine|acceptable|looks good|needs review)\b/u.test(text) &&
    !hasSpecificPredicate;
}

function hasConcreteFailurePredicate(source: PromotionSource, category: FindingCategory): boolean {
  const text = normalizedSourceText(source);
  if (category === "testing") {
    return /\b(deleted|removed|missing|lost|coverage|regression|production path|behavior|symbol|caller|contract)\b/u.test(text) &&
      mentionsNamedProductionScope(source);
  }
  return /\b(if|whether|when|without|allows?|fails?|breaks?|regression|contract|invariant|auth|permission|zero|nil|null|panic|overflow|precision|fallback|default|timeout|leak|race|incorrect|wrong|lost|removed|missing|no longer)\b/u.test(text);
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
  return isTestPath(source.packet.path) ||
    source.packet.fileStatus === "deleted" ||
    source.packet.isDeletedContent ||
    source.files.some(isTestPath) ||
    /\b(deleted|removed|drop|missing|coverage)\b/u.test(normalizedSourceText(source));
}

function mentionsNamedProductionScope(source: PromotionSource): boolean {
  return source.symbols.length > 0 ||
    source.files.some((file) => !isTestPath(file)) ||
    /\b(production|prod|handler|service|worker|client|api|caller|symbol|function|method|behavior)\b/u.test(normalizedSourceText(source));
}

function mentionsProductionImpact(source: PromotionSource): boolean {
  return !isTestPath(source.packet.path) || source.files.some((file) => !isTestPath(file));
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
  return isTestPath(source.packet.path) ||
    source.files.some(isTestPath) ||
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

function promotionLimit(packetResultCount: number, budgetMultiplier: number): number {
  const base = Math.min(MAX_PROMOTIONS, Math.max(MIN_PROMOTIONS_WHEN_AVAILABLE, Math.ceil(packetResultCount * 0.03)));
  return scaleBudgetValue(base, budgetMultiplier);
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

function isTestPath(filePath: string): boolean {
  return /(^|[/_.-])(test|tests|spec|specs)([/_.-]|$)|(_test|\.test|\.spec)\.[^.]+$/iu.test(filePath);
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
