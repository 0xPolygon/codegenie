import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import type {
  CodeninjaConfig,
  LogEvent,
  Logger,
  LogLevel,
  RunOutcome,
  TelemetryEvent,
  ToolCallRecord
} from "../types.js";
import type { LlmCallRecord, TelemetryRecorder } from "./telemetry-recorder.js";
import { stripCredentials } from "./redaction.js";

type CreateRunTelemetryOptions = {
  telemetryConfig: CodeninjaConfig["telemetry"];
  runMetadata?: RunArtifactMetadata;
  clock?: () => Date;
  idFactory?: () => string;
};

export type RunTelemetry = {
  logger: Logger;
  recorder: TelemetryRecorder;
  attachRunDirectory(repoRoot: string): Promise<{ runId: string; runDir: string }>;
  finalize(outcome: RunOutcome): Promise<void>;
};

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

const KNOWN_ARTIFACTS = new Set([
  "error.json",
  "planner-dossier.json",
  "planner-dossier-chunks.json",
  "resolved-input.json",
  "diff.json",
  "file-filter-decisions.json",
  "file-facts.json",
  "review-plan.json",
  "coverage.json",
  "budget-summary.json",
  "candidate-findings.json",
  "uncertainty-promotion.json",
  "verification.json",
  "final-selection.json",
  "human-attention-notes.json",
  "final-findings.json",
  "cost-profile.json",
  "final-review.md",
  "github-posting.json",
  "telemetry.json",
  "run.json",
  "model-calls-summary.json",
  "tool-calls-summary.json"
]);

type CacheCounts = Record<"hit" | "miss" | "disabled" | "write", number>;
type ModelStatusCounts = Record<LlmCallRecord["status"], number>;
type ProviderPromptCacheSummary = {
  readTokens: number;
  writeTokens: number;
  readCostUSD: number;
  writeCostUSD: number;
};
type ProviderPromptCacheSource = {
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheReadCostUSD: number;
  cacheWriteCostUSD: number;
};
type CostBreakdownSource = ProviderPromptCacheSource & {
  uncachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  inputCostUSD: number;
  outputCostUSD: number;
  costUSD: number;
};
type CostBreakdownSummary = {
  uncachedInput: { tokens: number; costUSD: number };
  providerPromptCacheRead: { tokens: number; costUSD: number };
  providerPromptCacheWrite: { tokens: number; costUSD: number };
  output: { tokens: number; costUSD: number };
  total: { tokens: number; costUSD: number };
};

type ModelStageSummary = {
  recordCount: number;
  count: number;
  providerCalls: number;
  inputTokens: number;
  uncachedInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  billableInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUSD: number;
  inputCostUSD: number;
  outputCostUSD: number;
  cacheReadCostUSD: number;
  cacheWriteCostUSD: number;
  unknownCostCalls: number;
  cache: CacheCounts;
  retryAttempts: number;
  repairCalls: number;
  schemaInvalidCalls: number;
  statuses: ModelStatusCounts;
};

type TelemetryStageSummary = {
  events: number;
  levels: Record<LogLevel, number>;
  cache: CacheCounts;
  startedAt?: string;
  completedAt?: string;
  runtimeMs: number;
};

type LogOverflowSummary = {
  droppedDebugInfo: number;
  droppedWarnError: number;
};

type RunArtifactMetadata = {
  argv?: string[];
  repoRoot?: string;
  review?: {
    mode?: string;
    target?: unknown;
    prNumber?: number;
    baseRef?: string;
    headRef?: string;
    baseSha?: string;
    headSha?: string;
    depth?: string;
    budgetMultiplier?: number;
    lenses?: string[];
    format?: string;
    postGithubComments?: boolean;
  };
};

type RunReviewArtifactMetadata = {
  mode: string;
  target: unknown;
  prNumber: number | null;
  baseRef: string | null;
  headRef: string | null;
  baseSha: string | null;
  headSha: string | null;
  depth: string | null;
  budgetMultiplier: number | null;
  lenses: string[];
  format: string | null;
  postGithubComments: boolean;
};

type PipelineTotals = {
  filesChanged: number;
  hunks: number;
  packets: number;
  packetReviews: number;
  candidates: number;
  verified: number;
  finalFindings: number;
  postedComments: number;
};

type PipelineTelemetrySummary = {
  workers: {
    started: number;
    completed: number;
    failed: number;
    retried: number;
    timedOut: number;
  };
  packets: {
    generated: number;
    reviewed: number;
    failed: number;
    degraded: number;
  };
  lenses: {
    selected: number;
    byLens: Record<string, number>;
  };
  coverage: {
    byLevel: Record<"deep" | "normal" | "light" | "skip", number>;
    hunks: {
      total: number;
      reviewed: number;
      skipped: number;
      failed: number;
      degraded: number;
    };
  };
  candidates: {
    generated: number;
    gateRejected: number;
    verificationScheduled: number;
    verificationBudgetLimited: number;
    clusteredDuplicates: number;
    verificationRepresentatives: number;
    lowConfidenceSuppressed: number;
    lowConfidenceEvidenceEligible: number;
    lowConfidenceEvidenceScheduled: number;
    lowConfidenceEvidenceLaneLimited: number;
    lowConfidenceEvidenceKept: number;
    lowConfidenceEvidenceRejected: number;
    lowConfidenceEvidenceIncomplete: number;
  };
  verdicts: {
    accept: number;
    revise: number;
    reject: number;
    incomplete: number;
  };
  dedup: {
    clusters: number;
    duplicates: number;
    suppressed: number;
  };
  finalSelection: {
    published: number;
    merged: number;
    suppressed: number;
    finalFindings: number;
  };
  posting: {
    attempted: number;
    postedComments: number;
    skippedDuplicates: number;
    failed: number;
  };
};

export function createRunTelemetry(opts: CreateRunTelemetryOptions): RunTelemetry {
  const impl = new RunTelemetryImpl(opts);
  return {
    logger: impl.logger,
    recorder: impl.recorder,
    attachRunDirectory: (repoRoot) => impl.attachRunDirectory(repoRoot),
    finalize: (outcome) => impl.finalize(outcome)
  };
}

