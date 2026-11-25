import { packetHasRepositoryTools } from "../util/packet-tools.js";
import { reviewDiagnostic, unresolvedToolDiagnostic } from "../util/review-health.js";
import { clarifyFindingLocations } from "./finding-location.js";
import { SCHEMA_REPAIR_TIMEOUT_MS } from "../util/budget.js";
import { buildRepositoryToolDefinitions } from "../llm/tool-definitions.js";
import type { LlmPostToolNudgeInput, LlmRunner, LlmToolResultSummary } from "../llm/llm-runner.js";
import { SubmitPacketReviewSchema, type SubmitPacketReview } from "../llm/schemas.js";
import { skillsCompatibleWithLanguage, type LensRegistry } from "../skills/lens-registry.js";
import { exactSourceToolNames, projectedSkillIds, type PromptBuilder } from "../skills/prompt-builder.js";
import type { TelemetryRecorder } from "../telemetry/telemetry-recorder.js";
import type {
  AnchorSource,
  CandidateFinding,
  CodegenieConfig,
  DiffAnchor,
  PacketReviewResult,
  RepositoryTools,
  RepositoryEvidence,
  ReviewPacket,
  ReviewPlan,
  ReviewPriority,
  ReviewStage,
  UnifiedDiff
} from "../types.js";
import { createWorkerRunner, type WorkerTask } from "./worker-runner.js";
import { inferAnchorFromChangedCode, isBudgetExhaustedError, isRunFatalLlmError, isRecoverableWorkerError, isSchemaInvalidError, validateAnchorForDiff } from "./pipeline-utils.js";
import { isCodegenieError } from "../util/errors.js";
import { applySeverityPolicy } from "./severity-policy.js";
import { isPacketReviewTestPath } from "../util/path-roles.js";
import { normalizeStage7Submit, stage7RecoverInvalidSubmit } from "../llm/stage7-submit-repair.js";
import { cleanStrings } from "../util/text-similarity.js";

type LensRunnerOptions = {
  runner: LlmRunner;
  promptBuilder: PromptBuilder;
  lensRegistry: LensRegistry;
  signal?: AbortSignal;
  checkpoint?: (stage: ReviewStage) => "ok" | "exhausted";
  diff?: UnifiedDiff;
};

type SubmittedFollowUpHint = SubmitPacketReview["followUpHints"][number];
type SubmittedUncertainty = SubmitPacketReview["uncertainties"][number];
type NormalizedHints = {
  kept: PacketReviewResult["followUpHints"];
  submittedCount: number;
  droppedCount: number;
};
type NormalizedUncertainties = {
  kept: PacketReviewResult["uncertainties"];
  submittedCount: number;
  droppedCount: number;
};
type Stage7PacketGeneration = {
  directCandidates: number;
  submittedFollowUpHints: number;
  keptFollowUpHints: number;
  droppedFollowUpHints: number;
  submittedUncertainties: number;
  keptUncertainties: number;
  droppedUncertainties: number;
};

const MAX_FOLLOW_UP_HINTS_PER_PACKET = 2;
const MAX_UNCERTAINTIES_PER_PACKET = 1;
const stage7Generation = new WeakMap<PacketReviewResult, Stage7PacketGeneration>();

