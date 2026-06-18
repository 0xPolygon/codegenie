import { buildRepositoryToolDefinitions } from "../llm/tool-definitions.js";
import type { LlmRunner, LlmSchemaRepairInput } from "../llm/llm-runner.js";
import { SubmitVerificationVerdictSchema, type SubmitVerificationVerdict } from "../llm/schemas.js";
import type { LensRegistry } from "../skills/lens-registry.js";
import { fenceUntrusted, stableJson, type PromptBuilder } from "../skills/prompt-builder.js";
import type { TelemetryRecorder } from "../telemetry/telemetry-recorder.js";
import type {
  CandidateFinding,
  CodeninjaConfig,
  PacketReviewResult,
  RepositoryTools,
  ReviewPacket,
  ReviewStage,
  UnifiedDiff,
  VerificationVerdict
} from "../types.js";
import { createWorkerRunner, type WorkerTask } from "./worker-runner.js";
import {
  isFatalLlmError,
  isRecoverableWorkerError,
  validateAnchorForDiff,
  validateAnchorForPacket
} from "./pipeline-utils.js";
import { isCodeninjaError } from "../util/errors.js";
import { scaleBudgetValue, scaleToolBudget } from "../util/budget.js";

const VERIFIER_TOOL_BUDGET = {
  maxToolCalls: 8,
  maxInvestigationRounds: 3,
  maxResultChars: 16_000,
  maxSingleToolResultChars: 6_000,
  reservedSourceResultChars: 4_000,
  sourceExtension: {
    maxToolCalls: 2,
    maxResultChars: 8_000
  }
};
const VERIFIER_EXPECTED_CALLS_PER_CANDIDATE = 2;
const VERIFIER_BASE_TOKEN_ESTIMATE = 1_000;
const EVIDENCE_RESOLUTION_LANE_MAX = 4;

type VerifyOptions = {
  runner: LlmRunner;
  promptBuilder: PromptBuilder;
  lensRegistry: LensRegistry;
  signal?: AbortSignal;
  checkpoint?: (stage: ReviewStage) => "ok" | "exhausted";
  reserve?: (stage: ReviewStage, estimatedTokens: number, estimatedModelCalls?: number) => "ok" | "exhausted";
  releaseReservation?: (stage: ReviewStage, estimatedTokens: number, estimatedModelCalls?: number) => void;
  diff?: UnifiedDiff;
};

type VerificationLane = "standard" | "evidence_resolution";
type VerificationGateDecisionLabel = "suppressed" | "scheduled" | "scheduled_for_evidence_resolution";

type VerificationGateFacts = {
  severity: CandidateFinding["severity"];
  confidence: CandidateFinding["confidence"];
  category: CandidateFinding["category"];
  changedLine: boolean;
  hasChangedCode: boolean;
  hasFailureMode: boolean;
  failureModeConcrete: boolean;
  relatedEvidenceCount: number;
};

type VerificationRecord =
  | {
      candidateId: string;
      gate: "suppressed";
      gateDecision: VerificationGateDecisionLabel;
      gateReason: string;
      verificationLane?: VerificationLane;
      gateFacts?: VerificationGateFacts;
      candidateProvenance?: CandidateFinding["provenance"];
      duplicateOf?: string;
      clusterId?: string;
    }
  | {
      candidateId: string;
      gate: "gate_anchor_stripped";
      gateDecision: VerificationGateDecisionLabel;
      gateReason: string;
      verificationLane?: VerificationLane;
      gateFacts?: VerificationGateFacts;
    }
  | {
      candidateId: string;
      gate: "passed" | "gate_anchor_stripped";
      verdict: VerificationVerdict;
      gateDecision?: VerificationGateDecisionLabel;
      gateReason?: string;
      verificationLane?: VerificationLane;
      gateFacts?: VerificationGateFacts;
      candidateProvenance?: CandidateFinding["provenance"];
      duplicateOf?: string;
      clusterId?: string;
      verificationStatus?: "completed" | "incomplete";
      incompleteReason?: string;
      errorCode?: string;
    };

type VerificationRuntimeStats = {
  schemaInvalid: number;
  repairAttempted: number;
  repairSucceeded: number;
  repairFailed: number;
};

type VerifierSchemaInvalidKind =
  | "xml_parameter_bleed"
  | "missing_submit_tool"
  | "invalid_tool_arguments"
  | "extra_tool_calls"
  | "unknown";

type VerifierRepairAttempt = {
  classification: VerifierSchemaInvalidKind;
  errorSummary: string;
};

type VerifierReservation = {
  candidateId: string;
  estimatedTokens: number;
  estimatedModelCalls: number;
  released: boolean;
};

type RelatedCodeEvidence = NonNullable<CandidateFinding["evidence"]["relatedCode"]>[number];

type CandidateGateDecision =
  | { outcome: "suppress"; reason: string; facts: VerificationGateFacts }
  | { outcome: "schedule"; reason: string; lane: VerificationLane; facts: VerificationGateFacts };

