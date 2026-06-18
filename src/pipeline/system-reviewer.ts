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
import { scaleToolBudget } from "../util/budget.js";
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
  sourceHintKeys: string[];
  hints: HintWithPacket[];
};

type QuestionFollowUpGroup = {
  key: string;
  question: string;
  reason: string;
  confidence: Exclude<Confidence, "low">;
  packetIds: string[];
  files: string[];
  symbols: string[];
  suggestedLenses: string[];
  sourceQuestionIds: string[];
};

type SystemReviewTaskMergeRecord = {
  taskId: string;
  mergedTaskIds: string[];
  reason: string;
};

type SystemReviewTaskSet = {
  rawTasks: SystemReviewTask[];
  tasks: SystemReviewTask[];
  mergeRecords: SystemReviewTaskMergeRecord[];
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
  const taskSet = buildSystemReviewTaskSet(input.packetResults, input.packets);
  const { rawTasks, tasks, mergeRecords } = taskSet;
  telemetry.event({
    stage: 8,
    level: "info",
    message: "stage_started",
    data: { rawTasks: rawTasks.length, tasks: tasks.length, maxTasks: MAX_SYSTEM_REVIEW_TASKS }
  });

  if (tasks.length === 0) {
    telemetry.event({
      stage: 8,
      level: "info",
      message: "system_review_skipped",
      data: { reason: "no repeated follow-up hints or unresolved review questions" }
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

  await telemetry.writeArtifact("system-review-raw-tasks.json", rawTasks);
  await telemetry.writeArtifact("system-review-tasks.json", tasks);
  telemetry.event({
    stage: 8,
    level: "info",
    message: "stage8_tasks_deduplicated",
    data: {
      inputTasks: rawTasks.length,
      outputTasks: tasks.length,
      mergedGroups: mergeRecords.length,
      mergedTaskIds: mergeRecords.flatMap((record) => record.mergedTaskIds),
      savedTasks: Math.max(0, rawTasks.length - tasks.length)
    }
  });
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
        built: rawTasks.length,
        dispatched: tasks.length,
        merged: mergeRecords.length,
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
      rawTasks: rawTasks.length,
      mergedTasks: mergeRecords.length,
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
  const resolvedKeys = new Set(resolvedHints.map((hint) => followUpHintKey(hint)));
  return packetResults.map((result) => ({
    ...result,
    followUpHints: result.followUpHints.filter((hint) => !resolvedKeys.has(followUpHintKey(hint)))
  }));
}

export function buildSystemReviewTasks(packetResults: PacketReviewResult[], packets: ReviewPacket[]): SystemReviewTask[] {
  return buildSystemReviewTaskSet(packetResults, packets).tasks;
}

function buildSystemReviewTaskSet(packetResults: PacketReviewResult[], packets: ReviewPacket[]): SystemReviewTaskSet {
  const findingsByPacket = new Map(packetResults.map((result) => [result.packetId, result.findings]));
  const packetById = new Map(packets.map((packet) => [packet.id, packet]));
  const hintTasks = repeatedHintGroups(packetResults)
    .sort(compareHintGroups)
    .slice(0, MAX_SYSTEM_REVIEW_TASKS * 2)
    .map((group) => {
      return taskFromGroup(group, findingsByPacket, packetById);
    });
  const questionTasks = questionFollowUpGroups(packetResults, packets)
    .sort(compareQuestionGroups)
    .slice(0, MAX_SYSTEM_REVIEW_TASKS)
    .map((group) => taskFromGroup(group, findingsByPacket, packetById));
  const rawTasks = [...hintTasks, ...questionTasks].sort(compareSystemReviewTasks);
  const deduped = dedupeSystemReviewTasks(rawTasks);
  return {
    rawTasks,
    tasks: deduped.tasks.sort(compareSystemReviewTasks).slice(0, MAX_SYSTEM_REVIEW_TASKS),
    mergeRecords: deduped.mergeRecords
  };
}

function taskFromGroup(
  group: HintGroup | QuestionFollowUpGroup,
  findingsByPacket: Map<string, CandidateFinding[]>,
  packetById: Map<string, ReviewPacket>
): SystemReviewTask {
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
    representativeFindings,
    ...("sourceQuestionIds" in group && group.sourceQuestionIds.length > 0 ? { sourceQuestionIds: group.sourceQuestionIds } : {}),
    ...("sourceHintKeys" in group && group.sourceHintKeys.length > 0 ? { sourceHintKeys: group.sourceHintKeys } : {})
  };
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
    toolBudget: scaleToolBudget(SYSTEM_REVIEW_TOOL_BUDGET, config.review.budgetMultiplier),
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
      const files = cleanStrings(hint.files);
      const symbols = cleanStrings(hint.symbols);
      const suggestedLenses = cleanStrings(hint.suggestedLenses);
      const key = followUpHintKey({ question, files, symbols });
      const existing = groups.get(key);
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
          sourceHintKeys: [key],
          hints: [{ ...hint, question, packetId: result.packetId }]
        });
        continue;
      }
      existing.packetIds = cleanStrings([...existing.packetIds, result.packetId]);
      existing.files = cleanStrings([...existing.files, ...files]);
      existing.symbols = cleanStrings([...existing.symbols, ...symbols]);
      existing.suggestedLenses = cleanStrings([...existing.suggestedLenses, ...suggestedLenses]);
      existing.sourceHintKeys = cleanStrings([...existing.sourceHintKeys, key]);
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