class RunTelemetryImpl {
  readonly runId: string;
  private readonly startedAt: string;
  private readonly clock: () => Date;
  private readonly config: CodeninjaConfig["telemetry"];
  private readonly metadata: RunArtifactMetadata;
  private repoRoot: string | undefined;
  private runDirectory: string | undefined;
  private logBuffer: LogEvent[] = [];
  private eventBuffer: TelemetryEvent[] = [];
  private modelBuffer: LlmCallRecord[] = [];
  private toolBuffer: ToolCallRecord[] = [];
  private eventSeq = 0;
  private toolSeq = 0;
  private logOverflow: LogOverflowSummary = { droppedDebugInfo: 0, droppedWarnError: 0 };
  private pipelineTotals = emptyPipelineTotals();
  private modelSummary = {
    totalRecords: 0,
    totalCalls: 0,
    providerCalls: 0,
    inputTokens: 0,
    uncachedInputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    billableInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUSD: 0,
    inputCostUSD: 0,
    outputCostUSD: 0,
    cacheReadCostUSD: 0,
    cacheWriteCostUSD: 0,
    unknownCostCalls: 0,
    cache: emptyCacheCounts(),
    retryAttempts: 0,
    repairCalls: 0,
    schemaInvalidCalls: 0,
    byStage: {} as Record<string, ModelStageSummary>
  };
  private toolSummary = {
    totalCalls: 0,
    byTool: {} as Record<string, { count: number; errors: number; rejections: number; degraded: number; totalDurationMs: number; totalResultChars: number }>,
    byStage: {} as Record<string, { count: number; errors: number; rejections: number; degraded: number; totalDurationMs: number; totalResultChars: number }>
  };
  private telemetrySummary = {
    events: 0,
    levels: emptyLevelCounts(),
    cache: emptyCacheCounts(),
    byStage: {} as Record<string, TelemetryStageSummary>
  };
  private pipelineSummary = emptyPipelineTelemetrySummary();

  readonly logger: Logger = {
    debug: (event) => this.log("debug", event),
    info: (event) => this.log("info", event),
    warn: (event) => this.log("warn", event),
    error: (event) => this.log("error", event)
  };

  readonly recorder: TelemetryRecorder;

  constructor(opts: CreateRunTelemetryOptions) {
    this.clock = opts.clock ?? (() => new Date());
    this.config = opts.telemetryConfig;
    this.metadata = opts.runMetadata ?? {};
    this.runId = opts.idFactory?.() ?? createRunId(this.clock());
    this.startedAt = this.clock().toISOString();
    const thisImpl = this;
    this.recorder = {
      get runId() {
        return thisImpl.runId;
      },
      get runDir() {
        return thisImpl.runDirectory;
      },
      event: (event) => this.recordEvent(event),
      recordModelCall: (record) => this.recordModelCall(record),
      recordToolCall: (record) => this.recordToolCall(record),
      writeArtifact: async (relPath, data) => {
        this.writeArtifact(relPath, data);
      },
      writeDebug: async (kind, id, record) => {
        this.writeDebug(kind, id, record);
      },
      flush: async () => {
        this.flushBuffers();
      }
    };
  }

  async attachRunDirectory(repoRoot: string): Promise<{ runId: string; runDir: string }> {
    this.repoRoot = path.resolve(repoRoot);
    if (!this.config.enabled) {
      return { runId: this.runId, runDir: "" };
    }

    const runsRoot = resolveRunRoot(this.repoRoot, this.config.runDir);
    provisionProjectGitignore(this.repoRoot, runsRoot);
    mkdirSync(runsRoot, { recursive: true });

    const runDir = path.join(runsRoot, this.runId);
    mkdirSync(runDir, { recursive: true });
    mkdirSync(path.join(runDir, "packets"), { recursive: true });
    if (this.config.debugTrace) {
      mkdirSync(path.join(runDir, "debug", "llm-calls"), { recursive: true });
      mkdirSync(path.join(runDir, "debug", "tool-calls"), { recursive: true });
    }

    this.runDirectory = runDir;
    touchCoreFiles(runDir);
    this.flushBuffers();
    this.recordPruneResult(pruneRuns(runsRoot, runDir, this.config.retainRuns));
    return { runId: this.runId, runDir };
  }

  async finalize(outcome: RunOutcome): Promise<void> {
    if (!this.config.enabled || !this.runDirectory) {
      return;
    }

    const finishedAt = this.clock().toISOString();
    const durationMs = durationBetween(this.startedAt, finishedAt);
    const totals = this.runTotals();
    const normalizedOutcome = normalizeOutcome(outcome);
    this.writeJson("run.json", {
      schemaVersion: 1,
      runId: this.runId,
      codeninjaVersion: readCodeninjaVersion(),
      nodeVersion: process.version,
      argv: this.metadata.argv ?? process.argv,
      repoRoot: this.metadata.repoRoot ?? this.repoRoot ?? null,
      review: this.runReviewMetadata(),
      startedAt: this.startedAt,
      finishedAt,
      completedAt: finishedAt,
      durationMs,
      outcome: normalizedOutcome,
      ...(normalizedOutcome.budgetStop !== null ? { budgetStop: normalizedOutcome.budgetStop } : {}),
      totals
    });
    const modelSummary = this.finalModelSummary();
    this.writeJson("telemetry.json", {
      schemaVersion: 1,
      runId: this.runId,
      startedAt: this.startedAt,
      finishedAt,
      completedAt: finishedAt,
      durationMs,
      logLevel: this.config.logLevel,
      debugTrace: this.config.debugTrace,
      events: this.eventSeq,
      logs: {
        bufferedOverflow: this.logOverflow
      },
      ...(normalizedOutcome.budgetStop !== null ? { budgetStop: normalizedOutcome.budgetStop } : {}),
      totals,
      stages: this.allStageSummaries(),
      workers: this.pipelineSummary.workers,
      packets: this.pipelineSummary.packets,
      lenses: this.pipelineSummary.lenses,
      coverage: this.pipelineSummary.coverage,
      candidates: this.pipelineSummary.candidates,
      verdicts: this.pipelineSummary.verdicts,
      dedup: this.pipelineSummary.dedup,
      finalSelection: this.pipelineSummary.finalSelection,
      posting: this.pipelineSummary.posting,
      modelCalls: modelSummary,
      toolCalls: this.finalToolSummary()
    });
    this.writeJson("model-calls-summary.json", modelSummary);
    this.writeJson("tool-calls-summary.json", this.finalToolSummary());
    this.writeJson("cost-profile.json", this.costProfile());
  }