export async function verifyFindings(
  input: { packetResults: PacketReviewResult[]; packets: ReviewPacket[] },
  tools: RepositoryTools,
  config: CodeninjaConfig,
  telemetry: TelemetryRecorder,
  opts: VerifyOptions
): Promise<{ verified: CandidateFinding[]; verdicts: VerificationVerdict[]; incompleteCount: number; gateRejections: number; verificationSkipped: boolean }> {
  telemetry.event({ stage: 9, level: "info", message: "stage_started", data: { candidates: candidateCount(input.packetResults) } });
  const packetsById = new Map(input.packets.map((packet) => [packet.id, packet]));
  const inputCandidates = input.packetResults.flatMap((result) => result.findings);
  const candidateProvenanceById = new Map(
    inputCandidates
      .filter((candidate) => candidate.provenance !== undefined)
      .map((candidate) => [candidate.id, candidate.provenance])
  );
  const records: VerificationRecord[] = [];
  const gatePassed: CandidateFinding[] = [];
  const anchorStripped = new Set<string>();
  const verificationLaneByCandidateId = new Map<string, VerificationLane>();
  const gateReasonByCandidateId = new Map<string, string>();
  const gateFactsByCandidateId = new Map<string, VerificationGateFacts>();
  let gateRejections = 0;
  let lowConfidenceSuppressed = 0;
  let lowConfidenceEvidenceEligible = 0;

  for (const candidate of inputCandidates) {
    const preGated = preGateAnchor(candidate, packetsById.get(candidate.producedBy.packetId), opts.diff, telemetry);
    if (preGated.anchorStripped) {
      anchorStripped.add(candidate.id);
    }
    const gateDecision = gateCandidate(preGated.candidate, config);
    if (gateDecision.outcome === "suppress") {
      gateRejections += 1;
      if (preGated.candidate.confidence === "low" && gateDecision.reason.startsWith("low_confidence")) {
        lowConfidenceSuppressed += 1;
      }
      records.push(
        preGated.anchorStripped
          ? {
              candidateId: candidate.id,
              gate: "gate_anchor_stripped",
              gateDecision: "suppressed",
              gateReason: `invalid_anchor; ${gateDecision.reason}`,
              gateFacts: gateDecision.facts
            }
          : {
              candidateId: candidate.id,
              gate: "suppressed",
              gateDecision: "suppressed",
              gateReason: gateDecision.reason,
              gateFacts: gateDecision.facts
            }
      );
      telemetry.event({
        stage: 9,
        level: "info",
        message: "verification_gate_suppressed",
        data: {
          candidateId: candidate.id,
          gateReason: gateDecision.reason,
          gateFacts: gateDecision.facts,
          ...(preGated.candidate.provenance !== undefined ? { candidateProvenance: preGated.candidate.provenance } : {})
        }
      });
      continue;
    }
    if (gateDecision.lane === "evidence_resolution") {
      lowConfidenceEvidenceEligible += 1;
    }
    verificationLaneByCandidateId.set(preGated.candidate.id, gateDecision.lane);
    gateReasonByCandidateId.set(preGated.candidate.id, gateDecision.reason);
    gateFactsByCandidateId.set(preGated.candidate.id, gateDecision.facts);
    telemetry.event({
      stage: 9,
      level: "info",
      message: "verification_gate_scheduled",
      data: {
        candidateId: candidate.id,
        gateReason: gateDecision.reason,
        verificationLane: gateDecision.lane,
        gateFacts: gateDecision.facts
      }
    });
    gatePassed.push(preGated.candidate);
  }
  const clustered = clusterCandidates(gatePassed, packetsById, telemetry);

  if (!config.review.verify) {
    const verdicts = clustered.all.map((candidate): VerificationVerdict => ({
      candidateId: candidate.id,
      verdict: "keep",
      reason: "verification disabled by config",
      requiredEvidencePresent: true,
      falsePositiveRisk: "low"
    }));
    records.push(...verdicts.map((verdict) => verificationRecord(verdict, anchorStripped, candidateRecordMeta(
      verdict.candidateId,
      verificationLaneByCandidateId,
      gateReasonByCandidateId,
      gateFactsByCandidateId
    ))));
    const recordsWithProvenance = attachCandidateProvenance(records, candidateProvenanceById);
    await telemetry.writeArtifact("verification.json", recordsWithProvenance);
    const promotedCounts = promotedVerificationCounts(inputCandidates, recordsWithProvenance, verdicts);
    telemetry.event({
      stage: 9,
      level: "info",
      message: "pipeline_metrics",
      data: {
        totals: { verified: clustered.all.length },
        candidates: {
          gateRejected: gateRejections,
          verificationScheduled: 0,
          clusteredDuplicates: clustered.duplicateCount,
          verificationRepresentatives: clustered.representatives.length,
          lowConfidenceSuppressed,
          lowConfidenceEvidenceEligible,
          lowConfidenceEvidenceScheduled: 0,
          lowConfidenceEvidenceLaneLimited: 0,
          lowConfidenceEvidenceKept: clustered.all.filter((candidate) => verificationLaneByCandidateId.get(candidate.id) === "evidence_resolution").length,
          lowConfidenceEvidenceRejected: 0,
          lowConfidenceEvidenceIncomplete: 0,
          ...promotedCounts
        },
        verdicts: verdictCounts(verdicts)
      }
    });
    return { verified: clustered.all, verdicts, incompleteCount: 0, gateRejections, verificationSkipped: true };
  }

  const orderedRepresentatives = orderVerifierRepresentatives(clustered.representatives);
  const scheduling = scheduleVerifierRepresentatives(orderedRepresentatives, packetsById, opts, telemetry, verificationLaneByCandidateId, config.review.budgetMultiplier);
  const runtimeStats: VerificationRuntimeStats = {
    schemaInvalid: 0,
    repairAttempted: 0,
    repairSucceeded: 0,
    repairFailed: 0
  };
  const workerRunner = createWorkerRunner({
    concurrency: config.review.concurrency,
    signal: opts.signal,
    isRetriableError: isRecoverableWorkerError,
    ...(scheduling.usesHeldReservations ? {} : opts.checkpoint !== undefined ? { checkpoint: opts.checkpoint } : {})
  });
  const tasks = scheduling.scheduled.map((candidate): WorkerTask<VerificationVerdict> => ({
    stage: 9,
    priority: candidate.severity === "critical" ? "critical" : candidate.severity === "high" ? "high" : "normal",
    candidateId: candidate.id,
    timeoutMs: config.review.perPassTimeoutMs,
    retryOnTransient: false,
    run: async (_signal, task) => {
      releaseVerifierReservation(scheduling.reservations.get(candidate.id), opts);
      return verifyCandidate(candidate, packetsById.get(candidate.producedBy.packetId), tools, config, opts, task.workerId, telemetry, runtimeStats);
    }
  }));
  const outcomes = await workerRunner.schedule(tasks);
  releaseVerifierReservations(scheduling.reservations, opts);
  const verdicts: VerificationVerdict[] = [];
  let incompleteCount = 0;
  for (const candidate of scheduling.laneLimited) {
    records.push(...laneLimitedVerificationRecords(
      candidate,
      clustered.duplicatesByRepresentative,
      verificationLaneByCandidateId,
      gateFactsByCandidateId
    ));
  }
  for (const candidate of scheduling.budgetLimited) {
    const verdict = incompleteVerificationVerdict(candidate.id, "budget_limited before dispatch");
    verdicts.push(verdict);
    records.push(verificationRecord(verdict, anchorStripped, {
      ...candidateRecordMeta(candidate.id, verificationLaneByCandidateId, gateReasonByCandidateId, gateFactsByCandidateId),
      verificationStatus: "incomplete",
      incompleteReason: "budget_limited"
    }));
    const duplicates = clustered.duplicatesByRepresentative.get(candidate.id) ?? [];
    incompleteCount += 1 + duplicates.length;
    records.push(
      ...duplicateVerificationRecords(verdict, clustered.duplicatesByRepresentative, anchorStripped, {
        ...candidateRecordMeta(candidate.id, verificationLaneByCandidateId, gateReasonByCandidateId, gateFactsByCandidateId),
        verificationStatus: "incomplete",
        incompleteReason: "budget_limited"
      })
    );
  }
  for (const outcome of outcomes) {
    if (outcome.outcome === "completed" && outcome.value) {
      verdicts.push(outcome.value);
      const meta = {
        ...candidateRecordMeta(outcome.value.candidateId, verificationLaneByCandidateId, gateReasonByCandidateId, gateFactsByCandidateId),
        ...verificationRecordMeta(outcome.value)
      };
      records.push(verificationRecord(outcome.value, anchorStripped, meta));
      records.push(...duplicateVerificationRecords(outcome.value, clustered.duplicatesByRepresentative, anchorStripped, meta));
      if (outcome.value.verificationIncomplete) {
        const duplicates = clustered.duplicatesByRepresentative.get(outcome.value.candidateId) ?? [];
        incompleteCount += 1 + duplicates.length;
      }
      continue;
    }
    if (isFatalLlmError(outcome.error)) {
      throw outcome.error;
    }
    const candidateId = outcome.task.candidateId ?? "unknown";
    const verdict = incompleteVerificationVerdict(candidateId, verifierOutcomeReason(outcome));
    verdicts.push(verdict);
    const meta = {
      ...candidateRecordMeta(candidateId, verificationLaneByCandidateId, gateReasonByCandidateId, gateFactsByCandidateId),
      ...verificationRecordMeta(verdict, outcome.error)
    };
    records.push(verificationRecord(verdict, anchorStripped, meta));
    const duplicates = clustered.duplicatesByRepresentative.get(candidateId) ?? [];
    incompleteCount += 1 + duplicates.length;
    records.push(...duplicateVerificationRecords(verdict, clustered.duplicatesByRepresentative, anchorStripped, meta));
  }

  const byId = new Map(clustered.representatives.map((candidate) => [candidate.id, candidate]));
  const verified = verdicts.flatMap((verdict) => {
    if (verdict.verificationIncomplete || verdict.verdict === "reject") {
      return [];
    }
    const candidate = byId.get(verdict.candidateId);
    if (!candidate) {
      return [];
    }
    const duplicates = clustered.duplicatesByRepresentative.get(verdict.candidateId) ?? [];
    return [candidate, ...duplicates].map((clusterCandidate) => applyVerificationVerdict(clusterCandidate, verdict));
  });

  const evidenceResolutionCounts = evidenceResolutionVerdictCounts(verdicts, verificationLaneByCandidateId);
  const recordsWithProvenance = attachCandidateProvenance(records, candidateProvenanceById);
  await telemetry.writeArtifact("verification.json", recordsWithProvenance);
  const promotedCounts = promotedVerificationCounts(inputCandidates, recordsWithProvenance, verdicts);
  telemetry.event({
    stage: 9,
    level: "info",
    message: "pipeline_metrics",
    data: {
      totals: { verified: verified.length },
      workers: summarizeWorkerOutcomes(outcomes, {
        budgetLimited: scheduling.budgetLimited.length,
        runtimeStats
      }),
      candidates: {
        gateRejected: gateRejections,
        verificationScheduled: scheduling.scheduled.length,
        verificationBudgetLimited: scheduling.budgetLimited.length,
        lowConfidenceSuppressed,
        lowConfidenceEvidenceEligible,
        lowConfidenceEvidenceScheduled: scheduling.evidenceResolutionScheduled,
        lowConfidenceEvidenceLaneLimited: scheduling.laneLimited.length,
        lowConfidenceEvidenceKept: evidenceResolutionCounts.kept,
        lowConfidenceEvidenceRejected: evidenceResolutionCounts.rejected,
        lowConfidenceEvidenceIncomplete: evidenceResolutionCounts.incomplete,
        clusteredDuplicates: clustered.duplicateCount,
        verificationRepresentatives: clustered.representatives.length,
        ...promotedCounts
      },
      verdicts: verdictCounts(verdicts)
    }
  });
  telemetry.event({ stage: 9, level: "info", message: "stage_completed", data: { verified: verified.length, incompleteCount, gateRejections } });
  return { verified, verdicts, incompleteCount, gateRejections, verificationSkipped: false };
}

