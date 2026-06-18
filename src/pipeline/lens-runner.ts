import { buildRepositoryToolDefinitions } from "../llm/tool-definitions.js";
import type { LlmPostToolNudgeInput, LlmRunner } from "../llm/llm-runner.js";
import { SubmitPacketReviewSchema, type SubmitPacketReview } from "../llm/schemas.js";
import type { LensRegistry } from "../skills/lens-registry.js";
import type { PromptBuilder } from "../skills/prompt-builder.js";
import type { TelemetryRecorder } from "../telemetry/telemetry-recorder.js";
import type {
  CandidateFinding,
  CodeninjaConfig,
  DiffAnchor,
  PacketReviewResult,
  RepositoryTools,
  ReviewPacket,
  ReviewPlan,
  ReviewPriority,
  ReviewDepth,
  ReviewStage,
  UnifiedDiff
} from "../types.js";
import { createWorkerRunner, type WorkerTask } from "./worker-runner.js";
import { isBudgetExhaustedError, isFatalLlmError, isRecoverableWorkerError, isSchemaInvalidError, validateAnchorForDiff, validateAnchorForPacket } from "./pipeline-utils.js";

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
type SubmittedAnsweredQuestion = NonNullable<SubmitPacketReview["answeredQuestions"]>[number];
type NormalizedHints = {
  kept: PacketReviewResult["followUpHints"];
  submittedCount: number;
  droppedCount: number;
};
type QuestionFollowUpHint = SubmittedFollowUpHint & { questionDerived: true };
type NormalizedUncertainties = {
  kept: PacketReviewResult["uncertainties"];
  submittedCount: number;
  droppedCount: number;
};
type NormalizedAnsweredQuestions = NonNullable<PacketReviewResult["answeredQuestions"]>;
type Stage7PacketGeneration = {
  directCandidates: number;
  submittedFollowUpHints: number;
  keptFollowUpHints: number;
  droppedFollowUpHints: number;
  submittedUncertainties: number;
  keptUncertainties: number;
  droppedUncertainties: number;
  answeredQuestions: number;
  partialQuestions: number;
};

const MAX_FOLLOW_UP_HINTS_PER_PACKET = 2;
const MAX_REVIEW_QUESTION_FOLLOW_UP_HINTS_PER_PACKET = 3;
const MAX_UNCERTAINTIES_PER_PACKET = 1;
const stage7Generation = new WeakMap<PacketReviewResult, Stage7PacketGeneration>();

export async function runLensPackets(
  _plan: ReviewPlan,
  packets: ReviewPacket[],
  tools: RepositoryTools,
  config: CodeninjaConfig,
  telemetry: TelemetryRecorder,
  opts: LensRunnerOptions
): Promise<PacketReviewResult[]> {
  telemetry.event({ stage: 7, level: "info", message: "stage_started", data: { packets: packets.length } });
  const workerRunner = createWorkerRunner({
    concurrency: config.review.concurrency,
    signal: opts.signal,
    isRetriableError: isRecoverableWorkerError,
    ...(opts.checkpoint !== undefined ? { checkpoint: opts.checkpoint } : {})
  });
  const tasks = packets.map((packet): WorkerTask<PacketReviewResult> => ({
    stage: 7,
    priority: packetPriority(packet),
    coverage: packet.coverage,
    packetId: packet.id,
    timeoutMs: config.review.perPassTimeoutMs,
    retryOnTransient: true,
    run: async (signal, task) => runPacket(packet, tools, config, opts, telemetry, task.workerId, signal)
  }));
  const outcomes = await workerRunner.schedule(tasks);
  const results = outcomes.map((outcome): PacketReviewResult => {
    if (outcome.outcome === "completed" && outcome.value) {
      return outcome.value;
    }
    if (isFatalLlmError(outcome.error) && !isSchemaInvalidError(outcome.error)) {
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
      data: { error: outcome.error instanceof Error ? outcome.error.message : String(outcome.error ?? "") }
    });
    return {
      packetId,
      lenses: packets.find((packet) => packet.id === packetId)?.lenses ?? [],
      findings: [],
      followUpHints: [],
      uncertainties: [],
      status: outcome.outcome === "not_dispatched" || budgetSkipped ? "skipped" : "failed"
    };
  });
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