function questionFollowUpGroups(packetResults: PacketReviewResult[], packets: ReviewPacket[]): QuestionFollowUpGroup[] {
  const packetById = new Map(packets.map((packet) => [packet.id, packet]));
  const resultByPacketId = new Map(packetResults.map((result) => [result.packetId, result]));
  const globallyCoveredQuestionIds = new Set(packetResults.flatMap((result) =>
    result.findings.flatMap((finding) => finding.reviewQuestionIds ?? [])
  ));
  const attachmentsByQuestion = new Map<string, Array<{ packet: ReviewPacket; question: NonNullable<ReviewPacket["reviewQuestions"]>[number] }>>();
  const primaryByQuestion = new Map<string, { packet: ReviewPacket; question: NonNullable<ReviewPacket["reviewQuestions"]>[number] }>();
  for (const packet of packets) {
    for (const question of packet.reviewQuestions ?? []) {
      const attached = attachmentsByQuestion.get(question.id) ?? [];
      attached.push({ packet, question });
      attachmentsByQuestion.set(question.id, attached);
      if (question.role === "primary") {
        primaryByQuestion.set(question.id, { packet, question });
      }
    }
  }

  const ownedGroups = [...primaryByQuestion.entries()].flatMap(([questionId, primary]) => {
    if (globallyCoveredQuestionIds.has(questionId)) {
      return [];
    }
    const group = ownedQuestionFollowUpGroup(questionId, primary, attachmentsByQuestion.get(questionId) ?? [], resultByPacketId);
    return group === undefined ? [] : [group];
  });

  const groups = new Map<string, QuestionFollowUpGroup>();
  for (const result of packetResults) {
    const packet = packetById.get(result.packetId);
    if (!packet) {
      continue;
    }
    const coveredQuestionIds = new Set(result.findings.flatMap((finding) => finding.reviewQuestionIds ?? []));
    const answersByQuestion = new Map((result.answeredQuestions ?? []).map((answer) => [answer.questionId, answer]));
    const unresolvedQuestionIds = new Set(result.unresolvedQuestions ?? []);
    for (const question of packet.reviewQuestions ?? []) {
      if (coveredQuestionIds.has(question.id) || globallyCoveredQuestionIds.has(question.id) || primaryByQuestion.has(question.id)) {
        continue;
      }
      const answer = answersByQuestion.get(question.id);
      const needsFollowUp = unresolvedQuestionIds.has(question.id) || answer?.outcome === "partial";
      if (!needsFollowUp || answer?.confidence === "low") {
        continue;
      }
      const files = cleanStrings(question.files.length > 0 ? question.files : [packet.path]);
      const symbols = cleanStrings([
        ...question.symbols,
        ...packet.symbolFacts.flatMap((fact) => [fact.enclosingSymbol, fact.signature])
          .filter((symbol): symbol is string => symbol !== undefined && symbol.trim().length > 0)
      ]);
      if (files.length === 0 && symbols.length === 0) {
        continue;
      }
      const reasonParts = [
        question.whyItMatters,
        answer?.answer,
        answer?.evidenceTrace,
        answer === undefined && unresolvedQuestionIds.has(question.id) ? "The packet left this attached review question unresolved." : undefined
      ].filter((part): part is string => part !== undefined && part.trim().length > 0);
      const key = `review-question:${question.id}|${followUpHintKey({ question: question.question, files, symbols })}`;
      const confidence = answer?.confidence === "high" ? "high" : "medium";
      const existing = groups.get(key);
      if (!existing) {
        groups.set(key, {
          key,
          question: question.question,
          reason: reasonParts.join(" "),
          confidence,
          packetIds: [result.packetId],
          files,
          symbols,
          suggestedLenses: cleanStrings(packet.lenses),
          sourceQuestionIds: [question.id]
        });
        continue;
      }
      existing.packetIds = cleanStrings([...existing.packetIds, result.packetId]);
      existing.files = cleanStrings([...existing.files, ...files]);
      existing.symbols = cleanStrings([...existing.symbols, ...symbols]);
      existing.suggestedLenses = cleanStrings([...existing.suggestedLenses, ...packet.lenses]);
      existing.sourceQuestionIds = cleanStrings([...existing.sourceQuestionIds, question.id]);
      if (confidenceRank(confidence) < confidenceRank(existing.confidence)) {
        existing.confidence = confidence;
      }
    }
  }
  const groupedQuestionIds = new Set([
    ...ownedGroups.flatMap((group) => group.sourceQuestionIds),
    ...[...groups.values()].flatMap((group) => group.sourceQuestionIds)
  ]);
  const ambiguousGroups = ambiguousQuestionFollowUpGroups(
    attachmentsByQuestion,
    primaryByQuestion,
    resultByPacketId,
    globallyCoveredQuestionIds,
    groupedQuestionIds
  );
  return [...ownedGroups, ...groups.values(), ...ambiguousGroups];
}