  private log(level: LogLevel, event: Omit<LogEvent, "timestamp" | "level">): void {
    if (level === "warn" || level === "error") {
      process.stderr.write(stripCredentials(`[${level}] ${event.stage}: ${event.message}\n`));
    }

    if (!this.config.enabled || LOG_LEVEL_ORDER[level] < LOG_LEVEL_ORDER[this.config.logLevel]) {
      return;
    }

    const record: LogEvent = {
      ...event,
      level,
      timestamp: this.clock().toISOString()
    };

    if (this.runDirectory) {
      this.appendJsonl("run.log", record);
      return;
    }

    this.logBuffer.push(record);
    if (this.logBuffer.length > 1000) {
      const trimmed = trimBufferedLogs(this.logBuffer);
      this.logBuffer = trimmed.logs;
      this.logOverflow.droppedDebugInfo += trimmed.droppedDebugInfo;
      this.logOverflow.droppedWarnError += trimmed.droppedWarnError;
    }
  }

  private recordEvent(event: Omit<TelemetryEvent, "runId" | "eventId" | "timestamp">): void {
    if (!this.config.enabled) {
      return;
    }

    const record: TelemetryEvent = {
      ...event,
      runId: this.runId,
      eventId: `ev-${String(++this.eventSeq).padStart(6, "0")}`,
      timestamp: this.clock().toISOString()
    };

    const capped = capTelemetryEventData(record);
    this.updateTelemetrySummary(capped);
    this.updateModelSummaryFromCacheEvent(capped);
    this.updatePipelineSummaryFromEvent(capped);
    this.mirrorTelemetryEventToRunLog(capped);
    if (this.runDirectory) {
      this.appendJsonl("events.jsonl", capped);
    } else {
      this.eventBuffer.push(capped);
    }
  }

  private mirrorTelemetryEventToRunLog(event: TelemetryEvent): void {
    if (LOG_LEVEL_ORDER[event.level] < LOG_LEVEL_ORDER[this.config.logLevel]) {
      return;
    }
    const data = eventLogData(event);
    const record: LogEvent = {
      timestamp: event.timestamp,
      level: event.level,
      runId: event.runId,
      stage: event.stage,
      event: event.message,
      message: event.message,
      ...(event.workerId !== undefined ? { workerId: event.workerId } : {}),
      ...(event.packetId !== undefined ? { packetId: event.packetId } : {}),
      ...(event.file !== undefined ? { path: event.file } : {}),
      ...(event.lensId !== undefined ? { lensId: event.lensId } : {}),
      ...(data !== undefined ? { data } : {})
    };
    if (this.runDirectory) {
      this.appendJsonl("run.log", record);
    } else {
      this.logBuffer.push(record);
    }
  }

  private recordModelCall(record: Omit<LlmCallRecord, "runId">): void {
    const fullRecord: LlmCallRecord = { ...record, runId: this.runId };
    this.updateModelSummary(fullRecord);
    if (!this.config.enabled) {
      return;
    }
    if (this.runDirectory) {
      this.appendJsonl("model-calls.jsonl", fullRecord);
    } else {
      this.modelBuffer.push(fullRecord);
    }
  }

  private recordToolCall(record: Omit<ToolCallRecord, "runId" | "toolCallId" | "timestamp">): string {
    const toolCallId = `tc-${String(++this.toolSeq).padStart(6, "0")}`;
    const fullRecord: ToolCallRecord = {
      ...record,
      runId: this.runId,
      toolCallId,
      timestamp: this.clock().toISOString()
    };
    this.updateToolSummary(fullRecord);
    this.logger.debug({
      runId: this.runId,
      stage: record.stage,
      event: "tool_call",
      message: `${record.tool} ${record.status}`,
      toolName: record.tool,
      ...(record.args.path !== undefined ? { path: record.args.path } : {}),
      ...(record.packetId !== undefined ? { packetId: record.packetId } : {}),
      ...(record.workerId !== undefined ? { workerId: record.workerId } : {}),
      ...(record.candidateId !== undefined ? { candidateId: record.candidateId } : {}),
      data: { status: record.status, resultChars: record.resultChars }
    });

    if (this.config.enabled) {
      if (this.runDirectory) {
        this.appendJsonl("tool-calls.jsonl", fullRecord);
      } else {
        this.toolBuffer.push(fullRecord);
      }
    }
    return toolCallId;
  }

  private writeArtifact(relPath: string, data: unknown): void {
    if (!this.config.enabled || !this.runDirectory) {
      return;
    }
    assertAllowedArtifactPath(relPath);
    if (relPath === "final-review.md") {
      this.writeText(relPath, typeof data === "string" ? data : serialize(data, 2));
      return;
    }
    this.writeJson(relPath, data);
  }

  private writeDebug(kind: "llm-calls" | "tool-calls", id: string, record: unknown): void {
    if (!this.config.enabled || !this.config.debugTrace || !this.runDirectory) {
      return;
    }
    const safeId = id.replace(/[^A-Za-z0-9_.-]/g, "_");
    const relPath = path.join("debug", kind, `${safeId}.json`);
    this.writeJson(relPath, record);
  }

  private flushBuffers(): void {
    if (!this.config.enabled || !this.runDirectory) {
      return;
    }

    for (const record of this.logBuffer) {
      this.appendJsonl("run.log", record);
    }
    for (const record of this.eventBuffer) {
      this.appendJsonl("events.jsonl", record);
    }
    for (const record of this.modelBuffer) {
      this.appendJsonl("model-calls.jsonl", record);
    }
    for (const record of this.toolBuffer) {
      this.appendJsonl("tool-calls.jsonl", record);
    }
    this.logBuffer = [];
    this.eventBuffer = [];
    this.modelBuffer = [];
    this.toolBuffer = [];
  }

  private appendJsonl(relPath: string, data: unknown): void {
    if (!this.runDirectory) {
      return;
    }
    appendFileSync(path.join(this.runDirectory, relPath), `${serialize(data)}\n`);
  }

  private writeJson(relPath: string, data: unknown): void {
    if (!this.runDirectory) {
      return;
    }
    const absolutePath = path.join(this.runDirectory, relPath);
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    const tmpPath = `${absolutePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmpPath, `${serialize(data, 2)}\n`);
    renameSync(tmpPath, absolutePath);
  }

  private writeText(relPath: string, data: string): void {
    if (!this.runDirectory) {
      return;
    }
    const absolutePath = path.join(this.runDirectory, relPath);
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    const tmpPath = `${absolutePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmpPath, data.endsWith("\n") ? data : `${data}\n`);
    renameSync(tmpPath, absolutePath);
  }

