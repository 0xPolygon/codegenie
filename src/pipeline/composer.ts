import type { LlmRunner } from "../llm/llm-runner.js";
import { SubmitCompositionSchema, type SubmitComposition } from "../llm/schemas.js";
import type { PromptBuilder } from "../skills/prompt-builder.js";
import type { TelemetryRecorder } from "../telemetry/telemetry-recorder.js";
import { scrubGitHubSecrets } from "../github/comment-sanitizer.js";
import type {
  CandidateFinding,
  Confidence,
  CodeninjaConfig,
  FinalFinding,
  NeedsHumanAttentionNote,
  PacketReviewResult,
  ReviewPacket,
  ResolvedReviewInput,
  ReviewPlan,
  ReviewResult,
  RunCoverageStatus,
  Severity,
  UnifiedDiff,
  VerificationVerdict
} from "../types.js";
import { coverageDisclosureLines, renderCoverageSummaryLines } from "../util/coverage-summary.js";
import { sha256Hex } from "../util/hashing.js";
import { isBudgetExhaustedError, isRecoverableTransientLlmError, validateAnchorForDiff } from "./pipeline-utils.js";
import { summarizeIntentSignals } from "./intent-signals.js";

type ComposeOptions = {
  runner: LlmRunner;
  promptBuilder: PromptBuilder;
  packetResults?: PacketReviewResult[];
  packets?: ReviewPacket[];
  postGithubComments?: boolean;
  diff?: UnifiedDiff;
};

type FindingGroup = {
  fingerprint: string;
  representative: CandidateFinding;
  findings: CandidateFinding[];
};

type SelectionRecord = {
  findingId: string;
  decision: "published" | "merged" | "suppressed";
  reason: string;
  mergedIntoFingerprint?: string;
};

type CompositionMode = "llm" | "llm_degraded" | "deterministic_fallback";

const MAX_COMPOSER_FINDINGS = 40;
const MAX_HUMAN_ATTENTION_NOTES = 5;
const HUMAN_ATTENTION_LOCATION_CAP = 6;

export async function dedupeRankAndComposeReview(
  verified: { verified: CandidateFinding[]; verdicts: VerificationVerdict[] },
  plan: ReviewPlan,
  _resolved: ResolvedReviewInput,
  coverage: RunCoverageStatus,
  config: CodeninjaConfig,
  telemetry: TelemetryRecorder,
  opts: ComposeOptions
): Promise<ReviewResult> {
  telemetry.event({ stage: 10, level: "info", message: "stage_started", data: { verified: verified.verified.length } });
  const packetsById = new Map((opts.packets ?? []).map((packet) => [packet.id, packet]));
  const pretrim = pretrimComposerInput(verified.verified);
  const groups = groupFindings(pretrim.kept, packetsById);
  const attention = buildHumanAttentionNotes(opts.packetResults ?? [], {
    packets: opts.packets ?? [],
    ...(opts.diff !== undefined ? { diff: opts.diff } : {}),
    telemetry
  });
  const verificationResolutions = buildVerificationResolutionIndex(verified.verdicts, opts.packetResults ?? [], verified.verified, packetsById, coverage);
  const preComposerAttentionGroups = suppressAttentionGroupsResolvedByVerification(
    attention.groups,
    verificationResolutions.filter((resolution) => resolution.verdict === "reject")
  ).available;
  const composerPromptSelection = selectHumanAttentionGroups(preComposerAttentionGroups);
  const composerPromptNotes = composerPromptSelection.notes;
  if (pretrim.suppressed.length > 0) {
    const reason = `composer pre-trim suppressed ${pretrim.suppressed.length} verified finding${pretrim.suppressed.length === 1 ? "" : "s"} above the ${MAX_COMPOSER_FINDINGS}-finding composer input cap`;
    coverage.reasons.push(reason);
    telemetry.event({
      stage: 10,
      level: "warn",
      message: "composer_pretrim_suppressed_findings",
      data: { suppressedFindings: pretrim.suppressed.length, maxComposerFindings: MAX_COMPOSER_FINDINGS }
    });
  }
  let fallbackUsed = false;
  let fallbackReason: string | undefined;
  let compositionDegraded = false;
  const composition = await runComposer(groups, plan, coverage, config, telemetry, opts, composerPromptNotes).catch((error) => {
    if (!canUseComposerFallback(error, groups, coverage)) {
      throw error;
    }
    fallbackUsed = true;
    fallbackReason = composerFallbackCoverageReason();
    telemetry.event({
      stage: 10,
      level: "warn",
      message: "composer_fallback_used",
      data: composerFallbackTelemetry(error, groups, fallbackReason)
    });
    coverage.reasons.push(fallbackReason);
    return fallbackComposition(groups);
  });

  const known = new Map(pretrim.kept.map((finding) => [finding.id, finding]));
  const anchorDowngradeReasons = new Map<string, string>();
  const finalFindings: FinalFinding[] = pretrim.suppressed.map((finding) => {
    const requestedPublication = "suppressed" as const;
    const final = toFinalFinding(finding, fingerprintFinding(finding, packetsById), templateBody(finding), requestedPublication, [finding], opts.diff);
    recordAnchorDowngrade(final, requestedPublication, anchorDowngradeReasons);
    return final;
  });
  const baseSelection = new Map<string, SelectionRecord>(
    pretrim.suppressed.map((finding) => [finding.id, { findingId: finding.id, decision: "suppressed", reason: "composer-pre-trim" }])
  );
  const used = new Set<string>();

  for (const composed of composition.composedFindings) {
    const unknownIds = composed.findingIds.filter((id) => !known.has(id));
    if (unknownIds.length > 0) {
      compositionDegraded = true;
      telemetry.event({ stage: 10, level: "warn", message: "composer_invented_finding", data: { findingIds: composed.findingIds, unknownIds } });
      continue;
    }
    const ids = expandClusterFindingIds(composed.findingIds, known);
    if (ids.length === 0) {
      compositionDegraded = true;
      telemetry.event({ stage: 10, level: "warn", message: "composer_invented_finding", data: { findingIds: composed.findingIds } });
      continue;
    }
    const overlappingIds = ids.filter((id) => used.has(id));
    if (overlappingIds.length > 0) {
      compositionDegraded = true;
      telemetry.event({ stage: 10, level: "warn", message: "composer_overlapping_finding_group", data: { findingIds: composed.findingIds, expandedFindingIds: ids, overlappingIds } });
      continue;
    }
    const representative = strongest(ids.map((id) => known.get(id)).filter((finding): finding is CandidateFinding => finding !== undefined));
    const fingerprint = fingerprintFinding(representative, packetsById);
    const mergedFindings = ids.map((id) => known.get(id)).filter((finding): finding is CandidateFinding => finding !== undefined);
    const final = toFinalFinding(representative, fingerprint, composed.finalBody, composed.publication, mergedFindings, opts.diff);
    recordAnchorDowngrade(final, composed.publication, anchorDowngradeReasons);
    finalFindings.push(final);
    used.add(representative.id);
    baseSelection.set(representative.id, { findingId: representative.id, decision: "published", reason: "composer-selected" });
    for (const id of ids.filter((id) => id !== representative.id)) {
      used.add(id);
      baseSelection.set(id, { findingId: id, decision: "merged", reason: "composer-merged", mergedIntoFingerprint: fingerprint });
    }
  }

  for (const finding of pretrim.kept) {
    if (used.has(finding.id)) {
      continue;
    }
    const fingerprint = fingerprintFinding(finding, packetsById);
    const requestedPublication = finding.anchor ? "inline" : "summary-only";
    const final = toFinalFinding(finding, fingerprint, templateBody(finding), requestedPublication, [finding], opts.diff);
    recordAnchorDowngrade(final, requestedPublication, anchorDowngradeReasons);
    finalFindings.push(final);
    baseSelection.set(finding.id, { findingId: finding.id, decision: "published", reason: "composer_omitted_finding" });
    compositionDegraded = true;
  }

  const lowConfidencePublishableIds = lowConfidencePublishableCandidateIds(verified.verdicts);
  const capped = applyCaps(finalFindings, config, {
    lowConfidencePublishableIds,
    telemetry
  });
  const compositionMode: CompositionMode = fallbackUsed ? "deterministic_fallback" : compositionDegraded ? "llm_degraded" : "llm";
  for (const [id, reason] of anchorDowngradeReasons) {
    if (!capped.downgradeReasons.has(id)) {
      capped.downgradeReasons.set(id, reason);
    }
  }
  const selection = buildSelectionRecords(capped.findings, baseSelection, capped.suppressedReasons, capped.downgradeReasons);
  const findings = capped.findings.filter((finding) => finding.publication === "inline");
  const summaryOnlyFindings = capped.findings.filter((finding) => finding.publication === "summary-only");
  const publishableCount = findings.length + summaryOnlyFindings.length;
  const humanAttention = selectHumanAttentionForOutput(
    attention.groups,
    capped.findings.filter((finding) => finding.publication !== "suppressed"),
    packetsById,
    verificationResolutions,
    telemetry
  );
  const summary = publishableCount === 0
    ? fallbackSummary(0)
    : fallbackUsed || compositionDegraded || isNoFindingsSummary(composition.summary) || summaryCountConflicts(composition.summary, publishableCount)
      ? fallbackSummary(publishableCount)
      : composition.summary || fallbackSummary(publishableCount);
  const createPostingPlan = opts.postGithubComments === true && (publishableCount > 0 || config.github.summaryWhenNoFindings);
  const result: ReviewResult = {
    summary,
    coverage,
    findings,
    summaryOnlyFindings,
    needsHumanAttention: humanAttention.notes,
    ...(humanAttention.omittedCount > 0 ? { needsHumanAttentionOmittedCount: humanAttention.omittedCount } : {}),
    noFindings: findings.length === 0 && summaryOnlyFindings.length === 0,
    ...(createPostingPlan
      ? {
          postingPlan: {
            inline: findings.flatMap((finding) => (finding.anchor ? [{ findingId: finding.id, anchor: finding.anchor }] : [])),
            reviewBody: renderReviewBody(summary, summaryOnlyFindings, humanAttention.notes, coverage, humanAttention.omittedCount)
          }
        }
      : {})
  };

  await telemetry.writeArtifact("final-selection.json", {
    composition: {
      mode: compositionMode,
      ...(fallbackReason !== undefined ? { fallbackReason } : {})
    },
    records: selection,
    groups: groups.map((group) => ({
      fingerprint: group.fingerprint,
      findingIds: group.findings.map((finding) => finding.id)
    }))
  });
  await telemetry.writeArtifact("human-attention-notes.json", scrubGitHubSecrets(
    humanAttentionArtifact(attention, humanAttention, composerPromptSelection.groups)
  ));
  await telemetry.writeArtifact("final-findings.json", scrubGitHubSecrets(capped.findings));
  telemetry.event({
    stage: 10,
    level: "info",
    message: "pipeline_metrics",
    data: {
      totals: { finalFindings: capped.findings.length },
      dedup: {
        clusters: groups.length,
        duplicates: groups.reduce((sum, group) => sum + Math.max(0, group.findings.length - 1), 0),
        suppressed: selection.filter((record) => record.decision === "suppressed").length
      },
      finalSelection: {
        published: selection.filter((record) => record.decision === "published").length,
        merged: selection.filter((record) => record.decision === "merged").length,
        suppressed: selection.filter((record) => record.decision === "suppressed").length,
        finalFindings: capped.findings.length,
        reportedFindings: publishableCount,
        compositionMode,
        ...(fallbackReason !== undefined ? { fallbackReason } : {})
      }
    }
  });
  telemetry.event({ stage: 10, level: "info", message: "stage_completed", data: { finalFindings: capped.findings.length, compositionMode } });
  return result;
}