function preGateAnchor(
  candidate: CandidateFinding,
  packet: ReviewPacket | undefined,
  diff: UnifiedDiff | undefined,
  telemetry: TelemetryRecorder
): { candidate: CandidateFinding; anchorStripped: boolean } {
  if (!candidate.anchor) {
    return { candidate, anchorStripped: false };
  }
  const anchor = normalizeAnchor(candidate.anchor, packet, diff);
  if (!anchor) {
    const { anchor: _invalidAnchor, ...withoutAnchor } = candidate;
    telemetry.event({
      stage: 9,
      level: "warn",
      message: "gate_anchor_stripped",
      file: candidate.path,
      data: { candidateId: candidate.id, anchor: candidate.anchor }
    });
    return { candidate: { ...withoutAnchor, changedLine: false }, anchorStripped: true };
  }
  return {
    candidate: {
      ...candidate,
      anchor,
      path: anchor.path,
      changedLine: true
    },
    anchorStripped: false
  };
}

function applyVerdictAnchor(candidate: CandidateFinding, verdict: VerificationVerdict): CandidateFinding {
  if (verdict.revisedAnchor === undefined) {
    return candidate;
  }
  return {
    ...candidate,
    anchor: verdict.revisedAnchor,
    path: verdict.revisedAnchor.path,
    changedLine: true
  };
}

function applyVerificationVerdict(candidate: CandidateFinding, verdict: VerificationVerdict): CandidateFinding {
  const revised = verdict.finalFinding !== undefined
    ? applyFindingRevision(candidate, verdict.finalFinding)
    : candidate;
  return applyVerdictIntentAssessment(applyVerdictAnchor(revised, verdict), verdict);
}

function applyFindingRevision(candidate: CandidateFinding, revision: CandidateFinding): CandidateFinding {
  const { clusterId: _revisionClusterId, duplicateOf: _revisionDuplicateOf, ...revisionFields } = revision;
  return {
    ...revisionFields,
    id: candidate.id,
    producedBy: candidate.producedBy,
    ...(candidate.clusterId !== undefined ? { clusterId: candidate.clusterId } : {}),
    ...(candidate.duplicateOf !== undefined ? { duplicateOf: candidate.duplicateOf } : {})
  };
}

function applyVerdictIntentAssessment(candidate: CandidateFinding, verdict: VerificationVerdict): CandidateFinding {
  return {
    ...candidate,
    ...(verdict.behaviorChange !== undefined ? { behaviorChange: verdict.behaviorChange } : {}),
    ...(verdict.intentEvidence !== undefined ? { intentEvidence: verdict.intentEvidence } : {})
  };
}

function duplicateVerificationRecords(
  verdict: VerificationVerdict,
  duplicatesByRepresentative: Map<string, CandidateFinding[]>,
  anchorStripped: Set<string>,
  meta: Partial<Extract<VerificationRecord, { verdict: VerificationVerdict }>> = {}
): VerificationRecord[] {
  return (duplicatesByRepresentative.get(verdict.candidateId) ?? []).map((duplicate) => {
    const duplicateVerdict: VerificationVerdict = {
      ...verdict,
      candidateId: duplicate.id,
      ...(verdict.finalFinding !== undefined ? { finalFinding: applyVerificationVerdict(duplicate, verdict) } : {})
    };
    return {
      candidateId: duplicate.id,
      gate: anchorStripped.has(duplicate.id) ? "gate_anchor_stripped" as const : "passed" as const,
      duplicateOf: verdict.candidateId,
      clusterId: duplicate.clusterId ?? verdict.candidateId,
      verdict: duplicateVerdict,
      ...meta
    };
  });
}

function verificationRecord(
  verdict: VerificationVerdict,
  anchorStripped: Set<string>,
  meta: Partial<Extract<VerificationRecord, { verdict: VerificationVerdict }>> = {}
): VerificationRecord {
  return {
    candidateId: verdict.candidateId,
    gate: anchorStripped.has(verdict.candidateId) ? "gate_anchor_stripped" : "passed",
    verdict,
    ...meta
  };
}

async function verifyCandidate(
  candidate: CandidateFinding,
  packet: ReviewPacket | undefined,
  tools: RepositoryTools,
  config: CodeninjaConfig,
  opts: VerifyOptions,
  workerId: string,
  telemetry: TelemetryRecorder,
  runtimeStats: VerificationRuntimeStats
): Promise<VerificationVerdict> {
  const skills = opts.lensRegistry.skillsForLens(candidate.producedBy.lensId);
  const prompt = opts.promptBuilder.buildVerifierPrompt({
    candidate,
    originContext: verificationOriginContext(candidate, packet),
    hunksText: packet?.hunks.map((hunk) => hunk.contentWithLineNumbers).join("\n\n") ?? "",
    ...(packet?.intentSignals !== undefined ? { intentSignals: packet.intentSignals } : {}),
    skills
  });
  const submitted = await runVerifierStructured(candidate, prompt, tools, config, opts, workerId, telemetry, runtimeStats);
  const normalized = normalizeSubmittedVerdict(candidate, submitted, telemetry);
  const revised = normalized.finalFinding !== undefined
    ? revisedFinding(candidate, normalized.finalFinding, packet, opts.diff)
    : undefined;
  const revisedAnchor = normalizeAnchor(normalized.revisedAnchor, packet, opts.diff);
  return {
    candidateId: candidate.id,
    verdict: normalized.verdict,
    reason: normalized.reason,
    requiredEvidencePresent: normalized.requiredEvidencePresent,
    falsePositiveRisk: normalized.falsePositiveRisk,
    ...(revised !== undefined ? { finalFinding: revised } : {}),
    ...(revisedAnchor !== undefined ? { revisedAnchor } : {}),
    ...(normalized.reason.startsWith("verification incomplete:") ? { verificationIncomplete: true } : {}),
    ...(normalized.behaviorChange !== undefined ? { behaviorChange: normalized.behaviorChange } : {}),
    ...(normalized.intentEvidence !== undefined ? { intentEvidence: normalized.intentEvidence } : {})
  };
}

function verificationOriginContext(candidate: CandidateFinding, packet: ReviewPacket | undefined): string {
  if (!packet) {
    return "";
  }
  const linkedQuestionIds = new Set(candidate.reviewQuestionIds ?? []);
  const linkedQuestions = (packet.reviewQuestions ?? []).filter((question) => linkedQuestionIds.has(question.id));
  if (linkedQuestions.length === 0) {
    return packet.contextText;
  }
  const questionContext = stableJson(linkedQuestions.map((question) => ({
    id: question.id,
    question: question.question,
    whyItMatters: question.whyItMatters,
    files: question.files,
    symbols: question.symbols,
    evidenceHint: question.evidenceHint,
    relevanceReason: question.relevanceReason
  })));
  return [packet.contextText, `Linked planner review questions:\n${questionContext}`]
    .filter((part) => part.trim().length > 0)
    .join("\n\n");
}