  private updateModelSummary(record: LlmCallRecord): void {
    const providerCallCount = record.cacheStatus === "hit" ? 0 : 1;
    this.modelSummary.totalRecords += 1;
    this.modelSummary.totalCalls += providerCallCount;
    this.modelSummary.providerCalls += providerCallCount;
    if (providerCallCount > 0) {
      this.modelSummary.inputTokens += record.inputTokens ?? 0;
      this.modelSummary.uncachedInputTokens += record.uncachedInputTokens ?? 0;
      this.modelSummary.cacheReadTokens += record.cacheReadTokens ?? 0;
      this.modelSummary.cacheWriteTokens += record.cacheWriteTokens ?? 0;
      this.modelSummary.billableInputTokens += record.billableInputTokens ?? 0;
      this.modelSummary.outputTokens += record.outputTokens ?? 0;
      this.modelSummary.totalTokens += record.totalTokens ?? 0;
    }
    this.modelSummary.cache[record.cacheStatus] += 1;
    this.modelSummary.retryAttempts += providerCallCount > 0 && record.attempt > 1 ? 1 : 0;
    this.modelSummary.repairCalls += record.kind === "repair" ? 1 : 0;
    this.modelSummary.schemaInvalidCalls += record.status === "schema_invalid" ? 1 : 0;
    if (providerCallCount === 0) {
      // Cache-hit records carry stored usage for visibility, but do not consume provider budgets.
    } else if (record.costUSD === undefined) {
      this.modelSummary.unknownCostCalls += 1;
    } else {
      this.modelSummary.costUSD += record.costUSD;
      this.modelSummary.inputCostUSD += record.inputCostUSD ?? 0;
      this.modelSummary.outputCostUSD += record.outputCostUSD ?? 0;
      this.modelSummary.cacheReadCostUSD += record.cacheReadCostUSD ?? 0;
      this.modelSummary.cacheWriteCostUSD += record.cacheWriteCostUSD ?? 0;
    }

    const stage = String(record.stage);
    const bucket =
      this.modelSummary.byStage[stage] ??
      (this.modelSummary.byStage[stage] = emptyModelStageSummary());
    bucket.recordCount += 1;
    bucket.count += providerCallCount;
    bucket.providerCalls += providerCallCount;
    if (providerCallCount > 0) {
      bucket.inputTokens += record.inputTokens ?? 0;
      bucket.uncachedInputTokens += record.uncachedInputTokens ?? 0;
      bucket.cacheReadTokens += record.cacheReadTokens ?? 0;
      bucket.cacheWriteTokens += record.cacheWriteTokens ?? 0;
      bucket.billableInputTokens += record.billableInputTokens ?? 0;
      bucket.outputTokens += record.outputTokens ?? 0;
      bucket.totalTokens += record.totalTokens ?? 0;
    }
    bucket.cache[record.cacheStatus] += 1;
    bucket.retryAttempts += providerCallCount > 0 && record.attempt > 1 ? 1 : 0;
    bucket.repairCalls += record.kind === "repair" ? 1 : 0;
    bucket.schemaInvalidCalls += record.status === "schema_invalid" ? 1 : 0;
    bucket.statuses[record.status] += 1;
    if (providerCallCount === 0) {
      return;
    }
    if (record.costUSD === undefined) {
      bucket.unknownCostCalls += 1;
    } else {
      bucket.costUSD += record.costUSD;
      bucket.inputCostUSD += record.inputCostUSD ?? 0;
      bucket.outputCostUSD += record.outputCostUSD ?? 0;
      bucket.cacheReadCostUSD += record.cacheReadCostUSD ?? 0;
      bucket.cacheWriteCostUSD += record.cacheWriteCostUSD ?? 0;
    }
  }

  private updateToolSummary(record: ToolCallRecord): void {
    this.toolSummary.totalCalls += 1;
    updateToolBucket(
      this.toolSummary.byTool[record.tool] ??
        (this.toolSummary.byTool[record.tool] = emptyToolBucket()),
      record
    );
    const stage = String(record.stage);
    updateToolBucket(
      this.toolSummary.byStage[stage] ??
        (this.toolSummary.byStage[stage] = emptyToolBucket()),
      record
    );
  }

  private updateModelSummaryFromCacheEvent(event: TelemetryEvent): void {
    if (event.cacheStatus !== "write" || event.message !== "model_call_cache_write") {
      return;
    }
    this.modelSummary.cache.write += 1;
    const stage = String(event.stage);
    const bucket =
      this.modelSummary.byStage[stage] ??
      (this.modelSummary.byStage[stage] = emptyModelStageSummary());
    bucket.cache.write += 1;
  }

  private finalToolSummary(): unknown {
    return {
      totalCalls: this.toolSummary.totalCalls,
      byTool: averageToolBuckets(this.toolSummary.byTool),
      byStage: averageToolBuckets(this.toolSummary.byStage)
    };
  }

  private finalModelSummary(): unknown {
    const byStage = Object.fromEntries(
      Object.entries(this.modelSummary.byStage).map(([stage, bucket]) => [
        stage,
        withCacheAliases(bucket)
      ])
    );
    return {
      ...this.modelSummary,
      localModelCallCache: copyCacheCounts(this.modelSummary.cache),
      providerPromptCache: providerPromptCacheSummary(this.modelSummary),
      byStage
    };
  }

  private costProfile(): unknown {
    const byStage = Object.fromEntries(
      Object.entries(this.modelSummary.byStage).map(([stage, bucket]) => [
        stage,
        {
          ...withCacheAliases(bucket),
          costBreakdown: costBreakdownSummary(bucket)
        }
      ])
    );
    return {
      totalCostUSD: this.modelSummary.costUSD,
      unknownCostCalls: this.modelSummary.unknownCostCalls,
      localModelCallCache: copyCacheCounts(this.modelSummary.cache),
      providerPromptCache: providerPromptCacheSummary(this.modelSummary),
      costBreakdown: costBreakdownSummary(this.modelSummary),
      tokens: {
        inputTokens: this.modelSummary.inputTokens,
        uncachedInputTokens: this.modelSummary.uncachedInputTokens,
        cacheReadTokens: this.modelSummary.cacheReadTokens,
        cacheWriteTokens: this.modelSummary.cacheWriteTokens,
        billableInputTokens: this.modelSummary.billableInputTokens,
        outputTokens: this.modelSummary.outputTokens,
        totalTokens: this.modelSummary.totalTokens
      },
      cost: {
        inputCostUSD: this.modelSummary.inputCostUSD,
        outputCostUSD: this.modelSummary.outputCostUSD,
        cacheReadCostUSD: this.modelSummary.cacheReadCostUSD,
        cacheWriteCostUSD: this.modelSummary.cacheWriteCostUSD,
        totalCostUSD: this.modelSummary.costUSD
      },
      byStage
    };
  }