async function runComposer(
  groups: FindingGroup[],
  plan: ReviewPlan,
  coverage: RunCoverageStatus,
  config: CodeninjaConfig,
  telemetry: TelemetryRecorder,
  opts: ComposeOptions,
  notes: NeedsHumanAttentionNote[]
): Promise<SubmitComposition> {
  const prompt = opts.promptBuilder.buildComposerPrompt({
    groupedFindingsJson: JSON.stringify(groups, null, 2),
    intent: `Declared intent: ${plan.diffUnderstanding.declaredIntent}\nInferred behavior: ${plan.diffUnderstanding.inferredBehavior}\n${summarizeIntentSignals(plan.intentSignals)}`,
    coverage,
    followUpHintNotes: notes.map((note) => `${note.question} (${note.files.join(", ")})`)
  });
  const submitted = await opts.runner.runStructured<SubmitComposition>({
    stage: 10,
    prompt: prompt.prompt,
    schema: SubmitCompositionSchema,
    templateVersion: prompt.templateVersion,
    timeoutMs: config.review.perPassTimeoutMs
  });
  telemetry.event({ stage: 10, level: "info", message: "composer_completed", data: { composed: submitted.composedFindings.length } });
  return submitted;
}

function groupFindings(findings: CandidateFinding[], packetsById: Map<string, ReviewPacket>): FindingGroup[] {
  const groups = new Map<string, CandidateFinding[]>();
  for (const finding of findings) {
    const fingerprint = fingerprintFinding(finding, packetsById);
    groups.set(fingerprint, [...(groups.get(fingerprint) ?? []), finding]);
  }
  const exactGroups = [...groups.entries()]
    .map(([fingerprint, members]) => ({
      fingerprint,
      representative: strongest(members),
      findings: members
    }))
    .sort((a, b) => compareFindings(a.representative, b.representative));
  return mergeRootCauseGroups(mergeProximityGroups(exactGroups, packetsById), packetsById);
}

function expandClusterFindingIds(findingIds: string[], known: Map<string, CandidateFinding>): string[] {
  const expanded = new Set<string>();
  for (const id of findingIds) {
    const finding = known.get(id);
    if (!finding) {
      continue;
    }
    const representativeId = finding.duplicateOf ?? finding.clusterId ?? finding.id;
    for (const candidate of known.values()) {
      if (candidate.id === representativeId || candidate.duplicateOf === representativeId || candidate.clusterId === representativeId) {
        expanded.add(candidate.id);
      }
    }
  }
  return [...expanded];
}

function canUseComposerFallback(error: unknown, groups: FindingGroup[], coverage: RunCoverageStatus): boolean {
  if (isBudgetExhaustedError(error)) {
    return true;
  }
  if (groups.length > 0) {
    return isRecoverableTransientLlmError(error);
  }
  return isRecoverableTransientLlmError(error) &&
    !coverage.partial &&
    !coverage.budgetStopped &&
    coverage.verificationIncompleteCount === 0;
}

function composerFallbackCoverageReason(): string {
  return "semantic composition skipped; deterministic fallback used";
}

function composerFallbackTelemetry(error: unknown, groups: FindingGroup[], fallbackReason: string): Record<string, unknown> {
  const errorRecord = error && typeof error === "object" ? error as { code?: unknown; recoverable?: unknown; context?: unknown } : {};
  return {
    compositionMode: "deterministic_fallback",
    fallbackReason,
    verifiedGroups: groups.length,
    error: error instanceof Error ? error.message : String(error),
    ...(typeof errorRecord.code === "string" ? { errorCode: errorRecord.code } : {}),
    ...(typeof errorRecord.recoverable === "boolean" ? { recoverable: errorRecord.recoverable } : {}),
    ...(errorRecord.context && typeof errorRecord.context === "object" ? { context: errorRecord.context } : {})
  };
}

function fallbackComposition(groups: FindingGroup[]): SubmitComposition {
  return {
    summary: groups.length === 0 ? "No credible findings." : `Found ${groups.length} verified issue${groups.length === 1 ? "" : "s"}.`,
    composedFindings: groups.map((group) => ({
      findingIds: group.findings.map((finding) => finding.id),
      finalBody: templateBody(group.representative, group.findings),
      publication: group.representative.anchor ? "inline" : "summary-only"
    }))
  };
}

function toFinalFinding(
  finding: CandidateFinding,
  fingerprint: string,
  finalBody: string,
  publication: FinalFinding["publication"],
  mergedFindings: CandidateFinding[],
  diff: UnifiedDiff | undefined
): FinalFinding {
  const { anchor: _unvalidatedAnchor, ...findingWithoutAnchor } = finding;
  const anchor = validateAnchorForDiff(finding.anchor, diff);
  const normalizedFinalBody = normalizeFinalBodyForRendering(finalBody, finding) || templateBody(finding);
  const mergedCandidateIds = uniqueStrings(mergedFindings.map((item) => item.id));
  const mergedAnchors = dedupeAnchors(mergedFindings.flatMap((item) => item.anchor === undefined ? [] : [item.anchor]));
  const mergedCategories = uniqueStrings(mergedFindings.map((item) => item.category)) as Array<CandidateFinding["category"]>;
  const mergedSeverities = uniqueStrings(mergedFindings.map((item) => item.severity)) as Array<CandidateFinding["severity"]>;
  return {
    ...findingWithoutAnchor,
    ...(anchor !== undefined ? { anchor } : {}),
    changedLine: anchor !== undefined,
    fingerprint,
    finalBody: normalizedFinalBody,
    publication: publication === "suppressed" ? "suppressed" : anchor ? publication : "summary-only",
    mergedCandidateIds,
    mergedCategories,
    mergedSeverities,
    mergedPaths: uniqueStrings(mergedFindings.map((item) => item.anchor?.path ?? item.path)),
    mergedTitles: uniqueStrings(mergedFindings.map((item) => item.title)),
    ...(mergedAnchors.length > 0 ? { mergedAnchors } : {})
  };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))].sort();
}

function dedupeAnchors(anchors: NonNullable<CandidateFinding["anchor"]>[]): NonNullable<FinalFinding["mergedAnchors"]> {
  const seen = new Set<string>();
  const output: NonNullable<FinalFinding["mergedAnchors"]> = [];
  for (const anchor of anchors) {
    const key = [
      anchor.path,
      anchor.side,
      anchor.line,
      anchor.startLine ?? "",
      anchor.startSide ?? "",
      anchor.hunkId
    ].join(":");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(anchor);
  }
  return output;
}

function recordAnchorDowngrade(
  finding: FinalFinding,
  requestedPublication: FinalFinding["publication"],
  downgradeReasons: Map<string, string>
): void {
  if (requestedPublication === "inline" && finding.publication === "summary-only" && finding.anchor === undefined) {
    downgradeReasons.set(finding.id, "unanchorable");
  }
}

function fallbackSummary(publishableCount: number): string {
  return publishableCount === 0 ? "No credible findings." : `Found ${publishableCount} verified issue${publishableCount === 1 ? "" : "s"}.`;
}

function summaryCountConflicts(summary: string | undefined, publishableCount: number): boolean {
  const count = summaryFindingCount(summary);
  return count !== undefined && count !== publishableCount;
}