function normalizeSubmittedVerdict(
  candidate: CandidateFinding,
  submitted: SubmitVerificationVerdict,
  telemetry: TelemetryRecorder
): SubmitVerificationVerdict {
  if (submitted.verdict === "reject" || submitted.requiredEvidencePresent === true) {
    return submitted;
  }
  telemetry.event({
    stage: 9,
    level: "warn",
    message: "verification_missing_evidence_normalized_to_reject",
    file: candidate.path,
    data: {
      candidateId: candidate.id,
      originalVerdict: submitted.verdict,
      falsePositiveRisk: submitted.falsePositiveRisk
    }
  });
  return {
    verdict: "reject",
    reason: `required evidence missing; original ${submitted.verdict} verdict rejected: ${submitted.reason}`,
    requiredEvidencePresent: false,
    falsePositiveRisk: "high"
  };
}

async function runVerifierStructured(
  candidate: CandidateFinding,
  prompt: { prompt: string; templateVersion: string },
  tools: RepositoryTools,
  config: CodeninjaConfig,
  opts: VerifyOptions,
  workerId: string,
  telemetry: TelemetryRecorder,
  runtimeStats: VerificationRuntimeStats
): Promise<SubmitVerificationVerdict> {
  let repairAttempt: VerifierRepairAttempt | undefined;
  try {
    const result = await opts.runner.runStructured<SubmitVerificationVerdict>({
      stage: 9,
      prompt: prompt.prompt,
      schema: SubmitVerificationVerdictSchema,
      templateVersion: prompt.templateVersion,
      tools: buildRepositoryToolDefinitions(tools, { includeLikelyTests: candidate.category === "testing" }),
      toolBudget: scaleToolBudget(VERIFIER_TOOL_BUDGET, config.review.budgetMultiplier),
      timeoutMs: config.review.perPassTimeoutMs,
      telemetryContext: { workerId, candidateId: candidate.id, packetId: candidate.producedBy.packetId },
      schemaRepair: {
        replaceConversation: true,
        failAfterRepair: false,
        buildPrompt: (input) => {
          repairAttempt = recordVerifierSchemaRepairAttempt(candidate, input, telemetry, runtimeStats);
          return buildVerifierSchemaRepairPrompt(candidate, input, repairAttempt);
        }
      }
    });
    if (repairAttempt !== undefined) {
      runtimeStats.repairSucceeded += 1;
    }
    return result;
  } catch (error) {
    if (repairAttempt !== undefined && isBudgetExhaustedWorkerError(error)) {
      runtimeStats.repairFailed += 1;
      telemetry.event({
        stage: 9,
        level: "warn",
        message: "verification_schema_repair_failed",
        file: candidate.path,
        data: {
          candidateId: candidate.id,
          classification: repairAttempt.classification,
          error: "budget exhausted before repair dispatch"
        }
      });
      return incompleteSubmittedVerdict(`schema_invalid; repair not dispatched because budget was exhausted: ${repairAttempt.classification}`);
    }
    if (!isSchemaInvalidError(error)) {
      throw error;
    }
    const errorSummary = sanitizeVerifierSchemaError(verifierErrorSummary(error));
    const fallbackAttempt = repairAttempt ?? recordVerifierSchemaInvalid(candidate, errorSummary, classifyVerifierSchemaInvalid(errorSummary), telemetry, runtimeStats);
    if (opts.checkpoint?.(9) === "exhausted") {
      runtimeStats.repairFailed += 1;
      return incompleteSubmittedVerdict(`schema_invalid; repair not dispatched because budget was exhausted: ${fallbackAttempt.classification}`);
    }
    const repairedFailed = repairAttempt !== undefined;
    if (repairedFailed) {
      runtimeStats.schemaInvalid += 1;
    }
    runtimeStats.repairFailed += 1;
    telemetry.event({
      stage: 9,
      level: "warn",
      message: "verification_schema_repair_failed",
      file: candidate.path,
      data: {
        candidateId: candidate.id,
        classification: fallbackAttempt.classification,
        error: errorSummary
      }
    });
    return incompleteSubmittedVerdict(`${repairedFailed ? "schema_invalid_after_repair" : "schema_invalid"}: ${fallbackAttempt.classification}`);
  }
}

function recordVerifierSchemaRepairAttempt(
  candidate: CandidateFinding,
  input: LlmSchemaRepairInput,
  telemetry: TelemetryRecorder,
  runtimeStats: VerificationRuntimeStats
): VerifierRepairAttempt {
  const classification = classifyVerifierSchemaInvalid(input);
  const attempt = recordVerifierSchemaInvalid(candidate, sanitizeVerifierSchemaError(input.error), classification, telemetry, runtimeStats);
  runtimeStats.repairAttempted += 1;
  telemetry.event({
    stage: 9,
    level: "info",
    message: "verification_schema_repair_attempted",
    file: candidate.path,
    data: {
      candidateId: candidate.id,
      classification
    }
  });
  return attempt;
}

function recordVerifierSchemaInvalid(
  candidate: CandidateFinding,
  errorSummary: string,
  classification: VerifierSchemaInvalidKind,
  telemetry: TelemetryRecorder,
  runtimeStats: VerificationRuntimeStats
): VerifierRepairAttempt {
  runtimeStats.schemaInvalid += 1;
  telemetry.event({
    stage: 9,
    level: "warn",
    message: "verification_schema_invalid",
    file: candidate.path,
    data: {
      candidateId: candidate.id,
      classification,
      error: errorSummary
    }
  });
  return { classification, errorSummary };
}

function buildVerifierSchemaRepairPrompt(
  candidate: CandidateFinding,
  input: LlmSchemaRepairInput,
  attempt: VerifierRepairAttempt
): string {
  const anchor = candidate.anchor
    ? `${candidate.anchor.path}:${String(candidate.anchor.line)} ${candidate.anchor.side}`
    : `${candidate.path}:unanchored`;
  const candidateSummary = fenceUntrusted(stableJson({
    id: candidate.id,
    title: candidate.title,
    path: candidate.path,
    anchor
  }), "verifier-repair-candidate-summary");
  return [
    "Repair the Stage 9 verifier response for codeninja.",
    "",
    candidateSummary,
    "",
    "Validation problem:",
    `- class: ${attempt.classification}`,
    `- summary: ${attempt.errorSummary}`,
    `- submit tool: ${input.submitTool}`,
    "",
    "Required action:",
    `- Call \`${input.submitTool}\` exactly once with schema-valid arguments.`,
    "- Do not output XML.",
    "- Do not write `<parameter>` tags.",
    "- Do not describe the schema.",
    "- Do not answer in plain text.",
    "- Do not call repository tools or ask for more context.",
    "",
    "Verdict reminder:",
    "- keep only if the candidate is proven by concrete evidence.",
    "- revise only when the same issue is real but the evidence, wording, or anchor needs correction.",
    "- reject when required evidence is missing, the claim is speculative, or false-positive risk is high.",
    "- If rejecting because verification cannot be completed, set requiredEvidencePresent=false and falsePositiveRisk=high."
  ].join("\n");
}

function classifyVerifierSchemaInvalid(input: LlmSchemaRepairInput | string): VerifierSchemaInvalidKind {
  const errorText = typeof input === "string" ? input : input.error;
  const serializedSubmitArgs = typeof input === "string"
    ? ""
    : input.submitCalls.map((call) => safeStringify(call.arguments)).join("\n");
  const text = `${errorText}\n${serializedSubmitArgs}`.toLowerCase();
  if (/<\/?\s*parameter\b/u.test(text) || /&lt;\/?\s*parameter\b/u.test(text)) {
    return "xml_parameter_bleed";
  }
  if (typeof input !== "string" && input.extraToolNames.length > 0) {
    return "extra_tool_calls";
  }
  if (/did not call|missing submit|no submit|plain text/u.test(text)) {
    return "missing_submit_tool";
  }
  if (typeof input !== "string" && input.submitCalls.length === 0) {
    return "missing_submit_tool";
  }
  if (/schema|validation|required property|additional propert|invalid|arguments/u.test(text)) {
    return "invalid_tool_arguments";
  }
  if (typeof input !== "string" && input.submitCalls.length > 0) {
    return "invalid_tool_arguments";
  }
  return "unknown";
}

function sanitizeVerifierSchemaError(error: string): string {
  return clampVerifierDiagnostic(
    error
      .replace(/<\s*parameter\b[^>]*>[\s\S]*?<\s*\/\s*parameter\s*>/giu, "[xml-parameter-block]")
      .replace(/&lt;\s*parameter\b[\s\S]*?&lt;\s*\/\s*parameter\s*&gt;/giu, "[xml-parameter-block]")
      .replace(/<[^>]{1,200}>/gu, "[xml-like-tag]")
  );
}