  private updateTelemetrySummary(event: TelemetryEvent): void {
    this.telemetrySummary.events += 1;
    this.telemetrySummary.levels[event.level] += 1;
    if (event.cacheStatus !== undefined) {
      this.telemetrySummary.cache[event.cacheStatus] += 1;
    }

    const stage = String(event.stage);
    const bucket =
      this.telemetrySummary.byStage[stage] ??
      (this.telemetrySummary.byStage[stage] = emptyTelemetryStageSummary());
    bucket.events += 1;
    bucket.levels[event.level] += 1;
    if (event.cacheStatus !== undefined) {
      bucket.cache[event.cacheStatus] += 1;
    }
    if (event.message === "stage_started" && bucket.startedAt === undefined) {
      bucket.startedAt = event.timestamp;
    }
    if (event.message === "stage_completed") {
      bucket.completedAt = event.timestamp;
      if (bucket.startedAt !== undefined) {
        bucket.runtimeMs += durationBetween(bucket.startedAt, event.timestamp);
      }
    }
  }

  private runTotals(): unknown {
    return {
      events: this.eventSeq,
      modelCallRecords: this.modelSummary.totalRecords,
      modelCalls: this.modelSummary.providerCalls,
      providerCalls: this.modelSummary.providerCalls,
      toolCalls: this.toolSummary.totalCalls,
      inputTokens: this.modelSummary.inputTokens,
      uncachedInputTokens: this.modelSummary.uncachedInputTokens,
      cacheReadTokens: this.modelSummary.cacheReadTokens,
      cacheWriteTokens: this.modelSummary.cacheWriteTokens,
      billableInputTokens: this.modelSummary.billableInputTokens,
      outputTokens: this.modelSummary.outputTokens,
      totalTokens: this.modelSummary.totalTokens,
      totalCostUSD: this.modelSummary.costUSD,
      inputCostUSD: this.modelSummary.inputCostUSD,
      outputCostUSD: this.modelSummary.outputCostUSD,
      cacheReadCostUSD: this.modelSummary.cacheReadCostUSD,
      cacheWriteCostUSD: this.modelSummary.cacheWriteCostUSD,
      costBreakdown: costBreakdownSummary(this.modelSummary),
      unknownCostCalls: this.modelSummary.unknownCostCalls,
      cache: this.modelSummary.cache,
      localModelCallCache: copyCacheCounts(this.modelSummary.cache),
      providerPromptCache: providerPromptCacheSummary(this.modelSummary),
      retryAttempts: this.modelSummary.retryAttempts,
      repairCalls: this.modelSummary.repairCalls,
      schemaInvalidCalls: this.modelSummary.schemaInvalidCalls,
      logOverflow: this.logOverflow,
      ...this.pipelineTotals
    };
  }

  private updatePipelineSummaryFromEvent(event: TelemetryEvent): void {
    if (event.message !== "pipeline_metrics" || !event.data || typeof event.data !== "object") {
      return;
    }
    const data = event.data as Record<string, unknown>;
    mergePipelineTotals(this.pipelineTotals, objectField(data.totals));
    mergePipelineWorkers(this.pipelineSummary.workers, objectField(data.workers));
    mergePipelinePackets(this.pipelineSummary.packets, objectField(data.packets));
    mergePipelineLenses(this.pipelineSummary.lenses, objectField(data.lenses));
    mergePipelineCoverage(this.pipelineSummary.coverage, objectField(data.coverage));
    mergePipelineCandidates(this.pipelineSummary.candidates, objectField(data.candidates));
    mergePipelineVerdicts(this.pipelineSummary.verdicts, objectField(data.verdicts));
    mergePipelineDedup(this.pipelineSummary.dedup, objectField(data.dedup));
    mergePipelineFinalSelection(this.pipelineSummary.finalSelection, objectField(data.finalSelection));
    mergePipelinePosting(this.pipelineSummary.posting, objectField(data.posting));
  }

  private runReviewMetadata(): RunReviewArtifactMetadata {
    const review = this.metadata.review ?? {};
    return {
      mode: review.mode ?? "unknown",
      target: review.target ?? null,
      prNumber: review.prNumber ?? null,
      baseRef: review.baseRef ?? null,
      headRef: review.headRef ?? null,
      baseSha: review.baseSha ?? null,
      headSha: review.headSha ?? null,
      depth: review.depth ?? null,
      budgetMultiplier: review.budgetMultiplier ?? null,
      lenses: review.lenses ?? [],
      format: review.format ?? null,
      postGithubComments: review.postGithubComments ?? false
    };
  }

  private allStageSummaries(): Record<string, TelemetryStageSummary> {
    const stages: Record<string, TelemetryStageSummary> = {};
    for (const stage of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) {
      stages[String(stage)] = {
        ...emptyTelemetryStageSummary(),
        ...(this.telemetrySummary.byStage[String(stage)] ?? {})
      };
    }
    return stages;
  }

  private recordPruneResult(result: PruneResult): void {
    if (result.deleted.length > 0) {
      this.recordEvent({
        stage: 0,
        level: "info",
        message: "old run directories pruned",
        data: { count: result.deleted.length, runs: result.deleted.map((dir) => path.basename(dir)) }
      });
    }

    for (const failure of result.failures) {
      this.logger.warn({
        runId: this.runId,
        stage: 0,
        event: "run_prune_failed",
        message: `failed to prune old run directory ${path.basename(failure.path)}`,
        data: { path: failure.path, error: failure.error }
      });
      this.recordEvent({
        stage: 0,
        level: "warn",
        message: "failed to prune old run directory",
        data: { path: failure.path, error: failure.error }
      });
    }
  }
}

type ToolBucket = {
  count: number;
  errors: number;
  rejections: number;
  degraded: number;
  totalDurationMs: number;
  totalResultChars: number;
};

function emptyCacheCounts(): CacheCounts {
  return {
    hit: 0,
    miss: 0,
    disabled: 0,
    write: 0
  };
}

