import { buildRepositoryToolDefinitions } from "../llm/tool-definitions.js";
import type { LlmRunner } from "../llm/llm-runner.js";
import { SubmitVerificationVerdictSchema, type SubmitVerificationVerdict } from "../llm/schemas.js";
import type { LensRegistry } from "../skills/lens-registry.js";
import type { PromptBuilder } from "../skills/prompt-builder.js";
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

const VERIFIER_TOOL_BUDGET = { maxToolCalls: 6, maxInvestigationRounds: 2, maxResultChars: 12_000 };
const VERIFIER_EXPECTED_CALLS_PER_CANDIDATE = 2;
const VERIFIER_BASE_TOKEN_ESTIMATE = 1_000;

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

type VerificationRecord =
  | { candidateId: string; gate: "suppressed"; gateReason: string }
  | { candidateId: string; gate: "gate_anchor_stripped"; gateReason: string }
  | {
      candidateId: string;
      gate: "passed" | "gate_anchor_stripped";
      verdict: VerificationVerdict;
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

type VerifierReservation = {
  candidateId: string;
  estimatedTokens: number;
  estimatedModelCalls: number;
  released: boolean;
};

type RelatedCodeEvidence = NonNullable<CandidateFinding["evidence"]["relatedCode"]>[number];

export async function verifyFindings(
  input: { packetResults: PacketReviewResult[]; packets: ReviewPacket[] },
  tools: RepositoryTools,
  config: CodeninjaConfig,
  telemetry: TelemetryRecorder,
  opts: VerifyOptions
): Promise<{ verified: CandidateFinding[]; verdicts: VerificationVerdict[]; incompleteCount: number; gateRejections: number; verificationSkipped: boolean }> {
  telemetry.event({ stage: 9, level: "info", message: "stage_started", data: { candidates: candidateCount(input.packetResults) } });
  const packetsById = new Map(input.packets.map((packet) => [packet.id, packet]));
  const records: VerificationRecord[] = [];
  const gatePassed: CandidateFinding[] = [];
  const anchorStripped = new Set<string>();
  let gateRejections = 0;

  for (const candidate of input.packetResults.flatMap((result) => result.findings)) {
    const preGated = preGateAnchor(candidate, packetsById.get(candidate.producedBy.packetId), opts.diff, telemetry);
    if (preGated.anchorStripped) {
      anchorStripped.add(candidate.id);
    }
    const gateReason = gateCandidate(preGated.candidate, config);
    if (gateReason) {
      gateRejections += 1;
      records.push(
        preGated.anchorStripped
          ? { candidateId: candidate.id, gate: "gate_anchor_stripped", gateReason: `invalid_anchor; ${gateReason}` }
          : { candidateId: candidate.id, gate: "suppressed", gateReason }
      );
      telemetry.event({ stage: 9, level: "info", message: "verification_gate_suppressed", data: { candidateId: candidate.id, gateReason } });
      continue;
    }
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
    records.push(...verdicts.map((verdict) => verificationRecord(verdict, anchorStripped)));
    await telemetry.writeArtifact("verification.json", records);
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
        verificationRepresentatives: clustered.representatives.length
      },
        verdicts: verdictCounts(verdicts)
      }
    });
    return { verified: clustered.all, verdicts, incompleteCount: 0, gateRejections, verificationSkipped: true };
  }

  const orderedRepresentatives = orderVerifierRepresentatives(clustered.representatives);
  const scheduling = scheduleVerifierRepresentatives(orderedRepresentatives, packetsById, opts, telemetry);
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
  for (const candidate of scheduling.budgetLimited) {
    const verdict = incompleteVerificationVerdict(candidate.id, "budget_limited before dispatch");
    verdicts.push(verdict);
    records.push(verificationRecord(verdict, anchorStripped, {
      verificationStatus: "incomplete",
      incompleteReason: "budget_limited"
    }));
    const duplicates = clustered.duplicatesByRepresentative.get(candidate.id) ?? [];
    incompleteCount += 1 + duplicates.length;
    records.push(
      ...duplicateVerificationRecords(verdict, clustered.duplicatesByRepresentative, anchorStripped, {
        verificationStatus: "incomplete",
        incompleteReason: "budget_limited"
      })
    );
  }
  for (const outcome of outcomes) {
    if (outcome.outcome === "completed" && outcome.value) {
      verdicts.push(outcome.value);
      records.push(verificationRecord(outcome.value, anchorStripped, verificationRecordMeta(outcome.value)));
      records.push(...duplicateVerificationRecords(outcome.value, clustered.duplicatesByRepresentative, anchorStripped, verificationRecordMeta(outcome.value)));
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
    records.push(verificationRecord(verdict, anchorStripped, verificationRecordMeta(verdict, outcome.error)));
    const duplicates = clustered.duplicatesByRepresentative.get(candidateId) ?? [];
    incompleteCount += 1 + duplicates.length;
    records.push(...duplicateVerificationRecords(verdict, clustered.duplicatesByRepresentative, anchorStripped, verificationRecordMeta(verdict, outcome.error)));
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

  await telemetry.writeArtifact("verification.json", records);
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
        clusteredDuplicates: clustered.duplicateCount,
        verificationRepresentatives: clustered.representatives.length
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
  return applyVerdictAnchor(revised, verdict);
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
    originContext: packet?.contextText ?? "",
    hunksText: packet?.hunks.map((hunk) => hunk.contentWithLineNumbers).join("\n\n") ?? "",
    skills
  });
  const submitted = await runVerifierStructured(candidate, prompt, tools, config, opts, workerId, telemetry, runtimeStats);
  const revised = submitted.finalFinding !== undefined
    ? revisedFinding(candidate, submitted.finalFinding, packet, opts.diff)
    : undefined;
  const revisedAnchor = normalizeAnchor(submitted.revisedAnchor, packet, opts.diff);
  return {
    candidateId: candidate.id,
    verdict: submitted.verdict,
    reason: submitted.reason,
    requiredEvidencePresent: submitted.requiredEvidencePresent,
    falsePositiveRisk: submitted.falsePositiveRisk,
    ...(revised !== undefined ? { finalFinding: revised } : {}),
    ...(revisedAnchor !== undefined ? { revisedAnchor } : {}),
    ...(submitted.reason.startsWith("verification incomplete:") ? { verificationIncomplete: true } : {})
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
  const request = (promptText: string) => opts.runner.runStructured<SubmitVerificationVerdict>({
    stage: 9,
    prompt: promptText,
    schema: SubmitVerificationVerdictSchema,
    templateVersion: prompt.templateVersion,
    tools: buildRepositoryToolDefinitions(tools),
    toolBudget: VERIFIER_TOOL_BUDGET,
    timeoutMs: config.review.perPassTimeoutMs,
    telemetryContext: { workerId, candidateId: candidate.id, packetId: candidate.producedBy.packetId }
  });

  try {
    return await request(prompt.prompt);
  } catch (error) {
    if (!isSchemaInvalidError(error)) {
      throw error;
    }
    runtimeStats.schemaInvalid += 1;
    telemetry.event({
      stage: 9,
      level: "warn",
      message: "verification_schema_invalid",
      file: candidate.path,
      data: {
        candidateId: candidate.id,
        error: verifierErrorSummary(error)
      }
    });
    if (opts.checkpoint?.(9) === "exhausted") {
      runtimeStats.repairFailed += 1;
      return incompleteSubmittedVerdict("schema_invalid; repair not dispatched because budget was exhausted");
    }

    runtimeStats.repairAttempted += 1;
    telemetry.event({
      stage: 9,
      level: "info",
      message: "verification_schema_repair_attempted",
      file: candidate.path,
      data: { candidateId: candidate.id }
    });
    try {
      const repaired = await request(`${prompt.prompt}\n\nThe previous verifier response failed submit_verdict schema validation. Retry once and call submit_verdict with schema-valid arguments only.`);
      runtimeStats.repairSucceeded += 1;
      return repaired;
    } catch (repairError) {
      if (!isSchemaInvalidError(repairError)) {
        throw repairError;
      }
      runtimeStats.schemaInvalid += 1;
      runtimeStats.repairFailed += 1;
      telemetry.event({
        stage: 9,
        level: "warn",
        message: "verification_schema_repair_failed",
        file: candidate.path,
        data: {
          candidateId: candidate.id,
          error: verifierErrorSummary(repairError)
        }
      });
      return incompleteSubmittedVerdict(`schema_invalid after repair: ${verifierErrorSummary(repairError)}`);
    }
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
    producedBy: original.producedBy,
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

function gateCandidate(candidate: CandidateFinding, config: CodeninjaConfig): string | undefined {
  if (candidate.evidence.changedCode.trim().length === 0) {
    return "missing_evidence";
  }
  if (candidate.failureMode.trim().length === 0) {
    return "missing_failure_mode";
  }
  if (belowConfidence(candidate.confidence, config.review.minConfidence) && candidate.severity !== "critical" && candidate.severity !== "high") {
    return "low_confidence";
  }
  return undefined;
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
  telemetry: TelemetryRecorder
): {
  scheduled: CandidateFinding[];
  budgetLimited: CandidateFinding[];
  reservations: Map<string, VerifierReservation>;
  usesHeldReservations: boolean;
} {
  const reservations = new Map<string, VerifierReservation>();
  const scheduled: CandidateFinding[] = [];
  const budgetLimited: CandidateFinding[] = [];
  const canHoldReservations = opts.reserve !== undefined && opts.releaseReservation !== undefined;

  for (const candidate of candidates) {
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
      orderedCandidateIds: candidates.map((candidate) => candidate.id),
      scheduledCandidateIds: scheduled.map((candidate) => candidate.id),
      budgetLimitedCandidateIds: budgetLimited.map((candidate) => candidate.id),
      priorities: candidates.map((candidate) => ({
        candidateId: candidate.id,
        severity: candidate.severity,
        confidence: candidate.confidence,
        changedLine: candidate.changedLine === true && candidate.anchor !== undefined
      }))
    }
  });

  return {
    scheduled,
    budgetLimited,
    reservations,
    usesHeldReservations: canHoldReservations && reservations.size > 0
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