function ambiguousQuestionFollowUpGroups(
  attachmentsByQuestion: Map<string, Array<{ packet: ReviewPacket; question: NonNullable<ReviewPacket["reviewQuestions"]>[number] }>>,
  primaryByQuestion: Map<string, { packet: ReviewPacket; question: NonNullable<ReviewPacket["reviewQuestions"]>[number] }>,
  resultByPacketId: Map<string, PacketReviewResult>,
  globallyCoveredQuestionIds: Set<string>,
  alreadyGroupedQuestionIds: Set<string>
): QuestionFollowUpGroup[] {
  const groups: QuestionFollowUpGroup[] = [];
  for (const [questionId, attachments] of attachmentsByQuestion) {
    if (
      globallyCoveredQuestionIds.has(questionId) ||
      primaryByQuestion.has(questionId) ||
      alreadyGroupedQuestionIds.has(questionId)
    ) {
      continue;
    }
    const hasAmbiguousAttachment = attachments.some((attachment) => attachment.question.ownershipStatus === "ambiguous");
    if (!hasAmbiguousAttachment && attachments.length < 2) {
      continue;
    }
    const question = attachments[0]?.question;
    if (question === undefined) {
      continue;
    }
    const attachmentResults = attachments
      .map((attachment) => ({
        ...attachment,
        result: resultByPacketId.get(attachment.packet.id)
      }))
      .filter((attachment) => attachment.result !== undefined);
    if (attachmentResults.length === 0) {
      continue;
    }
    const answers = attachmentResults
      .map((attachment) => ({
        ...attachment,
        answer: answerForQuestion(attachment.result as PacketReviewResult, questionId),
        unresolved: questionIsUnresolved(attachment.result as PacketReviewResult, questionId)
      }))
      .filter((attachment) => attachment.answer !== undefined || attachment.unresolved);
    if (answers.length === 0 || answers.every((entry) => entry.answer?.confidence === "low")) {
      continue;
    }
    const fullScopeNoIssue = answers.some((entry) =>
      entry.answer?.outcome === "answered_no_issue" &&
      entry.answer.confidence !== "low" &&
      answerCoversQuestionScope(entry.answer, entry.question, entry.packet, attachments)
    );
    const hasUnresolvedOrPartialAnswer = answers.some((entry) =>
      entry.unresolved ||
      entry.answer?.outcome === "partial" ||
      entry.answer?.outcome === "candidate_finding"
    );
    if (fullScopeNoIssue && !hasUnresolvedOrPartialAnswer) {
      continue;
    }

    const packetsForTask = cleanPacketAttachments(attachments.map((attachment) => attachment.packet));
    const files = cleanStrings(question.files.length > 0 ? question.files : packetsForTask.map((packet) => packet.path));
    const symbols = cleanStrings([
      ...question.symbols,
      ...packetsForTask.flatMap((packet) => packet.symbolFacts)
        .flatMap((fact) => [fact.enclosingSymbol, fact.signature])
        .filter((symbol): symbol is string => symbol !== undefined && symbol.trim().length > 0)
    ]);
    if (files.length === 0 && symbols.length === 0) {
      continue;
    }
    const reasonParts = [
      question.whyItMatters,
      "Ownership was ambiguous, so local no-issue answers do not close the full review question.",
      ...answers.flatMap((entry) => {
        if (entry.answer === undefined) {
          return entry.unresolved ? [`Packet ${entry.packet.id} left this attached review question unresolved.`] : [];
        }
        return [
          `Packet ${entry.packet.id} (${entry.answer.outcome}): ${entry.answer.answer}`,
          entry.answer.evidenceTrace
        ].filter((part): part is string => part !== undefined && part.trim().length > 0);
      })
    ].filter((part): part is string => part !== undefined && part.trim().length > 0);
    const hasHighConfidenceSignal = answers.some((entry) => entry.answer?.confidence === "high");
    groups.push({
      key: `review-question-ambiguous:${questionId}`,
      question: question.question,
      reason: reasonParts.join(" "),
      confidence: hasHighConfidenceSignal ? "high" : "medium",
      packetIds: cleanStrings(packetsForTask.map((packet) => packet.id)),
      files,
      symbols,
      suggestedLenses: cleanStrings(packetsForTask.flatMap((packet) => packet.lenses)),
      sourceQuestionIds: [questionId]
    });
  }
  return groups;
}

