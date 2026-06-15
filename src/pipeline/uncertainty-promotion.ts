import type {
  CandidateFinding,
  Confidence,
  FindingCategory,
  PacketReviewResult,
  ReviewPacket,
  Severity,
  StructuredUncertainty
} from "../types.js";
import type { TelemetryRecorder } from "../telemetry/telemetry-recorder.js";
import { sha256Hex } from "../util/hashing.js";

const MAX_PROMOTIONS = 4;
const MIN_PROMOTIONS_WHEN_AVAILABLE = 2;
const MAX_EVIDENCE_CHARS = 2400;

type PromotionInput = {
  packetResults: PacketReviewResult[];
  packets: ReviewPacket[];
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
  sourceKind: "uncertainty" | "follow_up_hint";
  question: string;
  files: string[];
  symbols: string[];
  promoted: boolean;
  reason: string;
  candidateId?: string;
};

type PromotionSource = {
  packetResult: PacketReviewResult;
  packet: ReviewPacket;
  sourceKind: "uncertainty" | "follow_up_hint";
  question: string;
  files: string[];
  symbols: string[];
  reason: string;
  confidence?: Confidence;
};

export async function promoteUncertaintiesForVerification(
  input: PromotionInput,
  telemetry: TelemetryRecorder
): Promise<{ packetResults: PacketReviewResult[]; summary: UncertaintyPromotionSummary }> {
  const packetsById = new Map(input.packets.map((packet) => [packet.id, packet]));
  const sources = input.packetResults.flatMap((result) => promotionSources(result, packetsById));
  const maxPromotions = promotionLimit(input.packetResults.length);
  const decisions: PromotionDecision[] = [];
  const promotedByPacket = new Map<string, CandidateFinding[]>();
  const notPromoted: Record<string, number> = {};

  const eligible = sources.flatMap((source) => {
    const decision = promotionDecision(source);
    if (!decision.eligible) {
      decisions.push(baseDecision(source, false, decision.reason));
      notPromoted[decision.reason] = (notPromoted[decision.reason] ?? 0) + 1;
      return [];
    }
    return [{ source, rank: promotionRank(source) }];
  }).sort((a, b) => b.rank - a.rank || a.source.question.localeCompare(b.source.question));

  const selected = eligible.slice(0, maxPromotions);
  const laneLimited = eligible.slice(maxPromotions);
  for (const limited of laneLimited) {
    decisions.push(baseDecision(limited.source, false, "promotion_lane_limited"));
  }

  selected.forEach(({ source }, index) => {
    const candidate = promotedCandidate(source, index);
    const existing = promotedByPacket.get(source.packet.id) ?? [];
    existing.push(candidate);
    promotedByPacket.set(source.packet.id, existing);
    decisions.push({
      ...baseDecision(source, true, "promoted_for_verification"),
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
      notPromoted: summary.notPromoted,
      promotedCandidateIds: summary.promotedCandidateIds
    }
  });

  return { packetResults, summary };
}

function promotionSources(result: PacketReviewResult, packetsById: Map<string, ReviewPacket>): PromotionSource[] {
  if (result.status !== "completed") {
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
    }))
  ];
}