export async function runLensPackets(
  _plan: ReviewPlan,
  packets: ReviewPacket[],
  tools: RepositoryTools,
  config: CodegenieConfig,
  telemetry: TelemetryRecorder,
  opts: LensRunnerOptions
): Promise<PacketReviewResult[]> {
  telemetry.event({ stage: 7, level: "info", message: "stage_started", data: { packets: packets.length } });
  const workerRunner = createWorkerRunner({
    telemetry,
    concurrency: config.review.concurrency,
    signal: opts.signal,
    isRetriableError: isRecoverableWorkerError,
    ...(opts.checkpoint !== undefined ? { checkpoint: opts.checkpoint } : {})
  });
  const retainedReads = new Map<string, RepositoryEvidence[]>();
  const tasks = packets.map((packet): WorkerTask<PacketReviewResult> => ({
    stage: 7,
    priority: packetPriority(packet),
    coverage: packet.coverage,
    dispatchRank: packet.dispatchRank,
    packetId: packet.id,
    timeoutMs: config.review.perPassTimeoutMs,
    repairAllowanceMs: SCHEMA_REPAIR_TIMEOUT_MS,
    awaitCancellation: true,
    retryOnTransient: true,
    run: packetAttemptRunner(packet, tools, config, opts, telemetry, retainedReads)
  }));
  const outcomes = await workerRunner.schedule(tasks);
  const passResults = outcomes.map((outcome): PacketReviewResult => {
    if (outcome.outcome === "completed" && outcome.value) {
      return outcome.value;
    }
    if (isRunFatalLlmError(outcome.error) && !isSchemaInvalidError(outcome.error)) {
      throw outcome.error;
    }
    const packetId = outcome.task.packetId ?? "unknown";
    const budgetSkipped = isBudgetExhaustedError(outcome.error);
    telemetry.event({
      stage: 7,
      level: outcome.outcome === "not_dispatched" || budgetSkipped ? "warn" : "error",
      message: `packet_review_${budgetSkipped ? "not_dispatched" : outcome.outcome}`,
      packetId,
      workerId: outcome.task.workerId,
      data: {
        error: outcome.error instanceof Error ? outcome.error.message : String(outcome.error ?? ""),
        ...(isCodegenieError(outcome.error) ? { errorCode: outcome.error.code } : {})
      }
    });
    return {
      packetId,
      lenses: packets.find((packet) => packet.id === packetId)?.lenses ?? [],
      repositoryEvidence: retainedReads.get(packetId) ?? [],
      findings: [],
      followUpHints: [],
      uncertainties: [],
      diagnostics: [reviewDiagnostic(7, outcome.error, packetId, outcome.outcome)],
      status: outcome.outcome === "not_dispatched" || budgetSkipped ? "skipped" : "failed"
    };
  });
  // Match results by the OUTCOME's own packet identity: schedule() returns
  // outcomes in dispatch order (priority/coverage sorted), not input order
  // (found live in eval run 0c4d5213/49).
  const resultByPacket = new Map<string, PacketReviewResult>();
  outcomes.forEach((outcome, index) => {
    const result = passResults[index];
    if (result !== undefined) resultByPacket.set(outcome.task.packetId ?? result.packetId, result);
  });
  const results = packets.map((packet): PacketReviewResult => resultByPacket.get(packet.id) ?? {
    packetId: packet.id, lenses: packet.lenses, findings: [], followUpHints: [], uncertainties: [], status: "failed"
  });
  await clarifyFindingLocations(results.flatMap((result) => result.findings), config, telemetry, { ...opts, packets });
  telemetry.event({
    stage: 7,
    level: "info",
    message: "pipeline_metrics",
    data: {
      totals: {
        packetReviews: results.length,
        candidates: results.reduce((sum, result) => sum + result.findings.length, 0)
      },
      workers: summarizeWorkerOutcomes(outcomes),
      packets: {
        reviewed: results.filter((result) => result.status === "completed").length,
        failed: results.filter((result) => result.status === "failed" || result.status === "incomplete").length
      },
      candidates: {
        generated: results.reduce((sum, result) => sum + result.findings.length, 0)
      },
      generation: summarizeStage7Generation(results)
    }
  });
  telemetry.event({ stage: 7, level: "info", message: "stage_completed", data: { packets: results.length } });
  return results;
}

// Retain delivered reads across retries of the same packet, even if a submit fails.
function packetAttemptRunner(
  packet: ReviewPacket, tools: RepositoryTools, config: CodegenieConfig,
  opts: LensRunnerOptions, telemetry: TelemetryRecorder,
  retained: Map<string, RepositoryEvidence[]>
): WorkerTask<PacketReviewResult>["run"] {
  const reads = new Map<string, RepositoryEvidence>();
  const observations = new Map<string, LlmToolResultSummary>();
  let attempt = 0;
  return async (signal, task) => {
    const currentAttempt = ++attempt;
    const collect = (results: LlmToolResultSummary[]) => {
      results.forEach((result, index) => {
        // Provider IDs are only local to a model response and may repeat even
        // within a worker attempt. Snapshot position is a host-owned identity.
        const id = `${task.workerId}/pass-1/attempt-${currentAttempt}/read-${index}`;
        observations.set(id, structuredClone(result));
        for (const [hit, evidence] of (result.repositoryEvidence ?? []).entries()) {
          const readId = result.repositoryEvidence!.length === 1 ? id : `${id}/hit-${hit}`;
          const read = { ...structuredClone(evidence), id: readId,
            origin: { workerId: task.workerId, attempt: currentAttempt, pass: 1, toolCallId: result.id } };
          reads.set(readId, read);
        }
      });
      retained.set(packet.id, [...reads.values()]);
      return [...observations.values()];
    };
    const result = await runPacket(packet, tools, config, opts, telemetry, task.workerId, signal, collect);
    result.repositoryEvidence = [...reads.values()];
    return result;
  };
}