function ownedQuestionFollowUpGroup(
  questionId: string,
  primary: { packet: ReviewPacket; question: NonNullable<ReviewPacket["reviewQuestions"]>[number] },
  attachments: Array<{ packet: ReviewPacket; question: NonNullable<ReviewPacket["reviewQuestions"]>[number] }>,
  resultByPacketId: Map<string, PacketReviewResult>
): QuestionFollowUpGroup | undefined {
  const primaryResult = resultByPacketId.get(primary.packet.id);
  if (primaryResult === undefined) {
    return undefined;
  }
  const primaryAnswer = answerForQuestion(primaryResult, questionId);
  const primaryUnresolved = questionIsUnresolved(primaryResult, questionId);
  const primaryNoIssueIncomplete =
    primaryAnswer?.outcome === "answered_no_issue" &&
    !answerCoversQuestionScope(primaryAnswer, primary.question, primary.packet, attachments);
  const primaryNeedsFollowUp =
    primaryUnresolved ||
    primaryAnswer?.outcome === "partial" ||
    primaryNoIssueIncomplete ||
    (primaryAnswer === undefined && primaryResult.status === "completed");
  if (!primaryNeedsFollowUp || primaryAnswer?.confidence === "low") {
    return undefined;
  }

  const supporting = attachments
    .filter((attachment) => attachment.packet.id !== primary.packet.id)
    .map((attachment) => ({
      ...attachment,
      result: resultByPacketId.get(attachment.packet.id)
    }))
    .filter((attachment) => attachment.result !== undefined);
  const supportingWithSignals = supporting.filter((attachment) =>
    answerForQuestion(attachment.result as PacketReviewResult, questionId) !== undefined ||
    questionIsUnresolved(attachment.result as PacketReviewResult, questionId)
  );
  const supportingPackets = supportingWithSignals.length > 0 ? supportingWithSignals : supporting;
  const packetsForTask = [primary.packet, ...supportingPackets.map((attachment) => attachment.packet)];
  const files = cleanStrings(primary.question.files.length > 0 ? primary.question.files : packetsForTask.map((packet) => packet.path));
  const symbols = cleanStrings([
    ...primary.question.symbols,
    ...packetsForTask.flatMap((packet) => packet.symbolFacts)
      .flatMap((fact) => [fact.enclosingSymbol, fact.signature])
      .filter((symbol): symbol is string => symbol !== undefined && symbol.trim().length > 0)
  ]);
  if (files.length === 0 && symbols.length === 0) {
    return undefined;
  }

  const reasonParts = [
    primary.question.whyItMatters,
    primaryAnswer !== undefined
      ? `Primary packet ${primary.packet.id}: ${primaryAnswer.answer}`
      : `Primary packet ${primary.packet.id} did not answer this attached review question.`,
    primaryAnswer?.evidenceTrace,
    ...supportingPackets.flatMap((attachment) => {
      const answer = answerForQuestion(attachment.result as PacketReviewResult, questionId);
      if (answer === undefined) {
        return questionIsUnresolved(attachment.result as PacketReviewResult, questionId)
          ? [`Supporting packet ${attachment.packet.id} left this question unresolved.`]
          : [];
      }
      return [`Supporting packet ${attachment.packet.id}: ${answer.answer}`, answer.evidenceTrace].filter(
        (part): part is string => part !== undefined && part.trim().length > 0
      );
    })
  ].filter((part): part is string => part !== undefined && part.trim().length > 0);
  const confidence = primaryAnswer?.confidence === "high" ? "high" : "medium";
  return {
    key: `review-question-primary:${questionId}`,
    question: primary.question.question,
    reason: reasonParts.join(" "),
    confidence,
    packetIds: cleanStrings(packetsForTask.map((packet) => packet.id)),
    files,
    symbols,
    suggestedLenses: cleanStrings(packetsForTask.flatMap((packet) => packet.lenses)),
    sourceQuestionIds: [questionId]
  };
}