function copyCacheCounts(cache: CacheCounts): CacheCounts {
  return {
    hit: cache.hit,
    miss: cache.miss,
    disabled: cache.disabled,
    write: cache.write
  };
}

function providerPromptCacheSummary(source: ProviderPromptCacheSource): ProviderPromptCacheSummary {
  return {
    readTokens: source.cacheReadTokens,
    writeTokens: source.cacheWriteTokens,
    readCostUSD: source.cacheReadCostUSD,
    writeCostUSD: source.cacheWriteCostUSD
  };
}

function costBreakdownSummary(source: CostBreakdownSource): CostBreakdownSummary {
  return {
    uncachedInput: {
      tokens: source.uncachedInputTokens,
      costUSD: source.inputCostUSD
    },
    providerPromptCacheRead: {
      tokens: source.cacheReadTokens,
      costUSD: source.cacheReadCostUSD
    },
    providerPromptCacheWrite: {
      tokens: source.cacheWriteTokens,
      costUSD: source.cacheWriteCostUSD
    },
    output: {
      tokens: source.outputTokens,
      costUSD: source.outputCostUSD
    },
    total: {
      tokens: source.totalTokens,
      costUSD: source.costUSD
    }
  };
}

function withCacheAliases<T extends ProviderPromptCacheSource & { cache: CacheCounts }>(summary: T): T & {
  localModelCallCache: CacheCounts;
  providerPromptCache: ProviderPromptCacheSummary;
} {
  return {
    ...summary,
    localModelCallCache: copyCacheCounts(summary.cache),
    providerPromptCache: providerPromptCacheSummary(summary)
  };
}

function emptyLevelCounts(): Record<LogLevel, number> {
  return {
    debug: 0,
    info: 0,
    warn: 0,
    error: 0
  };
}

function emptyModelStatusCounts(): ModelStatusCounts {
  return {
    ok: 0,
    schema_invalid: 0,
    transient_error: 0,
    auth_error: 0,
    timeout: 0,
    aborted: 0
  };
}

function emptyModelStageSummary(): ModelStageSummary {
  return {
    recordCount: 0,
    count: 0,
    providerCalls: 0,
    inputTokens: 0,
    uncachedInputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    billableInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUSD: 0,
    inputCostUSD: 0,
    outputCostUSD: 0,
    cacheReadCostUSD: 0,
    cacheWriteCostUSD: 0,
    unknownCostCalls: 0,
    cache: emptyCacheCounts(),
    retryAttempts: 0,
    repairCalls: 0,
    schemaInvalidCalls: 0,
    statuses: emptyModelStatusCounts()
  };
}

function emptyPipelineTotals(): PipelineTotals {
  return {
    filesChanged: 0,
    hunks: 0,
    packets: 0,
    packetReviews: 0,
    candidates: 0,
    verified: 0,
    finalFindings: 0,
    postedComments: 0
  };
}

function emptyPipelineTelemetrySummary(): PipelineTelemetrySummary {
  return {
    workers: {
      started: 0,
      completed: 0,
      failed: 0,
      retried: 0,
      timedOut: 0
    },
    packets: {
      generated: 0,
      reviewed: 0,
      failed: 0,
      degraded: 0
    },
    lenses: {
      selected: 0,
      byLens: {}
    },
    coverage: {
      byLevel: {
        deep: 0,
        normal: 0,
        light: 0,
        skip: 0
      },
      hunks: {
        total: 0,
        reviewed: 0,
        skipped: 0,
        failed: 0,
        degraded: 0
      }
    },
    candidates: {
      generated: 0,
      gateRejected: 0,
      verificationScheduled: 0,
      verificationBudgetLimited: 0,
      clusteredDuplicates: 0,
      verificationRepresentatives: 0,
      lowConfidenceSuppressed: 0,
      lowConfidenceEvidenceEligible: 0,
      lowConfidenceEvidenceScheduled: 0,
      lowConfidenceEvidenceLaneLimited: 0,
      lowConfidenceEvidenceKept: 0,
      lowConfidenceEvidenceRejected: 0,
      lowConfidenceEvidenceIncomplete: 0
    },
    verdicts: {
      accept: 0,
      revise: 0,
      reject: 0,
      incomplete: 0
    },
    dedup: {
      clusters: 0,
      duplicates: 0,
      suppressed: 0
    },
    finalSelection: {
      published: 0,
      merged: 0,
      suppressed: 0,
      finalFindings: 0
    },
    posting: {
      attempted: 0,
      postedComments: 0,
      skippedDuplicates: 0,
      failed: 0
    }
  };
}

function emptyTelemetryStageSummary(): TelemetryStageSummary {
  return {
    events: 0,
    levels: emptyLevelCounts(),
    cache: emptyCacheCounts(),
    runtimeMs: 0
  };
}

function emptyToolBucket(): ToolBucket {
  return {
    count: 0,
    errors: 0,
    rejections: 0,
    degraded: 0,
    totalDurationMs: 0,
    totalResultChars: 0
  };
}

function updateToolBucket(bucket: ToolBucket, record: ToolCallRecord): void {
  bucket.count += 1;
  bucket.errors += record.status === "error" ? 1 : 0;
  bucket.rejections += record.status === "rejected" ? 1 : 0;
  bucket.degraded += record.degraded ? 1 : 0;
  bucket.totalDurationMs += record.durationMs;
  bucket.totalResultChars += record.resultChars;
}

function averageToolBuckets(buckets: Record<string, ToolBucket>): Record<string, ToolBucket & { averageDurationMs: number; averageResultChars: number }> {
  const output: Record<string, ToolBucket & { averageDurationMs: number; averageResultChars: number }> = {};
  for (const [key, bucket] of Object.entries(buckets)) {
    output[key] = {
      ...bucket,
      averageDurationMs: bucket.count === 0 ? 0 : bucket.totalDurationMs / bucket.count,
      averageResultChars: bucket.count === 0 ? 0 : bucket.totalResultChars / bucket.count
    };
  }
  return output;
}

function mergePipelineTotals(target: PipelineTotals, source: Record<string, unknown> | undefined): void {
  if (!source) {
    return;
  }
  setNumber(target, "filesChanged", source.filesChanged);
  setNumber(target, "hunks", source.hunks);
  setNumber(target, "packets", source.packets);
  setNumber(target, "packetReviews", source.packetReviews);
  setNumber(target, "candidates", source.candidates);
  setNumber(target, "verified", source.verified);
  setNumber(target, "finalFindings", source.finalFindings);
  setNumber(target, "postedComments", source.postedComments);
}

