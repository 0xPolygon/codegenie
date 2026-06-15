import { buildRepositoryToolDefinitions } from "../llm/tool-definitions.js";
import type { LlmRunner } from "../llm/llm-runner.js";
import { SubmitSystemReviewSchema, type SubmitSystemReview } from "../llm/schemas.js";
import type { LensRegistry } from "../skills/lens-registry.js";
import type { PromptBuilder } from "../skills/prompt-builder.js";
import type { TelemetryRecorder } from "../telemetry/telemetry-recorder.js";
import type {
  CandidateFinding,
  CodeninjaConfig,
  Confidence,
  DiffAnchor,
  PacketReviewResult,
  RepositoryTools,
  ResolvedFollowUpHint,
  ReviewPacket,
  ReviewStage,
  SystemReviewResult,
  SystemReviewTask,
  UnifiedDiff
} from "../types.js";
import { sha256Hex } from "../util/hashing.js";
import { createWorkerRunner, type WorkerTask } from "./worker-runner.js";
import { isFatalLlmError, isRecoverableWorkerError, isSchemaInvalidError, validateAnchorForDiff } from "./pipeline-utils.js";

const MAX_SYSTEM_REVIEW_TASKS = 3;
const MAX_FINDINGS_PER_TASK = 5;
const SYSTEM_REVIEW_TOOL_BUDGET = { maxToolCalls: 6, maxInvestigationRounds: 2, maxResultChars: 12_000 };

type SystemReviewOptions = {
  runner: LlmRunner;
  promptBuilder: PromptBuilder;
  lensRegistry: LensRegistry;
  signal?: AbortSignal;
  checkpoint?: (stage: ReviewStage) => "ok" | "exhausted";
  diff?: UnifiedDiff;
};

type HintWithPacket = PacketReviewResult["followUpHints"][number] & { packetId: string };

type HintGroup = {
  key: string;
  question: string;
  reason: string;
  confidence: Exclude<Confidence, "low">;
  packetIds: string[];
  files: string[];
  symbols: string[];
  suggestedLenses: string[];
  hints: HintWithPacket[];
};

type SystemTaskReview = {
  task: SystemReviewTask;
  packetResult: PacketReviewResult;
  resolvedHints: ResolvedFollowUpHint[];
};

export async function runTargetedSystemReviews(
  input: { packetResults: PacketReviewResult[]; packets: ReviewPacket[] },
  tools: RepositoryTools,
  config: CodeninjaConfig,
  telemetry: TelemetryRecorder,
  opts: SystemReviewOptions
): Promise<SystemReviewResult> {
  const tasks = buildSystemReviewTasks(input.packetResults, input.packets);
  telemetry.event({
    stage: 8,
    level: "info",
    message: "stage_started",
    data: { tasks: tasks.length, maxTasks: MAX_SYSTEM_REVIEW_TASKS }
  });

  if (tasks.length === 0) {
    telemetry.event({
      stage: 8,
      level: "info",
      message: "system_review_skipped",
      data: { reason: "no repeated follow-up hints" }
    });
    telemetry.event({
      stage: 8,
      level: "info",
      message: "pipeline_metrics",
      data: { tasks: { built: 0, completed: 0, failed: 0 }, candidates: { generated: 0 }, resolvedHints: 0 }
    });
    telemetry.event({ stage: 8, level: "info", message: "stage_completed", data: { tasks: 0, candidates: 0, resolvedHints: 0 } });
    return { tasks: [], packetResults: [], resolvedHints: [] };
  }

  await telemetry.writeArtifact("system-review-tasks.json", tasks);
  const workerRunner = createWorkerRunner({
    concurrency: Math.min(config.review.concurrency, MAX_SYSTEM_REVIEW_TASKS),
    signal: opts.signal,
    isRetriableError: isRecoverableWorkerError,
    ...(opts.checkpoint !== undefined ? { checkpoint: opts.checkpoint } : {})
  });
  const workerTasks = tasks.map((task): WorkerTask<SystemTaskReview> => ({
    stage: 8,
    priority: task.confidence === "high" ? "high" : "normal",
    packetId: task.id,
    timeoutMs: config.review.perPassTimeoutMs,
    retryOnTransient: true,
    run: async (_signal, assigned) => runSystemReviewTask(task, tools, config, telemetry, opts, assigned.workerId)
  }));
  const outcomes = await workerRunner.schedule(workerTasks);
  const completed = outcomes.flatMap((outcome) => {
    if (outcome.outcome === "completed" && outcome.value) {
      return [outcome.value];
    }
    if (isFatalLlmError(outcome.error) && !isSchemaInvalidError(outcome.error)) {
      throw outcome.error;
    }
    telemetry.event({
      stage: 8,
      level: outcome.outcome === "not_dispatched" ? "warn" : "error",
      message: `system_review_${outcome.outcome}`,
      ...(outcome.task.packetId !== undefined ? { packetId: outcome.task.packetId } : {}),
      workerId: outcome.task.workerId,
      data: { error: outcome.error instanceof Error ? outcome.error.message : String(outcome.error ?? "") }
    });
    return [];
  });
  const packetResults = completed.map((result) => result.packetResult);
  const resolvedHints = completed.flatMap((result) => result.resolvedHints);
  await telemetry.writeArtifact("system-review-results.json", {
    packetResults,
    resolvedHints
  });
  telemetry.event({
    stage: 8,
    level: "info",
    message: "pipeline_metrics",
    data: {
      tasks: {
        built: tasks.length,
        completed: completed.length,
        failed: outcomes.filter((outcome) => outcome.outcome !== "completed").length
      },
      candidates: { generated: packetResults.reduce((sum, result) => sum + result.findings.length, 0) },
      resolvedHints: resolvedHints.length
    }
  });
  telemetry.event({
    stage: 8,
    level: "info",
    message: "stage_completed",
    data: {
      tasks: tasks.length,
      candidates: packetResults.reduce((sum, result) => sum + result.findings.length, 0),
      resolvedHints: resolvedHints.length
    }
  });
  return { tasks, packetResults, resolvedHints };
}