async function runPacket(
  packet: ReviewPacket,
  tools: RepositoryTools,
  config: CodegenieConfig,
  opts: LensRunnerOptions,
  telemetry: TelemetryRecorder,
  workerId: string,
  signal: AbortSignal,
  collect?: (results: LlmToolResultSummary[]) => LlmToolResultSummary[]
): Promise<PacketReviewResult> {
  const skills = skillsCompatibleWithLanguage(
    packet.lenses.flatMap((lensId) => opts.lensRegistry.skillsForLens(lensId)),
    packet.language
  );
  const toolSurface = config.review.toolSurface ?? "current";
  const hasTools = packetHasRepositoryTools(packet);
  const currentHunks = toolSurface === "six" ? packet.hunks.map(hunk => hunk.hunkId) : undefined;
  const changeDirectory = currentHunks && tools.readChangePromptDirectory?.(currentHunks, hasTools);
  const prompt = opts.promptBuilder.buildPacketReviewPrompt({ packet, skills, ...(changeDirectory ? { changeDirectory } : {}) });
  const passSkillIds = projectedSkillIds(prompt.projection);
  const repositoryTools = !hasTools
    ? []
    : buildRepositoryToolDefinitions(tools, { toolSurface, includeLikelyTests: shouldExposeLikelyTestsForPacket(packet),
      ...(currentHunks ? { currentHunks } : {}) });
  let toolResults: LlmToolResultSummary[] = [];
  const submitted = await opts.runner.runStructured<SubmitPacketReview>({
    onToolResults: results => { toolResults = collect?.(results) ?? results; },
    stage: 7,
    prompt: prompt.prompt,
    schema: SubmitPacketReviewSchema,
    signal,
    templateVersion: prompt.templateVersion,
    tools: repositoryTools,
    toolBudget: packet.toolBudget,
    timeoutMs: config.review.perPassTimeoutMs,
    telemetryContext: { workerId, packetId: packet.id, toolSurface },
    normalizeSubmit: normalizeStage7Submit,
    // Plan 95: stage 7's deterministic submit cleanup rides the shared
    // recoverInvalidSubmit seam like every other stage; the engine and its
    // telemetry live in stage7-submit-repair.ts.
    schemaRepair: {
      recoverInvalidSubmit: (input) => stage7RecoverInvalidSubmit(input, telemetry, { workerId, packetId: packet.id })
    },
    finalization: {
      noResultInstruction: STAGE7_NO_FINDINGS_SUBMIT_INSTRUCTION,
      ...(toolSurface === "six"
        ? { softTargetNotice: "The local investigation target has been reached. Continue only while a removed or added line in this packet's hunks is still unaccounted for; then submit." }
        : { buildPostToolNudge: (input) => buildPostToolCloseNudge(packet, input, exactSourceToolNames[toolSurface]) })
    }
  });
  const findings = submitted.findings.map((finding, index) => stampFinding(packet, finding, index, passSkillIds, workerId, telemetry, opts.diff));
  const reviewStatus = normalizedReviewStatus(submitted, findings.length);
  if (reviewStatus === "no_findings") {
    telemetry.event({
      stage: 7,
      level: "info",
      message: "packet_review_no_findings",
      packetId: packet.id,
      workerId,
      data: {
        reason: submitted.noFindingReason ?? "No concrete failure mode was submitted.",
        toolBudget: packet.toolBudget,
        coverage: packet.coverage,
        reviewProfile: packet.reviewProfile
      }
    });
  } else if (reviewStatus === "incomplete") {
    telemetry.event({
      stage: 7,
      level: "warn",
      message: "packet_review_incomplete",
      packetId: packet.id,
      workerId,
      data: {
        reason: submitted.noFindingReason
      }
    });
  }
  const followUpHints = normalizeFollowUpHints(submitted.followUpHints, packet, passSkillIds, telemetry, workerId);
  const uncertainties = normalizeUncertainties(submitted.uncertainties, packet, passSkillIds, telemetry, workerId);
  const diagnostic = reviewStatus === "incomplete" || followUpHints.kept.length > 0 || uncertainties.kept.length > 0
    ? unresolvedToolDiagnostic(7, toolResults, packet.id, reviewStatus !== "incomplete") : undefined;
  const result: PacketReviewResult = {
    repositoryEvidence: toolResults.flatMap(result => result.repositoryEvidence ?? []),
    ...(diagnostic ? { diagnostics: [diagnostic] } : {}),
    packetId: packet.id,
    lenses: packet.lenses,
    findings,
    reviewStatus,
    ...(submitted.noFindingReason !== undefined ? { noFindingReason: submitted.noFindingReason } : {}),
    followUpHints: followUpHints.kept,
    uncertainties: uncertainties.kept,
    status: reviewStatus === "incomplete" ? "incomplete" : "completed"
  };
  stage7Generation.set(result, {
    directCandidates: findings.length,
    submittedFollowUpHints: followUpHints.submittedCount,
    keptFollowUpHints: followUpHints.kept.length,
    droppedFollowUpHints: followUpHints.droppedCount,
    submittedUncertainties: uncertainties.submittedCount,
    keptUncertainties: uncertainties.kept.length,
    droppedUncertainties: uncertainties.droppedCount
  });
  return result;
}

