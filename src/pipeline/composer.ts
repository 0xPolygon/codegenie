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
import { isFatalLlmError, validateAnchorForDiff } from "./pipeline-utils.js";

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

const MAX_COMPOSER_FINDINGS = 40;
const MAX_HUMAN_ATTENTION_NOTES = 8;
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
  const notes = needsHumanAttention(opts.packetResults ?? [], telemetry);
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
  let compositionDegraded = false;
  const composition = await runComposer(groups, plan, coverage, config, telemetry, opts, notes).catch((error) => {
    if (isFatalLlmError(error)) {
      throw error;
    }
    fallbackUsed = true;
    telemetry.event({
      stage: 10,
      level: "warn",
      message: "composer fallback used",
      data: { error: error instanceof Error ? error.message : String(error) }
    });
    coverage.reasons.push("semantic composition skipped; deterministic fallback used");
    return fallbackComposition(groups);
  });

  const known = new Map(pretrim.kept.map((finding) => [finding.id, finding]));
  const anchorDowngradeReasons = new Map<string, string>();
  const finalFindings: FinalFinding[] = pretrim.suppressed.map((finding) => {
    const requestedPublication = "suppressed" as const;
    const final = toFinalFinding(finding, fingerprintFinding(finding, packetsById), templateBody(finding), requestedPublication, [finding.id], opts.diff);
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
    const final = toFinalFinding(representative, fingerprint, composed.finalBody, composed.publication, ids, opts.diff);
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
    const final = toFinalFinding(finding, fingerprint, templateBody(finding), requestedPublication, [finding.id], opts.diff);
    recordAnchorDowngrade(final, requestedPublication, anchorDowngradeReasons);
    finalFindings.push(final);
    baseSelection.set(finding.id, { findingId: finding.id, decision: "published", reason: "composer_omitted_finding" });
    compositionDegraded = true;
  }

  const capped = applyCaps(finalFindings, config);
  for (const [id, reason] of anchorDowngradeReasons) {
    if (!capped.downgradeReasons.has(id)) {
      capped.downgradeReasons.set(id, reason);
    }
  }
  const selection = buildSelectionRecords(capped.findings, baseSelection, capped.suppressedReasons, capped.downgradeReasons);
  const findings = capped.findings.filter((finding) => finding.publication === "inline");
  const summaryOnlyFindings = capped.findings.filter((finding) => finding.publication === "summary-only");
  const publishableCount = findings.length + summaryOnlyFindings.length;
  const summary = publishableCount === 0
    ? fallbackSummary(0)
    : fallbackUsed || compositionDegraded || isNoFindingsSummary(composition.summary)
      ? fallbackSummary(publishableCount)
      : composition.summary || fallbackSummary(publishableCount);
  const createPostingPlan = opts.postGithubComments === true && (publishableCount > 0 || config.github.summaryWhenNoFindings);
  const result: ReviewResult = {
    summary,
    coverage,
    findings,
    summaryOnlyFindings,
    needsHumanAttention: notes,
    noFindings: findings.length === 0 && summaryOnlyFindings.length === 0,
    ...(createPostingPlan
      ? {
          postingPlan: {
            inline: findings.flatMap((finding) => (finding.anchor ? [{ findingId: finding.id, anchor: finding.anchor }] : [])),
            reviewBody: renderReviewBody(summary, summaryOnlyFindings, notes, coverage)
          }
        }
      : {})
  };

  await telemetry.writeArtifact("final-selection.json", {
    records: selection,
    groups: groups.map((group) => ({
      fingerprint: group.fingerprint,
      findingIds: group.findings.map((finding) => finding.id)
    }))
  });
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
        finalFindings: capped.findings.length
      }
    }
  });
  telemetry.event({ stage: 10, level: "info", message: "stage_completed", data: { finalFindings: capped.findings.length } });
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
    intent: `Declared intent: ${plan.diffUnderstanding.declaredIntent}\nInferred behavior: ${plan.diffUnderstanding.inferredBehavior}`,
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
  mergedCandidateIds: string[],
  diff: UnifiedDiff | undefined
): FinalFinding {
  const { anchor: _unvalidatedAnchor, ...findingWithoutAnchor } = finding;
  const anchor = validateAnchorForDiff(finding.anchor, diff);
  return {
    ...findingWithoutAnchor,
    ...(anchor !== undefined ? { anchor } : {}),
    changedLine: anchor !== undefined,
    fingerprint,
    finalBody,
    publication: publication === "suppressed" ? "suppressed" : anchor ? publication : "summary-only",
    mergedCandidateIds: [...new Set(mergedCandidateIds)]
  };
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

function applyCaps(findings: FinalFinding[], config: CodeninjaConfig): { findings: FinalFinding[]; suppressedReasons: Map<string, string>; downgradeReasons: Map<string, string> } {
  const suppressedReasons = new Map<string, string>();
  const downgradeReasons = new Map<string, string>();
  const ranked = [...findings].sort(compareFindings);
  const thresholded = ranked.map((finding) => {
    if (belowSeverity(finding.severity, config.review.minSeverity)) {
      suppressedReasons.set(finding.id, "severity-threshold");
      return { ...finding, publication: "suppressed" as const };
    }
    if (belowConfidence(finding.confidence, config.review.minConfidence)) {
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

type AttentionHint = Omit<PacketReviewResult["followUpHints"][number], "confidence"> & {
  confidence: Exclude<Confidence, "low">;
  packetId: string;
};

type AttentionHintGroup = {
  key: string;
  representative: AttentionHint;
  files: string[];
  symbols: string[];
  packetIds: Set<string>;
  count: number;
};

function needsHumanAttention(packetResults: PacketReviewResult[], telemetry?: TelemetryRecorder): NeedsHumanAttentionNote[] {
  const groups = new Map<string, AttentionHintGroup>();
  let rawHints = 0;
  let eligibleHints = 0;

  for (const result of packetResults) {
    for (const hint of result.followUpHints) {
      rawHints += 1;
      const confidence = hint.confidence;
      if (confidence === "low") {
        continue;
      }
      const question = hint.question.trim();
      if (question.length === 0) {
        continue;
      }
      eligibleHints += 1;
      const normalized: AttentionHint = {
        question,
        files: cleanStrings(hint.files),
        symbols: cleanStrings(hint.symbols),
        reason: hint.reason.trim(),
        suggestedLenses: hint.suggestedLenses,
        confidence,
        packetId: result.packetId
      };
      const key = followUpHintKey(normalized);
      const existing = groups.get(key);
      if (!existing) {
        groups.set(key, {
          key,
          representative: normalized,
          files: normalized.files,
          symbols: normalized.symbols,
          packetIds: new Set([result.packetId]),
          count: 1
        });
        continue;
      }
      existing.count += 1;
      existing.packetIds.add(result.packetId);
      existing.files = mergeStrings(existing.files, normalized.files);
      existing.symbols = mergeStrings(existing.symbols, normalized.symbols);
      existing.representative = strongerAttentionHint(existing.representative, normalized);
    }
  }

  const ranked = [...groups.values()].sort(compareAttentionGroups);
  const emitted = ranked.slice(0, MAX_HUMAN_ATTENTION_NOTES).map(toAttentionNote);
  if (rawHints > 0) {
    telemetry?.event({
      stage: 10,
      level: "info",
      message: "human_attention_hints_grouped",
      data: {
        rawHints,
        eligibleHints,
        groups: ranked.length,
        emitted: emitted.length,
        suppressedGroups: Math.max(0, ranked.length - emitted.length),
        duplicateHints: Math.max(0, eligibleHints - ranked.length),
        maxHumanAttentionNotes: MAX_HUMAN_ATTENTION_NOTES,
        groupedHints: ranked.map((group, index) => ({
          key: group.key,
          question: group.representative.question,
          count: group.count,
          packets: group.packetIds.size,
          files: capStrings(group.files),
          symbols: capStrings(group.symbols),
          emitted: index < MAX_HUMAN_ATTENTION_NOTES
        }))
      }
    });
  }
  return emitted;
}

function toAttentionNote(group: AttentionHintGroup): NeedsHumanAttentionNote {
  return {
    question: group.representative.question,
    files: capStrings(group.files),
    symbols: capStrings(group.symbols),
    reason: group.count > 1
      ? `${group.representative.reason} Grouped from ${group.count} related hints across ${group.packetIds.size} packet${group.packetIds.size === 1 ? "" : "s"}.`
      : group.representative.reason,
    confidence: group.representative.confidence
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

function strongerConfidence(a: Exclude<Confidence, "low">, b: Exclude<Confidence, "low">): Exclude<Confidence, "low"> {
  return confidenceRank(a) <= confidenceRank(b) ? a : b;
}

function renderReviewBody(
  summary: string,
  summaryOnly: FinalFinding[],
  notes: NeedsHumanAttentionNote[],
  coverage: RunCoverageStatus
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
  }
  return lines.join("\n");
}

function indentBlock(text: string): string {
  return text.split(/\r?\n/u).map((line) => `  ${line}`).join("\n");
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