function answerForQuestion(result: PacketReviewResult, questionId: string): NonNullable<PacketReviewResult["answeredQuestions"]>[number] | undefined {
  return result.answeredQuestions?.find((answer) => answer.questionId === questionId);
}

function questionIsUnresolved(result: PacketReviewResult, questionId: string): boolean {
  return (result.unresolvedQuestions ?? []).includes(questionId);
}

function answerCoversQuestionScope(
  answer: NonNullable<PacketReviewResult["answeredQuestions"]>[number],
  question: NonNullable<ReviewPacket["reviewQuestions"]>[number],
  packet: ReviewPacket,
  attachments: Array<{ packet: ReviewPacket; question: NonNullable<ReviewPacket["reviewQuestions"]>[number] }>
): boolean {
  const questionFiles = cleanStrings(question.files.map(stripLocationSuffix));
  const questionSymbols = cleanStrings(question.symbols);
  const hasMultiFileScope = questionFiles.length > 1;
  const hasMultiSymbolScope = questionSymbols.length > 1;
  const hasMultiPacketScope = attachments.length > 1 || (question.ownershipCandidatePacketIds ?? []).length > 1;
  if (!hasMultiFileScope && !hasMultiSymbolScope && !hasMultiPacketScope && question.ownershipStatus !== "ambiguous") {
    return true;
  }
  const evidencePaths = cleanStrings(answer.evidence.map((entry) => stripLocationSuffix(entry.path)));
  const attachmentPaths = cleanStrings(attachments.map((attachment) => attachment.packet.path));
  const matchedQuestionFiles = questionFiles.filter((file) => evidencePaths.includes(file));
  const referencedAttachmentPaths = attachmentPaths.filter((path) => evidencePaths.includes(path));
  const text = [
    answer.answer,
    answer.evidenceTrace ?? "",
    ...answer.evidence.flatMap((entry) => [entry.lines ?? "", entry.whyRelevant])
  ].join(" ");
  const mentionedQuestionSymbols = questionSymbols.filter((symbol) => textMentionsSymbol(text, symbol));
  return (hasMultiFileScope && matchedQuestionFiles.length >= 2) ||
    (hasMultiPacketScope && referencedAttachmentPaths.length >= 2) ||
    (hasMultiSymbolScope && mentionedQuestionSymbols.length >= 2);
}