function normalizeFollowUpHints(
  hints: SubmittedFollowUpHint[],
  packet: ReviewPacket,
  passSkillIds: readonly string[],
  telemetry: TelemetryRecorder,
  workerId: string
): NormalizedHints {
  const valid: PacketReviewResult["followUpHints"] = [];
  for (const hint of hints) {
    const normalized = {
      ...hint,
      question: hint.question.trim(),
      files: cleanStrings(hint.files),
      symbols: cleanStrings(hint.symbols),
      suggestedLenses: cleanStrings(hint.suggestedLenses),
      reason: hint.reason.trim(),
      projectedSkillIds: [...passSkillIds]
    };
    const pointerRich = normalized.files.length > 0 || normalized.symbols.length > 0;
    if (normalized.question.length === 0 || !pointerRich) {
      telemetry.event({
        stage: 7,
        level: "warn",
        message: normalized.question.length === 0 ? "vague_hint" : "follow_up_hint_dropped",
        packetId: packet.id,
        workerId,
        data: {
          question: normalized.question,
          files: normalized.files,
          symbols: normalized.symbols,
          reason: normalized.reason,
          confidence: normalized.confidence
        }
      });
      continue;
    }
    valid.push(normalized);
  }

  const ranked = [...valid].sort((a, b) => followUpHintRank(b, packet) - followUpHintRank(a, packet) ||
    a.question.localeCompare(b.question));
  const kept = ranked.slice(0, MAX_FOLLOW_UP_HINTS_PER_PACKET);
  const dropped = ranked.slice(MAX_FOLLOW_UP_HINTS_PER_PACKET);
  for (const hint of kept) {
    telemetry.event({
      stage: 7,
      level: "info",
      message: "follow_up_hint",
      packetId: packet.id,
      workerId,
      data: {
        question: hint.question,
        files: hint.files,
        symbols: hint.symbols,
        reason: hint.reason,
        confidence: hint.confidence,
        projectedSkillIds: hint.projectedSkillIds
      }
    });
  }
  if (dropped.length > 0) {
    telemetry.event({
      stage: 7,
      level: "info",
      message: "follow_up_hint_capped",
      packetId: packet.id,
      workerId,
      data: {
        cap: MAX_FOLLOW_UP_HINTS_PER_PACKET,
        keptCount: kept.length,
        droppedCount: dropped.length,
        dropped: dropped.slice(0, 5).map((hint) => ({
          question: hint.question,
          files: hint.files,
          symbols: hint.symbols,
          confidence: hint.confidence
        }))
      }
    });
  }
  return {
    kept,
    submittedCount: hints.length,
    droppedCount: hints.length - kept.length
  };
}