function mergePipelineWorkers(target: PipelineTelemetrySummary["workers"], source: Record<string, unknown> | undefined): void {
  if (!source) {
    return;
  }
  addNumber(target, "started", source.started);
  addNumber(target, "completed", source.completed);
  addNumber(target, "failed", source.failed);
  addNumber(target, "retried", source.retried);
  addNumber(target, "timedOut", source.timedOut);
}

function mergePipelinePackets(target: PipelineTelemetrySummary["packets"], source: Record<string, unknown> | undefined): void {
  if (!source) {
    return;
  }
  setNumber(target, "generated", source.generated);
  setNumber(target, "reviewed", source.reviewed);
  setNumber(target, "failed", source.failed);
  setNumber(target, "degraded", source.degraded);
}

function mergePipelineLenses(target: PipelineTelemetrySummary["lenses"], source: Record<string, unknown> | undefined): void {
  if (!source) {
    return;
  }
  if (typeof source.selected === "number" && Number.isFinite(source.selected)) {
    target.selected = source.selected;
  }
  const byLens = objectField(source.byLens);
  if (!byLens) {
    return;
  }
  for (const [lens, count] of Object.entries(byLens)) {
    if (typeof count === "number" && Number.isFinite(count)) {
      target.byLens[lens] = count;
    }
  }
}

function mergePipelineCoverage(target: PipelineTelemetrySummary["coverage"], source: Record<string, unknown> | undefined): void {
  if (!source) {
    return;
  }
  const byLevel = objectField(source.byLevel);
  if (byLevel) {
    setNumber(target.byLevel, "deep", byLevel.deep);
    setNumber(target.byLevel, "normal", byLevel.normal);
    setNumber(target.byLevel, "light", byLevel.light);
    setNumber(target.byLevel, "skip", byLevel.skip);
  }
  const hunks = objectField(source.hunks);
  if (hunks) {
    setNumber(target.hunks, "total", hunks.total);
    setNumber(target.hunks, "reviewed", hunks.reviewed);
    setNumber(target.hunks, "skipped", hunks.skipped);
    setNumber(target.hunks, "failed", hunks.failed);
    setNumber(target.hunks, "degraded", hunks.degraded);
  }
}

function mergePipelineCandidates(target: PipelineTelemetrySummary["candidates"], source: Record<string, unknown> | undefined): void {
  if (!source) {
    return;
  }
  setNumber(target, "generated", source.generated);
  setNumber(target, "gateRejected", source.gateRejected);
  setNumber(target, "verificationScheduled", source.verificationScheduled);
  setNumber(target, "verificationBudgetLimited", source.verificationBudgetLimited);
  setNumber(target, "clusteredDuplicates", source.clusteredDuplicates);
  setNumber(target, "verificationRepresentatives", source.verificationRepresentatives);
  setNumber(target, "lowConfidenceSuppressed", source.lowConfidenceSuppressed);
  setNumber(target, "lowConfidenceEvidenceEligible", source.lowConfidenceEvidenceEligible);
  setNumber(target, "lowConfidenceEvidenceScheduled", source.lowConfidenceEvidenceScheduled);
  setNumber(target, "lowConfidenceEvidenceLaneLimited", source.lowConfidenceEvidenceLaneLimited);
  setNumber(target, "lowConfidenceEvidenceKept", source.lowConfidenceEvidenceKept);
  setNumber(target, "lowConfidenceEvidenceRejected", source.lowConfidenceEvidenceRejected);
  setNumber(target, "lowConfidenceEvidenceIncomplete", source.lowConfidenceEvidenceIncomplete);
}

function mergePipelineVerdicts(target: PipelineTelemetrySummary["verdicts"], source: Record<string, unknown> | undefined): void {
  if (!source) {
    return;
  }
  setNumber(target, "accept", source.accept);
  setNumber(target, "revise", source.revise);
  setNumber(target, "reject", source.reject);
  setNumber(target, "incomplete", source.incomplete);
}

function mergePipelineDedup(target: PipelineTelemetrySummary["dedup"], source: Record<string, unknown> | undefined): void {
  if (!source) {
    return;
  }
  setNumber(target, "clusters", source.clusters);
  setNumber(target, "duplicates", source.duplicates);
  setNumber(target, "suppressed", source.suppressed);
}

function mergePipelineFinalSelection(target: PipelineTelemetrySummary["finalSelection"], source: Record<string, unknown> | undefined): void {
  if (!source) {
    return;
  }
  setNumber(target, "published", source.published);
  setNumber(target, "merged", source.merged);
  setNumber(target, "suppressed", source.suppressed);
  setNumber(target, "finalFindings", source.finalFindings);
}

function mergePipelinePosting(target: PipelineTelemetrySummary["posting"], source: Record<string, unknown> | undefined): void {
  if (!source) {
    return;
  }
  setNumber(target, "attempted", source.attempted);
  setNumber(target, "postedComments", source.postedComments);
  setNumber(target, "skippedDuplicates", source.skippedDuplicates);
  setNumber(target, "failed", source.failed);
}

function objectField(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function setNumber(target: Record<string, number>, key: string, value: unknown): void {
  if (typeof value === "number" && Number.isFinite(value)) {
    target[key] = value;
  }
}

function addNumber(target: Record<string, number>, key: string, value: unknown): void {
  if (typeof value === "number" && Number.isFinite(value)) {
    target[key] = (target[key] ?? 0) + value;
  }
}

function resolveRunRoot(repoRoot: string, runDir: string): string {
  return path.isAbsolute(runDir) ? runDir : path.resolve(repoRoot, runDir);
}

function provisionProjectGitignore(repoRoot: string, runsRoot: string): void {
  const codeninjaDir = path.resolve(repoRoot, ".codeninja");
  if (!isPathInside(codeninjaDir, runsRoot) && path.resolve(runsRoot) !== path.join(codeninjaDir, "runs")) {
    return;
  }

  provisionCodeninjaGitignore(repoRoot);
}

export function provisionCodeninjaGitignore(repoRoot: string): void {
  const codeninjaDir = path.resolve(repoRoot, ".codeninja");
  const codeninjaDirExisted = existsSync(codeninjaDir);
  mkdirSync(codeninjaDir, { recursive: true });
  const gitignorePath = path.join(codeninjaDir, ".gitignore");
  const required = ["runs/", "cache/", "locks/"];
  const existing = codeninjaDirExisted && existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
  const lines = new Set(existing.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.length > 0));
  let changed = !existsSync(gitignorePath);
  for (const requiredLine of required) {
    if (!lines.has(requiredLine)) {
      lines.add(requiredLine);
      changed = true;
    }
  }
  if (!changed) {
    return;
  }
  writeFileSync(gitignorePath, `${[...lines].join("\n")}\n`);
}