function promotionDecision(source: PromotionSource): { eligible: boolean; reason: string } {
  if (source.packetResult.findings.length > 0) {
    if (!pointsAtDistinctScope(source) || duplicateOfExistingFinding(source)) {
      return { eligible: false, reason: "covered_by_existing_candidate" };
    }
  }
  if (source.files.length === 0 && source.symbols.length === 0) {
    return { eligible: false, reason: "no_concrete_file_or_symbol" };
  }
  if (source.sourceKind === "follow_up_hint" && source.confidence === "low") {
    return { eligible: false, reason: "low_confidence_hint" };
  }
  if (!mentionsChangedScope(source)) {
    return { eligible: false, reason: "not_tied_to_changed_scope" };
  }
  const risk = riskProfile(source);
  if (!risk.promotable) {
    return { eligible: false, reason: "weak_or_non_actionable_risk" };
  }
  if (risk.category === "testing" && !mentionsChangedTestOrDeletedCoverage(source)) {
    return { eligible: false, reason: "test_risk_without_changed_test_or_deleted_coverage" };
  }
  if (!mentionsProductionImpact(source) && risk.category !== "testing") {
    return { eligible: false, reason: "no_production_impact" };
  }
  return { eligible: true, reason: "eligible" };
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
  const anchor = firstChangedAnchor(source.packet);
  const confidence = promotedConfidence(source, risk.category);
  const changedCode = source.packet.hunks.map((hunk) => hunk.contentWithLineNumbers).join("\n\n");
  const relatedCode = relatedEvidence(source);
  return {
    id: promotedCandidateId(source, index),
    title: promotedTitle(source, risk.category),
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

function promotionRank(source: PromotionSource): number {
  const risk = riskProfile(source);
  return (source.sourceKind === "follow_up_hint" ? 8 : 4) +
    (source.confidence === "high" ? 8 : source.confidence === "medium" ? 4 : 0) +
    (risk.category === "security" ? 12 : risk.category === "correctness" || risk.category === "logic_bug" ? 8 : 6) +
    (source.packet.reviewPriority === "critical" ? 8 : source.packet.reviewPriority === "high" ? 4 : 0) +
    (source.symbols.length > 0 ? 2 : 0) +
    (mentionsChangedTestOrDeletedCoverage(source) ? 2 : 0);
}

function riskProfile(source: PromotionSource): { promotable: boolean; category: FindingCategory } {
  const text = normalizedSourceText(source);
  if (/\b(auth|authorization|authentication|permission|tenant|signature|token|secret|security|access control)\b/u.test(text)) {
    return { promotable: true, category: "security" };
  }
  if (/\b(test|coverage|regression|fixture|assert|expect|deleted test|missing test)\b/u.test(text)) {
    return { promotable: true, category: "testing" };
  }
  if (/\b(bug|incorrect|wrong|break|broken|fail|failure|regression|behavior|semantic|contract|caller|invariant|fallback|default|zero|nil|null|panic|overflow|round|precision|race|leak|retry|timeout|context|close|cleanup)\b/u.test(text)) {
    return { promotable: true, category: text.includes("logic") ? "logic_bug" : "correctness" };
  }
  return { promotable: false, category: "maintainability" };
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

function mentionsChangedTestOrDeletedCoverage(source: PromotionSource): boolean {
  return isTestPath(source.packet.path) ||
    source.packet.fileStatus === "deleted" ||
    source.packet.isDeletedContent ||
    source.files.some(isTestPath) ||
    /\b(deleted|removed|drop|missing|coverage)\b/u.test(normalizedSourceText(source));
}

function mentionsProductionImpact(source: PromotionSource): boolean {
  return !isTestPath(source.packet.path) || source.files.some((file) => !isTestPath(file));
}

function duplicateOfExistingFinding(source: PromotionSource): boolean {
  const question = normalize(source.question);
  return source.packetResult.findings.some((finding) => {
    const text = normalize([finding.title, finding.failureMode, finding.whyThisMatters].join(" "));
    return text.length > 0 && (text.includes(question) || question.includes(text.slice(0, 80)));
  });
}

function baseDecision(source: PromotionSource, promoted: boolean, reason: string): PromotionDecision {
  return {
    packetId: source.packet.id,
    sourceKind: source.sourceKind,
    question: source.question.trim(),
    files: source.files,
    symbols: source.symbols,
    promoted,
    reason
  };
}

function promotionLimit(packetResultCount: number): number {
  return Math.min(MAX_PROMOTIONS, Math.max(MIN_PROMOTIONS_WHEN_AVAILABLE, Math.ceil(packetResultCount * 0.03)));
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