function normalizeUncertainties(
  uncertainties: SubmittedUncertainty[],
  packet: ReviewPacket,
  passSkillIds: readonly string[],
  telemetry: TelemetryRecorder,
  workerId: string
): NormalizedUncertainties {
  const valid = uncertainties.flatMap((uncertainty): PacketReviewResult["uncertainties"] => {
    const normalized = {
      question: uncertainty.question.trim(),
      files: cleanStrings(uncertainty.files),
      symbols: cleanStrings(uncertainty.symbols),
      projectedSkillIds: [...passSkillIds]
    };
    if (normalized.question.length === 0) {
      telemetry.event({
        stage: 7,
        level: "warn",
        message: "uncertainty_dropped",
        packetId: packet.id,
        workerId,
        data: { reason: "empty_question", uncertainty }
      });
      return [];
    }
    return [normalized];
  });
  const ranked = [...valid].sort((a, b) => uncertaintyRank(b, packet) - uncertaintyRank(a, packet) ||
    a.question.localeCompare(b.question));
  const kept = ranked.slice(0, MAX_UNCERTAINTIES_PER_PACKET);
  const dropped = ranked.slice(MAX_UNCERTAINTIES_PER_PACKET);
  for (const uncertainty of kept) {
    telemetry.event({
      stage: 7,
      level: "info",
      message: "uncertainty",
      packetId: packet.id,
      workerId,
      data: uncertainty
    });
  }
  if (dropped.length > 0) {
    telemetry.event({
      stage: 7,
      level: "info",
      message: "uncertainty_capped",
      packetId: packet.id,
      workerId,
      data: {
        cap: MAX_UNCERTAINTIES_PER_PACKET,
        keptCount: kept.length,
        droppedCount: dropped.length,
        dropped: dropped.slice(0, 5).map((uncertainty) => ({
          question: uncertainty.question,
          files: uncertainty.files,
          symbols: uncertainty.symbols
        }))
      }
    });
  }
  return {
    kept,
    submittedCount: uncertainties.length,
    droppedCount: uncertainties.length - kept.length
  };
}

function summarizeStage7Generation(results: PacketReviewResult[]): {
  directCandidates: number;
  packetsWithCandidates: number;
  noFindingsPackets: number;
  incompletePackets: number;
  submittedFollowUpHints: number;
  keptFollowUpHints: number;
  droppedFollowUpHints: number;
  submittedUncertainties: number;
  keptUncertainties: number;
  droppedUncertainties: number;
  submittedHintsAndUncertainties: number;
  keptHintsAndUncertainties: number;
} {
  const generations = results.map((result): Stage7PacketGeneration => stage7Generation.get(result) ?? {
    directCandidates: result.findings.length,
    submittedFollowUpHints: result.followUpHints.length,
    keptFollowUpHints: result.followUpHints.length,
    droppedFollowUpHints: 0,
    submittedUncertainties: result.uncertainties.length,
    keptUncertainties: result.uncertainties.length,
    droppedUncertainties: 0
  });
  const submittedFollowUpHints = generations.reduce((sum, item) => sum + item.submittedFollowUpHints, 0);
  const keptFollowUpHints = generations.reduce((sum, item) => sum + item.keptFollowUpHints, 0);
  const droppedFollowUpHints = generations.reduce((sum, item) => sum + item.droppedFollowUpHints, 0);
  const submittedUncertainties = generations.reduce((sum, item) => sum + item.submittedUncertainties, 0);
  const keptUncertainties = generations.reduce((sum, item) => sum + item.keptUncertainties, 0);
  const droppedUncertainties = generations.reduce((sum, item) => sum + item.droppedUncertainties, 0);
  return {
    directCandidates: generations.reduce((sum, item) => sum + item.directCandidates, 0),
    packetsWithCandidates: results.filter((result) => result.findings.length > 0).length,
    noFindingsPackets: results.filter((result) => result.reviewStatus === "no_findings").length,
    incompletePackets: results.filter((result) => result.reviewStatus === "incomplete" || result.status === "incomplete").length,
    submittedFollowUpHints,
    keptFollowUpHints,
    droppedFollowUpHints,
    submittedUncertainties,
    keptUncertainties,
    droppedUncertainties,
    submittedHintsAndUncertainties: submittedFollowUpHints + submittedUncertainties,
    keptHintsAndUncertainties: keptFollowUpHints + keptUncertainties
  };
}

function followUpHintRank(hint: PacketReviewResult["followUpHints"][number], packet: ReviewPacket): number {
  return confidenceScore(hint.confidence) * 30 +
    pointerScore(hint.files, hint.symbols, packet) * 10 +
    concretenessScore(hint.question, hint.reason);
}

function uncertaintyRank(uncertainty: PacketReviewResult["uncertainties"][number], packet: ReviewPacket): number {
  return pointerScore(uncertainty.files, uncertainty.symbols, packet) * 10 +
    concretenessScore(uncertainty.question, "");
}