function clampVerifierDiagnostic(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 500 ? `${trimmed.slice(0, 497)}...` : trimmed;
}

function safeStringify(input: unknown): string {
  try {
    return JSON.stringify(input) ?? "";
  } catch {
    return "";
  }
}

function revisedFinding(
  original: CandidateFinding,
  submitted: SubmitVerificationVerdict["finalFinding"],
  packet: ReviewPacket | undefined,
  diff: UnifiedDiff | undefined
): CandidateFinding | undefined {
  if (!submitted) {
    return undefined;
  }
  const submittedAnchor = normalizeAnchor(submitted.anchor, packet, diff);
  const originalAnchor = validateAnchorForDiff(original.anchor, diff);
  const anchor = submittedAnchor ?? originalAnchor;
  const revised: CandidateFinding = {
    id: original.id,
    title: submitted.title,
    severity: submitted.severity,
    confidence: submitted.confidence,
    path: anchor !== undefined ? pathFromAnchor(anchor, original.path) : original.path,
    changedLine: anchor !== undefined,
    category: submitted.category,
    evidence: submitted.evidence,
    failureMode: submitted.failureMode,
    whyThisMatters: submitted.whyThisMatters,
    verification: submitted.verification,
    ...(submitted.behaviorChange !== undefined ? { behaviorChange: submitted.behaviorChange } : {}),
    ...(submitted.intentEvidence !== undefined ? { intentEvidence: submitted.intentEvidence } : {}),
    producedBy: original.producedBy,
    ...(original.reviewQuestionIds !== undefined ? { reviewQuestionIds: original.reviewQuestionIds } : {}),
    ...(original.clusterId !== undefined ? { clusterId: original.clusterId } : {}),
    ...(original.duplicateOf !== undefined ? { duplicateOf: original.duplicateOf } : {})
  };
  if (anchor !== undefined) {
    revised.anchor = anchor;
  }
  if (submitted.suggestedFix !== undefined) {
    revised.suggestedFix = submitted.suggestedFix;
  }
  if (submitted.suggestedTest !== undefined) {
    revised.suggestedTest = submitted.suggestedTest;
  }
  return revised;
}

function pathFromAnchor(anchor: CandidateFinding["anchor"], fallbackPath: string): string {
  if (!anchor) {
    return fallbackPath;
  }
  return anchor.path;
}

function normalizeAnchor(
  anchor: CandidateFinding["anchor"],
  packet: ReviewPacket | undefined,
  diff: UnifiedDiff | undefined
): CandidateFinding["anchor"] {
  const packetValid = packet ? validateAnchorForPacket(anchor, packet) : anchor;
  return validateAnchorForDiff(packetValid, diff);
}

function gateCandidate(candidate: CandidateFinding, config: CodeninjaConfig): CandidateGateDecision {
  const facts = candidateGateFacts(candidate);
  if (!facts.hasChangedCode) {
    return { outcome: "suppress", reason: "missing_evidence", facts };
  }
  if (!facts.hasFailureMode) {
    return { outcome: "suppress", reason: "missing_failure_mode", facts };
  }
  if (!belowConfidence(candidate.confidence, config.review.minConfidence)) {
    return { outcome: "schedule", reason: "meets_confidence_threshold", lane: "standard", facts };
  }
  if (candidate.severity === "critical" || candidate.severity === "high") {
    return { outcome: "schedule", reason: "high_impact_below_confidence_threshold", lane: "standard", facts };
  }
  if (candidate.confidence === "low" && isEvidenceBackedLowConfidenceCandidate(facts)) {
    return { outcome: "schedule", reason: "low_confidence_evidence_backed", lane: "evidence_resolution", facts };
  }
  return { outcome: "suppress", reason: lowConfidenceGateReason(facts), facts };
}

function candidateGateFacts(candidate: CandidateFinding): VerificationGateFacts {
  const relatedEvidenceCount = (candidate.evidence.relatedCode ?? []).filter((entry) =>
    entry.path.trim().length > 0 &&
    entry.lines.trim().length > 0 &&
    entry.whyRelevant.trim().length > 0
  ).length;
  const failureMode = candidate.failureMode.trim();
  return {
    severity: candidate.severity,
    confidence: candidate.confidence,
    category: candidate.category,
    changedLine: candidate.changedLine === true && candidate.anchor !== undefined,
    hasChangedCode: candidate.evidence.changedCode.trim().length > 0,
    hasFailureMode: failureMode.length > 0,
    failureModeConcrete: failureMode.length >= 24,
    relatedEvidenceCount
  };
}

function isEvidenceBackedLowConfidenceCandidate(facts: VerificationGateFacts): boolean {
  return facts.changedLine &&
    facts.hasChangedCode &&
    facts.hasFailureMode &&
    facts.failureModeConcrete &&
    facts.relatedEvidenceCount > 0 &&
    (facts.category === "logic_bug" || facts.category === "correctness" || facts.category === "security");
}

function lowConfidenceGateReason(facts: VerificationGateFacts): string {
  if (facts.confidence !== "low") {
    return "below_min_confidence";
  }
  if (!(facts.category === "logic_bug" || facts.category === "correctness" || facts.category === "security")) {
    return "low_confidence_unsupported_category";
  }
  if (!facts.changedLine) {
    return "low_confidence_no_changed_line_anchor";
  }
  if (facts.relatedEvidenceCount === 0) {
    return "low_confidence_no_related_evidence";
  }
  if (!facts.failureModeConcrete) {
    return "low_confidence_weak_failure_mode";
  }
  return "low_confidence";
}

function belowConfidence(actual: CandidateFinding["confidence"], minimum: CandidateFinding["confidence"]): boolean {
  return confidenceRank(actual) > confidenceRank(minimum);
}

function candidateCount(results: PacketReviewResult[]): number {
  return results.reduce((sum, result) => sum + result.findings.length, 0);
}

function orderVerifierRepresentatives(candidates: CandidateFinding[]): CandidateFinding[] {
  return [...candidates].sort((a, b) =>
    severityRank(a.severity) - severityRank(b.severity) ||
    changedLineRank(a) - changedLineRank(b) ||
    confidenceRank(a.confidence) - confidenceRank(b.confidence) ||
    a.id.localeCompare(b.id)
  );
}

function changedLineRank(candidate: CandidateFinding): number {
  return candidate.changedLine && candidate.anchor !== undefined ? 0 : 1;
}