function cleanPacketAttachments(packets: ReviewPacket[]): ReviewPacket[] {
  const seen = new Set<string>();
  const result: ReviewPacket[] = [];
  for (const packet of packets) {
    if (seen.has(packet.id)) {
      continue;
    }
    seen.add(packet.id);
    result.push(packet);
  }
  return result;
}

function compareHintGroups(a: HintGroup, b: HintGroup): number {
  return confidenceRank(a.confidence) - confidenceRank(b.confidence) ||
    b.packetIds.length - a.packetIds.length ||
    b.files.length - a.files.length ||
    a.question.localeCompare(b.question);
}

function compareQuestionGroups(a: QuestionFollowUpGroup, b: QuestionFollowUpGroup): number {
  return confidenceRank(a.confidence) - confidenceRank(b.confidence) ||
    b.packetIds.length - a.packetIds.length ||
    b.files.length - a.files.length ||
    a.question.localeCompare(b.question);
}

function compareSystemReviewTasks(a: SystemReviewTask, b: SystemReviewTask): number {
  return confidenceRank(a.confidence) - confidenceRank(b.confidence) ||
    b.packetIds.length - a.packetIds.length ||
    b.files.length - a.files.length ||
    a.question.localeCompare(b.question);
}

function dedupeSystemReviewTasks(tasks: SystemReviewTask[]): { tasks: SystemReviewTask[]; mergeRecords: SystemReviewTaskMergeRecord[] } {
  const deduped: SystemReviewTask[] = [];
  for (const task of tasks) {
    const existing = deduped.find((candidate) => systemReviewTasksMatch(candidate, task));
    if (existing !== undefined) {
      deduped[deduped.indexOf(existing)] = mergeSystemReviewTasks(existing, task);
      continue;
    }
    deduped.push({ ...task, mergedTaskIds: task.mergedTaskIds ?? [task.id] });
  }
  const mergeRecords = deduped
    .filter((task) => (task.mergedTaskIds ?? []).length > 1)
    .map((task): SystemReviewTaskMergeRecord => ({
      taskId: task.id,
      mergedTaskIds: task.mergedTaskIds ?? [task.id],
      reason: mergeReason(task)
    }));
  return { tasks: deduped, mergeRecords };
}

function systemReviewTasksMatch(a: SystemReviewTask, b: SystemReviewTask): boolean {
  if (intersects(a.sourceQuestionIds ?? [], b.sourceQuestionIds ?? [])) {
    return true;
  }
  if (!intersects(a.files, b.files)) {
    return false;
  }
  const aQuestion = normalizeFollowUpQuestion(a.question);
  const bQuestion = normalizeFollowUpQuestion(b.question);
  if (aQuestion === bQuestion) {
    return true;
  }
  if (!intersects(a.symbols, b.symbols)) {
    return false;
  }
  return meaningfulTokenOverlap(aQuestion, bQuestion) >= 0.62;
}