type PruneResult = {
  deleted: string[];
  failures: Array<{ path: string; error: string }>;
};

function pruneRuns(runsRoot: string, activeRunDir: string, retainRuns: number): PruneResult {
  const result: PruneResult = { deleted: [], failures: [] };
  const keepCount = Math.max(1, retainRuns);

  let names: string[];
  try {
    names = readdirSync(runsRoot);
  } catch (error) {
    result.failures.push({ path: runsRoot, error: errorMessage(error) });
    return result;
  }

  const dirs = names
    .map((name) => {
      const entry = path.join(runsRoot, name);
      try {
        const stats = statSync(entry);
        return stats.isDirectory() && existsSync(path.join(entry, "run.json")) ? { path: entry, mtimeMs: stats.mtimeMs } : undefined;
      } catch (error) {
        result.failures.push({ path: entry, error: errorMessage(error) });
        return undefined;
      }
    })
    .filter((entry): entry is { path: string; mtimeMs: number } => entry !== undefined)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const dir of dirs.slice(keepCount)) {
    if (path.resolve(dir.path) !== path.resolve(activeRunDir)) {
      try {
        rmSync(dir.path, { recursive: true, force: true });
        result.deleted.push(dir.path);
      } catch (error) {
        result.failures.push({ path: dir.path, error: errorMessage(error) });
      }
    }
  }

  return result;
}

function touchCoreFiles(runDir: string): void {
  for (const relPath of ["run.log", "events.jsonl", "model-calls.jsonl", "tool-calls.jsonl"]) {
    const filePath = path.join(runDir, relPath);
    if (!existsSync(filePath)) {
      writeFileSync(filePath, "");
    }
  }
}

function assertAllowedArtifactPath(relPath: string): void {
  const normalized = relPath.split(path.sep).join("/");
  if (KNOWN_ARTIFACTS.has(normalized) || /^packets\/[^/]+\.json$/.test(normalized)) {
    return;
  }
  throw new Error(`unknown run artifact path: ${relPath}`);
}

function eventLogData(event: TelemetryEvent): Record<string, unknown> | undefined {
  const output: Record<string, unknown> = {};
  if (event.eventId !== undefined) {
    output.eventId = event.eventId;
  }
  if (event.durationMs !== undefined) {
    output.durationMs = event.durationMs;
  }
  if (event.cacheStatus !== undefined) {
    output.cacheStatus = event.cacheStatus;
  }
  if (event.lineRange !== undefined) {
    output.lineRange = event.lineRange;
  }
  if (event.data !== undefined) {
    Object.assign(output, event.data);
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

function capTelemetryEventData(event: TelemetryEvent): TelemetryEvent {
  if (!event.data) {
    return event;
  }
  const serialized = JSON.stringify(event.data);
  if (serialized.length <= 16 * 1024) {
    return event;
  }
  return {
    ...event,
    data: { truncated: true, chars: serialized.length }
  };
}

function trimBufferedLogs(logs: LogEvent[]): { logs: LogEvent[]; droppedDebugInfo: number; droppedWarnError: number } {
  const capacity = 1000;
  const indexed = logs.map((event, index) => ({ event, index }));
  const highPriority = indexed.filter(({ event }) => event.level === "warn" || event.level === "error");
  const lowerPriority = indexed.filter(({ event }) => event.level !== "warn" && event.level !== "error");

  if (highPriority.length >= capacity) {
    return {
      logs: highPriority.slice(-capacity).map(({ event }) => event),
      droppedDebugInfo: lowerPriority.length,
      droppedWarnError: highPriority.length - capacity
    };
  }

  const lowerToKeep = capacity - highPriority.length;
  const kept = [...highPriority, ...lowerPriority.slice(-lowerToKeep)].sort((a, b) => a.index - b.index);
  return {
    logs: kept.map(({ event }) => event),
    droppedDebugInfo: lowerPriority.length - Math.min(lowerPriority.length, lowerToKeep),
    droppedWarnError: 0
  };
}

function createRunId(date: Date): string {
  const yyyy = String(date.getUTCFullYear());
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mi = String(date.getUTCMinutes()).padStart(2, "0");
  const ss = String(date.getUTCSeconds()).padStart(2, "0");
  return `${yyyy}${mm}${dd}-${hh}${mi}${ss}-${randomBytes(4).toString("hex")}`;
}

function serialize(data: unknown, space?: number): string {
  return JSON.stringify(canonicalize(stripCredentials(data)), null, space);
}

function durationBetween(startIso: string, endIso: string): number {
  return Math.max(0, Date.parse(endIso) - Date.parse(startIso));
}

function normalizeOutcome(outcome: RunOutcome): {
  status: RunOutcome["status"];
  errorCode: RunOutcome["errorCode"] | null;
  exitCode: number;
  budgetStop: RunOutcome["budgetStop"] | null;
} {
  return {
    status: outcome.status,
    errorCode: outcome.errorCode ?? null,
    exitCode: outcome.exitCode,
    budgetStop: outcome.budgetStop ?? null
  };
}

function readCodeninjaVersion(): string {
  let currentDir = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    const packageJsonPath = path.join(currentDir, "package.json");
    if (existsSync(packageJsonPath)) {
      try {
        const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: unknown };
        if (typeof parsed.version === "string") {
          return parsed.version;
        }
      } catch {
        return "unknown";
      }
    }

    const parent = path.dirname(currentDir);
    if (parent === currentDir) {
      break;
    }
    currentDir = parent;
  }

  return process.env.npm_package_version ?? "unknown";
}

function canonicalize(input: unknown): unknown {
  if (Array.isArray(input)) {
    return input.map((item) => canonicalize(item));
  }

  if (input && typeof input === "object") {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort()) {
      const value = (input as Record<string, unknown>)[key];
      if (value !== undefined) {
        output[key] = canonicalize(value);
      }
    }
    return output;
  }

  return input;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