function summaryFindingCount(summary: string | undefined): number | undefined {
  if (!summary) {
    return undefined;
  }
  const match = summary.trim().match(/\b(?:found|reported|identified|composed)\s+(\d+)\s+(?:verified\s+)?(?:issue|issues|finding|findings)\b/iu);
  return match ? Number(match[1]) : undefined;
}

function isNoFindingsSummary(summary: string | undefined): boolean {
  if (!summary) {
    return false;
  }
  const normalized = summary.trim().replace(/\s+/gu, " ");
  return /^(?:no|nothing)\b.{0,120}\b(?:findings?|issues?|problems?|concerns?)\b\.?$/iu.test(normalized) ||
    /^no credible findings were found\.?$/iu.test(normalized);
}

function pretrimComposerInput(findings: CandidateFinding[]): { kept: CandidateFinding[]; suppressed: CandidateFinding[] } {
  if (findings.length <= MAX_COMPOSER_FINDINGS) {
    return { kept: findings, suppressed: [] };
  }
  const criticalHigh = findings.filter((finding) => finding.severity === "critical" || finding.severity === "high");
  const others = findings
    .filter((finding) => finding.severity !== "critical" && finding.severity !== "high")
    .sort(compareFindings);
  const remainingSlots = Math.max(0, MAX_COMPOSER_FINDINGS - criticalHigh.length);
  const kept = [...criticalHigh, ...others.slice(0, remainingSlots)].sort(compareFindings);
  const keptIds = new Set(kept.map((finding) => finding.id));
  return {
    kept,
    suppressed: findings.filter((finding) => !keptIds.has(finding.id)).sort(compareFindings)
  };
}

function mergeProximityGroups(groups: FindingGroup[], packetsById: Map<string, ReviewPacket>): FindingGroup[] {
  const merged: FindingGroup[] = [];
  for (const group of groups) {
    const existing = merged.find((candidate) => nearbyGroup(candidate, group));
    if (!existing) {
      merged.push(group);
      continue;
    }
    existing.findings.push(...group.findings);
    existing.representative = strongest(existing.findings);
    existing.fingerprint = fingerprintFinding(existing.representative, packetsById);
  }
  return merged.sort((a, b) => compareFindings(a.representative, b.representative));
}

function mergeRootCauseGroups(groups: FindingGroup[], packetsById: Map<string, ReviewPacket>): FindingGroup[] {
  const merged: FindingGroup[] = [];
  for (const group of groups) {
    const existing = merged.find((candidate) => rootCauseGroupsMatch(candidate, group, packetsById));
    if (!existing) {
      merged.push({ ...group, fingerprint: rootCauseGroupFingerprint(group, packetsById) });
      continue;
    }
    existing.findings.push(...group.findings);
    existing.representative = strongest(existing.findings);
    existing.fingerprint = rootCauseGroupFingerprint(existing, packetsById);
  }
  return merged.sort((a, b) => compareFindings(a.representative, b.representative));
}

function nearbyGroup(a: FindingGroup, b: FindingGroup): boolean {
  return a.representative.path === b.representative.path &&
    a.representative.category === b.representative.category &&
    a.findings.some((left) => b.findings.some((right) => anchorsWithinFiveLines(left.anchor, right.anchor)));
}

function anchorsWithinFiveLines(a: CandidateFinding["anchor"], b: CandidateFinding["anchor"]): boolean {
  if (!a || !b) {
    return false;
  }
  return a.side === b.side && a.path === b.path && Math.abs(a.line - b.line) <= 5;
}

function rootCauseGroupsMatch(a: FindingGroup, b: FindingGroup, packetsById: Map<string, ReviewPacket>): boolean {
  if (a.representative.path !== b.representative.path || a.representative.category !== b.representative.category) {
    return false;
  }
  const similarity = rootCauseSimilarity(a.findings, b.findings);
  if (similarity < 0.5) {
    return false;
  }
  if (a.findings.some((left) => b.findings.some((right) => anchorsWithinFiveLines(left.anchor, right.anchor)))) {
    return true;
  }
  if (groupsShareSymbol(a, b, packetsById)) {
    return similarity >= 0.55;
  }
  if (groupsShareLocation(a, b, packetsById)) {
    return similarity >= 0.6;
  }
  if (groupHasAnchor(a) !== groupHasAnchor(b)) {
    return similarity >= 0.65;
  }
  return similarity >= 0.8;
}

function rootCauseSimilarity(a: CandidateFinding[], b: CandidateFinding[]): number {
  let best = 0;
  for (const left of a) {
    for (const right of b) {
      best = Math.max(best, tokenJaccard(rootCauseTerms(left), rootCauseTerms(right)));
    }
  }
  return best;
}

function tokenJaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const term of a) {
    if (b.has(term)) {
      intersection += 1;
    }
  }
  return intersection / (a.size + b.size - intersection);
}

function rootCauseTerms(finding: CandidateFinding): Set<string> {
  return normalizedTerms([
    finding.title,
    finding.failureMode,
    finding.whyThisMatters,
    finding.suggestedFix ?? "",
    finding.evidence.changedCode,
    ...(finding.evidence.relatedCode ?? []).flatMap((related) => [related.whyRelevant, related.lines])
  ].join(" "));
}

function normalizedTerms(text: string): Set<string> {
  const stopWords = new Set([
    "about",
    "after",
    "also",
    "before",
    "because",
    "being",
    "cannot",
    "code",
    "could",
    "from",
    "have",
    "into",
    "line",
    "more",
    "should",
    "that",
    "this",
    "when",
    "where",
    "will",
    "with",
    "without",
    "would"
  ]);
  return new Set(text
    .toLowerCase()
    .replace(/[^a-z0-9_]+/gu, " ")
    .split(/\s+/u)
    .map((term) => term.trim())
    .filter((term) => term.length >= 4 && !stopWords.has(term)));
}

function groupHasAnchor(group: FindingGroup): boolean {
  return group.findings.some((finding) => finding.anchor !== undefined);
}

function groupsShareSymbol(a: FindingGroup, b: FindingGroup, packetsById: Map<string, ReviewPacket>): boolean {
  const left = groupSymbols(a, packetsById);
  const right = groupSymbols(b, packetsById);
  return left.size > 0 && [...left].some((symbol) => right.has(symbol));
}

function groupSymbols(group: FindingGroup, packetsById: Map<string, ReviewPacket>): Set<string> {
  return new Set(group.findings.flatMap((finding) => symbolsForFinding(finding, packetsById)).map(normalize));
}

function symbolsForFinding(finding: CandidateFinding, packetsById: Map<string, ReviewPacket>): string[] {
  const packet = packetsById.get(finding.producedBy.packetId);
  const symbols = new Set<string>();
  if (finding.anchor?.hunkId) {
    const symbol = symbolForHunk(packet, finding.anchor.hunkId);
    if (symbol !== undefined) {
      symbols.add(symbol);
    }
  }
  for (const hunk of matchingEvidenceHunks(finding, packet)) {
    const symbol = symbolForHunk(packet, hunk.hunkId);
    if (symbol !== undefined) {
      symbols.add(symbol);
    }
  }
  const packetSymbol = uniquePacketSymbol(packet);
  if (packetSymbol !== undefined) {
    symbols.add(packetSymbol);
  }
  return [...symbols];
}

function groupsShareLocation(a: FindingGroup, b: FindingGroup, packetsById: Map<string, ReviewPacket>): boolean {
  const left = groupLocationKeys(a, packetsById);
  const right = groupLocationKeys(b, packetsById);
  return left.size > 0 && [...left].some((location) => right.has(location));
}

function groupLocationKeys(group: FindingGroup, packetsById: Map<string, ReviewPacket>): Set<string> {
  const keys = new Set<string>();
  for (const finding of group.findings) {
    const packet = packetsById.get(finding.producedBy.packetId);
    keys.add(`packet:${finding.producedBy.packetId}`);
    if (finding.anchor?.hunkId) {
      keys.add(`hunk:${finding.anchor.hunkId}`);
    }
    for (const hunk of matchingEvidenceHunks(finding, packet)) {
      keys.add(`hunk:${hunk.hunkId}`);
    }
  }
  return keys;
}

function rootCauseGroupFingerprint(group: FindingGroup, packetsById: Map<string, ReviewPacket>): string {
  const terms = [...new Set(group.findings.flatMap((finding) => [...rootCauseTerms(finding)]))]
    .sort()
    .slice(0, 24)
    .join(" ");
  const symbols = [...groupSymbols(group, packetsById)].sort().join(",");
  return sha256Hex([
    normalize(group.representative.path),
    normalize(group.representative.category),
    normalize(terms),
    normalize(symbols)
  ].join("\0"));
}

type ApplyCapsOptions = {
  lowConfidencePublishableIds: Set<string>;
  telemetry: TelemetryRecorder;
};