export function suppressResolvedFollowUpHints(
  packetResults: PacketReviewResult[],
  resolvedHints: ResolvedFollowUpHint[]
): PacketReviewResult[] {
  if (resolvedHints.length === 0) {
    return packetResults;
  }
  const resolvedKeys = new Set(resolvedHints.map((hint) => followUpHintKey(hint.question)));
  return packetResults.map((result) => ({
    ...result,
    followUpHints: result.followUpHints.filter((hint) => !resolvedKeys.has(followUpHintKey(hint.question)))
  }));
}

export function buildSystemReviewTasks(packetResults: PacketReviewResult[], packets: ReviewPacket[]): SystemReviewTask[] {
  const groups = repeatedHintGroups(packetResults);
  const findingsByPacket = new Map(packetResults.map((result) => [result.packetId, result.findings]));
  const packetById = new Map(packets.map((packet) => [packet.id, packet]));
  return groups
    .sort(compareHintGroups)
    .slice(0, MAX_SYSTEM_REVIEW_TASKS)
    .map((group) => {
      const representativeFindings = group.packetIds
        .flatMap((packetId) => findingsByPacket.get(packetId) ?? [])
        .slice(0, 5);
      const packetSymbols = group.packetIds
        .flatMap((packetId) => packetById.get(packetId)?.symbolFacts ?? [])
        .flatMap((fact) => [fact.enclosingSymbol, fact.signature])
        .filter((symbol): symbol is string => symbol !== undefined && symbol.trim().length > 0);
      return {
        id: `system-${sha256Hex(group.key).slice(0, 12)}`,
        question: group.question,
        reason: group.reason,
        confidence: group.confidence,
        packetIds: group.packetIds,
        files: group.files,
        symbols: cleanStrings([...group.symbols, ...packetSymbols]).slice(0, 20),
        suggestedLenses: cleanStrings(["core/code-review", ...group.suggestedLenses]).slice(0, 10),
        representativeFindings
      };
    });
}

async function runSystemReviewTask(
  task: SystemReviewTask,
  tools: RepositoryTools,
  config: CodeninjaConfig,
  telemetry: TelemetryRecorder,
  opts: SystemReviewOptions,
  workerId: string
): Promise<SystemTaskReview> {
  const skills = task.suggestedLenses.flatMap((lensId) => opts.lensRegistry.skillsForLens(lensId));
  const prompt = opts.promptBuilder.buildSystemReviewPrompt({ task, skills });
  const submitted = await opts.runner.runStructured<SubmitSystemReview>({
    stage: 8,
    prompt: prompt.prompt,
    schema: SubmitSystemReviewSchema,
    templateVersion: prompt.templateVersion,
    tools: buildRepositoryToolDefinitions(tools),
    toolBudget: SYSTEM_REVIEW_TOOL_BUDGET,
    timeoutMs: config.review.perPassTimeoutMs,
    telemetryContext: { workerId, packetId: task.id }
  });
  const findings = submitted.findings
    .slice(0, MAX_FINDINGS_PER_TASK)
    .map((finding, index) => stampSystemFinding(task, finding, index, workerId, opts.diff));
  const resolvedHints = submitted.resolvedHints.map((hint): ResolvedFollowUpHint => ({
    taskId: task.id,
    question: task.question,
    files: cleanStrings(hint.files.length > 0 ? hint.files : task.files),
    symbols: cleanStrings(hint.symbols.length > 0 ? hint.symbols : task.symbols),
    resolution: hint.resolution.trim()
  })).filter((hint) => hint.resolution.length > 0);
  for (const resolved of resolvedHints) {
    telemetry.event({
      stage: 8,
      level: "info",
      message: "system_review_resolved_hint",
      packetId: task.id,
      workerId,
      data: resolved
    });
  }
  return {
    task,
    packetResult: {
      packetId: task.id,
      lenses: task.suggestedLenses,
      findings,
      followUpHints: [],
      uncertainties: [],
      status: "completed"
    },
    resolvedHints
  };
}

