import { deriveReviewHealth, factualReviewSummary, renderReviewHealth } from "../util/review-health.js";
import { createCompositionAttributionRepair, normalizeCompositionReferences } from "./composition-repair.js";
import { attentionResolutionErrors, buildAttentionReconciliation, createAttentionResolutionRepair, reconcileAttention, type AttentionReconciliation } from "./attention-reconciliation.js";
import { type CompositionMetrics, eligibleCompositionSource, compositionSources, composePresentation, safeReportProse, validateCompositionSubmission, renderRetainedComposition } from "./composition-content.js";
import type { LlmRunner } from "../llm/llm-runner.js";
import { SubmitCompositionSchema, type SubmitComposition } from "../llm/schemas.js";
import type { PromptBuilder } from "../skills/prompt-builder.js";
import type { TelemetryRecorder } from "../telemetry/telemetry-recorder.js";
import { scrubGitHubSecrets } from "../github/comment-sanitizer.js";
import type {
  CandidateFinding,
  Confidence,
  CodegenieConfig,
  DiffAnchor,
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
import { coverageDisclosureLines, renderCoverageSummaryLines, renderCoverageTrustBanner } from "../util/coverage-summary.js";
import { codeBlock, fenceLanguageForPath, inlineCode, severityBadge } from "../util/markdown.js";
import { sha256Hex } from "../util/hashing.js";
import { isCompositionTestPath, isDocsPath } from "../util/path-roles.js";
import { normalizedTerms, tokenJaccard } from "../util/text-similarity.js";
import { isBudgetExhaustedError, isRecoverableLlmError, isSchemaInvalidError, validateAnchorForDiff } from "./pipeline-utils.js";
import { summarizeIntentSignals } from "./intent-signals.js";
import { hasCriticalOrHighGuarantee } from "./severity-policy.js";
import type { LlmSchemaInvalidSubmitRecoveryInput, LlmSchemaRepairInput } from "../llm/llm-runner.js";
import {
  buildHumanAttentionNotes,
  humanAttentionArtifact,
  selectHumanAttentionForOutput,
  selectHumanAttentionGroups,
  MAX_HUMAN_ATTENTION_NOTES
} from "./human-attention.js";

type ComposeOptions = {
  runner: LlmRunner;
  promptBuilder: PromptBuilder;
  packetResults?: PacketReviewResult[];
  packets?: ReviewPacket[];
  postGithubComments?: boolean;
  diff?: UnifiedDiff;
  repositoryPaths?: readonly string[];
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

type CompositionMode = "llm" | "llm_degraded" | "deterministic_fallback" | "schema_repair_fallback";
type PublicationAnchorDecision = {
  anchor?: DiffAnchor;
  source: "selected" | "merged" | "none";
  reason: string;
  sourceFindingId?: string;
};
type PublicationAnchorCandidate = {
  finding: CandidateFinding;
  anchor: DiffAnchor;
};

const MAX_COMPOSER_FINDINGS = 40;
const MAX_COMPOSER_SUMMARY_CHARS = 4000;
const CROSS_FILE_EVIDENCE_LINK_SIMILARITY = 0.42;

export async function dedupeRankAndComposeReview(
  verified: { verified: CandidateFinding[]; verdicts: VerificationVerdict[] },
  plan: ReviewPlan,
  resolved: ResolvedReviewInput,
  coverage: RunCoverageStatus,
  config: CodegenieConfig,
  telemetry: TelemetryRecorder,
  opts: ComposeOptions
): Promise<ReviewResult> {
  const link = evidenceLinker(resolved);
  const presentationMeasurements: Array<{ findingIds: string[]; synthesis: "composed" | "fallback"; metrics: CompositionMetrics }> = [];
  const recordPresentation = (findingIds: string[], synthesis: "composed" | "fallback", metrics: CompositionMetrics) => {
    presentationMeasurements.push({ findingIds, synthesis, metrics });
    telemetry.event({ stage: 10, level: "info", message: "composition_presentation_metrics", data: { findingIds, synthesis, ...metrics } });
  };
  telemetry.event({ stage: 10, level: "info", message: "stage_started", data: { verified: verified.verified.length } });
  const packetsById = new Map((opts.packets ?? []).map((packet) => [packet.id, packet]));
  const publishable = verified.verified.map((candidate) => withholdRepresentativeAnchor(candidate, telemetry));
  const pretrim = pretrimComposerInput(publishable);
  const groups = groupFindings(pretrim.kept, packetsById);
  const attention = buildHumanAttentionNotes(opts.packetResults ?? [], {
    packets: opts.packets ?? [],
    ...(opts.repositoryPaths !== undefined ? { repositoryPaths: opts.repositoryPaths } : {}),
    ...(opts.diff !== undefined ? { diff: opts.diff } : {}),
    telemetry
  });
  const preComposerAttentionGroups = attention.groups;
  const composerPromptSelection = selectHumanAttentionGroups(preComposerAttentionGroups);
  const composerPromptNotes = composerPromptSelection.notes;
  const attentionReconciliation = buildAttentionReconciliation(verified.verdicts, pretrim.kept, opts.packetResults ?? [], resolved, attention.raw);
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
  let fallbackMode: CompositionMode | undefined;
  let compositionDegraded = false;
  const composition = await runComposer(groups, plan, coverage, config, telemetry, opts, composerPromptNotes, attentionReconciliation).catch((error) => {
    if (!canUseComposerFallback(error)) {
      telemetry.event({
        stage: 10,
        level: "error",
        message: "stage_failed",
        data: composerFailureTelemetry(error, groups)
      });
      throw error;
    }
    fallbackUsed = true;
    fallbackMode = isSchemaInvalidError(error) ? "schema_repair_fallback" : "deterministic_fallback";
    fallbackReason = composerFallbackCoverageReason(fallbackMode);
    telemetry.event({
      stage: 10,
      level: "warn",
      message: "composer_fallback_used",
      data: composerFallbackTelemetry(error, groups, fallbackReason, fallbackMode)
    });
    coverage.reasons.push(fallbackReason);
    return fallbackComposition(groups, link);
  });

  const known = new Map(pretrim.kept.map((finding) => [finding.id, finding]));
  const anchorDowngradeReasons = new Map<string, string>();
  const publicationAnchorDecisions = new Map<string, PublicationAnchorDecision>();
  const confidenceSelections = new Map<string, ConfidenceSelection & { representativeConfidence: Confidence }>();
  const finalFindings: FinalFinding[] = pretrim.suppressed.map((finding) => {
    const requestedPublication = "suppressed" as const;
    const final = toFinalFinding(finding, fingerprintFinding(finding, packetsById), templateBody(finding, [finding], link), requestedPublication, [finding], opts.diff, publicationAnchorDecisions, confidenceSelections, link, false, metrics => recordPresentation([finding.id], "fallback", metrics), pretrim.kept);
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
    const mergedFindings = ids.map((id) => known.get(id)).filter((finding): finding is CandidateFinding => finding !== undefined);
    const representative = canonicalMergedRepresentative(mergedFindings, opts.diff);
    const fingerprint = fingerprintFinding(representative, packetsById);
    let body = composed.finalBody ?? "";
    let attributed = false;
    if (composed.sections !== undefined || composed.evidenceRefs !== undefined) {
      try {
        const presentation = composePresentation(mergedFindings, (composed.sections ?? []).map(section => ({ ...section, text: normalizeFinalBodyForRendering(section.text, representative) })), composed.evidenceRefs ?? [], link, composed, pretrim.kept);
        body = presentation.body;
        recordPresentation(ids, "composed", presentation.metrics);
        attributed = true;
        telemetry.event({ stage: 10, level: "info", message: "composition_sources_accounted", data: { findingIds: ids, sections: composed.sections, evidenceRefs: composed.evidenceRefs, semanticPreservation: "not_machine_proven" } });
      } catch (error) {
        compositionDegraded = true;
        body = templateBody(representative, mergedFindings, link);
        telemetry.event({ stage: 10, level: "warn", message: "composition_source_validation_failed", data: { findingIds: ids, error: String(error) } });
      }
    } else {
      // Legacy outputs remain readable, but lack component-level attribution.
      compositionDegraded = true;
      telemetry.event({ stage: 10, level: "warn", message: "composition_legacy_content_fallback", data: { findingIds: ids } });
    }
    const final = toFinalFinding(representative, fingerprint, body, composed.publication, mergedFindings, opts.diff, publicationAnchorDecisions, confidenceSelections, link, attributed, metrics => recordPresentation(ids, "fallback", metrics), pretrim.kept);
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
    const final = toFinalFinding(finding, fingerprint, templateBody(finding, [finding], link), requestedPublication, [finding], opts.diff, publicationAnchorDecisions, confidenceSelections, link, false, metrics => recordPresentation([finding.id], "fallback", metrics), pretrim.kept);
    recordAnchorDowngrade(final, requestedPublication, anchorDowngradeReasons);
    finalFindings.push(final);
    baseSelection.set(finding.id, { findingId: finding.id, decision: "published", reason: "composer_omitted_finding" });
    compositionDegraded = true;
  }

  // Distinct diagnoses at one structural location must not share a posting
  // identity, or GitHub duplicate suppression can hide one of them. Ordinary
  // fingerprints retain their existing wording-independent identity.
  const fingerprintCounts = new Map<string, number>();
  for (const finding of finalFindings) fingerprintCounts.set(finding.fingerprint, (fingerprintCounts.get(finding.fingerprint) ?? 0) + 1);
  for (const finding of finalFindings) {
    if (fingerprintCounts.get(finding.fingerprint)! < 2) continue;
    finding.fingerprint = sha256Hex([finding.fingerprint, normalize(finding.evidence.changedCode),
      [...normalizedTerms(finding.failureMode)].sort().join(" ")].join("\0"));
    for (const id of finding.mergedCandidateIds) {
      const selection = baseSelection.get(id);
      if (selection?.decision === "merged") selection.mergedIntoFingerprint = finding.fingerprint;
    }
  }
  const lowConfidencePublishableIds = lowConfidencePublishableCandidateIds(verified.verdicts);
  const capped = applyCaps(finalFindings, config, {
    lowConfidencePublishableIds,
    telemetry
  });
  const compositionMode: CompositionMode = fallbackMode ?? (fallbackUsed ? "deterministic_fallback" : compositionDegraded ? "llm_degraded" : "llm");
  recordMergedAnchorRecoveries(capped.findings, publicationAnchorDecisions, telemetry);
  for (const [id, reason] of anchorDowngradeReasons) {
    if (!capped.downgradeReasons.has(id)) {
      capped.downgradeReasons.set(id, reason);
    }
  }
  const selection = buildSelectionRecords(capped.findings, baseSelection, capped.suppressedReasons, capped.downgradeReasons);
  const findings = capped.findings.filter((finding) => finding.publication === "inline");
  const summaryOnlyFindings = capped.findings.filter((finding) => finding.publication === "summary-only");
  const publishableCount = findings.length + summaryOnlyFindings.length;
  const reconciledAttention = reconcileAttention(attentionReconciliation, composition.attentionResolutions,
    compositionMode === "llm");
  const decisionsByHint = new Map(reconciledAttention.decisions.filter(decision => decision.accepted).map(decision => [decision.concernId, decision]));
  const regroupedAttention = buildHumanAttentionNotes([], { packets: opts.packets ?? [], rawHints: attention.raw.flatMap(hint => {
    const decision = decisionsByHint.get(`packet/${hint.id}`);
    return decision?.disposition === "resolved" ? [] : [{ ...hint, question: decision?.remainingQuestion ?? hint.question }];
  }) });
  const humanAttention = selectHumanAttentionForOutput(
    regroupedAttention.groups,
    [], // Finding overlap alone does not establish that every question was answered.
    packetsById,
    [], // Packet questions require explicit evidence-backed reconciliation, not verdict/word similarity.
    telemetry
  );
  const verifierQuestions = new Set(reconciledAttention.outcomes.filter(outcome => !outcome.candidateId.startsWith("packet:")).map(outcome => outcome.remainingQuestion));
  for (const note of reconciledAttention.notes.filter(note => verifierQuestions.has(note.question))) {
    if (!humanAttention.notes.some(existing => existing.question === note.question)) humanAttention.notes.push(note);
  }
  telemetry.event({ stage: 10, level: "info", message: "human_attention_reconciliation", data: {
    suppliedConcerns: attentionReconciliation.inventory.concerns.length,
    evidenceSelection: attentionReconciliation.selection,
    suppliedEvidence: attentionReconciliation.inventory.evidence.length,
    omittedConcerns: attentionReconciliation.omittedConcernIds.length,
    omittedEvidence: attentionReconciliation.omittedEvidenceIds.length,
    excludedEvidence: attentionReconciliation.excludedEvidenceIds.length,
    accepted: reconciledAttention.decisions.filter(decision => decision.accepted).length,
    assessedUnresolved: reconciledAttention.decisions.filter(decision => decision.accepted && decision.disposition === "unresolved").length,
    missingDecisions: attentionReconciliation.inventory.concerns.filter(concern => !reconciledAttention.decisions.some(decision => decision.concernId === concern.id)).length,
    rejected: reconciledAttention.decisions.filter(decision => !decision.accepted).length,
    resolvedConcernIds: reconciledAttention.decisions.filter(decision => decision.accepted && decision.disposition === "resolved").map(decision => decision.concernId).slice(0, 30),
    narrowedConcernIds: reconciledAttention.decisions.filter(decision => decision.accepted && decision.disposition === "narrowed").map(decision => decision.concernId).slice(0, 30)
  } });
  // Publication policy must not affect defect selection: an unverified proposed
  // test can still describe a confirmation path used by the existing gates.
  for (const finding of capped.findings) {
    const fallbackPresentation = presentationMeasurements.find(record => record.synthesis === "fallback" && record.findingIds.includes(finding.id));
    publishSupportedSuggestions(finding, pretrim.kept, fallbackPresentation?.metrics.publishedSuggestionSources);
  }
  // Explicitly answering every retained question can finish an evidence handoff.
  // This never rescues a worker that failed to complete its required review.
  if (coverage.diagnostics) coverage.diagnostics = coverage.diagnostics.filter(diagnostic => {
    if (diagnostic.origin !== "tool" || !diagnostic.workItem) return true;
    if (diagnostic.stage === 7 && !opts.packetResults?.some(packet => packet.packetId === diagnostic.workItem && packet.status === "completed")) return true;
    const key = diagnostic.stage === 7 ? `packet:${diagnostic.workItem}` : diagnostic.workItem;
    const groups = attentionReconciliation.groups.filter(group => group.candidateId === key);
    const answered = groups.length > 0 && groups.every(group => !group.ineligibleReason && group.concerns.length > 0 && group.concerns.every(concern => decisionsByHint.get(concern.id)?.disposition === "resolved"));
    if (answered) telemetry.event({ stage: 10, level: "info", message: "tool_evidence_limitation_reconciled", data: { diagnostic, concernIds: groups.flatMap(group => group.concerns.map(concern => concern.id)) } });
    return !answered;
  });
  const unresolvedCount = humanAttention.notes.length + humanAttention.omittedCount;
  if (humanAttention.notes.length > MAX_HUMAN_ATTENTION_NOTES) {
    humanAttention.omittedCount += humanAttention.notes.length - MAX_HUMAN_ATTENTION_NOTES;
    humanAttention.notes = humanAttention.notes.slice(0, MAX_HUMAN_ATTENTION_NOTES);
  }
  const health = deriveReviewHealth(coverage, unresolvedCount, verified.verified.length > 0);
  const summary = health.status !== "completed" ? factualReviewSummary(health, publishableCount) : publishableCount === 0
    ? coverage.partial
      ? "Review incomplete: completed work produced no credible verified findings, but incomplete coverage or verification prevents a clean conclusion."
      : fallbackSummary(0)
    : fallbackUsed || compositionDegraded || isNoFindingsSummary(composition.summary) || summaryCountConflicts(composition.summary, publishableCount)
      ? fallbackSummary(publishableCount)
      : safeReportProse(composition.summary) || fallbackSummary(publishableCount);
  const createPostingPlan = opts.postGithubComments === true && (publishableCount > 0 || config.github.summaryWhenNoFindings);
  const compositionOutcome = { mode: compositionMode, ...(fallbackReason ? { fallbackReason } : {}) };
  const result: ReviewResult = {
    composition: compositionOutcome,
    summary,
    health,
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
            reviewBody: renderReviewBody(summary, summaryOnlyFindings, humanAttention.notes, coverage, humanAttention.omittedCount, health, compositionOutcome)
          }
        }
      : {})
  };

  await telemetry.writeArtifact("composition-sources.json", scrubGitHubSecrets({
    schemaVersion: 1,
    mode: compositionMode,
    semanticPreservation: "not_machine_proven",
    sourceComponents: compositionSources(pretrim.kept),
    proposals: composition.composedFindings,
    dispositions: selection,
    presentationMeasurements
  }));
  await telemetry.writeArtifact("final-selection.json", {
    composition: {
      mode: compositionMode,
      ...(fallbackReason !== undefined ? { fallbackReason } : {})
    },
    records: selection,
    publicationAnchors: publicationAnchorSelectionRecords(capped.findings, publicationAnchorDecisions),
    confidenceSelections: [...confidenceSelections.entries()]
      .map(([findingId, selection]) => ({ findingId, ...selection }))
      .sort((left, right) => left.findingId.localeCompare(right.findingId)),
    groups: groups.map((group) => ({
      fingerprint: group.fingerprint,
      findingIds: group.findings.map((finding) => finding.id)
    }))
  });
  await telemetry.writeArtifact("human-attention-notes.json", scrubGitHubSecrets(
    { ...humanAttentionArtifact(attention, humanAttention, composerPromptSelection.groups, regroupedAttention),
      // These records deliberately share original scope/evidence objects.
      // Serialize to a tree before the scrubber's repeated-object protection
      // so shared provenance is not mistaken for circular data and redacted.
      reconciliation: JSON.parse(JSON.stringify({ ...attentionReconciliation, ...reconciledAttention })) }
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
  config: CodegenieConfig,
  telemetry: TelemetryRecorder,
  opts: ComposeOptions,
  notes: NeedsHumanAttentionNote[],
  attention: AttentionReconciliation
): Promise<SubmitComposition> {
  const prompt = opts.promptBuilder.buildComposerPrompt({
    groupedFindingsJson: JSON.stringify(groups.map(group => ({ fingerprint: group.fingerprint, representativeId: group.representative.id, findings: group.findings.map(({ id, title, severity, confidence, category, path, anchor, behaviorChange, intentEvidence }) => ({ id, title, severity, confidence, category, path, anchor, behaviorChange, intentEvidence })), sourceComponents: compositionSources(group.findings, groups.flatMap(group => group.findings)) })), null, 2),
    intent: `Declared intent: ${plan.diffUnderstanding.declaredIntent}\nInferred behavior: ${plan.diffUnderstanding.inferredBehavior}\n${summarizeIntentSignals(plan.intentSignals)}`,
    coverage,
    followUpHintNotes: notes.map((note) => `${note.question} (${note.files.join(", ")})`),
    ...(attention.inventory.concerns.length ? { attentionReconciliationJson: JSON.stringify(attention.inventory) } : {})
  });
  const submitted = await opts.runner.runStructured<SubmitComposition>({
    stage: 10,
    compositionReasoningStepDown: config.review.compositionReasoningStepDown,
    prompt: prompt.prompt,
    schema: composerSubmissionSchema(groups, attention),
    normalizeSubmit: value => normalizeCompositionReferences(value, groups.flatMap(group => group.findings)),
    validateSubmit: value => {
      try {
        validateCompositionSubmission(value, groups.flatMap(group => group.findings));
        const attentionErrors = attentionResolutionErrors(attention, value.attentionResolutions);
        if (attentionErrors.length) return { ok: false, classification: "schema_invalid", details: `${attentionErrors.join("; ")}. Assess each supplied concern; use unresolved when independent evidence is insufficient.` };
        return { ok: true };
      } catch (error) {
        return { ok: false, classification: "schema_invalid", details: String(error) };
      }
    },
    templateVersion: prompt.templateVersion,
    timeoutMs: config.review.perPassTimeoutMs,
    schemaRepair: {
      createFieldRepair: (schema, retained) => {
        try {
          validateCompositionSubmission(retained as SubmitComposition, groups.flatMap(group => group.findings));
          const repair = createAttentionResolutionRepair(schema, retained as SubmitComposition, attention);
          if (repair) return repair;
        } catch { /* Finding-content failures need their existing repair contract. */ }
        return createCompositionAttributionRepair(schema, retained, groups.flatMap(group => group.findings));
      },
      // Source IDs alone cannot establish their meaning. Keep the immutable
      // source inventory available during the bounded semantic repair.
      replaceConversation: false,
      recoverInvalidSubmit: (input) => recoverComposerInvalidSubmit(input, groups, telemetry),
      buildPrompt: (input) => buildComposerSchemaRepairPrompt(input, groups)
    }
  });
  telemetry.event({ stage: 10, level: "info", message: "composer_completed", data: { composed: submitted.composedFindings.length } });
  return submitted;
}

export function composerSubmissionSchema(groups: FindingGroup[], attention?: AttentionReconciliation): typeof SubmitCompositionSchema {
  const schema = structuredClone(SubmitCompositionSchema);
  if (attention?.inventory.concerns.length) {
    Object.assign(schema, { required: [...new Set([...(schema.required ?? []), "attentionResolutions"])] });
    Object.assign(schema.properties.attentionResolutions, { minItems: attention.inventory.concerns.length, maxItems: attention.inventory.concerns.length });
    Object.assign(schema.properties.attentionResolutions.items.properties.concernId, { enum: attention.inventory.concerns.map(concern => concern.id) });
  }
  const sources = compositionSources(groups.flatMap(group => group.findings));
  const item = schema.properties.composedFindings.items;
  // Historical artifacts may contain finalBody; providers only author sections.
  Reflect.deleteProperty(item.properties, "finalBody");

  Object.assign(item.properties.sections, { maxItems: 4 });
  const restrictToInventory = (schemaItem: object, ids: string[]) => {
    // Empty enum is rejected by some provider schema implementations.
    // Membership is still enforced by validateCompositionSubmission.
    if (ids.length) Object.assign(schemaItem, { enum: ids });
  };
  Object.assign(item, { required: [...new Set([...(item.required ?? []), "sections", "evidenceRefs"])] });
  // Providers receive the exact inventory; semantic validation also checks
  // membership, kinds, duplicates and coverage across the selected groups.
  restrictToInventory(item.properties.findingIds.items, groups.flatMap(group => group.findings.map(finding => finding.id)));
  restrictToInventory(item.properties.sections.items.properties.sourceRefs.items, sources.filter(source => source.kind !== "evidence" && eligibleCompositionSource(source, source.kind)).map(source => source.id));
  const evidenceIds = sources.filter(source => source.kind === "evidence").map(source => source.id);
  restrictToInventory(item.properties.evidenceRefs.items, evidenceIds);
  restrictToInventory(item.properties.primaryEvidenceRefs.items, evidenceIds);
  restrictToInventory(item.properties.retainedSourceRefs.items, sources.map(source => source.id));
  restrictToInventory(item.properties.reconciliations.items.properties.sourceRefs.items, sources.filter(source => source.kind === "verification").map(source => source.id));
  restrictToInventory(item.properties.reconciliations.items.properties.supportingRefs.items, sources.map(source => source.id));
  return schema;
}

type ComposerSchemaInvalidKind =
  | "xml_parameter_bleed"
  | "missing_composed_findings"
  | "summary_overflow"
  | "missing_submit_call"
  | "invalid_tool_arguments";

function recoverComposerInvalidSubmit(
  input: LlmSchemaInvalidSubmitRecoveryInput,
  groups: FindingGroup[],
  telemetry: TelemetryRecorder
): Record<string, unknown> | undefined {
  const classification = classifyComposerSchemaInvalid(input);
  telemetry.event({
    stage: 10,
    level: "warn",
    message: "composer_schema_invalid_classified",
    data: {
      submitTool: input.submitTool,
      invalidSubmitCallCount: input.submitCalls.length,
      schemaRepairUsed: input.schemaRepairUsed,
      schemaInvalidKind: classification
    }
  });

  if (input.submitTool !== "submit_composition" || input.submitCalls.length === 0 || classification !== "xml_parameter_bleed") {
    return undefined;
  }

  telemetry.event({
    stage: 10,
    level: "warn",
    message: "composer_payload_salvage_attempted",
    data: { schemaInvalidKind: classification, invalidSubmitCallCount: input.submitCalls.length }
  });

  const args = input.submitCalls[0]?.arguments;
  const summary = typeof args?.summary === "string" ? args.summary : undefined;
  if (summary === undefined) {
    telemetry.event({
      stage: 10,
      level: "warn",
      message: "composer_payload_salvage_failed",
      data: { reason: "missing_summary", schemaInvalidKind: classification }
    });
    return undefined;
  }

  const marker = summary.match(/<\s*parameter\b[^>]*\bname\s*=\s*["']composedFindings["'][^>]*>/iu);
  if (!marker || marker.index === undefined) {
    telemetry.event({
      stage: 10,
      level: "warn",
      message: "composer_payload_salvage_failed",
      data: { reason: "missing_composed_findings_parameter", schemaInvalidKind: classification }
    });
    return undefined;
  }

  const jsonText = extractFirstJsonArray(summary.slice(marker.index + marker[0].length));
  if (jsonText === undefined) {
    telemetry.event({
      stage: 10,
      level: "warn",
      message: "composer_payload_salvage_failed",
      data: { reason: "missing_or_truncated_json_array", schemaInvalidKind: classification }
    });
    return undefined;
  }

  let composedFindings: unknown;
  try {
    composedFindings = JSON.parse(jsonText);
  } catch {
    telemetry.event({
      stage: 10,
      level: "warn",
      message: "composer_payload_salvage_failed",
      data: { reason: "invalid_json_array", schemaInvalidKind: classification }
    });
    return undefined;
  }

  const knownIds = new Set(groups.flatMap((group) => group.findings.map((finding) => finding.id)));
  const unknownIds = unknownComposedFindingIds(composedFindings, knownIds);
  if (unknownIds === undefined) {
    telemetry.event({
      stage: 10,
      level: "warn",
      message: "composer_payload_salvage_failed",
      data: { reason: "invalid_composed_findings_shape", schemaInvalidKind: classification }
    });
    return undefined;
  }
  if (unknownIds.length > 0) {
    telemetry.event({
      stage: 10,
      level: "warn",
      message: "composer_payload_salvage_failed",
      data: { reason: "unknown_finding_ids", unknownIds, schemaInvalidKind: classification }
    });
    return undefined;
  }

  const recovered = {
    summary: sanitizeComposerSummary(summary.slice(0, marker.index)),
    composedFindings
  };
  telemetry.event({
    stage: 10,
    level: "info",
    message: "composer_payload_salvage_proposed",
    data: {
      schemaInvalidKind: classification,
      composedFindings: Array.isArray(composedFindings) ? composedFindings.length : 0,
      summaryChars: recovered.summary.length
    }
  });
  return recovered;
}

function classifyComposerSchemaInvalid(input: LlmSchemaInvalidSubmitRecoveryInput): ComposerSchemaInvalidKind {
  if (input.submitCalls.length === 0) {
    return "missing_submit_call";
  }
  const argsText = input.submitCalls.map((call) => safeComposerJson(call.arguments)).join("\n");
  const text = `${input.error}\n${argsText}`.toLowerCase();
  if (/<\/?\s*parameter\b/u.test(text) || /&lt;\/?\s*parameter\b/u.test(text)) {
    return "xml_parameter_bleed";
  }
  if (/\bcomposedfindings\b/u.test(text) && /\b(required|missing|expected)\b/u.test(text)) {
    return "missing_composed_findings";
  }
  if (/\bsummary\b/u.test(text) && /\b(?:4000|max(?:imum)?|length|characters?)\b/u.test(text)) {
    return "summary_overflow";
  }
  return "invalid_tool_arguments";
}

function sanitizeComposerSummary(input: string): string {
  const cleaned = input
    .replace(/<\s*\/?\s*parameter\b[^>]*>/giu, " ")
    .replace(/&lt;\s*\/?\s*parameter\b[^&]*(?:&gt;)?/giu, " ")
    .replace(/<[^>]{1,200}>/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return cleaned.slice(0, MAX_COMPOSER_SUMMARY_CHARS);
}

function extractFirstJsonArray(input: string): string | undefined {
  const start = input.indexOf("[");
  if (start < 0) {
    return undefined;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < input.length; index += 1) {
    const char = input[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "[") {
      depth += 1;
    } else if (char === "]") {
      depth -= 1;
      if (depth === 0) {
        return input.slice(start, index + 1);
      }
    }
  }
  return undefined;
}

function unknownComposedFindingIds(input: unknown, knownIds: Set<string>): string[] | undefined {
  if (!Array.isArray(input)) {
    return undefined;
  }
  const unknownIds = new Set<string>();
  for (const item of input) {
    if (!item || typeof item !== "object") {
      return undefined;
    }
    const record = item as Record<string, unknown>;
    const findingIds = record.findingIds;
    if (!Array.isArray(findingIds) || findingIds.length === 0) {
      return undefined;
    }
    if (!Array.isArray(record.sections) && (typeof record.finalBody !== "string" || record.finalBody.trim().length === 0)) {
      return undefined;
    }
    if (record.publication !== "inline" && record.publication !== "summary-only") {
      return undefined;
    }
    for (const id of findingIds) {
      if (typeof id !== "string" || id.trim().length === 0) {
        return undefined;
      }
      if (!knownIds.has(id)) {
        unknownIds.add(id);
      }
    }
  }
  return [...unknownIds];
}

function buildComposerSchemaRepairPrompt(input: LlmSchemaRepairInput, groups: FindingGroup[]): string {
  return [
    "Repair the Stage 10 review-composition response for codegenie.",
    "",
    `Validation problem: ${input.error}`,
    "",
    "Required action:",
    "- Call `submit_composition` exactly once with schema-valid arguments.",
    "- Use only the verified finding IDs listed below.",
    "- Do not invent, remove, or re-review findings.",
    "- Do not output XML.",
    "- Do not write `<parameter>` tags.",
    "- Do not wrap the tool call or its JSON arguments in Markdown code fences (fences are allowed inside section text values).",
    "- Do not answer in prose outside the tool call.",
    "- Do not ask for repository tools or more context.",
    "",
    "Schema constraints:",
    "- summary: string, 4000 characters or fewer; diagnosis, scope and uncertainty only, no remedies or test instructions.",
    "- composedFindings: array of objects { findingIds, sections, evidenceRefs, publication }; retainedSourceRefs, primaryEvidenceRefs and reconciliations are optional.",
    "- attentionResolutions: when an attention inventory is supplied, assess every listed concern exactly once as resolved, narrowed, or unresolved. Resolved/narrowed require independent supportingRefs; unresolved may use [] and preserves the question. Compare published findings as well as other supplied evidence.",
    "- findingIds: non-empty array of known finding IDs.",
    "- Write one concise current conclusion per section kind. Do not generate legacy finalBody.",
    "- Fix/test sections require supported current suggestion sources. Retain all other proposals in retainedSourceRefs; do not restate them in summary, impact or verification prose.",
    "- publication: \"inline\" or \"summary-only\".",
    "",
    "Verified finding groups:",
    safeComposerJson(compactComposerRepairGroups(groups))
  ].join("\n");
}

function compactComposerRepairGroups(groups: FindingGroup[]): unknown[] {
  return groups.map((group) => ({
    findingIds: group.findings.map((finding) => finding.id),
    representative: {
      id: group.representative.id,
      title: group.representative.title,
      severity: group.representative.severity,
      confidence: group.representative.confidence,
      path: group.representative.path,
      anchorLine: group.representative.anchor?.line,
      category: group.representative.category,
      failureMode: group.representative.failureMode,
      whyThisMatters: group.representative.whyThisMatters
    },
    defaultPublication: group.representative.anchor ? "inline" : "summary-only",
    sourceComponents: compositionSources(group.findings, groups.flatMap(group => group.findings))
  }));
}

function safeComposerJson(input: unknown): string {
  try {
    return JSON.stringify(input);
  } catch {
    return "";
  }
}

function groupFindings(findings: CandidateFinding[], packetsById: Map<string, ReviewPacket>): FindingGroup[] {
  // A structural fingerprint locates work; it is not proof that two diagnoses
  // in that function/hunk describe the same defect.
  const exactGroups: FindingGroup[] = [];
  for (const finding of [...findings].sort(compareFindings)) {
    const fingerprint = fingerprintFinding(finding, packetsById);
    const existing = exactGroups.find(group => group.fingerprint === fingerprint
      && group.findings.every(member => diagnosesMatch(member, finding) || conciseDiagnosesMatch(member, finding)));
    if (existing) {
      existing.findings.push(finding);
      existing.representative = canonicalMergedRepresentative(existing.findings);
    } else exactGroups.push({ fingerprint, representative: finding, findings: [finding] });
  }
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

function canUseComposerFallback(error: unknown): boolean {
  return isBudgetExhaustedError(error) || isRecoverableLlmError(error);
}

// A "backfill_packet_representative" anchor exists to prove on-diff-ness at
// the verification gate (plan 76); it may point at the wrong line, so it is
// never published as an inline location. Stripping it here routes the
// finding through the ordinary summary-only path (or the merged-anchor
// recovery, which only uses trusted member anchors).
function withholdRepresentativeAnchor(candidate: CandidateFinding, telemetry: TelemetryRecorder): CandidateFinding {
  if (candidate.anchorSource !== "backfill_packet_representative" || candidate.anchor === undefined) {
    return candidate;
  }
  telemetry.event({
    stage: 10,
    level: "info",
    message: "representative_anchor_withheld",
    file: candidate.path,
    data: { candidateId: candidate.id, anchor: candidate.anchor }
  });
  const { anchor: _representativeAnchor, ...withoutAnchor } = candidate;
  return { ...withoutAnchor, changedLine: false };
}

function composerFallbackCoverageReason(mode: CompositionMode): string {
  return mode === "schema_repair_fallback"
    ? "semantic composition schema repair failed; deterministic fallback used"
    : "semantic composition skipped; deterministic fallback used";
}

function composerFallbackTelemetry(error: unknown, groups: FindingGroup[], fallbackReason: string, compositionMode: CompositionMode): Record<string, unknown> {
  const errorRecord = error && typeof error === "object" ? error as { code?: unknown; recoverable?: unknown; context?: unknown } : {};
  return {
    compositionMode,
    fallbackReason,
    verifiedGroups: groups.length,
    error: error instanceof Error ? error.message : String(error),
    ...(typeof errorRecord.code === "string" ? { errorCode: errorRecord.code } : {}),
    ...(typeof errorRecord.recoverable === "boolean" ? { recoverable: errorRecord.recoverable } : {}),
    ...(errorRecord.context && typeof errorRecord.context === "object" ? { context: errorRecord.context } : {})
  };
}

function composerFailureTelemetry(error: unknown, groups: FindingGroup[]): Record<string, unknown> {
  const errorRecord = error && typeof error === "object" ? error as { code?: unknown; recoverable?: unknown; context?: unknown } : {};
  return {
    verifiedGroups: groups.length,
    error: error instanceof Error ? error.message : String(error),
    ...(typeof errorRecord.code === "string" ? { errorCode: errorRecord.code } : {}),
    ...(typeof errorRecord.recoverable === "boolean" ? { recoverable: errorRecord.recoverable } : {}),
    ...(errorRecord.context && typeof errorRecord.context === "object" ? { context: errorRecord.context } : {})
  };
}

function fallbackComposition(groups: FindingGroup[], link?: EvidenceLinker): SubmitComposition {
  return {
    summary: groups.length === 0 ? "No credible findings." : `Found ${groups.length} verified issue${groups.length === 1 ? "" : "s"}.`,
    composedFindings: groups.map((group) => ({
      findingIds: group.findings.map((finding) => finding.id),
      finalBody: templateBody(group.representative, group.findings, link, undefined, groups.flatMap(group => group.findings)),
      publication: group.representative.anchor ? "inline" : "summary-only"
    }))
  };
}

type ConfidenceSelection = {
  confidence: Confidence;
  sourceFindingId?: string;
  reason: "representative" | "same_severity" | "compatible_lower_severity";
};

// Plan 74: the canonical representative supplies the final metadata, but a
// stronger-confidence verified candidate in the SAME merge group may supply
// the final confidence — bounded so adjacency never inflates certainty:
// same-severity candidates may lend their confidence outright; a one-step
// lower-severity candidate lifts confidence by at most one step and never
// above medium; larger severity gaps, category mismatches, and
// behaviorChange disagreements lend nothing. Never lowers confidence.
function selectMergedConfidence(
  representative: CandidateFinding,
  mergedFindings: CandidateFinding[]
): ConfidenceSelection {
  let selected: ConfidenceSelection = { confidence: representative.confidence, reason: "representative" };
  const candidates = [...mergedFindings].sort((a, b) => a.id.localeCompare(b.id));
  for (const candidate of candidates) {
    if (candidate.id === representative.id || candidate.category !== representative.category) {
      continue;
    }
    if (candidate.behaviorChange !== undefined && representative.behaviorChange !== undefined &&
        candidate.behaviorChange !== representative.behaviorChange) {
      continue;
    }
    if (confidenceRank(candidate.confidence) >= confidenceRank(representative.confidence)) {
      continue;
    }
    const severityGap = severityRank(candidate.severity) - severityRank(representative.severity);
    let lifted: Confidence | undefined;
    let reason: ConfidenceSelection["reason"] | undefined;
    if (severityGap === 0) {
      lifted = candidate.confidence;
      reason = "same_severity";
    } else if (severityGap === 1) {
      const oneStepUp = liftConfidenceOneStep(representative.confidence);
      lifted = confidenceRank(candidate.confidence) > confidenceRank(oneStepUp) ? candidate.confidence : oneStepUp;
      if (confidenceRank(lifted) < confidenceRank("medium")) {
        lifted = "medium";
      }
      reason = "compatible_lower_severity";
    } else {
      continue;
    }
    if (confidenceRank(lifted) < confidenceRank(selected.confidence)) {
      selected = { confidence: lifted, sourceFindingId: candidate.id, reason: reason };
    }
  }
  return selected;
}

function liftConfidenceOneStep(confidence: Confidence): Confidence {
  if (confidence === "low") {
    return "medium";
  }
  return "high";
}

function publishSupportedSuggestions(finding: FinalFinding, candidates: CandidateFinding[], publishedSourceRefs?: string[]): void {
  const memberIds = new Set([finding.id, ...(finding.mergedCandidateIds ?? [])]);
  const sources = compositionSources(candidates.filter(candidate => memberIds.has(candidate.id)), candidates);
  delete finding.suggestionAssessments;
  for (const [field, kind] of [["suggestedFix", "fix"], ["suggestedTest", "test"]] as const) {
    delete finding[field];
    const source = sources.find(source => eligibleCompositionSource(source, kind)
      && (publishedSourceRefs === undefined || publishedSourceRefs.includes(source.id)));
    if (source) {
      finding[field] = source.text;
      (finding.suggestionAssessments ??= {})[field] = source.suggestionAssessment!;
    }
  }
}

function toFinalFinding(
  finding: CandidateFinding,
  fingerprint: string,
  finalBody: string,
  publication: FinalFinding["publication"],
  mergedFindings: CandidateFinding[],
  diff: UnifiedDiff | undefined,
  publicationAnchorDecisions?: Map<string, PublicationAnchorDecision>,
  confidenceSelections?: Map<string, ConfidenceSelection & { representativeConfidence: Confidence }>,
  link?: EvidenceLinker,
  attributed = false,
  onFallbackMetrics?: (metrics: CompositionMetrics) => void,
  assessmentFindings = mergedFindings
): FinalFinding {
  const { anchor: _unvalidatedAnchor, anchorSource: _staleAnchorSource, ...findingWithoutAnchor } = finding;
  const publicationAnchor = selectPublicationAnchor(finding, mergedFindings, diff);
  // Only attributed output can replace verified prose. Legacy or invalid output
  // uses one deterministic rendering, never narrative plus every source section.
  const normalizedFinalBody = attributed ? finalBody : templateBody(finding, mergedFindings, link, onFallbackMetrics, assessmentFindings);
  const normalizedTitle = normalizeFinalFindingTitle(finding, mergedFindings, attributed ? normalizedFinalBody : undefined);
  const mergedCandidateIds = uniqueStrings(mergedFindings.map((item) => item.id));
  const mergedAnchors = dedupeAnchors(mergedFindings.flatMap((item) => item.anchor === undefined ? [] : [item.anchor]));
  const mergedCategories = uniqueStrings(mergedFindings.map((item) => item.category)) as Array<CandidateFinding["category"]>;
  const mergedSeverities = uniqueStrings(mergedFindings.map((item) => item.severity)) as Array<CandidateFinding["severity"]>;
  // anchorSource must describe the PUBLISHED anchor, not the candidate's
  // pre-composition one: an anchor donated by a merged member carries the
  // donor's provenance, and an anchorless finding claims no source (run 31
  // published a merged-member anchor still labeled
  // backfill_packet_representative).
  const publishedAnchorSource = publicationAnchor.anchor === undefined
    ? undefined
    : publicationAnchor.sourceFindingId === finding.id
      ? finding.anchorSource
      : mergedFindings.find((item) => item.id === publicationAnchor.sourceFindingId)?.anchorSource;
  const mergedConfidence = selectMergedConfidence(finding, mergedFindings);
  if (mergedConfidence.confidence !== finding.confidence) {
    confidenceSelections?.set(finding.id, { ...mergedConfidence, representativeConfidence: finding.confidence });
  }
  const final: FinalFinding = {
    ...findingWithoutAnchor,
    confidence: mergedConfidence.confidence,
    title: normalizedTitle,
    ...(publicationAnchor.anchor !== undefined ? { anchor: publicationAnchor.anchor } : {}),
    ...(publishedAnchorSource !== undefined ? { anchorSource: publishedAnchorSource } : {}),
    changedLine: publicationAnchor.anchor !== undefined,
    fingerprint,
    finalBody: normalizedFinalBody,
    publication: finalPublicationFromAnchor(publication, publicationAnchor),
    mergedCandidateIds,
    mergedCategories,
    mergedSeverities,
    mergedPaths: uniqueStrings(mergedFindings.map((item) => item.anchor?.path ?? item.path)),
    mergedTitles: uniqueStrings(mergedFindings.map((item) => item.title)),
    ...(mergedAnchors.length > 0 ? { mergedAnchors } : {})
  };
  publicationAnchorDecisions?.set(final.id, publicationAnchor);
  return final;
}

function finalPublicationFromAnchor(
  requestedPublication: FinalFinding["publication"],
  publicationAnchor: PublicationAnchorDecision
): FinalFinding["publication"] {
  if (requestedPublication === "suppressed") {
    return "suppressed";
  }
  if (publicationAnchor.anchor === undefined) {
    return "summary-only";
  }
  if (requestedPublication === "inline") {
    return "inline";
  }
  return "summary-only";
}

function selectPublicationAnchor(
  finding: CandidateFinding,
  mergedFindings: CandidateFinding[],
  diff: UnifiedDiff | undefined
): PublicationAnchorDecision {
  const selectedAnchor = validateAnchorForDiff(finding.anchor, diff);
  if (selectedAnchor !== undefined) {
    return {
      anchor: selectedAnchor,
      source: "selected",
      sourceFindingId: finding.id,
      reason: "selected finding has a valid changed-line anchor"
    };
  }

  const candidates = mergedFindings
    .filter((candidate) => candidate.id !== finding.id)
    .flatMap((candidate): PublicationAnchorCandidate[] => {
      const anchor = validateAnchorForDiff(candidate.anchor, diff);
      return anchor === undefined ? [] : [{ finding: candidate, anchor }];
    })
    .sort((left, right) => comparePublicationAnchorCandidates(left, right, finding));
  const best = candidates[0];
  if (best !== undefined) {
    return {
      anchor: best.anchor,
      source: "merged",
      sourceFindingId: best.finding.id,
      reason: "selected finding was unanchored; using a valid anchor from a merged verified finding"
    };
  }

  return {
    source: "none",
    reason: finding.anchor === undefined
      ? "selected finding and merged findings have no anchor"
      : "selected finding anchor was invalid and no merged finding had a valid changed-line anchor"
  };
}

function comparePublicationAnchorCandidates(
  left: PublicationAnchorCandidate,
  right: PublicationAnchorCandidate,
  selected: CandidateFinding
): number {
  return samePathAnchorRank(left.anchor, selected.path) - samePathAnchorRank(right.anchor, selected.path) ||
    categoryPathRoleRank(selected.category, left.anchor.path) - categoryPathRoleRank(selected.category, right.anchor.path) ||
    severityRank(left.finding.severity) - severityRank(right.finding.severity) ||
    confidenceRank(left.finding.confidence) - confidenceRank(right.finding.confidence) ||
    left.anchor.path.localeCompare(right.anchor.path) ||
    left.anchor.line - right.anchor.line ||
    (left.anchor.startLine ?? left.anchor.line) - (right.anchor.startLine ?? right.anchor.line) ||
    left.anchor.hunkId.localeCompare(right.anchor.hunkId) ||
    left.finding.id.localeCompare(right.finding.id);
}

function samePathAnchorRank(anchor: DiffAnchor, selectedPath: string): number {
  return anchor.path === selectedPath ? 0 : 1;
}

function categoryPathRoleRank(category: CandidateFinding["category"], filePath: string): number {
  if (isDocsPath(filePath)) {
    return 2;
  }
  const testPath = isCompositionTestPath(filePath);
  if (category === "testing") {
    return testPath ? 0 : 1;
  }
  return testPath ? 1 : 0;
}

function recordMergedAnchorRecoveries(
  findings: FinalFinding[],
  decisions: Map<string, PublicationAnchorDecision>,
  telemetry: TelemetryRecorder
): void {
  for (const finding of findings) {
    const decision = decisions.get(finding.id);
    if (finding.publication !== "inline" || decision?.source !== "merged" || decision.anchor === undefined) {
      continue;
    }
    telemetry.event({
      stage: 10,
      level: "info",
      message: "merged_anchor_inline_recovered",
      file: decision.anchor.path,
      data: {
        findingId: finding.id,
        fingerprint: finding.fingerprint,
        sourceFindingId: decision.sourceFindingId,
        path: decision.anchor.path,
        line: decision.anchor.line,
        side: decision.anchor.side,
        hunkId: decision.anchor.hunkId,
        reason: decision.reason
      }
    });
  }
}

function publicationAnchorSelectionRecords(
  findings: FinalFinding[],
  decisions: Map<string, PublicationAnchorDecision>
): Array<{
  findingId: string;
  fingerprint: string;
  publication: FinalFinding["publication"];
  source: PublicationAnchorDecision["source"];
  reason: string;
  sourceFindingId?: string;
  anchor?: DiffAnchor;
}> {
  return findings.map((finding) => {
    const decision = decisions.get(finding.id) ?? {
      source: finding.anchor === undefined ? "none" as const : "selected" as const,
      reason: finding.anchor === undefined ? "no publication anchor" : "selected finding has a publication anchor",
      ...(finding.anchor !== undefined ? { anchor: finding.anchor } : {})
    };
    return {
      findingId: finding.id,
      fingerprint: finding.fingerprint,
      publication: finding.publication,
      source: decision.source,
      reason: decision.reason,
      ...(decision.sourceFindingId !== undefined ? { sourceFindingId: decision.sourceFindingId } : {}),
      ...(decision.anchor !== undefined ? { anchor: decision.anchor } : {})
    };
  }).sort((left, right) => left.findingId.localeCompare(right.findingId));
}

function normalizeFinalFindingTitle(finding: CandidateFinding, mergedFindings: CandidateFinding[], finalBody?: string): string {
  if (!isQuestionShapedFindingTitle(finding.title)) {
    return finding.title;
  }
  const concreteCandidateTitle = mergedFindings
    .map((candidate) => candidate.title.trim())
    .find((title) => title.length > 0 && !isQuestionShapedFindingTitle(title));
  if (concreteCandidateTitle !== undefined) {
    return limitTitle(concreteCandidateTitle);
  }
  // `verification` is deliberately NOT in this ladder: it describes process
  // ("Promoted from follow_up_hint; normal verifier must confirm…"), never
  // content — run 31 published exactly that boilerplate as a title.
  const fallback = [
    finding.failureMode,
    ...(finalBody === undefined ? [] : [finalBody]),
    finding.whyThisMatters
  ].map(firstIssueSentence).find((title) => title !== undefined);
  return fallback ?? finding.title;
}

function isQuestionShapedFindingTitle(title: string): boolean {
  const normalized = title.trim();
  return normalized.endsWith("?") ||
    /^(?:verify|check|confirm|investigate|review|does|can|could|should|is|are|whether)\b/iu.test(normalized);
}

function firstIssueSentence(input: string): string | undefined {
  const cleaned = input
    .replace(/\r\n/g, "\n")
    .split(/\n+/u)
    .map((line) => line.trim().replace(/^[-*]\s+/u, ""))
    .find((line) => line.length > 0);
  if (cleaned === undefined || isQuestionShapedFindingTitle(cleaned)) {
    return undefined;
  }
  const sentence = cleaned.match(/^(.{12,200}?)(?:[.!?](?:\s|$)|$)/u)?.[1]?.trim() ?? cleaned;
  if (sentence.length < 12 || isQuestionShapedFindingTitle(sentence)) {
    return undefined;
  }
  return limitTitle(sentence);
}

function limitTitle(title: string): string {
  const cleaned = title.trim().replace(/\s+/gu, " ");
  return cleaned.length <= 200 ? cleaned : `${cleaned.slice(0, 197).trimEnd()}...`;
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
  return publishableCount === 0 ? "✅ No credible findings." : `⚠️ Found ${publishableCount} verified issue${publishableCount === 1 ? "" : "s"}.`;
}

function summaryCountConflicts(summary: string | undefined, publishableCount: number): boolean {
  const count = summaryFindingCount(summary);
  return count !== undefined && count !== publishableCount;
}

function summaryFindingCount(summary: string | undefined): number | undefined {
  if (!summary) {
    return undefined;
  }
  const normalized = summary.trim().replace(/\s+/gu, " ");
  const countToken = "(\\d+|[a-z]+(?:[- ][a-z]+)?)";
  const leadingMatch = normalized.match(new RegExp(`\\b(?:found|reported|identified|composed)\\s+${countToken}\\s+(?:verified\\s+)?(?:issue|issues|finding|findings)\\b`, "iu"));
  const verifiedMatch = normalized.match(new RegExp(`\\b${countToken}\\s+verified\\s+(?:issue|issues|finding|findings)\\b`, "iu"));
  return parseSummaryCountToken((leadingMatch ?? verifiedMatch)?.[1]);
}

function parseSummaryCountToken(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (/^\d+$/u.test(value)) {
    return Number(value);
  }
  const normalized = value.toLowerCase().replace(/-/gu, " ").trim();
  const words: Record<string, number> = {
    no: 0,
    zero: 0,
    a: 1,
    an: 1,
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
    thirteen: 13,
    fourteen: 14,
    fifteen: 15,
    sixteen: 16,
    seventeen: 17,
    eighteen: 18,
    nineteen: 19
  };
  if (words[normalized] !== undefined) {
    return words[normalized];
  }
  const tens: Record<string, number> = {
    twenty: 20,
    thirty: 30,
    forty: 40,
    fifty: 50,
    sixty: 60,
    seventy: 70,
    eighty: 80,
    ninety: 90
  };
  const parts = normalized.split(/\s+/u);
  if (parts.length === 1) {
    return tens[parts[0] ?? ""];
  }
  if (parts.length === 2) {
    const [tenWord, oneWord] = parts;
    const ten = tens[tenWord ?? ""];
    const one = words[oneWord ?? ""];
    if (ten !== undefined && one !== undefined && one > 0 && one < 10) {
      return ten + one;
    }
  }
  return undefined;
}

function isNoFindingsSummary(summary: string | undefined): boolean {
  if (!summary) {
    return false;
  }
  const normalized = summary.trim().replace(/\s+/gu, " ");
  return /\bno\s+(?:new\s+)?(?:credible\s+|actionable\s+|verified\s+)?(?:findings?|issues?|problems?|concerns?)\b/iu.test(normalized) ||
    /\bnothing\b.{0,120}\b(?:findings?|issues?|problems?|concerns?)\b/iu.test(normalized) ||
    /^no credible findings were found\.?$/iu.test(normalized);
}

function pretrimComposerInput(findings: CandidateFinding[]): { kept: CandidateFinding[]; suppressed: CandidateFinding[] } {
  if (findings.length <= MAX_COMPOSER_FINDINGS) {
    return { kept: findings, suppressed: [] };
  }
  const criticalHigh = findings.filter((finding) => hasCriticalOrHighGuarantee(finding));
  const others = findings
    .filter((finding) => !hasCriticalOrHighGuarantee(finding))
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
    const existing = merged.find(candidate => nearbyGroup(candidate, group)
      && candidate.findings.every(left => group.findings.every(right => diagnosesMatch(left, right))));
    if (!existing) {
      merged.push(group);
      continue;
    }
    existing.findings.push(...group.findings);
    existing.representative = canonicalMergedRepresentative(existing.findings);
    existing.fingerprint = fingerprintFinding(existing.representative, packetsById);
  }
  return merged.sort((a, b) => compareFindings(a.representative, b.representative));
}

function mergeRootCauseGroups(groups: FindingGroup[], packetsById: Map<string, ReviewPacket>): FindingGroup[] {
  const merged: FindingGroup[] = [];
  for (const group of groups) {
    // Require compatibility with every existing member; a broad middle
    // candidate must not connect two otherwise unrelated defects.
    const index = merged.findIndex(candidate => rootCauseGroupsMatch(candidate, group, packetsById));
    if (index < 0) merged.push({ ...group, fingerprint: rootCauseGroupFingerprint(group, packetsById) });
    else merged[index] = combineFindingGroups([merged[index]!, group], packetsById);
  }
  return merged.sort((a, b) => compareFindings(a.representative, b.representative));
}

function combineFindingGroups(groups: FindingGroup[], packetsById: Map<string, ReviewPacket>): FindingGroup {
  const findings = groups.flatMap((group) => group.findings);
  const representative = canonicalMergedRepresentative(findings);
  const combined = {
    fingerprint: "",
    representative,
    findings
  };
  return { ...combined, fingerprint: rootCauseGroupFingerprint(combined, packetsById) };
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
  if (a.representative.category !== b.representative.category) {
    return false;
  }
  if (a.findings.length > 1 || b.findings.length > 1) {
    return a.findings.every(left => b.findings.every(right => rootCauseGroupsMatch(
      { ...a, representative: left, findings: [left] }, { ...b, representative: right, findings: [right] }, packetsById)));
  }
  const similarity = rootCauseSimilarity(a.findings, b.findings);
  if (a.representative.path !== b.representative.path) {
    return crossFileRootCauseGroupsMatch(a, b, packetsById, similarity);
  }
  if (similarity < 0.5 || (!diagnosesMatch(a.representative, b.representative) && !conciseDiagnosesMatch(a.representative, b.representative))) {
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

function crossFileRootCauseGroupsMatch(
  a: FindingGroup,
  b: FindingGroup,
  packetsById: Map<string, ReviewPacket>,
  similarity: number
): boolean {
  // Large evidence inventories and alternate remedies can dilute full-text
  // similarity. Compare the diagnosis separately only with a concrete link to
  // the other finding's changed implementation location.
  const left = a.representative;
  const right = b.representative;
  const leftDiagnosis = normalizedTerms(left.failureMode);
  const rightDiagnosis = normalizedTerms(right.failureMode);
  const sharedDiagnosis = [...leftDiagnosis].filter(term => rightDiagnosis.has(term)).length;
  const sharedImplementation = (left.evidence.relatedCode ?? []).some(l => (right.evidence.relatedCode ?? []).some(r =>
    l.path === r.path && normalizedTerms(l.lines).size >= 6 && l.lines.trim() === r.lines.trim()));
  const linkedImplementation = referencesImplementation(left, right) || referencesImplementation(right, left);
  if ((sharedImplementation || linkedImplementation)
    && sharedDiagnosis / Math.max(1, Math.min(leftDiagnosis.size, rightDiagnosis.size)) >= 0.65) return true;
  // A concise diagnosis can remain aligned while long evidence inventories and
  // differently phrased explanations dominate full-text similarity. Require an
  // explicit implementation location as well, never a matching title alone.
  if (linkedImplementation && conciseDiagnosesMatch(left, right)) return true;
  if (similarity < CROSS_FILE_EVIDENCE_LINK_SIMILARITY) {
    return false;
  }
  if (groupsShareEvidencePath(a, b)) {
    return diagnosesMatch(left, right);
  }
  if (groupsShareSymbol(a, b, packetsById)) {
    return similarity >= 0.55;
  }
  if (groupsShareLocation(a, b, packetsById)) {
    return similarity >= 0.6;
  }
  return false;
}

function conciseDiagnosesMatch(left: CandidateFinding, right: CandidateFinding): boolean {
  const leftTitle = normalizedTerms(left.title.replace(/([a-z])([A-Z])/g, "$1 $2"));
  const rightTitle = normalizedTerms(right.title.replace(/([a-z])([A-Z])/g, "$1 $2"));
  const shared = [...leftTitle].filter(term => rightTitle.has(term)).length;
  return shared >= 4 && shared / Math.max(1, Math.min(leftTitle.size, rightTitle.size)) >= 0.6;
}

function diagnosesMatch(left: CandidateFinding, right: CandidateFinding): boolean {
  return !!left.failureMode.trim() && left.failureMode.trim() === right.failureMode.trim()
    || tokenJaccard(normalizedTerms(left.failureMode), normalizedTerms(right.failureMode)) >= CROSS_FILE_EVIDENCE_LINK_SIMILARITY;
}

function referencesImplementation(from: CandidateFinding, to: CandidateFinding): boolean {
  return (from.evidence.relatedCode ?? []).some(evidence => {
    if (evidence.path !== to.path) return false;
    const range = /^(?:L)?(\d+)(?:\s*[-–:]\s*(?:L)?(\d+))?$/u.exec(evidence.lines.trim());
    if (!range) {
      const identifiers = new Set(evidence.lines.match(/[\p{L}_$][\p{L}\p{N}_$]*/gu) ?? []);
      const specificIdentifiers = (to.evidence.changedCode.match(/[\p{L}_$][\p{L}\p{N}_$]*/gu) ?? [])
        .filter(name => /[a-z][A-Z]|[a-z]_[a-z]/u.test(name));
      return normalizedTerms(evidence.lines).size >= 6 && (specificIdentifiers.some(name => identifiers.has(name))
        || tokenJaccard(normalizedTerms(evidence.lines), normalizedTerms(to.evidence.changedCode)) >= CROSS_FILE_EVIDENCE_LINK_SIMILARITY);
    }
    const start = Number(range[1]);
    const end = Number(range[2] ?? range[1]);
    return start > 0 && end >= start && (!to.anchor || (start <= to.anchor.line && to.anchor.line <= end));
  });
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

function groupsShareEvidencePath(a: FindingGroup, b: FindingGroup): boolean {
  const leftPrimary = groupPrimaryPaths(a);
  const rightPrimary = groupPrimaryPaths(b);
  const leftRelated = groupRelatedEvidencePaths(a);
  const rightRelated = groupRelatedEvidencePaths(b);
  return setsIntersect(leftPrimary, rightRelated) ||
    setsIntersect(rightPrimary, leftRelated) ||
    setsIntersect(leftRelated, rightRelated);
}

function groupPrimaryPaths(group: FindingGroup): Set<string> {
  const paths = new Set<string>();
  for (const finding of group.findings) {
    addPathKey(paths, finding.path);
    addPathKey(paths, finding.anchor?.path);
  }
  return paths;
}

function groupRelatedEvidencePaths(group: FindingGroup): Set<string> {
  const paths = new Set<string>();
  for (const finding of group.findings) {
    for (const related of finding.evidence.relatedCode ?? []) {
      addPathKey(paths, related.path);
    }
  }
  return paths;
}

function addPathKey(paths: Set<string>, path: string | undefined): void {
  const key = path?.trim().toLowerCase();
  if (key && key.length > 0) {
    paths.add(key);
  }
}

function setsIntersect(a: Set<string>, b: Set<string>): boolean {
  return a.size > 0 && [...a].some((item) => b.has(item));
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

// Group identity must be wording-independent (plan 83, fable D7): the spec's
// point is that rerun duplicate suppression and cross-run eval comparison
// survive the model rephrasing the same defect. Identity derives solely from
// the members' structural fingerprints — a singleton keeps its member's
// fingerprint exactly, so ungrouped findings stay stable across lanes/runs.
function rootCauseGroupFingerprint(group: FindingGroup, packetsById: Map<string, ReviewPacket>): string {
  const memberPrints = [...new Set(group.findings.map((finding) => fingerprintFinding(finding, packetsById)))].sort();
  if (memberPrints.length === 1) {
    return memberPrints[0]!;
  }
  return sha256Hex(["root-cause-group", ...memberPrints].join("\0"));
}

type ApplyCapsOptions = {
  lowConfidencePublishableIds: Set<string>;
  telemetry: TelemetryRecorder;
};

type LowConfidenceBehaviorDeltaOutcome = "publish" | "publish_summary_only" | "suppress";

function applyCaps(
  findings: FinalFinding[],
  config: CodegenieConfig,
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
      const outcome = lowConfidenceBehaviorDeltaOutcome(finding, opts.lowConfidencePublishableIds);
      if (outcome !== "suppress") {
        const published = outcome === "publish_summary_only"
          ? { ...finding, publication: "summary-only" as const }
          : finding;
        if (outcome === "publish_summary_only") {
          downgradeReasons.set(finding.id, "low-confidence-anchorless");
        }
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
            severity: finding.severity,
            anchorless: outcome === "publish_summary_only",
            publication: published.publication
          }
        });
        return published;
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
    if (inlineCount > config.review.softCommentCap && !hasCriticalOrHighGuarantee(finding)) {
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
    if (reportedCount > config.review.maxFindings && !hasCriticalOrHighGuarantee(finding)) {
      suppressedReasons.set(finding.id, "report-cap");
      return { ...finding, publication: "suppressed" as const };
    }
    return finding;
  });
  return { findings: capped, suppressedReasons, downgradeReasons };
}

function lowConfidencePublishableCandidateIds(verdicts: VerificationVerdict[]): Set<string> {
  return new Set(verdicts
    .filter((verdict) =>
      (verdict.verdict === "keep" || verdict.verdict === "revise") &&
      verdict.requiredEvidencePresent === true &&
      verdict.falsePositiveRisk !== "high" &&
      verdict.verificationIncomplete !== true
    )
    .map((verdict) => verdict.candidateId));
}

function lowConfidenceBehaviorDeltaOutcome(
  finding: FinalFinding,
  verifiedPublishableIds: Set<string>
): LowConfidenceBehaviorDeltaOutcome {
  if (finding.confidence !== "low") {
    return "suppress";
  }
  if (!verifiedPublishableIds.has(finding.id)) {
    return "suppress";
  }
  if (finding.publication === "suppressed") {
    return "suppress";
  }
  if (!isBehaviorDeltaCategory(finding.category)) {
    return "suppress";
  }
  if (!hasConcreteText(finding.evidence.changedCode, 12) || (finding.evidence.relatedCode ?? []).length === 0) {
    return "suppress";
  }
  if (!hasConcreteText(finding.failureMode, 36) || !hasConcreteText(finding.whyThisMatters, 24)) {
    return "suppress";
  }
  if (!hasConfirmationPath(finding)) {
    return "suppress";
  }
  if (finding.anchor !== undefined && finding.changedLine === true) {
    return "publish";
  }
  if (finding.anchor === undefined && finding.changedLine === false) {
    return "publish_summary_only";
  }
  return "suppress";
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

function renderReviewBody(
  summary: string,
  summaryOnly: FinalFinding[],
  notes: NeedsHumanAttentionNote[],
  coverage: RunCoverageStatus,
  omittedNoteCount = 0,
  health?: import("../types.js").ReviewHealth,
  composition?: ReviewResult["composition"]
): string {
  const trustBanner = health ? renderReviewHealth(health, composition) || renderCoverageTrustBanner(coverage) : renderCoverageTrustBanner(coverage);
  const lines = [
    "### 🧞 Codegenie Review",
    "",
    ...(trustBanner.length > 0 ? [trustBanner, ""] : []),
    summary || "Review completed.",
    "",
    ...renderCoverageSummaryLines(coverage).slice(0, 2)
  ];
  const coverageDisclosures = coverageDisclosureLines(coverage);
  if (coverageDisclosures.length > 0) {
    lines.push("", "**Coverage disclosure:**", ...coverageDisclosures);
  }
  if (summaryOnly.length > 0) {
    lines.push("", "**Summary-only findings:**");
    for (const finding of summaryOnly) {
      lines.push("", `- ${severityBadge(finding.severity)}: **${finding.title}** (${inlineCode(`${finding.path}${finding.anchor ? `:${finding.anchor.line}` : ""}`)})`);
      lines.push(indentBlock(finding.finalBody.trim() || finding.failureMode));
    }
  }
  if (notes.length > 0) {
    lines.push("", "**🙋 Needs human attention:**");
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

// Builds GitHub blob links for evidence file mentions; only PR reviews know
// the owner/repo slug and head SHA, so other modes render no links.
type EvidenceLinker = (path: string, line?: number) => string | undefined;

function evidenceLinker(resolved: ResolvedReviewInput): EvidenceLinker {
  const pr = resolved.pr;
  const sha = pr?.headSha?.trim();
  if (pr === undefined || sha === undefined || sha.length === 0) {
    return () => undefined;
  }
  return (path, line) => `https://github.com/${pr.owner}/${pr.repo}/blob/${sha}/${path}${line !== undefined ? `#L${line}` : ""}`;
}

function templateBody(finding: CandidateFinding, groupedFindings: CandidateFinding[] = [finding], link?: EvidenceLinker, onMetrics?: (metrics: CompositionMetrics) => void, assessmentFindings = groupedFindings): string {
  return renderRetainedComposition([finding, ...groupedFindings.filter(member => member.id !== finding.id)], link, text => normalizeUnsupportedIntentFraming(text, finding), onMetrics, assessmentFindings);
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

function canonicalMergedRepresentative(
  findings: CandidateFinding[],
  diff?: UnifiedDiff
): CandidateFinding {
  if (!findings.some(isPromotedFinding)) {
    return strongest(findings);
  }
  const anchoredDirect = findings.filter((finding) =>
    !isPromotedFinding(finding) &&
    finding.anchor !== undefined &&
    (diff === undefined || validateAnchorForDiff(finding.anchor, diff) !== undefined)
  );
  if (anchoredDirect.length === 0) {
    return strongest(findings);
  }
  const declarative = anchoredDirect.filter((finding) => !isQuestionShapedFindingTitle(finding.title));
  return strongest(declarative.length > 0 ? declarative : anchoredDirect);
}

function isPromotedFinding(finding: CandidateFinding): boolean {
  return finding.provenance?.source === "uncertainty_promotion";
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

/** Rebuild publication text if a budget stop occurred during composition itself. */
export function refreshReviewHealth(result: ReviewResult): void {
  if (result.health?.status === "failed" || result.health?.status === "incomplete") result.coverage.partial = true;
  result.health = deriveReviewHealth(result.coverage, result.health?.unresolvedCount ?? result.needsHumanAttention.length + (result.needsHumanAttentionOmittedCount ?? 0),
    result.findings.length + result.summaryOnlyFindings.length > 0);
  if (result.health.status === "failed" || result.health.status === "incomplete") result.coverage.partial = true;
  if (result.health.status !== "completed") result.summary = factualReviewSummary(result.health, result.findings.length + result.summaryOnlyFindings.length);
  if (result.postingPlan) result.postingPlan.reviewBody = renderReviewBody(result.summary, result.summaryOnlyFindings, result.needsHumanAttention, result.coverage, result.needsHumanAttentionOmittedCount, result.health);
}