function applyCaps(
  findings: FinalFinding[],
  config: CodeninjaConfig,
  opts: ApplyCapsOptions
): { findings: FinalFinding[]; suppressedReasons: Map<string, string>; downgradeReasons: Map<string, string> } {
  const suppressedReasons = new Map<string, string>();
  const downgradeReasons = new Map<string, string>();
  const ranked = [...findings].sort(compareFindings);
  const thresholded = ranked.map((finding) => {
    if (belowSeverity(finding.severity, config.review.minSeverity)) {
      suppressedReasons.set(finding.id, "severity-threshold");
      return { ...finding, publication: "suppressed" as const };
    }
    if (belowConfidence(finding.confidence, config.review.minConfidence)) {
      if (isPublishableLowConfidenceBehaviorDelta(finding, opts.lowConfidencePublishableIds)) {
        opts.telemetry.event({
          stage: 10,
          level: "info",
          message: "low_confidence_verified_delta_published",
          file: finding.path,
          data: {
            findingId: finding.id,
            mergedCandidateIds: finding.mergedCandidateIds,
            category: finding.category,
            confidence: finding.confidence,
            severity: finding.severity
          }
        });
        return finding;
      }
      suppressedReasons.set(finding.id, "confidence-threshold");
      return { ...finding, publication: "suppressed" as const };
    }
    if (belowConfidence(finding.confidence, config.review.minInlineConfidence) && finding.publication === "inline") {
      downgradeReasons.set(finding.id, "min-inline-confidence");
      return { ...finding, publication: "summary-only" as const };
    }
    return finding;
  });

  let inlineCount = 0;
  const softCapped = thresholded.map((finding) => {
    if (finding.publication !== "inline") {
      return finding;
    }
    inlineCount += 1;
    if (inlineCount > config.review.softCommentCap && finding.severity !== "critical" && finding.severity !== "high") {
      downgradeReasons.set(finding.id, "soft-comment-cap");
      return { ...finding, publication: "summary-only" as const };
    }
    return finding;
  });

  let reportedCount = 0;
  const capped = softCapped.map((finding) => {
    if (finding.publication === "suppressed") {
      return finding;
    }
    reportedCount += 1;
    if (reportedCount > config.review.maxFindings && finding.severity !== "critical" && finding.severity !== "high") {
      suppressedReasons.set(finding.id, "report-cap");
      return { ...finding, publication: "suppressed" as const };
    }
    return finding;
  });
  return { findings: capped, suppressedReasons, downgradeReasons };
}

function lowConfidencePublishableCandidateIds(verdicts: VerificationVerdict[]): Set<string> {
  return new Set(verdicts
    .filter((verdict) => verdict.verdict === "keep" || verdict.verdict === "revise")
    .map((verdict) => verdict.candidateId));
}

function isPublishableLowConfidenceBehaviorDelta(
  finding: FinalFinding,
  verifiedPublishableIds: Set<string>
): boolean {
  if (finding.confidence !== "low") {
    return false;
  }
  if (!finding.mergedCandidateIds.some((id) => verifiedPublishableIds.has(id))) {
    return false;
  }
  if (finding.publication === "suppressed" || finding.anchor === undefined || finding.changedLine !== true) {
    return false;
  }
  if (!isBehaviorDeltaCategory(finding.category)) {
    return false;
  }
  if (!hasConcreteText(finding.evidence.changedCode, 12) || (finding.evidence.relatedCode ?? []).length === 0) {
    return false;
  }
  if (!hasConcreteText(finding.failureMode, 36) || !hasConcreteText(finding.whyThisMatters, 24)) {
    return false;
  }
  return hasConfirmationPath(finding);
}

function isBehaviorDeltaCategory(category: CandidateFinding["category"]): boolean {
  return category === "logic_bug" ||
    category === "correctness" ||
    category === "security" ||
    category === "performance" ||
    category === "testing";
}

function hasConcreteText(value: string | undefined, minLength: number): boolean {
  return (value ?? "").trim().length >= minLength;
}

function hasConfirmationPath(finding: FinalFinding): boolean {
  const text = `${finding.suggestedTest ?? ""}\n${finding.verification}`.toLowerCase();
  return /\b(test|assert|confirm|verify|reproduce|coverage|case|scenario)\b/u.test(text);
}

function buildSelectionRecords(
  findings: FinalFinding[],
  baseSelection: Map<string, SelectionRecord>,
  suppressedReasons: Map<string, string>,
  downgradeReasons: Map<string, string>
): SelectionRecord[] {
  const records = new Map<string, SelectionRecord>();
  for (const finding of findings) {
    const suppressedReason = finding.publication === "suppressed"
      ? suppressedReasons.get(finding.id) ?? baseSelection.get(finding.id)?.reason ?? "suppressed"
      : undefined;
    if (suppressedReason) {
      for (const id of finding.mergedCandidateIds) {
        records.set(id, { findingId: id, decision: "suppressed", reason: suppressedReason });
      }
      continue;
    }
    const downgradeReason = finding.publication === "summary-only" ? downgradeReasons.get(finding.id) : undefined;
    for (const id of finding.mergedCandidateIds) {
      const base = baseSelection.get(id);
      if (downgradeReason !== undefined) {
        const decision = base?.decision ?? (id === finding.id ? "published" : "merged");
        records.set(id, {
          findingId: id,
          decision,
          reason: downgradeReason,
          ...(decision === "merged" ? { mergedIntoFingerprint: base?.mergedIntoFingerprint ?? finding.fingerprint } : {})
        });
        continue;
      }
      records.set(id, base ?? {
        findingId: id,
        decision: id === finding.id ? "published" : "merged",
        reason: id === finding.id ? "composer-selected" : "composer-merged",
        ...(id === finding.id ? {} : { mergedIntoFingerprint: finding.fingerprint })
      });
    }
  }
  return [...records.values()].sort((a, b) => a.findingId.localeCompare(b.findingId));
}

type RawAttentionHint = {
  id: string;
  source: "follow_up_hint" | "uncertainty";
  question: string;
  files: string[];
  originalFiles: string[];
  droppedPaths: Array<{ path: string; reason: string }>;
  symbols: string[];
  suggestedLenses: string[];
  reason: string;
  confidence: Confidence;
  packetId: string;
};

type AttentionHint = RawAttentionHint & { confidence: Exclude<Confidence, "low"> };

type AttentionHintGroup = {
  key: string;
  representative: AttentionHint;
  files: string[];
  symbols: string[];
  rawNoteIds: Set<string>;
  droppedPaths: Array<{ path: string; reason: string }>;
  invalidPathCount: number;
  packetIds: Set<string>;
  sources: Set<RawAttentionHint["source"]>;
  count: number;
};

type HumanAttentionNotes = {
  raw: RawAttentionHint[];
  groups: AttentionHintGroup[];
  notes: NeedsHumanAttentionNote[];
  omittedCount: number;
};

type VerificationResolution = {
  candidateId: string;
  verdict: VerificationVerdict["verdict"];
  reason: string;
  files: string[];
  symbols: string[];
  terms: Set<string>;
  questionKeys: Set<string>;
};

type VerificationSuppressionRecord = {
  groupKey: string;
  noteIds: string[];
  note: NeedsHumanAttentionNote;
  candidateId: string;
  verdict: VerificationVerdict["verdict"];
  reason: string;
  verdictReason: string;
  match: {
    sharedFiles: string[];
    sharedSymbols: string[];
    sharedTerms: number;
    similarity: number;
    questionMatched: boolean;
  };
};

type HumanAttentionOutput = {
  notes: NeedsHumanAttentionNote[];
  omittedCount: number;
  suppressedByFindings: NeedsHumanAttentionNote[];
  suppressedByFindingGroups: AttentionHintGroup[];
  suppressedByVerification: VerificationSuppressionRecord[];
  keptGroups: AttentionHintGroup[];
  selectedGroups: AttentionHintGroup[];
};

function buildHumanAttentionNotes(
  packetResults: PacketReviewResult[],
  options: { packets: ReviewPacket[]; diff?: UnifiedDiff; telemetry?: TelemetryRecorder }
): HumanAttentionNotes {
  const raw = rawAttentionHints(packetResults, knownAttentionPaths(options.packets, options.diff), options.telemetry);
  const groups = new Map<string, AttentionHintGroup>();
  let eligibleHints = 0;

  for (const hint of raw) {
    if (hint.confidence === "low") {
      continue;
    }
    const question = hint.question.trim();
    if (question.length === 0) {
      continue;
    }
    if (hint.files.length === 0 && hint.symbols.length === 0) {
      options.telemetry?.event({
        stage: 10,
        level: "warn",
        message: "human_attention_note_dropped",
        packetId: hint.packetId,
        data: {
          reason: "no_valid_file_or_symbol",
          noteId: hint.id,
          droppedPaths: hint.droppedPaths
        }
      });
      continue;
    }
    eligibleHints += 1;
    const normalized: AttentionHint = { ...hint, question, confidence: hint.confidence };
    const key = followUpHintKey(normalized);
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        key,
        representative: normalized,
        files: normalized.files,
        symbols: normalized.symbols,
        rawNoteIds: new Set([normalized.id]),
        droppedPaths: normalized.droppedPaths,
        invalidPathCount: normalized.droppedPaths.length,
        packetIds: new Set([normalized.packetId]),
        sources: new Set([normalized.source]),
        count: 1
      });
      continue;
    }
    existing.count += 1;
    existing.packetIds.add(normalized.packetId);
    existing.sources.add(normalized.source);
    existing.rawNoteIds.add(normalized.id);
    existing.files = mergeStrings(existing.files, normalized.files);
    existing.symbols = mergeStrings(existing.symbols, normalized.symbols);
    existing.droppedPaths = mergeDroppedPaths(existing.droppedPaths, normalized.droppedPaths);
    existing.invalidPathCount += normalized.droppedPaths.length;
    existing.representative = strongerAttentionHint(existing.representative, normalized);
  }

  const ranked = [...groups.values()].sort(compareAttentionGroups);
  const selected = selectHumanAttentionGroups(ranked);
  if (raw.length > 0) {
    options.telemetry?.event({
      stage: 10,
      level: "info",
      message: "human_attention_hints_grouped",
      data: {
        rawHints: raw.length,
        rawFollowUpHints: raw.filter((hint) => hint.source === "follow_up_hint").length,
        rawUncertainties: raw.filter((hint) => hint.source === "uncertainty").length,
        eligibleHints,
        groups: ranked.length,
        emitted: selected.notes.length,
        suppressedGroups: selected.omittedCount,
        duplicateHints: Math.max(0, eligibleHints - ranked.length),
        maxHumanAttentionNotes: MAX_HUMAN_ATTENTION_NOTES,
        groupedHints: ranked.map((group, index) => ({
          key: group.key,
          question: group.representative.question,
          count: group.count,
          packets: group.packetIds.size,
          files: capStrings(group.files),
          symbols: capStrings(group.symbols),
          sources: [...group.sources].sort(),
          emitted: index < MAX_HUMAN_ATTENTION_NOTES
        }))
      }
    });
  }
  return { raw, groups: ranked, notes: selected.notes, omittedCount: selected.omittedCount };
}