function stampSystemFinding(
  task: SystemReviewTask,
  submitted: SubmitSystemReview["findings"][number],
  index: number,
  workerId: string,
  diff: UnifiedDiff | undefined
): CandidateFinding {
  const anchor = validateAnchorForDiff(submitted.anchor as DiffAnchor | undefined, diff);
  const path = anchor?.path ?? submitted.path;
  return {
    id: `${task.id.slice(0, 12)}-f${index + 1}`,
    title: submitted.title,
    severity: submitted.severity,
    confidence: submitted.confidence,
    path,
    ...(anchor !== undefined ? { anchor } : {}),
    changedLine: anchor !== undefined,
    category: submitted.category,
    evidence: submitted.evidence,
    failureMode: submitted.failureMode,
    whyThisMatters: submitted.whyThisMatters,
    ...(submitted.suggestedFix !== undefined ? { suggestedFix: submitted.suggestedFix } : {}),
    ...(submitted.suggestedTest !== undefined ? { suggestedTest: submitted.suggestedTest } : {}),
    verification: submitted.verification,
    producedBy: {
      kind: "packet",
      stage: 8,
      packetId: task.id,
      lensId: task.suggestedLenses[0] ?? "core/code-review",
      skillIds: [],
      workerId
    }
  };
}

function repeatedHintGroups(packetResults: PacketReviewResult[]): HintGroup[] {
  const groups = new Map<string, HintGroup>();
  for (const result of packetResults) {
    for (const hint of result.followUpHints) {
      const question = hint.question.trim();
      if (question.length === 0 || hint.confidence === "low") {
        continue;
      }
      const key = followUpHintKey(question);
      const existing = groups.get(key);
      const files = cleanStrings(hint.files);
      const symbols = cleanStrings(hint.symbols);
      const suggestedLenses = cleanStrings(hint.suggestedLenses);
      const packetIds = [result.packetId];
      if (!existing) {
        groups.set(key, {
          key,
          question,
          reason: hint.reason.trim(),
          confidence: hint.confidence,
          packetIds,
          files,
          symbols,
          suggestedLenses,
          hints: [{ ...hint, question, packetId: result.packetId }]
        });
        continue;
      }
      existing.packetIds = cleanStrings([...existing.packetIds, result.packetId]);
      existing.files = cleanStrings([...existing.files, ...files]);
      existing.symbols = cleanStrings([...existing.symbols, ...symbols]);
      existing.suggestedLenses = cleanStrings([...existing.suggestedLenses, ...suggestedLenses]);
      existing.hints.push({ ...hint, question, packetId: result.packetId });
      if (confidenceRank(hint.confidence) < confidenceRank(existing.confidence)) {
        existing.confidence = hint.confidence;
        existing.question = question;
        existing.reason = hint.reason.trim();
      }
    }
  }
  return [...groups.values()].filter((group) => group.packetIds.length > 1);
}

function compareHintGroups(a: HintGroup, b: HintGroup): number {
  return confidenceRank(a.confidence) - confidenceRank(b.confidence) ||
    b.packetIds.length - a.packetIds.length ||
    b.files.length - a.files.length ||
    a.question.localeCompare(b.question);
}

function confidenceRank(confidence: Confidence): number {
  return { high: 0, medium: 1, low: 2 }[confidence];
}

function cleanStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))].sort();
}

function followUpHintKey(question: string): string {
  return normalizeFollowUpQuestion(question)
    .replace(/^(please\s+)?(check|confirm|verify|investigate|review)\s+(whether|if|that)?\s*/u, "")
    .replace(/^(whether|if)\s+/u, "")
    .trim();
}

function normalizeFollowUpQuestion(question: string): string {
  return question.toLowerCase()
    .replace(/[`"'’]/gu, "")
    .replace(/[^a-z0-9_./:-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}