function scheduleVerifierRepresentatives(
  candidates: CandidateFinding[],
  packetsById: Map<string, ReviewPacket>,
  opts: VerifyOptions,
  telemetry: TelemetryRecorder,
  verificationLaneByCandidateId: Map<string, VerificationLane>,
  budgetMultiplier: number
): {
  scheduled: CandidateFinding[];
  budgetLimited: CandidateFinding[];
  laneLimited: CandidateFinding[];
  reservations: Map<string, VerifierReservation>;
  usesHeldReservations: boolean;
  evidenceResolutionScheduled: number;
} {
  const reservations = new Map<string, VerifierReservation>();
  const scheduled: CandidateFinding[] = [];
  const budgetLimited: CandidateFinding[] = [];
  const laneLimited: CandidateFinding[] = [];
  const canHoldReservations = opts.reserve !== undefined && opts.releaseReservation !== undefined;
  const standardCandidates = candidates.filter((candidate) => verificationLaneByCandidateId.get(candidate.id) !== "evidence_resolution");
  const evidenceResolutionCandidates = candidates.filter((candidate) => verificationLaneByCandidateId.get(candidate.id) === "evidence_resolution");
  const evidenceResolutionLaneMax = scaleBudgetValue(EVIDENCE_RESOLUTION_LANE_MAX, budgetMultiplier);
  const evidenceResolutionScheduledCandidates = evidenceResolutionCandidates.slice(0, evidenceResolutionLaneMax);
  laneLimited.push(...evidenceResolutionCandidates.slice(evidenceResolutionLaneMax));

  for (const candidate of [...standardCandidates, ...evidenceResolutionScheduledCandidates]) {
    if (budgetLimited.length > 0) {
      budgetLimited.push(candidate);
      continue;
    }
    if (canHoldReservations) {
      const reservation: VerifierReservation = {
        candidateId: candidate.id,
        estimatedTokens: estimateVerifierReservationTokens(candidate, packetsById.get(candidate.producedBy.packetId)),
        estimatedModelCalls: VERIFIER_EXPECTED_CALLS_PER_CANDIDATE,
        released: false
      };
      if (opts.reserve?.(9, reservation.estimatedTokens, reservation.estimatedModelCalls) === "exhausted") {
        budgetLimited.push(candidate);
        continue;
      }
      reservations.set(candidate.id, reservation);
    }
    scheduled.push(candidate);
  }

  telemetry.event({
    stage: 9,
    level: budgetLimited.length > 0 ? "warn" : "info",
    message: "verification_scheduling",
    data: {
      expectedCallsPerCandidate: VERIFIER_EXPECTED_CALLS_PER_CANDIDATE,
      evidenceResolutionLaneMax,
      orderedCandidateIds: candidates.map((candidate) => candidate.id),
      scheduledCandidateIds: scheduled.map((candidate) => candidate.id),
      budgetLimitedCandidateIds: budgetLimited.map((candidate) => candidate.id),
      evidenceResolutionCandidateIds: evidenceResolutionCandidates.map((candidate) => candidate.id),
      evidenceResolutionScheduledCandidateIds: scheduled
        .filter((candidate) => verificationLaneByCandidateId.get(candidate.id) === "evidence_resolution")
        .map((candidate) => candidate.id),
      evidenceResolutionLaneLimitedCandidateIds: laneLimited.map((candidate) => candidate.id),
      priorities: candidates.map((candidate) => ({
        candidateId: candidate.id,
        severity: candidate.severity,
        confidence: candidate.confidence,
        changedLine: candidate.changedLine === true && candidate.anchor !== undefined,
        verificationLane: verificationLaneByCandidateId.get(candidate.id) ?? "standard"
      }))
    }
  });

  return {
    scheduled,
    budgetLimited,
    laneLimited,
    reservations,
    usesHeldReservations: canHoldReservations && reservations.size > 0,
    evidenceResolutionScheduled: scheduled.filter((candidate) => verificationLaneByCandidateId.get(candidate.id) === "evidence_resolution").length
  };
}

function releaseVerifierReservations(reservations: Map<string, VerifierReservation>, opts: VerifyOptions): void {
  for (const reservation of reservations.values()) {
    releaseVerifierReservation(reservation, opts);
  }
}

function releaseVerifierReservation(reservation: VerifierReservation | undefined, opts: VerifyOptions): void {
  if (!reservation || reservation.released) {
    return;
  }
  reservation.released = true;
  opts.releaseReservation?.(9, reservation.estimatedTokens, reservation.estimatedModelCalls);
}

function estimateVerifierReservationTokens(candidate: CandidateFinding, packet: ReviewPacket | undefined): number {
  const hunkText = packet?.hunks.map((hunk) => hunk.contentWithLineNumbers).join("\n\n") ?? "";
  const rawChars = JSON.stringify(candidate).length + (packet?.contextText.length ?? 0) + hunkText.length;
  return VERIFIER_BASE_TOKEN_ESTIMATE + Math.ceil(rawChars / 4);
}

function verdictCounts(verdicts: VerificationVerdict[]): { accept: number; revise: number; reject: number; incomplete: number } {
  return {
    accept: verdicts.filter((verdict) => verdict.verdict === "keep").length,
    revise: verdicts.filter((verdict) => verdict.verdict === "revise").length,
    reject: verdicts.filter((verdict) => verdict.verdict === "reject" && verdict.verificationIncomplete !== true).length,
    incomplete: verdicts.filter((verdict) => verdict.verificationIncomplete === true).length
  };
}

function evidenceResolutionVerdictCounts(
  verdicts: VerificationVerdict[],
  verificationLaneByCandidateId: Map<string, VerificationLane>
): { kept: number; rejected: number; incomplete: number } {
  const evidenceVerdicts = verdicts.filter((verdict) => verificationLaneByCandidateId.get(verdict.candidateId) === "evidence_resolution");
  return {
    kept: evidenceVerdicts.filter((verdict) => verdict.verificationIncomplete !== true && verdict.verdict !== "reject").length,
    rejected: evidenceVerdicts.filter((verdict) => verdict.verificationIncomplete !== true && verdict.verdict === "reject").length,
    incomplete: evidenceVerdicts.filter((verdict) => verdict.verificationIncomplete === true).length
  };
}

function candidateRecordMeta(
  candidateId: string,
  verificationLaneByCandidateId: Map<string, VerificationLane>,
  gateReasonByCandidateId: Map<string, string>,
  gateFactsByCandidateId: Map<string, VerificationGateFacts>
): Partial<Extract<VerificationRecord, { verdict: VerificationVerdict }>> {
  const verificationLane = verificationLaneByCandidateId.get(candidateId);
  const gateReason = gateReasonByCandidateId.get(candidateId);
  const gateFacts = gateFactsByCandidateId.get(candidateId);
  return {
    ...(verificationLane !== undefined ? { verificationLane } : {}),
    ...(verificationLane !== undefined ? { gateDecision: verificationLane === "evidence_resolution" ? "scheduled_for_evidence_resolution" : "scheduled" } : {}),
    ...(gateReason !== undefined ? { gateReason } : {}),
    ...(gateFacts !== undefined ? { gateFacts } : {})
  };
}

function attachCandidateProvenance(
  records: VerificationRecord[],
  candidateProvenanceById: Map<string, CandidateFinding["provenance"]>
): VerificationRecord[] {
  return records.map((record) => {
    const provenance = candidateProvenanceById.get(record.candidateId);
    return provenance !== undefined ? { ...record, candidateProvenance: provenance } : record;
  });
}

function promotedVerificationCounts(
  candidates: CandidateFinding[],
  records: VerificationRecord[],
  verdicts: VerificationVerdict[]
): {
  promotedCandidates: number;
  promotedGateRejected: number;
  promotedVerificationScheduled: number;
  promotedVerificationKept: number;
  promotedVerificationRejected: number;
  promotedVerificationIncomplete: number;
  promotedVerificationLaneLimited: number;
} {
  const promotedIds = new Set(
    candidates
      .filter((candidate) => candidate.provenance?.source === "uncertainty_promotion")
      .map((candidate) => candidate.id)
  );
  const promotedVerdicts = verdicts.filter((verdict) => promotedIds.has(verdict.candidateId));
  const promotedRecords = records.filter((record) => promotedIds.has(record.candidateId));
  return {
    promotedCandidates: promotedIds.size,
    promotedGateRejected: promotedRecords.filter((record) =>
      record.gate === "suppressed" &&
      record.gateDecision === "suppressed"
    ).length,
    promotedVerificationScheduled: promotedVerdicts.length,
    promotedVerificationKept: promotedVerdicts.filter((verdict) => verdict.verificationIncomplete !== true && verdict.verdict !== "reject").length,
    promotedVerificationRejected: promotedVerdicts.filter((verdict) => verdict.verificationIncomplete !== true && verdict.verdict === "reject").length,
    promotedVerificationIncomplete: promotedVerdicts.filter((verdict) => verdict.verificationIncomplete === true).length,
    promotedVerificationLaneLimited: promotedRecords.filter((record) =>
      record.gateReason === "low_confidence_evidence_resolution_lane_limit"
    ).length
  };
}

function laneLimitedVerificationRecords(
  representative: CandidateFinding,
  duplicatesByRepresentative: Map<string, CandidateFinding[]>,
  verificationLaneByCandidateId: Map<string, VerificationLane>,
  gateFactsByCandidateId: Map<string, VerificationGateFacts>
): VerificationRecord[] {
  const records: VerificationRecord[] = [laneLimitedVerificationRecord(representative, verificationLaneByCandidateId, gateFactsByCandidateId)];
  records.push(...(duplicatesByRepresentative.get(representative.id) ?? []).map((duplicate) => ({
    ...laneLimitedVerificationRecord(duplicate, verificationLaneByCandidateId, gateFactsByCandidateId),
    duplicateOf: representative.id,
    clusterId: duplicate.clusterId ?? representative.id
  })));
  return records;
}