function rawAttentionHints(
  packetResults: PacketReviewResult[],
  knownPaths: Set<string>,
  telemetry: TelemetryRecorder | undefined
): RawAttentionHint[] {
  const raw: RawAttentionHint[] = [];
  for (const result of packetResults) {
    for (const hint of result.followUpHints) {
      const files = validateAttentionFiles(result.packetId, hint.files, knownPaths, telemetry);
      raw.push({
        id: rawAttentionHintId(result.packetId, "follow_up_hint", hint.question, files.files, hint.symbols),
        source: "follow_up_hint",
        question: hint.question.trim(),
        files: files.files,
        originalFiles: cleanStrings(hint.files),
        droppedPaths: files.dropped,
        symbols: cleanStrings(hint.symbols),
        reason: hint.reason.trim(),
        suggestedLenses: cleanStrings(hint.suggestedLenses),
        confidence: hint.confidence,
        packetId: result.packetId
      });
    }
    for (const uncertainty of result.uncertainties) {
      const files = validateAttentionFiles(result.packetId, uncertainty.files, knownPaths, telemetry);
      raw.push({
        id: rawAttentionHintId(result.packetId, "uncertainty", uncertainty.question, files.files, uncertainty.symbols),
        source: "uncertainty",
        question: uncertainty.question.trim(),
        files: files.files,
        originalFiles: cleanStrings(uncertainty.files),
        droppedPaths: files.dropped,
        symbols: cleanStrings(uncertainty.symbols),
        reason: "Packet reviewer could not resolve this question from the reviewed context.",
        suggestedLenses: [],
        confidence: "medium",
        packetId: result.packetId
      });
    }
  }
  return raw;
}

function knownAttentionPaths(packets: ReviewPacket[], diff: UnifiedDiff | undefined): Set<string> {
  const paths = new Set<string>();
  const add = (value: string | undefined) => {
    const normalized = normalizeAttentionPath(value ?? "");
    if (normalized !== undefined) {
      paths.add(normalized);
    }
  };
  for (const file of diff?.files ?? []) {
    add(file.path);
    add(file.oldPath);
  }
  for (const packet of packets) {
    add(packet.path);
    add(packet.oldPath);
    add(packet.context.path);
    for (const fact of packet.symbolFacts) {
      add(fact.path);
    }
    for (const symbol of packet.relevantTests) {
      add(symbol.path);
    }
    for (const symbol of packet.packetSymbols ?? []) {
      add(symbol.path);
    }
    for (const hint of packet.surroundingContextHints) {
      add(hint.path);
    }
    if (packet.context.enclosingFunction !== undefined) {
      add(packet.context.enclosingFunction.path);
    }
    if (packet.context.enclosingType !== undefined) {
      add(packet.context.enclosingType.path);
    }
    if (packet.context.enclosingMethod !== undefined) {
      add(packet.context.enclosingMethod.path);
    }
  }
  return paths;
}

function validateAttentionFiles(
  packetId: string,
  files: string[],
  knownPaths: Set<string>,
  telemetry: TelemetryRecorder | undefined
): { files: string[]; dropped: Array<{ path: string; reason: string }> } {
  const valid: string[] = [];
  const dropped: Array<{ path: string; reason: string }> = [];
  for (const original of cleanStrings(files)) {
    const validation = validateAttentionPath(original, knownPaths);
    if (validation.validPath !== undefined) {
      valid.push(validation.validPath);
      continue;
    }
    dropped.push({ path: original, reason: validation.reason });
    telemetry?.event({
      stage: 10,
      level: "warn",
      message: "human_attention_note_path_dropped",
      packetId,
      data: {
        originalPath: original,
        reason: validation.reason
      }
    });
  }
  return { files: cleanStrings(valid), dropped };
}

function validateAttentionPath(pathValue: string, knownPaths: Set<string>): { validPath?: string; reason: string } {
  const trimmed = pathValue.trim();
  if (trimmed.length === 0) {
    return { reason: "empty" };
  }
  if (isAbsolutePathLike(trimmed)) {
    return { reason: "absolute_path" };
  }
  const normalized = normalizeAttentionPath(trimmed);
  if (normalized === undefined) {
    return { reason: "invalid_path" };
  }
  if (normalized.split("/").some((part) => part === "..")) {
    return { reason: "traversal" };
  }
  if (knownPaths.size > 0 && !knownPaths.has(normalized)) {
    return { reason: "unknown_path" };
  }
  return { validPath: normalized, reason: "valid" };
}