async function runPacket(
  packet: ReviewPacket,
  tools: RepositoryTools,
  config: CodeninjaConfig,
  opts: LensRunnerOptions,
  telemetry: TelemetryRecorder,
  workerId: string,
  _signal: AbortSignal
): Promise<PacketReviewResult> {
  const skills = packet.lenses.flatMap((lensId) => opts.lensRegistry.skillsForLens(lensId));
  const prompt = opts.promptBuilder.buildPacketReviewPrompt({ packet, skills });
  const repositoryTools = packet.reviewProfile === "simple" || packet.toolBudget.maxToolCalls <= 0
    ? []
    : buildRepositoryToolDefinitions(tools, { includeLikelyTests: shouldExposeLikelyTestsForPacket(packet) });
  const submitted = await opts.runner.runStructured<SubmitPacketReview>({
    stage: 7,
    prompt: prompt.prompt,
    schema: SubmitPacketReviewSchema,
    templateVersion: prompt.templateVersion,
    tools: repositoryTools,
    toolBudget: packet.toolBudget,
    timeoutMs: config.review.perPassTimeoutMs,
    telemetryContext: { workerId, packetId: packet.id },
    finalization: {
      noResultInstruction: STAGE7_NO_FINDINGS_SUBMIT_INSTRUCTION,
      buildPostToolNudge: (input) => buildPostToolCloseNudge(packet, config.review.depth, input)
    }
  });
  const findings = submitted.findings.map((finding, index) => stampFinding(packet, finding, index, opts.lensRegistry, workerId, telemetry, opts.diff));
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
        unresolvedQuestions: submitted.unresolvedQuestions ?? [],
        reason: submitted.noFindingReason
      }
    });
  }
  const answeredQuestions = normalizeAnsweredQuestions(submitted.answeredQuestions ?? [], packet, findings, telemetry, workerId);
  const questionFollowUpHints = followUpHintsFromPartialQuestions(answeredQuestions, packet);
  const followUpHints = normalizeFollowUpHints(submitted.followUpHints, packet, telemetry, workerId, questionFollowUpHints);
  const uncertainties = normalizeUncertainties(submitted.uncertainties, packet, telemetry, workerId);
  const result: PacketReviewResult = {
    packetId: packet.id,
    lenses: packet.lenses,
    findings,
    reviewStatus,
    ...(submitted.noFindingReason !== undefined ? { noFindingReason: submitted.noFindingReason } : {}),
    ...(answeredQuestions.length > 0 ? { answeredQuestions } : {}),
    ...(submitted.unresolvedQuestions !== undefined ? { unresolvedQuestions: submitted.unresolvedQuestions } : {}),
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
    droppedUncertainties: uncertainties.droppedCount,
    answeredQuestions: answeredQuestions.length,
    partialQuestions: answeredQuestions.filter((question) => question.outcome === "partial").length
  });
  return result;
}