function confidenceScore(confidence: PacketReviewResult["followUpHints"][number]["confidence"]): number {
  return { high: 3, medium: 2, low: 1 }[confidence];
}

function pointerScore(files: string[], symbols: string[], packet: ReviewPacket): number {
  const packetPaths = new Set([packet.path, ...(packet.oldPath !== undefined ? [packet.oldPath] : [])]);
  const changedFile = files.some((file) => packetPaths.has(stripLocationSuffix(file)));
  const symbolMatch = symbols.some((symbol) => packet.symbolFacts.some((fact) =>
    symbolMatches(symbol, fact.enclosingSymbol) || symbolMatches(symbol, fact.signature)
  ));
  return (files.length > 0 ? 1 : 0) +
    (symbols.length > 0 ? 1 : 0) +
    (changedFile ? 2 : 0) +
    (symbolMatch ? 2 : 0);
}

function concretenessScore(question: string, reason: string): number {
  const text = `${question} ${reason}`.toLowerCase();
  return (/\b(if|when|whether|because|fails?|breaks?|regression|contract|auth|permission|coverage|test|zero|nil|null|overflow|timeout|leak|race)\b/u.test(text) ? 2 : 0) +
    (question.length <= 180 ? 1 : 0);
}

function shouldExposeLikelyTestsForPacket(packet: ReviewPacket): boolean {
  return isPacketReviewTestPath(packet.path) ||
    (packet.oldPath !== undefined && isPacketReviewTestPath(packet.oldPath)) ||
    packet.lenses.some(isTestingLens) ||
    packet.testCoverageDelta !== undefined ||
    packet.labels.some(isTestingSignal) ||
    packet.attentionNotes.some(isTestingSignal);
}

function isTestingLens(lens: string): boolean {
  return /(^|[/_-])tests?($|[/_-])/iu.test(lens) || /(^|[/_-])testing($|[/_-])/iu.test(lens);
}

function isTestingSignal(value: string): boolean {
  return /\b(test|tests|testing|coverage)\b/iu.test(value);
}

function symbolMatches(symbol: string, factValue: string | undefined): boolean {
  if (!factValue) {
    return false;
  }
  const left = symbol.toLowerCase().trim();
  const right = factValue.toLowerCase();
  return left.length > 0 && (right === left || right.includes(left));
}

function stripLocationSuffix(value: string): string {
  return value.trim().replace(/:\d+(?:-\d+)?$/u, "");
}

function normalizedReviewStatus(submitted: SubmitPacketReview, findingCount: number): NonNullable<PacketReviewResult["reviewStatus"]> {
  if (submitted.reviewStatus === "incomplete") {
    return "incomplete";
  }
  if (findingCount > 0) {
    return "findings";
  }
  return "no_findings";
}

const STAGE7_NO_FINDINGS_SUBMIT_INSTRUCTION =
  "If there are no findings, submit reviewStatus:\"no_findings\", findings: [], and a short noFindingReason. If concrete unresolved risk remains but evidence is insufficient for a finding, include pointer-rich followUpHints or uncertainties.";

function buildPostToolCloseNudge(packet: ReviewPacket, input: LlmPostToolNudgeInput, toolNames: string): string | undefined {
  const threshold = closeNudgeThreshold(packet);
  if (input.investigationRounds < threshold) {
    return undefined;
  }
  return `Only continue if the next repository tool call resolves one named predicate for packet ${packet.id}; prefer exact source reads such as ${toolNames}. Otherwise call ${input.submitToolName} now with either a candidate finding, a short no-finding answer, or an exact unresolved predicate. ${STAGE7_NO_FINDINGS_SUBMIT_INSTRUCTION}`;
}

export function closeNudgeThreshold(packet: Pick<ReviewPacket, "coverage" | "reviewProfile">): number {
  if (packet.coverage === "light" || packet.reviewProfile === "simple") {
    return 1;
  }
  if (packet.coverage === "deep" || packet.reviewProfile === "investigate") {
    return 3;
  }
  return 2;
}