function laneLimitedVerificationRecord(
  candidate: CandidateFinding,
  verificationLaneByCandidateId: Map<string, VerificationLane>,
  gateFactsByCandidateId: Map<string, VerificationGateFacts>
): VerificationRecord {
  const gateFacts = gateFactsByCandidateId.get(candidate.id);
  return {
    candidateId: candidate.id,
    gate: "suppressed",
    gateDecision: "scheduled_for_evidence_resolution",
    gateReason: "low_confidence_evidence_resolution_lane_limit",
    verificationLane: verificationLaneByCandidateId.get(candidate.id) ?? "evidence_resolution",
    ...(gateFacts !== undefined ? { gateFacts } : {})
  };
}

function summarizeWorkerOutcomes(
  outcomes: Array<{ outcome: string; attempts: number; error?: unknown; value?: VerificationVerdict }>,
  opts: {
    budgetLimited: number;
    runtimeStats: VerificationRuntimeStats;
  }
): {
  scheduled: number;
  started: number;
  completed: number;
  failed: number;
  retried: number;
  timedOut: number;
  schemaInvalid: number;
  repairAttempted: number;
  repairSucceeded: number;
  repairFailed: number;
  notDispatched: number;
  budgetLimited: number;
} {
  return {
    scheduled: outcomes.length + opts.budgetLimited,
    started: outcomes.filter((outcome) => outcome.attempts > 0).length,
    completed: outcomes.filter((outcome) => outcome.outcome === "completed").length,
    failed: outcomes.filter((outcome) => outcome.outcome === "failed" || outcome.outcome === "cancelled" || outcome.outcome === "not_dispatched").length,
    retried: outcomes.filter((outcome) => outcome.attempts > 1).length,
    timedOut: outcomes.filter((outcome) => outcome.outcome === "timed_out").length,
    schemaInvalid: opts.runtimeStats.schemaInvalid + outcomes.filter((outcome) => isSchemaInvalidError(outcome.error)).length,
    repairAttempted: opts.runtimeStats.repairAttempted,
    repairSucceeded: opts.runtimeStats.repairSucceeded,
    repairFailed: opts.runtimeStats.repairFailed,
    notDispatched: outcomes.filter((outcome) => outcome.outcome === "not_dispatched").length,
    budgetLimited: opts.budgetLimited
  };
}

function incompleteVerificationVerdict(candidateId: string, reason: string): VerificationVerdict {
  return {
    candidateId,
    verdict: "reject",
    reason: `verification incomplete: ${reason}`,
    requiredEvidencePresent: false,
    falsePositiveRisk: "high",
    verificationIncomplete: true
  };
}

function incompleteSubmittedVerdict(reason: string): SubmitVerificationVerdict {
  return {
    verdict: "reject",
    reason: `verification incomplete: ${reason}`,
    requiredEvidencePresent: false,
    falsePositiveRisk: "high"
  };
}

function verificationRecordMeta(
  verdict: VerificationVerdict,
  error?: unknown
): Partial<Extract<VerificationRecord, { verdict: VerificationVerdict }>> {
  if (verdict.verificationIncomplete !== true) {
    return { verificationStatus: "completed" };
  }
  const code = errorCode(error);
  return {
    verificationStatus: "incomplete",
    incompleteReason: incompleteReasonLabel(verdict.reason),
    ...(code !== undefined ? { errorCode: code } : {})
  };
}

function verifierOutcomeReason(outcome: { outcome: string; error?: unknown }): string {
  if (isSchemaInvalidError(outcome.error)) {
    return `schema_invalid: ${verifierErrorSummary(outcome.error)}`;
  }
  if (isBudgetExhaustedWorkerError(outcome.error) || outcome.outcome === "not_dispatched") {
    return `${outcome.outcome} due to budget limit`;
  }
  if (outcome.error !== undefined) {
    return `${outcome.outcome}: ${verifierErrorSummary(outcome.error)}`;
  }
  return outcome.outcome;
}

function incompleteReasonLabel(reason: string): string {
  if (reason.includes("budget_limited") || reason.includes("budget limit")) {
    return "budget_limited";
  }
  if (reason.includes("schema_invalid")) {
    return "schema_invalid";
  }
  if (reason.includes("not_dispatched")) {
    return "not_dispatched";
  }
  return "verifier_incomplete";
}

function isSchemaInvalidError(error: unknown): boolean {
  return isCodeninjaError(error) && error.code === "llm_schema_invalid";
}

function isBudgetExhaustedWorkerError(error: unknown): boolean {
  return isCodeninjaError(error) && (error.code === "budget_exhausted" || error.context?.reason === "budget_exhausted");
}

function errorCode(error: unknown): string | undefined {
  return isCodeninjaError(error) ? error.code : undefined;
}