function normalizeAttentionPath(pathValue: string): string | undefined {
  const normalized = pathValue
    .trim()
    .replace(/\\/gu, "/")
    .replace(/:\d+(?:-\d+)?$/u, "")
    .replace(/^\.\//u, "")
    .replace(/\/{2,}/gu, "/");
  if (normalized.length === 0 || normalized === ".") {
    return undefined;
  }
  return normalized;
}

function isAbsolutePathLike(pathValue: string): boolean {
  return pathValue.startsWith("/") || /^[a-z]:[\\/]/iu.test(pathValue);
}

function rawAttentionHintId(
  packetId: string,
  source: RawAttentionHint["source"],
  question: string,
  files: string[],
  symbols: string[]
): string {
  return `note-${sha256Hex([
    packetId,
    source,
    normalizeFollowUpQuestion(question),
    cleanStrings(files).join(","),
    cleanStrings(symbols).join(",")
  ].join("\0")).slice(0, 12)}`;
}

function selectHumanAttentionGroups(groups: AttentionHintGroup[]): { groups: AttentionHintGroup[]; notes: NeedsHumanAttentionNote[]; omittedCount: number } {
  const emittedGroups = groups.slice(0, MAX_HUMAN_ATTENTION_NOTES);
  const emitted = emittedGroups.map(toAttentionNote);
  return { groups: emittedGroups, notes: emitted, omittedCount: Math.max(0, groups.length - emitted.length) };
}

function selectHumanAttentionForOutput(
  groups: AttentionHintGroup[],
  findings: FinalFinding[],
  packetsById: Map<string, ReviewPacket>,
  verificationResolutions: VerificationResolution[],
  telemetry?: TelemetryRecorder
): HumanAttentionOutput {
  const availableAfterFindings = groups.filter((group) => !findings.some((finding) => attentionGroupCoveredByFinding(group, finding, packetsById)));
  const suppressedByFindingGroups = groups.filter((group) => !availableAfterFindings.includes(group));
  const suppressedByFindings = suppressedByFindingGroups.map(toAttentionNote);
  const verificationSuppression = suppressAttentionGroupsResolvedByVerification(availableAfterFindings, verificationResolutions);
  const selected = selectHumanAttentionGroups(verificationSuppression.available);

  if (suppressedByFindings.length > 0) {
    telemetry?.event({
      stage: 10,
      level: "info",
      message: "human_attention_hints_suppressed_by_findings",
      data: {
        suppressed: suppressedByFindings.length,
        remainingGroups: availableAfterFindings.length
      }
    });
  }
  if (verificationSuppression.suppressed.length > 0) {
    telemetry?.event({
      stage: 10,
      level: "info",
      message: "human_attention_hints_suppressed_by_verification",
      data: {
        suppressed: verificationSuppression.suppressed.length,
        remainingGroups: verificationSuppression.available.length,
        candidates: verificationSuppression.suppressed.map((record) => ({
          candidateId: record.candidateId,
          verdict: record.verdict,
          groupKey: record.groupKey
        }))
      }
    });
  }

  return {
    notes: selected.notes,
    omittedCount: selected.omittedCount,
    suppressedByFindings,
    suppressedByFindingGroups,
    suppressedByVerification: verificationSuppression.suppressed,
    keptGroups: verificationSuppression.available,
    selectedGroups: selected.groups
  };
}

function suppressAttentionGroupsResolvedByVerification(
  groups: AttentionHintGroup[],
  resolutions: VerificationResolution[]
): { available: AttentionHintGroup[]; suppressed: VerificationSuppressionRecord[] } {
  if (resolutions.length === 0) {
    return { available: groups, suppressed: [] };
  }
  const available: AttentionHintGroup[] = [];
  const suppressed: VerificationSuppressionRecord[] = [];
  for (const group of groups) {
    const match = firstVerificationResolutionMatch(group, resolutions);
    if (match === undefined) {
      available.push(group);
      continue;
    }
    suppressed.push({
      groupKey: group.key,
      noteIds: [...group.rawNoteIds].sort(),
      note: toAttentionNote(group),
      candidateId: match.resolution.candidateId,
      verdict: match.resolution.verdict,
      reason: `resolved by stage 9 ${match.resolution.verdict} verdict for ${match.resolution.candidateId}`,
      verdictReason: match.resolution.reason,
      match: {
        sharedFiles: match.sharedFiles,
        sharedSymbols: match.sharedSymbols,
        sharedTerms: match.sharedTerms,
        similarity: match.similarity,
        questionMatched: match.questionMatched
      }
    });
  }
  return { available, suppressed };
}

function firstVerificationResolutionMatch(
  group: AttentionHintGroup,
  resolutions: VerificationResolution[]
): (VerificationResolutionMatch & { resolution: VerificationResolution }) | undefined {
  for (const resolution of resolutions) {
    const match = attentionGroupResolvedByVerification(group, resolution);
    if (match !== undefined) {
      return { ...match, resolution };
    }
  }
  return undefined;
}

type VerificationResolutionMatch = {
  sharedFiles: string[];
  sharedSymbols: string[];
  sharedTerms: number;
  similarity: number;
  questionMatched: boolean;
};

function attentionGroupResolvedByVerification(
  group: AttentionHintGroup,
  resolution: VerificationResolution
): VerificationResolutionMatch | undefined {
  const groupFiles = new Set(group.files.map(normalize).filter(Boolean));
  const resolutionFiles = new Set(resolution.files.map(normalize).filter(Boolean));
  const sharedFiles = sortedIntersection(groupFiles, resolutionFiles);
  if (groupFiles.size > 0 && resolutionFiles.size > 0 && sharedFiles.length === 0) {
    return undefined;
  }

  const groupSymbols = new Set(group.symbols.map(normalize).filter(Boolean));
  const resolutionSymbols = new Set(resolution.symbols.map(normalize).filter(Boolean));
  const sharedSymbols = sortedIntersection(groupSymbols, resolutionSymbols);
  if (sharedFiles.length === 0 && sharedSymbols.length === 0) {
    if (group.invalidPathCount > 0) {
      const groupTerms = normalizedTerms([
        group.representative.question,
        group.representative.reason,
        group.symbols.join(" ")
      ].join(" "));
      const sharedTerms = intersectionCount(groupTerms, resolution.terms);
      const similarity = tokenJaccard(groupTerms, resolution.terms);
      const questionMatched = attentionGroupQuestionKeys(group).some((key) => resolution.questionKeys.has(key));
      return questionMatched || sharedTerms >= 7 || similarity >= 0.55
        ? { sharedFiles, sharedSymbols, sharedTerms, similarity, questionMatched }
        : undefined;
    }
    return undefined;
  }

  const groupTerms = normalizedTerms([
    group.representative.question,
    group.representative.reason,
    group.symbols.join(" ")
  ].join(" "));
  const sharedTerms = intersectionCount(groupTerms, resolution.terms);
  const similarity = tokenJaccard(groupTerms, resolution.terms);
  const questionMatched = attentionGroupQuestionKeys(group).some((key) => resolution.questionKeys.has(key));

  if (sharedFiles.length > 0 && sharedSymbols.length > 0) {
    return questionMatched || sharedTerms >= 3 || similarity >= 0.3
      ? { sharedFiles, sharedSymbols, sharedTerms, similarity, questionMatched }
      : undefined;
  }
  if (sharedSymbols.length > 0) {
    return questionMatched || sharedTerms >= 4 || similarity >= 0.35
      ? { sharedFiles, sharedSymbols, sharedTerms, similarity, questionMatched }
      : undefined;
  }
  return questionMatched || sharedTerms >= 5 || similarity >= 0.45
    ? { sharedFiles, sharedSymbols, sharedTerms, similarity, questionMatched }
    : undefined;
}

function attentionGroupCoveredByFinding(
  group: AttentionHintGroup,
  finding: FinalFinding,
  packetsById: Map<string, ReviewPacket>
): boolean {
  const sharesSymbol = groupSharesFindingSymbol(group, finding, packetsById);
  const sharesFile = groupSharesFindingFile(group, finding);
  if (!sharesSymbol && !sharesFile) {
    if (group.invalidPathCount === 0) {
      return false;
    }
    const groupTerms = normalizedTerms([
      group.representative.question,
      group.representative.reason,
      group.symbols.join(" ")
    ].join(" "));
    const findingTerms = rootCauseTerms(finding);
    const sharedTerms = intersectionCount(groupTerms, findingTerms);
    const similarity = tokenJaccard(groupTerms, findingTerms);
    return sharedTerms >= 7 || similarity >= 0.55;
  }

  const groupTerms = normalizedTerms([
    group.representative.question,
    group.representative.reason,
    group.symbols.join(" ")
  ].join(" "));
  const findingTerms = rootCauseTerms(finding);
  const sharedTerms = intersectionCount(groupTerms, findingTerms);
  const similarity = tokenJaccard(groupTerms, findingTerms);

  if (sharesSymbol) {
    return sharedTerms >= 4 || similarity >= 0.35;
  }
  return sharedTerms >= 5 || similarity >= 0.45;
}

function groupSharesFindingSymbol(
  group: AttentionHintGroup,
  finding: FinalFinding,
  packetsById: Map<string, ReviewPacket>
): boolean {
  const left = new Set(group.symbols.map(normalize).filter(Boolean));
  if (left.size === 0) {
    return false;
  }
  const right = new Set(symbolsForFinding(finding, packetsById).map(normalize).filter(Boolean));
  return right.size > 0 && [...left].some((symbol) => right.has(symbol));
}

function groupSharesFindingFile(group: AttentionHintGroup, finding: FinalFinding): boolean {
  const groupFiles = new Set(group.files.map(normalize).filter(Boolean));
  if (groupFiles.size === 0) {
    return false;
  }
  const findingFiles = new Set([
    finding.path,
    ...(finding.evidence.relatedCode ?? []).map((related) => related.path)
  ].map(normalize).filter(Boolean));
  return [...groupFiles].some((file) => findingFiles.has(file));
}

function buildVerificationResolutionIndex(
  verdicts: VerificationVerdict[],
  packetResults: PacketReviewResult[],
  verifiedFindings: CandidateFinding[],
  packetsById: Map<string, ReviewPacket>,
  coverage: RunCoverageStatus
): VerificationResolution[] {
  if (coverage.verificationSkipped === true || verdicts.length === 0) {
    return [];
  }
  const candidatesById = candidateFindingsById(packetResults, verifiedFindings, verdicts);
  return verdicts.flatMap((verdict): VerificationResolution[] => {
    if (!verdictResolvesPredicate(verdict)) {
      return [];
    }
    const original = candidatesById.get(verdict.candidateId);
    const resolved = verdict.finalFinding ?? original;
    if (original === undefined && resolved === undefined) {
      return [];
    }
    const files = cleanStrings([
      ...(original !== undefined ? candidateFiles(original, packetsById) : []),
      ...(resolved !== undefined ? candidateFiles(resolved, packetsById) : [])
    ]);
    const symbols = cleanStrings([
      ...(original !== undefined ? candidateSymbols(original, packetsById) : []),
      ...(resolved !== undefined ? candidateSymbols(resolved, packetsById) : [])
    ]);
    const normalizedQuestionKeys = new Set([
      ...(original?.provenance !== undefined ? questionKeys(original.provenance.question) : []),
      ...(resolved?.provenance !== undefined ? questionKeys(resolved.provenance.question) : [])
    ]);
    const terms = normalizedTerms([
      original !== undefined ? candidateResolutionText(original) : "",
      resolved !== undefined && resolved !== original ? candidateResolutionText(resolved) : "",
      verdict.reason,
      symbols.join(" ")
    ].join(" "));
    return [{
      candidateId: verdict.candidateId,
      verdict: verdict.verdict,
      reason: verdict.reason,
      files,
      symbols,
      terms,
      questionKeys: normalizedQuestionKeys
    }];
  });
}

function candidateFindingsById(
  packetResults: PacketReviewResult[],
  verifiedFindings: CandidateFinding[],
  verdicts: VerificationVerdict[]
): Map<string, CandidateFinding> {
  const candidates = new Map<string, CandidateFinding>();
  for (const result of packetResults) {
    for (const finding of result.findings) {
      candidates.set(finding.id, finding);
    }
  }
  for (const finding of verifiedFindings) {
    candidates.set(finding.id, finding);
  }
  for (const verdict of verdicts) {
    if (verdict.finalFinding !== undefined) {
      candidates.set(verdict.finalFinding.id, verdict.finalFinding);
    }
  }
  return candidates;
}

function verdictResolvesPredicate(verdict: VerificationVerdict): boolean {
  return verdict.verificationIncomplete !== true &&
    verdict.requiredEvidencePresent === true &&
    !/^verification disabled by config$/iu.test(verdict.reason.trim());
}

function candidateFiles(candidate: CandidateFinding, packetsById: Map<string, ReviewPacket>): string[] {
  const packet = packetsById.get(candidate.producedBy.packetId);
  return cleanStrings([
    candidate.path,
    candidate.anchor?.path ?? "",
    ...(candidate.provenance?.files ?? []),
    packet?.path ?? "",
    packet?.oldPath ?? ""
  ]);
}

function candidateSymbols(candidate: CandidateFinding, packetsById: Map<string, ReviewPacket>): string[] {
  return cleanStrings([
    ...symbolsForFinding(candidate, packetsById),
    ...(candidate.provenance?.symbols ?? [])
  ]);
}

function candidateResolutionText(candidate: CandidateFinding): string {
  return [
    candidate.title,
    candidate.failureMode,
    candidate.whyThisMatters,
    candidate.verification,
    candidate.suggestedFix ?? "",
    candidate.evidence.changedCode,
    ...(candidate.evidence.relatedCode ?? []).flatMap((related) => [related.path, related.lines, related.whyRelevant]),
    candidate.provenance?.question ?? "",
    candidate.provenance?.reason ?? ""
  ].join(" ");
}

function intersectionCount(a: Set<string>, b: Set<string>): number {
  let count = 0;
  for (const value of a) {
    if (b.has(value)) {
      count += 1;
    }
  }
  return count;
}

function sortedIntersection(a: Set<string>, b: Set<string>): string[] {
  return [...a].filter((value) => b.has(value)).sort();
}

function attentionGroupArtifact(group: AttentionHintGroup): Record<string, unknown> {
  return {
    key: group.key,
    noteIds: [...group.rawNoteIds].sort(),
    question: group.representative.question,
    reason: group.representative.reason,
    confidence: group.representative.confidence,
    files: group.files,
    droppedPaths: group.droppedPaths,
    invalidPathCount: group.invalidPathCount,
    symbols: group.symbols,
    packetIds: [...group.packetIds].sort(),
    sources: [...group.sources].sort(),
    count: group.count
  };
}

function rawAttentionHintArtifact(hint: RawAttentionHint): Record<string, unknown> {
  return {
    id: hint.id,
    source: hint.source,
    packetId: hint.packetId,
    question: hint.question,
    reason: hint.reason,
    confidence: hint.confidence,
    files: hint.files,
    originalFiles: hint.originalFiles,
    droppedPaths: hint.droppedPaths,
    symbols: hint.symbols,
    suggestedLenses: hint.suggestedLenses
  };
}

function humanAttentionArtifact(
  attention: HumanAttentionNotes,
  output: HumanAttentionOutput,
  composerPromptGroups: AttentionHintGroup[]
): Record<string, unknown> {
  return {
    schemaVersion: 2,
    notes: attention.raw.map(rawAttentionHintArtifact),
    groups: attention.groups.map(attentionGroupArtifact),
    composerPromptGroupIds: composerPromptGroups.map((group) => group.key),
    outputGroupIds: output.selectedGroups.map((group) => group.key),
    outputNotes: output.notes,
    omittedCount: output.omittedCount,
    suppressedByFindings: output.suppressedByFindingGroups.map((group) => ({
      groupKey: group.key,
      noteIds: [...group.rawNoteIds].sort()
    })),
    suppressedByVerification: output.suppressedByVerification.map((record) => ({
      groupKey: record.groupKey,
      noteIds: record.noteIds,
      candidateId: record.candidateId,
      verdict: record.verdict,
      reason: record.reason,
      verdictReason: record.verdictReason,
      match: record.match
    })),
    keptForOutputGroupIds: output.keptGroups.map((group) => group.key)
  };
}

function toAttentionNote(group: AttentionHintGroup): NeedsHumanAttentionNote {
  return {
    question: group.representative.question,
    files: capStrings(group.files),
    symbols: capStrings(group.symbols),
    reason: group.count > 1
      ? `${group.representative.reason} Grouped from ${group.count} related hints across ${group.packetIds.size} packet${group.packetIds.size === 1 ? "" : "s"}.`
      : group.representative.reason,
    confidence: group.representative.confidence,
    sourcePacketIds: [...group.packetIds].sort()
  };
}

function compareAttentionGroups(a: AttentionHintGroup, b: AttentionHintGroup): number {
  return attentionGroupRank(b) - attentionGroupRank(a) ||
    a.representative.question.localeCompare(b.representative.question) ||
    a.key.localeCompare(b.key);
}

function attentionGroupRank(group: AttentionHintGroup): number {
  const confidenceScore = (2 - confidenceRank(group.representative.confidence)) * 1000;
  const packetScore = Math.min(group.packetIds.size, 5) * 100;
  const duplicateScore = Math.min(group.count, 10) * 10;
  const specificityScore = Math.min(group.files.length, 3) + Math.min(group.symbols.length, 3) + (normalizedQuestionWords(group.representative.question).length >= 6 ? 2 : 0);
  return confidenceScore + packetScore + duplicateScore + specificityScore;
}

function strongerAttentionHint(a: AttentionHint, b: AttentionHint): AttentionHint {
  const confidenceDelta = confidenceRank(a.confidence) - confidenceRank(b.confidence);
  if (confidenceDelta !== 0) {
    return confidenceDelta < 0 ? a : b;
  }
  if (cleanReasonLength(b.reason) > cleanReasonLength(a.reason)) {
    return b;
  }
  return a;
}

function followUpHintKey(hint: AttentionHint): string {
  const exactQuestion = normalizeFollowUpQuestion(hint.question);
  const looseQuestion = normalizeLooseFollowUpQuestion(exactQuestion);
  if (exactQuestion === looseQuestion) {
    return `follow_up|exact|${exactQuestion}`;
  }
  const files = cleanStrings(hint.files).slice(0, 3).join(",");
  const symbols = cleanStrings(hint.symbols).slice(0, 3).join(",");
  return `follow_up|near|${looseQuestion}|files:${files}|symbols:${symbols}`;
}

function normalizeFollowUpQuestion(question: string): string {
  return question.toLowerCase()
    .replace(/[`"'’]/gu, "")
    .replace(/[^a-z0-9_./:-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizeLooseFollowUpQuestion(question: string): string {
  return question
    .replace(/^(please\s+)?(check|confirm|verify|investigate|review)\s+(whether|if|that)?\s*/u, "")
    .replace(/^(whether|if)\s+/u, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function questionKeys(question: string): string[] {
  const exact = normalizeFollowUpQuestion(question);
  const loose = normalizeLooseFollowUpQuestion(exact);
  return [...new Set([exact, loose].filter((key) => key.length > 0))];
}

function attentionGroupQuestionKeys(group: AttentionHintGroup): string[] {
  return questionKeys(group.representative.question);
}

function normalizedQuestionWords(question: string): string[] {
  const normalized = normalizeLooseFollowUpQuestion(normalizeFollowUpQuestion(question));
  return normalized.length === 0 ? [] : normalized.split(" ");
}

function cleanStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))].sort();
}

function capStrings(values: string[]): string[] {
  return values.slice(0, HUMAN_ATTENTION_LOCATION_CAP);
}

function cleanReasonLength(reason: string): number {
  return reason.trim().length;
}

function mergeStrings(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])].sort();
}

function mergeDroppedPaths(
  a: Array<{ path: string; reason: string }>,
  b: Array<{ path: string; reason: string }>
): Array<{ path: string; reason: string }> {
  const byKey = new Map<string, { path: string; reason: string }>();
  for (const item of [...a, ...b]) {
    byKey.set(`${item.path}\0${item.reason}`, item);
  }
  return [...byKey.values()].sort((left, right) => left.path.localeCompare(right.path) || left.reason.localeCompare(right.reason));
}

function strongerConfidence(a: Exclude<Confidence, "low">, b: Exclude<Confidence, "low">): Exclude<Confidence, "low"> {
  return confidenceRank(a) <= confidenceRank(b) ? a : b;
}

function renderReviewBody(
  summary: string,
  summaryOnly: FinalFinding[],
  notes: NeedsHumanAttentionNote[],
  coverage: RunCoverageStatus,
  omittedNoteCount = 0
): string {
  const lines = [summary || "codeninja review completed.", "", ...renderCoverageSummaryLines(coverage).slice(0, 2)];
  const coverageDisclosures = coverageDisclosureLines(coverage);
  if (coverageDisclosures.length > 0) {
    lines.push("", "Coverage disclosure:", ...coverageDisclosures);
  }
  if (summaryOnly.length > 0) {
    lines.push("", "Summary-only findings:");
    for (const finding of summaryOnly) {
      lines.push("", `- ${finding.title} (${finding.path}${finding.anchor ? `:${finding.anchor.line}` : ""})`);
      lines.push(indentBlock(finding.finalBody.trim() || finding.failureMode));
    }
  }
  if (notes.length > 0) {
    lines.push("", "Needs human attention:");
    for (const note of notes) {
      lines.push(`- ${note.question}`);
    }
    if (omittedNoteCount > 0) {
      lines.push(`- Additional unresolved notes suppressed: ${omittedNoteCount}`);
    }
  }
  return lines.join("\n");
}

function indentBlock(text: string): string {
  return text.split(/\r?\n/u).map((line) => `  ${line}`).join("\n");
}

function normalizeFinalBodyForRendering(finalBody: string, finding: CandidateFinding): string {
  const lines = finalBody.replace(/\r\n/g, "\n").split("\n");
  let index = 0;
  let stripped = false;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      index += 1;
      stripped = true;
      continue;
    }
    if (isDuplicateTitleLine(trimmed, finding.title) || isRendererOwnedMetadataLine(trimmed)) {
      index += 1;
      stripped = true;
      continue;
    }
    break;
  }

  const cleaned = lines.slice(index).join("\n").trim();
  const normalized = stripped ? cleaned : finalBody.trim();
  return normalizeUnsupportedIntentFraming(normalized, finding);
}

function normalizeUnsupportedIntentFraming(body: string, finding: CandidateFinding): string {
  if (
    finding.behaviorChange === "accidental_regression" ||
    ((finding.behaviorChange === undefined || finding.behaviorChange === "unknown") && intentEvidenceSupportsAccidentalFraming(finding))
  ) {
    return body;
  }
  if (finding.behaviorChange === undefined && !hasUnsupportedIntentFraming(body)) {
    return body;
  }
  return body
    .replace(/\baccidentally\s+/giu, "")
    .replace(/\baccidental\s+regression\b/giu, "behavior change")
    .replace(/\bsilently\s+(changes?|changed|changing)\s+/giu, "$1 ")
    .replace(/\bcontradicts?\s+(?:the\s+)?(?:declared\s+)?intent\b/giu, "changes the contract")
    .replace(/[ \t]{2,}/gu, " ")
    .trim();
}

function hasUnsupportedIntentFraming(body: string): boolean {
  return /\baccidentally\b|\baccidental\s+regression\b|\bcontradicts?\s+(?:the\s+)?(?:declared\s+)?intent\b|\bsilently\s+(?:changes?|changed|changing)\b/iu.test(body);
}

function intentEvidenceSupportsAccidentalFraming(finding: CandidateFinding): boolean {
  return (finding.intentEvidence ?? []).some((entry) =>
    /\b(no\s+behaviou?r\s+change|behaviou?r[-\s]?preserving|preserve\s+(?:existing\s+)?behaviou?r|no\s+semantic\s+change|semantically\s+equivalent|refactor)\b/iu.test(entry)
  );
}

function isDuplicateTitleLine(line: string, title: string): boolean {
  const withoutHeading = line.replace(/^#{1,6}\s+/u, "");
  const withoutTitleLabel = withoutHeading.replace(/^title\s*:\s*/iu, "");
  const withoutSeverityPrefix = withoutTitleLabel.replace(/^(?:critical|high|medium|low)\s*:\s*/iu, "");
  return normalizeBodyPrefix(withoutSeverityPrefix) === normalizeBodyPrefix(title);
}

function isRendererOwnedMetadataLine(line: string): boolean {
  const normalized = line
    .replace(/^[-*]\s+/u, "")
    .replace(/\*\*/gu, "")
    .replace(/`/gu, "")
    .trim();
  if (/^(?:severity|confidence|category)\s*:/iu.test(normalized)) {
    return true;
  }
  const parts = normalized.split(/\s*(?:[|·•]|,\s*)\s*/u).filter(Boolean);
  if (parts.length > 1) {
    return parts.every(isRendererOwnedMetadataPart);
  }
  return isRendererOwnedMetadataPart(normalized);
}

function isRendererOwnedMetadataPart(part: string): boolean {
  if (/^(?:severity|confidence|category)\s*:/iu.test(part)) {
    return true;
  }
  const file = /^file\s*:\s*(.+)$/iu.exec(part);
  return file !== null && looksLikeFileLocation(file[1] ?? "");
}

function looksLikeFileLocation(value: string): boolean {
  const trimmed = value.trim();
  if (/\s/u.test(trimmed)) {
    return false;
  }
  return /^[\w@./\\ -]+(?::\d+)?(?:-\d+)?$/u.test(trimmed) && (
    /[./\\]/u.test(trimmed) ||
    /:\d+(?:-\d+)?$/u.test(trimmed)
  );
}

function normalizeBodyPrefix(text: string): string {
  return text
    .replace(/[*_`~]/gu, "")
    .replace(/[.:;,\s]+$/u, "")
    .trim()
    .replace(/\s+/gu, " ")
    .toLowerCase();
}

function templateBody(finding: CandidateFinding, groupedFindings: CandidateFinding[] = [finding]): string {
  const evidenceLines = mergedEvidenceLines(finding, groupedFindings);
  return [
    `Impact: ${finding.failureMode}`,
    finding.whyThisMatters,
    "",
    "Evidence:",
    ...evidenceLines,
    finding.suggestedFix ? "" : undefined,
    finding.suggestedFix ? `Suggested fix: ${finding.suggestedFix}` : undefined,
    finding.suggestedTest ? `Suggested test: ${finding.suggestedTest}` : undefined
  ]
    .filter((line): line is string => line !== undefined && line.length > 0)
    .join("\n");
}

function mergedEvidenceLines(representative: CandidateFinding, groupedFindings: CandidateFinding[]): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  const add = (line: string) => {
    const normalized = normalizeSnippet(line);
    if (normalized.length === 0 || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    lines.push(`- ${line}`);
  };
  add(`Changed code: ${compactEvidence(representative.evidence.changedCode)}`);
  for (const related of representative.evidence.relatedCode ?? []) {
    add(`${related.path}: ${compactEvidence(related.lines)} (${related.whyRelevant})`);
  }
  for (const finding of groupedFindings) {
    if (finding.id === representative.id) {
      continue;
    }
    add(`Also reported in ${finding.path}${finding.anchor ? `:${finding.anchor.line}` : ""}: ${compactEvidence(finding.evidence.changedCode)}`);
    for (const related of finding.evidence.relatedCode ?? []) {
      add(`${related.path}: ${compactEvidence(related.lines)} (${related.whyRelevant})`);
    }
  }
  return lines.length > 0 ? lines : ["- Evidence was present in the reviewed diff."];
}

function compactEvidence(text: string): string {
  const compact = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
  return compact.length > 240 ? `${compact.slice(0, 237)}...` : compact;
}

function fingerprintFinding(finding: CandidateFinding, packetsById: Map<string, ReviewPacket> = new Map()): string {
  return sha256Hex([
    normalize(finding.path),
    normalize(fingerprintLocationIdentity(finding, packetsById)),
    normalize(finding.category),
    normalize(finding.producedBy.lensId)
  ].join("\0"));
}

function fingerprintLocationIdentity(finding: CandidateFinding, packetsById: Map<string, ReviewPacket>): string {
  const packet = packetsById.get(finding.producedBy.packetId);
  const hunkId = finding.anchor?.hunkId ?? inferredHunkId(finding, packet);
  const symbol = hunkId !== undefined ? symbolForHunk(packet, hunkId) : uniquePacketSymbol(packet);
  if (symbol !== undefined) {
    return symbol;
  }
  if (hunkId !== undefined) {
    return hunkId;
  }
  return packet?.id ?? finding.producedBy.packetId;
}

function inferredHunkId(finding: CandidateFinding, packet: ReviewPacket | undefined): string | undefined {
  if (!packet) {
    return undefined;
  }
  const matching = matchingEvidenceHunks(finding, packet);
  if (matching.length === 1) {
    return matching[0]?.hunkId;
  }
  if (matching.length > 1) {
    return undefined;
  }
  return packet.hunks.length === 1 ? packet.hunks[0]?.hunkId : undefined;
}

function matchingEvidenceHunks(finding: CandidateFinding, packet: ReviewPacket | undefined): ReviewPacket["hunks"] {
  if (!packet) {
    return [];
  }
  const needle = normalizeSnippet(finding.evidence.changedCode);
  if (needle.length === 0) {
    return [];
  }
  return packet.hunks.filter((hunk) => {
    const haystack = normalizeSnippet(hunk.lines.map((line) => line.content).join("\n"));
    return haystack.length > 0 && (haystack.includes(needle) || needle.includes(haystack));
  });
}

function symbolForHunk(packet: ReviewPacket | undefined, hunkId: string): string | undefined {
  const symbols = [...new Set(
    (packet?.symbolFacts ?? [])
      .filter((fact) => fact.hunkId === hunkId)
      .map((fact) => fact.enclosingSymbol)
      .filter((symbol): symbol is string => symbol !== undefined && symbol.trim().length > 0)
  )];
  return symbols.length === 1 ? symbols[0] : undefined;
}

function uniquePacketSymbol(packet: ReviewPacket | undefined): string | undefined {
  const symbols = [...new Set(
    (packet?.symbolFacts ?? [])
      .map((fact) => fact.enclosingSymbol)
      .filter((symbol): symbol is string => symbol !== undefined && symbol.trim().length > 0)
  )];
  return symbols.length === 1 ? symbols[0] : undefined;
}

function normalizeSnippet(input: string): string {
  return input
    .split(/\r?\n/u)
    .map((line) => line.replace(/^\s*[+-]\s?/u, "").trim())
    .join("\n")
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .trim();
}

function strongest(findings: CandidateFinding[]): CandidateFinding {
  const sorted = [...findings].sort(compareFindings);
  const first = sorted[0];
  if (!first) {
    throw new Error("cannot choose representative from empty finding group");
  }
  return first;
}

function compareFindings(
  a: Pick<CandidateFinding, "severity" | "confidence" | "id" | "anchor">,
  b: Pick<CandidateFinding, "severity" | "confidence" | "id" | "anchor">
): number {
  return severityRank(a.severity) - severityRank(b.severity) ||
    confidenceRank(a.confidence) - confidenceRank(b.confidence) ||
    anchorLineRank(a) - anchorLineRank(b) ||
    a.id.localeCompare(b.id);
}

function anchorLineRank(finding: Pick<CandidateFinding, "anchor">): number {
  return finding.anchor?.line ?? Number.POSITIVE_INFINITY;
}

function severityRank(severity: Severity): number {
  return { critical: 0, high: 1, medium: 2, low: 3 }[severity];
}

function confidenceRank(confidence: Confidence): number {
  return { high: 0, medium: 1, low: 2 }[confidence];
}

function belowConfidence(actual: Confidence, minimum: Confidence): boolean {
  return confidenceRank(actual) > confidenceRank(minimum);
}

function belowSeverity(actual: Severity, minimum: Severity | undefined): boolean {
  return minimum !== undefined && severityRank(actual) > severityRank(minimum);
}

function normalize(input: string): string {
  return input.toLowerCase().replace(/\s+/gu, " ").trim();
}