function stampFinding(
  packet: ReviewPacket,
  submitted: SubmitPacketReview["findings"][number],
  index: number,
  passSkillIds: readonly string[],
  workerId: string,
  telemetry: TelemetryRecorder,
  diff: UnifiedDiff | undefined
): CandidateFinding {
  const modelAnchor = normalizeAnchor(submitted.anchor, packet, diff);
  const candidateId = `${packet.id.slice(0, 8)}-f${index + 1}`;
  if (submitted.anchor !== undefined && modelAnchor === undefined) {
    telemetry.event({
      stage: 7,
      level: "warn",
      message: "out_of_hunk_anchor",
      packetId: packet.id,
      data: { candidateId, finding: submitted.title, anchor: submitted.anchor }
    });
  }
  // Tier 1 anchor reconstruction (plan 76): when the model quoted changed
  // code but did not provide a usable structured anchor, a precise anchor is
  // often derivable from the quote itself.
  let anchor = modelAnchor;
  let anchorSource: AnchorSource | undefined = modelAnchor !== undefined ? "model" : undefined;
  if (anchor === undefined && submitted.evidence.changedCode.trim().length > 0) {
    const inferred = normalizeAnchor(inferAnchorFromChangedCode(diff ?? packet, submitted.evidence.changedCode), packet, diff);
    if (inferred !== undefined) {
      anchor = inferred;
      anchorSource = "backfill_changed_code";
      telemetry.event({
        stage: 7,
        level: "info",
        message: "anchor_inferred",
        packetId: packet.id,
        data: { candidateId, hunkId: inferred.hunkId, line: inferred.line, side: inferred.side }
      });
    } else {
      telemetry.event({
        stage: 7,
        level: "info",
        message: "anchor_inference_failed",
        packetId: packet.id,
        data: { candidateId }
      });
    }
  }
  if (submitted.anchor !== undefined && anchor === undefined) {
    telemetry.event({
      stage: 7,
      level: "info",
      message: "candidate_anchor_summary_only",
      packetId: packet.id,
      data: { candidateId, finding: submitted.title, anchor: submitted.anchor }
    });
  }
  const changedLine = anchor !== undefined;
  const path = anchor?.path ?? submitted.path ?? submitted.anchor?.path ?? packet.path;
  const primaryLens = packet.lenses[0] ?? "core/code-review";
  return {
    id: candidateId,
    title: submitted.title,
    ...applySeverityPolicy(submitted.severity, submitted.behaviorChange),
    confidence: submitted.confidence,
    path,
    ...(anchor !== undefined ? { anchor } : {}),
    ...(anchorSource !== undefined ? { anchorSource } : {}),
    modelAnchorSubmitted: submitted.anchor !== undefined,
    ...(anchor === undefined ? { locationResolution: { status: "unresolved" as const, ...(submitted.anchor ? { rejectedAnchor: submitted.anchor } : {}) } } : {}),
    changedLine,
    category: submitted.category,
    evidence: submitted.evidence,
    failureMode: submitted.failureMode,
    whyThisMatters: submitted.whyThisMatters,
    ...(submitted.suggestedFix !== undefined ? { suggestedFix: submitted.suggestedFix } : {}),
    ...(submitted.suggestedTest !== undefined ? { suggestedTest: submitted.suggestedTest } : {}),
    verification: submitted.verification,
    ...(submitted.behaviorChange !== undefined ? { behaviorChange: submitted.behaviorChange } : {}),
    ...(submitted.intentEvidence !== undefined ? { intentEvidence: submitted.intentEvidence } : {}),
    producedBy: {
      kind: "packet",
      stage: 7,
      packetId: packet.id,
      lensId: primaryLens,
      skillIds: [...passSkillIds],
      workerId
    }
  };
}

function normalizeAnchor(
  anchor: DiffAnchor | undefined,
  packet: ReviewPacket,
  diff: UnifiedDiff | undefined
): DiffAnchor | undefined {
  return validateAnchorForDiff(anchor, diff);
}

function packetPriority(packet: ReviewPacket): ReviewPriority {
  return packet.reviewPriority;
}

function summarizeWorkerOutcomes(outcomes: Array<{ outcome: string; attempts: number }>): {
  started: number;
  completed: number;
  failed: number;
  retried: number;
  timedOut: number;
} {
  return {
    started: outcomes.filter((outcome) => outcome.attempts > 0).length,
    completed: outcomes.filter((outcome) => outcome.outcome === "completed").length,
    failed: outcomes.filter((outcome) => outcome.outcome === "failed" || outcome.outcome === "cancelled" || outcome.outcome === "not_dispatched").length,
    retried: outcomes.filter((outcome) => outcome.attempts > 1).length,
    timedOut: outcomes.filter((outcome) => outcome.outcome === "timed_out").length
  };
}