function normalizeFollowUpHints(
  hints: SubmittedFollowUpHint[],
  packet: ReviewPacket,
  telemetry: TelemetryRecorder,
  workerId: string,
  questionHints: QuestionFollowUpHint[] = []
): NormalizedHints {
  const valid: PacketReviewResult["followUpHints"] = [];
  for (const hint of hints) {
    const normalized = {
      ...hint,
      question: hint.question.trim(),
      files: cleanStrings(hint.files),
      symbols: cleanStrings(hint.symbols),
      suggestedLenses: cleanStrings(hint.suggestedLenses),
      reason: hint.reason.trim()
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

  const validQuestionHints = normalizeQuestionFollowUpHints(questionHints, packet, telemetry, workerId);
  const ranked = [...valid].sort((a, b) => followUpHintRank(b, packet) - followUpHintRank(a, packet) ||
    a.question.localeCompare(b.question));
  const rankedQuestionHints = [...validQuestionHints].sort((a, b) => followUpHintRank(b, packet) - followUpHintRank(a, packet) ||
    a.question.localeCompare(b.question));
  const keptQuestionHints = rankedQuestionHints.slice(0, MAX_REVIEW_QUESTION_FOLLOW_UP_HINTS_PER_PACKET);
  const droppedQuestionHints = rankedQuestionHints.slice(MAX_REVIEW_QUESTION_FOLLOW_UP_HINTS_PER_PACKET);
  const keptGenericHints = ranked.slice(0, MAX_FOLLOW_UP_HINTS_PER_PACKET);
  const droppedGenericHints = ranked.slice(MAX_FOLLOW_UP_HINTS_PER_PACKET);
  const questionHintKeys = new Set(keptQuestionHints.map(followUpHintKey));
  const kept = [...keptQuestionHints, ...keptGenericHints];
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
        reviewQuestionFollowUp: questionHintKeys.has(followUpHintKey(hint))
      }
    });
  }
  if (droppedQuestionHints.length > 0) {
    telemetry.event({
      stage: 7,
      level: "info",
      message: "review_question_follow_up_capped",
      packetId: packet.id,
      workerId,
      data: {
        cap: MAX_REVIEW_QUESTION_FOLLOW_UP_HINTS_PER_PACKET,
        keptCount: keptQuestionHints.length,
        droppedCount: droppedQuestionHints.length,
        dropped: droppedQuestionHints.slice(0, 5).map((hint) => ({
          question: hint.question,
          files: hint.files,
          symbols: hint.symbols,
          confidence: hint.confidence
        }))
      }
    });
  }
  if (droppedGenericHints.length > 0) {
    telemetry.event({
      stage: 7,
      level: "info",
      message: "follow_up_hint_capped",
      packetId: packet.id,
      workerId,
      data: {
        cap: MAX_FOLLOW_UP_HINTS_PER_PACKET,
        keptCount: keptGenericHints.length,
        droppedCount: droppedGenericHints.length,
        dropped: droppedGenericHints.slice(0, 5).map((hint) => ({
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
    submittedCount: hints.length + questionHints.length,
    droppedCount: hints.length + questionHints.length - kept.length
  };
}

function normalizeQuestionFollowUpHints(
  hints: QuestionFollowUpHint[],
  packet: ReviewPacket,
  telemetry: TelemetryRecorder,
  workerId: string
): PacketReviewResult["followUpHints"] {
  const valid: PacketReviewResult["followUpHints"] = [];
  for (const hint of hints) {
    const normalized = {
      question: hint.question.trim(),
      files: cleanStrings(hint.files),
      symbols: cleanStrings(hint.symbols),
      suggestedLenses: cleanStrings(hint.suggestedLenses),
      reason: hint.reason.trim(),
      confidence: hint.confidence
    };
    const pointerRich = normalized.files.length > 0 || normalized.symbols.length > 0;
    if (normalized.question.length === 0 || !pointerRich) {
      telemetry.event({
        stage: 7,
        level: "warn",
        message: "review_question_follow_up_dropped",
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
  return valid;
}

function normalizeUncertainties(
  uncertainties: SubmittedUncertainty[],
  packet: ReviewPacket,
  telemetry: TelemetryRecorder,
  workerId: string
): NormalizedUncertainties {
  const valid = uncertainties.flatMap((uncertainty): PacketReviewResult["uncertainties"] => {
    const normalized = {
      question: uncertainty.question.trim(),
      files: cleanStrings(uncertainty.files),
      symbols: cleanStrings(uncertainty.symbols)
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

function normalizeAnsweredQuestions(
  submittedAnswers: SubmittedAnsweredQuestion[],
  packet: ReviewPacket,
  findings: CandidateFinding[],
  telemetry: TelemetryRecorder,
  workerId: string
): NormalizedAnsweredQuestions {
  const attachedById = new Map((packet.reviewQuestions ?? []).map((question) => [question.id, question]));
  const findingQuestionIds = new Set(findings.flatMap((finding) => finding.reviewQuestionIds ?? []));
  const normalized: NormalizedAnsweredQuestions = [];

  for (const answer of submittedAnswers) {
    const attached = attachedById.get(answer.questionId.trim());
    if (!attached) {
      telemetry.event({
        stage: 7,
        level: "warn",
        message: "review_question_answer_dropped",
        packetId: packet.id,
        workerId,
        data: {
          questionId: answer.questionId,
          reason: "unknown_question_id"
        }
      });
      continue;
    }
    const evidence = answer.evidence
      .map((entry) => ({
        path: stripLocationSuffix(entry.path),
        ...(entry.lines !== undefined && entry.lines.trim().length > 0 ? { lines: entry.lines.trim() } : {}),
        whyRelevant: entry.whyRelevant.trim()
      }))
      .filter((entry) => entry.path.length > 0 && entry.whyRelevant.length > 0)
      .slice(0, 8);
    const evidenceTrace = answer.evidenceTrace?.trim();
    const answerText = answer.answer.trim();
    let outcome = answer.outcome;
    let confidence = answer.confidence;

    if (answerText.length === 0) {
      telemetry.event({
        stage: 7,
        level: "warn",
        message: "review_question_answer_dropped",
        packetId: packet.id,
        workerId,
        data: {
          questionId: attached.id,
          reason: "empty_answer"
        }
      });
      continue;
    }

    if (outcome === "answered_no_issue" && (evidence.length === 0 || evidenceTrace === undefined || evidenceTrace.length === 0)) {
      outcome = "partial";
      confidence = confidence === "high" ? "medium" : confidence;
      telemetry.event({
        stage: 7,
        level: "warn",
        message: "review_question_answer_downgraded",
        packetId: packet.id,
        workerId,
        data: {
          questionId: attached.id,
          reason: "answered_no_issue_without_evidence_trace"
        }
      });
    }

    if (outcome === "candidate_finding" && !findingQuestionIds.has(attached.id)) {
      outcome = "partial";
      confidence = confidence === "high" ? "medium" : confidence;
      telemetry.event({
        stage: 7,
        level: "warn",
        message: "review_question_answer_downgraded",
        packetId: packet.id,
        workerId,
        data: {
          questionId: attached.id,
          reason: "candidate_finding_without_linked_finding"
        }
      });
    }

    const normalizedAnswer = {
      questionId: attached.id,
      answer: answerText,
      confidence,
      outcome,
      evidence,
      ...(evidenceTrace !== undefined && evidenceTrace.length > 0 ? { evidenceTrace } : {}),
      ...(attached.role !== undefined ? { role: attached.role } : {})
    };
    normalized.push(normalizedAnswer);
    telemetry.event({
      stage: 7,
      level: "info",
      message: "review_question_answered",
      packetId: packet.id,
      workerId,
      data: {
        questionId: attached.id,
        role: attached.role,
        outcome,
        confidence,
        evidenceCount: evidence.length,
        hasEvidenceTrace: evidenceTrace !== undefined && evidenceTrace.length > 0
      }
    });
  }

  return normalized;
}

function followUpHintsFromPartialQuestions(
  answers: NormalizedAnsweredQuestions,
  packet: ReviewPacket
): QuestionFollowUpHint[] {
  if (answers.length === 0 || (packet.reviewQuestions ?? []).length === 0) {
    return [];
  }
  const questionsById = new Map((packet.reviewQuestions ?? []).map((question) => [question.id, question]));
  return answers
    .filter((answer) => answer.outcome === "partial")
    .flatMap((answer): QuestionFollowUpHint[] => {
      const question = questionsById.get(answer.questionId);
      if (!question) {
        return [];
      }
      if (question.role === "supporting") {
        return [];
      }
      return [{
        question: question.question,
        files: cleanStrings(question.files.length > 0 ? question.files : answer.evidence.map((entry) => entry.path)),
        symbols: cleanStrings(question.symbols),
        suggestedLenses: packet.lenses,
        reason: `Partial answer to planner review question ${question.id}: ${answer.answer}`,
        confidence: answer.confidence,
        questionDerived: true
      }];
    });
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
  answeredQuestions: number;
  partialQuestions: number;
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
    droppedUncertainties: 0,
    answeredQuestions: result.answeredQuestions?.length ?? 0,
    partialQuestions: result.answeredQuestions?.filter((question) => question.outcome === "partial").length ?? 0
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
    answeredQuestions: generations.reduce((sum, item) => sum + item.answeredQuestions, 0),
    partialQuestions: generations.reduce((sum, item) => sum + item.partialQuestions, 0),
    submittedHintsAndUncertainties: submittedFollowUpHints + submittedUncertainties,
    keptHintsAndUncertainties: keptFollowUpHints + keptUncertainties
  };
}

function followUpHintRank(hint: PacketReviewResult["followUpHints"][number], packet: ReviewPacket): number {
  return confidenceScore(hint.confidence) * 30 +
    pointerScore(hint.files, hint.symbols, packet) * 10 +
    concretenessScore(hint.question, hint.reason) +
    (hint.reason.includes("Partial answer to planner review question") ? 10 : 0);
}

function followUpHintKey(hint: PacketReviewResult["followUpHints"][number]): string {
  return `${hint.question}\0${hint.files.join(",")}\0${hint.symbols.join(",")}\0${hint.reason}`;
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
  return isTestPath(packet.path) ||
    (packet.oldPath !== undefined && isTestPath(packet.oldPath)) ||
    packet.lenses.some(isTestingLens) ||
    packet.testCoverageDelta !== undefined ||
    packet.labels.some(isTestingSignal) ||
    packet.riskNotes.some(isTestingSignal);
}

function isTestingLens(lens: string): boolean {
  return /(^|[/_-])tests?($|[/_-])/iu.test(lens) || /(^|[/_-])testing($|[/_-])/iu.test(lens);
}

function isTestingSignal(value: string): boolean {
  return /\b(test|tests|testing|coverage)\b/iu.test(value);
}

function isTestPath(filePath: string): boolean {
  const normalized = filePath.toLowerCase().replace(/\\/gu, "/");
  return /(^|\/)(__tests__|tests?|specs?)(\/|$)/u.test(normalized) ||
    /(^|[._-])(test|spec)(?=\.[^/]+$)/u.test(normalized);
}

function symbolMatches(symbol: string, factValue: string | undefined): boolean {
  if (!factValue) {
    return false;
  }
  const left = symbol.toLowerCase().trim();
  const right = factValue.toLowerCase();
  return left.length > 0 && (right === left || right.includes(left));
}

function cleanStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))].sort();
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
  "If there are no findings, submit reviewStatus:\"no_findings\", findings: [], and a short noFindingReason. Keep answeredQuestions concise with only the decisive trace. If concrete unresolved risk remains but evidence is insufficient for a finding, include pointer-rich followUpHints or uncertainties instead of burying it only in unresolvedQuestions.";

function buildPostToolCloseNudge(packet: ReviewPacket, depth: ReviewDepth, input: LlmPostToolNudgeInput): string | undefined {
  const threshold = closeNudgeThreshold(packet, depth);
  if (input.investigationRounds < threshold) {
    return undefined;
  }
  return `Only continue if the next repository tool call resolves one named predicate for packet ${packet.id}; prefer exact source reads such as read_symbol, read_range, find_definition, or read_diff_blocks. Otherwise call ${input.submitToolName} now with either a candidate finding, a short no-finding answer, or an exact unresolved predicate. ${STAGE7_NO_FINDINGS_SUBMIT_INSTRUCTION}`;
}

function closeNudgeThreshold(packet: ReviewPacket, depth: ReviewDepth): number {
  if (depth === "light" || packet.coverage === "light" || packet.reviewProfile === "simple") {
    return 1;
  }
  if (depth === "deep" || packet.coverage === "deep" || packet.reviewProfile === "investigate") {
    return 3;
  }
  return 2;
}

function stampFinding(
  packet: ReviewPacket,
  submitted: SubmitPacketReview["findings"][number],
  index: number,
  lensRegistry: LensRegistry,
  workerId: string,
  telemetry: TelemetryRecorder,
  diff: UnifiedDiff | undefined
): CandidateFinding {
  const anchor = normalizeAnchor(submitted.anchor, packet, diff);
  const changedLine = anchor !== undefined;
  const path = anchor?.path ?? packet.path;
  const candidateId = `${packet.id.slice(0, 8)}-f${index + 1}`;
  const reviewQuestionIds = normalizeFindingReviewQuestionIds(packet, submitted.reviewQuestionIds ?? [], telemetry, candidateId, workerId);
  if (submitted.anchor !== undefined && anchor === undefined) {
    telemetry.event({
      stage: 7,
      level: "warn",
      message: "out_of_hunk_anchor",
      packetId: packet.id,
      data: { candidateId, finding: submitted.title, anchor: submitted.anchor }
    });
    telemetry.event({
      stage: 7,
      level: "info",
      message: "candidate_anchor_summary_only",
      packetId: packet.id,
      data: { candidateId, finding: submitted.title, anchor: submitted.anchor }
    });
  }
  const primaryLens = packet.lenses[0] ?? "core/code-review";
  return {
    id: candidateId,
    title: submitted.title,
    severity: submitted.severity,
    confidence: submitted.confidence,
    path,
    ...(anchor !== undefined ? { anchor } : {}),
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
    ...(reviewQuestionIds.length > 0 ? { reviewQuestionIds } : {}),
    producedBy: {
      kind: "packet",
      stage: 7,
      packetId: packet.id,
      lensId: primaryLens,
      skillIds: lensRegistry.skillsForLens(primaryLens).map((skill) => skill.id),
      workerId
    }
  };
}

function normalizeFindingReviewQuestionIds(
  packet: ReviewPacket,
  submittedIds: string[],
  telemetry: TelemetryRecorder,
  candidateId: string,
  workerId: string
): string[] {
  const attachedQuestionIds = new Set((packet.reviewQuestions ?? []).map((question) => question.id));
  const normalizedIds = cleanStrings(submittedIds);
  const kept = normalizedIds.filter((questionId) => attachedQuestionIds.has(questionId));
  const dropped = normalizedIds.filter((questionId) => !attachedQuestionIds.has(questionId));
  if (dropped.length > 0) {
    telemetry.event({
      stage: 7,
      level: "warn",
      message: "finding_review_question_ids_dropped",
      packetId: packet.id,
      workerId,
      data: {
        candidateId,
        dropped,
        attachedQuestionIds: [...attachedQuestionIds].sort()
      }
    });
  }
  return kept;
}

function normalizeAnchor(
  anchor: DiffAnchor | undefined,
  packet: ReviewPacket,
  diff: UnifiedDiff | undefined
): DiffAnchor | undefined {
  return validateAnchorForDiff(validateAnchorForPacket(anchor, packet), diff);
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
