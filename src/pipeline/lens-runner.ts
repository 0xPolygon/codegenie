import { buildRepositoryToolDefinitions } from "../llm/tool-definitions.js";
import type { LlmRunner } from "../llm/llm-runner.js";
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
      }
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
    : buildRepositoryToolDefinitions(tools);
  const submitted = await opts.runner.runStructured<SubmitPacketReview>({
    stage: 7,
    prompt: prompt.prompt,
    schema: SubmitPacketReviewSchema,
    templateVersion: prompt.templateVersion,
    tools: repositoryTools,
    toolBudget: packet.toolBudget,
    timeoutMs: config.review.perPassTimeoutMs,
    telemetryContext: { workerId, packetId: packet.id }
  });
  const findings = submitted.findings.map((finding, index) => stampFinding(packet, finding, index, opts.lensRegistry, workerId, telemetry, opts.diff));
  const followUpHints = submitted.followUpHints.flatMap((hint) => {
    const question = hint.question.trim();
    const pointerRich = hint.files.length > 0 || hint.symbols.length > 0;
    const valid = pointerRich && question.length > 0;
    telemetry.event({
      stage: 7,
      level: valid ? "info" : "warn",
      message: valid ? "follow_up_hint" : question.length === 0 ? "vague_hint" : "follow_up_hint_dropped",
      packetId: packet.id,
      workerId,
      data: {
        question,
        files: hint.files,
        symbols: hint.symbols,
        reason: hint.reason,
        confidence: hint.confidence
      }
    });
    return valid ? [{ ...hint, question }] : [];
  });
  for (const uncertainty of submitted.uncertainties) {
    telemetry.event({
      stage: 7,
      level: "info",
      message: "uncertainty",
      packetId: packet.id,
      workerId,
      data: uncertainty
    });
  }
  return {
    packetId: packet.id,
    lenses: packet.lenses,
    findings,
    followUpHints,
    uncertainties: submitted.uncertainties,
    status: "completed"
  };
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
  if (submitted.anchor !== undefined && anchor === undefined) {
    telemetry.event({
      stage: 7,
      level: "warn",
      message: "out_of_hunk_anchor",
      packetId: packet.id,
      data: { finding: submitted.title, anchor: submitted.anchor }
    });
  }
  const primaryLens = packet.lenses[0] ?? "core/code-review";
  return {
    id: `${packet.id.slice(0, 8)}-f${index + 1}`,
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

function summarizeWorkerOutcomes<T>(outcomes: Array<{ outcome: string; attempts: number }>): {
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