function mergeSystemReviewTasks(a: SystemReviewTask, b: SystemReviewTask): SystemReviewTask {
  const taskIds = cleanStrings([...(a.mergedTaskIds ?? [a.id]), ...(b.mergedTaskIds ?? [b.id])]);
  const reasons = cleanStrings([a.reason, b.reason]);
  return {
    ...a,
    confidence: confidenceRank(b.confidence) < confidenceRank(a.confidence) ? b.confidence : a.confidence,
    packetIds: cleanStrings([...a.packetIds, ...b.packetIds]),
    files: cleanStrings([...a.files, ...b.files]),
    symbols: cleanStrings([...a.symbols, ...b.symbols]).slice(0, 20),
    suggestedLenses: cleanStrings([...a.suggestedLenses, ...b.suggestedLenses]).slice(0, 10),
    representativeFindings: dedupeFindings([...a.representativeFindings, ...b.representativeFindings]).slice(0, 5),
    reason: reasons.join(" "),
    ...(cleanStrings([...(a.sourceQuestionIds ?? []), ...(b.sourceQuestionIds ?? [])]).length > 0
      ? { sourceQuestionIds: cleanStrings([...(a.sourceQuestionIds ?? []), ...(b.sourceQuestionIds ?? [])]) }
      : {}),
    ...(cleanStrings([...(a.sourceHintKeys ?? []), ...(b.sourceHintKeys ?? [])]).length > 0
      ? { sourceHintKeys: cleanStrings([...(a.sourceHintKeys ?? []), ...(b.sourceHintKeys ?? [])]) }
      : {}),
    mergedTaskIds: taskIds
  };
}

function mergeReason(task: SystemReviewTask): string {
  if ((task.sourceQuestionIds ?? []).length > 0) {
    return "same_review_question";
  }
  if ((task.sourceHintKeys ?? []).length > 1) {
    return "same_or_overlapping_follow_up_hints";
  }
  return "symbol_file_and_question_overlap";
}

function dedupeFindings(findings: CandidateFinding[]): CandidateFinding[] {
  const seen = new Set<string>();
  const result: CandidateFinding[] = [];
  for (const finding of findings) {
    if (seen.has(finding.id)) {
      continue;
    }
    seen.add(finding.id);
    result.push(finding);
  }
  return result;
}

function intersects(left: string[], right: string[]): boolean {
  const rightSet = new Set(right.map(normalizeScopeValue));
  return left.some((value) => rightSet.has(normalizeScopeValue(value)));
}

function meaningfulTokenOverlap(left: string, right: string): number {
  const leftTokens = meaningfulTokens(left);
  const rightTokens = meaningfulTokens(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }
  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      overlap += 1;
    }
  }
  return overlap / Math.min(leftTokens.size, rightTokens.size);
}

function meaningfulTokens(input: string): Set<string> {
  const stop = new Set(["after", "before", "check", "confirm", "verify", "whether", "review", "this", "that", "changed", "change", "behavior", "contract", "still", "with", "from", "into", "across", "same", "question"]);
  return new Set(normalizeFollowUpQuestion(input).split(" ").filter((token) => token.length >= 4 && !stop.has(token)));
}

function confidenceRank(confidence: Confidence): number {
  return { high: 0, medium: 1, low: 2 }[confidence];
}

function cleanStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))].sort();
}

type FollowUpHintKeyInput = {
  question: string;
  files: string[];
  symbols: string[];
};

function followUpHintKey(input: FollowUpHintKeyInput): string {
  const question = normalizeFollowUpQuestion(input.question)
    .replace(/^(please\s+)?(check|confirm|verify|investigate|review)\s+(whether|if|that)?\s*/u, "")
    .replace(/^(whether|if)\s+/u, "")
    .trim();
  const files = cleanStrings(input.files).map(normalizeScopeValue).slice(0, 5).join(",");
  const symbols = cleanStrings(input.symbols).map(normalizeScopeValue).slice(0, 5).join(",");
  return `q:${question}|files:${files || "none"}|symbols:${symbols || "none"}`;
}

function normalizeFollowUpQuestion(question: string): string {
  return question.toLowerCase()
    .replace(/[`"'’]/gu, "")
    .replace(/[^a-z0-9_./:-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function textMentionsSymbol(text: string, symbol: string): boolean {
  const normalizedText = normalizeFollowUpQuestion(text);
  const normalizedSymbol = normalizeFollowUpQuestion(symbol);
  return normalizedText.length > 0 &&
    normalizedSymbol.length > 0 &&
    (normalizedText === normalizedSymbol || normalizedText.includes(normalizedSymbol));
}

function stripLocationSuffix(value: string): string {
  return value.trim().replace(/:\d+(?:-\d+)?$/u, "");
}

function normalizeScopeValue(input: string): string {
  return input.toLowerCase().replace(/\s+/gu, " ").trim();
}