function verifierErrorSummary(error: unknown): string {
  if (isCodeninjaError(error)) {
    return error.context?.error !== undefined ? String(error.context.error) : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

function clusterCandidates(
  candidates: CandidateFinding[],
  packetsById: Map<string, ReviewPacket>,
  telemetry: TelemetryRecorder
): {
  all: CandidateFinding[];
  representatives: CandidateFinding[];
  duplicatesByRepresentative: Map<string, CandidateFinding[]>;
  duplicateCount: number;
} {
  const clusters: CandidateFinding[][] = [];
  for (const candidate of candidates) {
    const cluster = clusters.find((members) => duplicateCandidate(candidate, members[0], packetsById));
    if (cluster) {
      cluster.push(candidate);
    } else {
      clusters.push([candidate]);
    }
  }

  const all: CandidateFinding[] = [];
  const representatives: CandidateFinding[] = [];
  const duplicatesByRepresentative = new Map<string, CandidateFinding[]>();

  for (const cluster of clusters) {
    const representative = verifierRepresentative(cluster);
    const duplicates = cluster
      .filter((candidate) => candidate.id !== representative.id)
      .map((candidate) => ({
        ...candidate,
        clusterId: representative.id,
        duplicateOf: representative.id
      }));
    const clusteredRepresentative = cluster.length > 1
      ? withSiblingEvidence({ ...representative, clusterId: representative.id }, duplicates)
      : representative;
    representatives.push(clusteredRepresentative);
    all.push(clusteredRepresentative, ...duplicates);
    if (duplicates.length > 0) {
      duplicatesByRepresentative.set(representative.id, duplicates);
      telemetry.event({
        stage: 9,
        level: "info",
        message: "verification_candidates_clustered",
        data: {
          representativeId: representative.id,
          duplicateIds: duplicates.map((candidate) => candidate.id),
          clusterSize: cluster.length,
          skippedVerificationCandidates: duplicates.length,
          paths: [...new Set(cluster.map((candidate) => candidate.path))].sort()
        }
      });
    }
  }

  const duplicateCount = all.length - representatives.length;
  telemetry.event({
    stage: 9,
    level: "info",
    message: "verification_candidate_clustering",
    data: {
      candidates: candidates.length,
      representatives: representatives.length,
      clusters: clusters.length,
      duplicateCandidates: duplicateCount,
      clusteredGroups: [...duplicatesByRepresentative.entries()].map(([representativeId, duplicates]) => ({
        representativeId,
        duplicateIds: duplicates.map((candidate) => candidate.id),
        clusterSize: duplicates.length + 1
      }))
    }
  });

  return { all, representatives, duplicatesByRepresentative, duplicateCount };
}

function duplicateCandidate(
  a: CandidateFinding,
  b: CandidateFinding | undefined,
  packetsById: Map<string, ReviewPacket>
): boolean {
  if (!b) {
    return false;
  }
  const failureMatches = strongTextMatch(a.failureMode, b.failureMode);
  if (a.category !== b.category && !failureMatches) {
    return false;
  }
  if (!candidateScopesOverlap(a, b, packetsById)) {
    return false;
  }
  const titleMatches = strongTextMatch(a.title, b.title);
  const evidenceMatches = changedEvidenceMatches(a, b);
  const symbolMatches = candidateSymbolsOverlap(a, b, packetsById);
  const exactLocationMatches = locationClusterKey(a, packetsById) !== undefined && locationClusterKey(a, packetsById) === locationClusterKey(b, packetsById);
  if (exactLocationMatches && (titleMatches || failureMatches || evidenceMatches)) {
    return true;
  }
  if (highImpactAmbiguous(a, b) && !failureMatches && !evidenceMatches) {
    return false;
  }
  return (failureMatches && (titleMatches || evidenceMatches || symbolMatches || a.path === b.path)) ||
    (evidenceMatches && (titleMatches || failureMatches)) ||
    (titleMatches && failureMatches);
}

function withSiblingEvidence(representative: CandidateFinding, duplicates: CandidateFinding[]): CandidateFinding {
  const relatedCode = dedupeRelatedCode([
    ...(representative.evidence.relatedCode ?? []),
    ...duplicates.flatMap((duplicate): RelatedCodeEvidence[] => [
      {
        path: duplicate.path,
        lines: truncateEvidenceLines(duplicate.evidence.changedCode),
        whyRelevant: `Duplicate candidate ${duplicate.id} reported the same root issue: ${truncateReason(duplicate.failureMode)}`
      },
      ...(duplicate.evidence.relatedCode ?? [])
    ])
  ]).slice(0, 10);
  return {
    ...representative,
    evidence: {
      ...representative.evidence,
      ...(relatedCode.length > 0 ? { relatedCode } : {})
    }
  };
}

function dedupeRelatedCode(entries: RelatedCodeEvidence[]): RelatedCodeEvidence[] {
  const seen = new Set<string>();
  const deduped: RelatedCodeEvidence[] = [];
  for (const entry of entries) {
    const key = `${entry.path}\n${normalizeCode(entry.lines)}\n${normalize(entry.whyRelevant)}`;
    if (seen.has(key) || entry.lines.trim().length === 0) {
      continue;
    }
    seen.add(key);
    deduped.push(entry);
  }
  return deduped;
}

function candidateScopesOverlap(a: CandidateFinding, b: CandidateFinding, packetsById: Map<string, ReviewPacket>): boolean {
  const aLocation = locationClusterKey(a, packetsById);
  const bLocation = locationClusterKey(b, packetsById);
  if (aLocation !== undefined && aLocation === bLocation) {
    return true;
  }
  if (a.path === b.path) {
    const aSymbols = candidateSymbols(a, packetsById);
    const bSymbols = candidateSymbols(b, packetsById);
    if (!a.anchor && !b.anchor && aSymbols.size > 0 && bSymbols.size > 0 && !setsIntersect(aSymbols, bSymbols)) {
      return false;
    }
    return true;
  }
  if (setsIntersect(candidateEvidencePaths(a), candidateEvidencePaths(b))) {
    return true;
  }
  return relatedRoot(a.path) === relatedRoot(b.path) && candidateSymbolsOverlap(a, b, packetsById);
}

function locationClusterKey(candidate: CandidateFinding, packetsById: Map<string, ReviewPacket>): string | undefined {
  if (candidate.anchor) {
    return `anchor:${candidate.anchor.path}:${candidate.anchor.side}:${candidate.anchor.line}:${candidate.anchor.hunkId}`;
  }
  const symbols = candidateSymbols(candidate, packetsById);
  if (symbols.size !== 1) {
    return undefined;
  }
  return `symbol:${candidate.path}:${[...symbols][0]}`;
}

function candidateEvidencePaths(candidate: CandidateFinding): Set<string> {
  return new Set([candidate.path, ...(candidate.evidence.relatedCode ?? []).map((entry) => entry.path)]);
}

function candidateSymbolsOverlap(a: CandidateFinding, b: CandidateFinding, packetsById: Map<string, ReviewPacket>): boolean {
  return setsIntersect(candidateSymbols(a, packetsById), candidateSymbols(b, packetsById));
}

function candidateSymbols(candidate: CandidateFinding, packetsById: Map<string, ReviewPacket>): Set<string> {
  const packet = packetsById.get(candidate.producedBy.packetId);
  return new Set(
    (packet?.symbolFacts ?? [])
      .flatMap((fact) => [fact.enclosingSymbol, fact.signature])
      .filter((symbol): symbol is string => symbol !== undefined && symbol.trim().length > 0)
      .map(normalize)
  );
}

function changedEvidenceMatches(a: CandidateFinding, b: CandidateFinding): boolean {
  const aChanged = normalizeCode(a.evidence.changedCode);
  const bChanged = normalizeCode(b.evidence.changedCode);
  if (aChanged.length > 0 && aChanged === bChanged) {
    return true;
  }
  const aRelated = relatedEvidenceKeys(a);
  const bRelated = relatedEvidenceKeys(b);
  return setsIntersect(aRelated, bRelated);
}

function relatedEvidenceKeys(candidate: CandidateFinding): Set<string> {
  return new Set((candidate.evidence.relatedCode ?? [])
    .map((entry) => `${entry.path}:${normalizeCode(entry.lines)}`)
    .filter((entry) => !entry.endsWith(":")));
}

function highImpactAmbiguous(a: CandidateFinding, b: CandidateFinding): boolean {
  return isHighImpact(a) || isHighImpact(b);
}

function isHighImpact(candidate: CandidateFinding): boolean {
  return candidate.severity === "critical" || candidate.severity === "high";
}

function strongTextMatch(a: string, b: string): boolean {
  const left = normalize(a);
  const right = normalize(b);
  if (left.length === 0 || right.length === 0) {
    return false;
  }
  if (left === right) {
    return isSubstantiveText(left);
  }
  const shorter = left.length < right.length ? left : right;
  const longer = left.length < right.length ? right : left;
  if (shorter.length >= 24 && longer.includes(shorter)) {
    return true;
  }
  const leftTokens = significantTokens(left);
  const rightTokens = significantTokens(right);
  if (leftTokens.size < 4 || rightTokens.size < 4) {
    return false;
  }
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return union > 0 && intersection / union >= 0.82;
}

function isSubstantiveText(input: string): boolean {
  return input.length >= 12 || significantTokens(input).size >= 3;
}

function significantTokens(input: string): Set<string> {
  const stopWords = new Set(["a", "an", "and", "are", "as", "be", "by", "for", "from", "in", "is", "it", "of", "on", "or", "that", "the", "this", "to", "with"]);
  return new Set(input.split(" ").filter((token) => token.length > 1 && !stopWords.has(token)));
}

function setsIntersect<T>(a: Set<T>, b: Set<T>): boolean {
  for (const value of a) {
    if (b.has(value)) {
      return true;
    }
  }
  return false;
}

function relatedRoot(filePath: string): string {
  const parts = filePath.split("/").filter(Boolean);
  if (parts.length <= 2) {
    return parts[0] ?? filePath;
  }
  return parts.slice(0, 2).join("/");
}

function truncateEvidenceLines(lines: string): string {
  const trimmed = lines.trim();
  return trimmed.length <= 4000 ? trimmed : `${trimmed.slice(0, 3997)}...`;
}

function truncateReason(reason: string): string {
  const trimmed = reason.trim().replace(/\s+/gu, " ");
  return trimmed.length <= 240 ? trimmed : `${trimmed.slice(0, 237)}...`;
}

function verifierRepresentative(candidates: CandidateFinding[]): CandidateFinding {
  const first = [...candidates].sort((a, b) =>
    severityRank(a.severity) - severityRank(b.severity) ||
    confidenceRank(a.confidence) - confidenceRank(b.confidence) ||
    a.id.localeCompare(b.id)
  )[0];
  if (!first) {
    throw new Error("cannot choose representative from empty verification cluster");
  }
  return first;
}

function severityRank(severity: CandidateFinding["severity"]): number {
  return { critical: 0, high: 1, medium: 2, low: 3 }[severity];
}

function confidenceRank(confidence: CandidateFinding["confidence"]): number {
  return { high: 0, medium: 1, low: 2 }[confidence];
}

function normalize(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9_./:-]+/gu, " ").replace(/\s+/gu, " ").trim();
}

function normalizeCode(input: string): string {
  return input.trim().replace(/\s+/gu, " ");
}
