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
import type {
  CodegenieConfig,
  ContextPressureSummary,
  LogEvent,
  Logger,
  LogLevel,
  ReviewStage,
  RunOutcome,
  TelemetryEvent,
  ToolCallRecord
} from "../types.js";
import type { LlmCallRecord, TelemetryRecorder } from "./telemetry-recorder.js";
import { stripCredentials } from "./redaction.js";
import { isLocalToolBudgetRejectionReason } from "../util/context-pressure.js";
import { resolveCodegenieRuntimeProvenance } from "../util/runtime-provenance.js";
import { STAGE_LABELS, STAGES } from "../review-stages.js";

type CreateRunTelemetryOptions = {
  telemetryConfig: CodegenieConfig["telemetry"];
  runMetadata?: RunArtifactMetadata;
  clock?: () => Date;
  idFactory?: () => string;
  directoryNameFactory?: () => string;
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

export const ARTIFACT_LOCATION = {
  "error.json": "stages/00-run/error.json",
  "cost-profile.json": "stages/00-run/cost-profile.json",
  "model-calls-summary.json": "stages/00-run/model-calls-summary.json",
  "tool-calls-summary.json": "stages/00-run/tool-calls-summary.json",
  "resolved-input.json": "stages/01-input/resolved-input.json",
  "diff.json": "stages/02-diff/diff.json",
  "file-filter-decisions.json": "stages/02-diff/file-filter-decisions.json",
  "file-facts.json": "stages/03-classify/file-facts.json",
  "intent-signals.json": "stages/05-planner/intent-signals.json",
  "planner-dossier.json": "stages/05-planner/planner-dossier.json",
  "planner-dossier-chunks.json": "stages/05-planner/planner-dossier-chunks.json",
  "review-plan.json": "stages/05-planner/review-plan.json",
  "hunk-relationships.json": "stages/06-packets/hunk-relationships.json",
  "system-review-raw-tasks.json": "stages/08-followups/system-review-raw-tasks.json",
  "system-review-tasks.json": "stages/08-followups/system-review-tasks.json",
  "system-review-results.json": "stages/08-followups/system-review-results.json",
  "candidate-findings.json": "stages/09-verification/candidate-findings.json",
  "uncertainty-promotion.json": "stages/09-verification/uncertainty-promotion.json",
  "verification.json": "stages/09-verification/verification.json",
  "attention.json": "stages/10-composition/attention.json",
  "coverage.json": "stages/10-composition/coverage.json",
  "budget-summary.json": "stages/10-composition/budget-summary.json",
  "final-selection.json": "stages/10-composition/final-selection.json",
  "human-attention-notes.json": "stages/10-composition/human-attention-notes.json",
  "final-findings.json": "stages/10-composition/final-findings.json",
  "github-posting.json": "stages/11-github-posting/github-posting.json",
  "final-review.md": "final-review.md",
  "run.json": "run.json",
  "telemetry.json": "telemetry.json",
  "artifact-manifest.json": "artifact-manifest.json"
} as const;

export type LogicalArtifactName = keyof typeof ARTIFACT_LOCATION;

export const KNOWN_ARTIFACTS = new Set(Object.keys(ARTIFACT_LOCATION));

const ROOT_STREAM_ARTIFACTS = ["run.log", "events.jsonl", "model-calls.jsonl", "tool-calls.jsonl"] as const;
const PACKET_ARTIFACT_RE = /^packets\/[^/]+\.json$/u;
const CANONICAL_PACKET_ARTIFACT_RE = /^stages\/06-packets\/packets\/[^/]+\.json$/u;
const CANONICAL_ARTIFACT_PATHS: ReadonlySet<string> = new Set(Object.values(ARTIFACT_LOCATION));

type CacheCounts = Record<"hit" | "miss" | "disabled" | "write", number>;
type ModelStatusCounts = Record<LlmCallRecord["status"], number>;
type FinalArgumentStateCounts = Record<NonNullable<LlmCallRecord["finalArgumentState"]>, number>;
type FinalArgumentErrorKindCounts = Record<NonNullable<LlmCallRecord["finalArgumentErrorKind"]>, number>;
type FinalArgumentOutcomeCounts = Record<"recovered" | "terminal_invalid" | "not_dispatched", number>;
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
  reasoningTokens: number;
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
  finalize: ModelFinalizeSummary;
};

type SchemaRecoveryCounters = {
  schemaInvalidCalls: number;
  schemaInvalidRecovered: number;
  schemaInvalidUnrecovered: number;
  schemaRepairAttempts: number;
  schemaRepairRecovered: number;
  deterministicSchemaRecovered: number;
  schemaRecoveryFailed: number;
};

type SchemaRecoverySummary = SchemaRecoveryCounters & {
  byStage: Record<string, SchemaRecoveryCounters>;
};

type ModelFinalizeSummary = {
  compactCalls: number;
  fullCalls: number;
  noFindingCalls: number;
  candidateOrUnknownCalls: number;
  promptChars: number;
  noFindingPromptChars: number;
  candidateOrUnknownPromptChars: number;
  costUSD: number;
  noFindingCostUSD: number;
  candidateOrUnknownCostUSD: number;
  unknownCostCalls: number;
};

type ToolResultCacheSummary = {
  hits: number;
  misses: number;
  writes: number;
  disabled: number;
  inflightHits: number;
  evictions: number;
  backendExecutions: number;
  savedBackendCalls: number;
};

type TelemetryStageSummary = {
  events: number;
  levels: Record<LogLevel, number>;
  cache: CacheCounts;
  startedAt?: string;
  completedAt?: string;
  runtimeMs: number;
  schemaRecovery: SchemaRecoveryCounters;
};

type Stage7SchemaRepairSummary = {
  candidateInvalidSubmits: number;
  noFindingInvalidSubmits: number;
  cleanupAttempted: number;
  cleanupRecovered: number;
  cleanupRejected: number;
  compactRepairScheduled: number;
  appendRepairScheduled: number;
  repairRecovered: number;
  repairFailed: number;
  repairPromptChars: number;
  compactRepairPromptChars: number;
  appendRepairPromptChars: number;
  actualRepairCalls: number;
  actualRepairPromptChars: number;
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
    concurrency?: number;
    budgetBoost?: number;
    llmMaxConcurrentCalls?: number;
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
  concurrency: number | null;
  budgetBoost: number | null;
  llmMaxConcurrentCalls: number | null;
  lenses: string[];
  format: string | null;
  postGithubComments: boolean;
};

type ArtifactKind = "json" | "jsonl" | "markdown" | "text";

type ArtifactManifestEntry = {
  id: string;
  stage: ReviewStage | 0;
  stageName: string;
  kind: ArtifactKind;
  path: string;
};

type ArtifactManifest = {
  schemaVersion: 1;
  layoutVersion: 2;
  generatedAt: string;
  artifacts: ArtifactManifestEntry[];
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
    compositionMode: string | null;
    fallbackReason: string | null;
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
  private readonly directoryName: string;
  private readonly startedAt: string;
  private readonly clock: () => Date;
  private readonly config: CodegenieConfig["telemetry"];
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
    reasoningTokens: 0,
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
    finalArgumentStates: emptyFinalArgumentStateCounts(),
    finalArgumentErrorKinds: emptyFinalArgumentErrorKindCounts(),
    finalArgumentOutcomes: { recovered: 0, terminal_invalid: 0, not_dispatched: 0 } as FinalArgumentOutcomeCounts,
    toolChoiceDowngradedCalls: 0,
    finalize: emptyModelFinalizeSummary(),
    byStage: {} as Record<string, ModelStageSummary>
  };
  private toolSummary = {
    totalCalls: 0,
    resultCache: emptyToolResultCacheSummary(),
    byTool: {} as Record<string, ToolBucket>,
    byStage: {} as Record<string, ToolBucket>
  };
  private contextPressure = {
    toolBudgetRejections: 0,
    toolBudgetRejectionsByStage: {} as Partial<Record<ReviewStage, number>>,
    toolBudgetExtensions: {
      granted: 0,
      denied: 0,
      resultChars: 0,
      grantedByStage: {} as Partial<Record<ReviewStage, number>>,
      deniedByStage: {} as Partial<Record<ReviewStage, number>>
    },
    degradedToolResults: 0,
    degradedToolResultsByStage: {} as Partial<Record<ReviewStage, number>>,
    rejectionReasons: {} as Record<string, number>
  };
  private telemetrySummary = {
    events: 0,
    levels: emptyLevelCounts(),
    cache: emptyCacheCounts(),
    byStage: {} as Record<string, TelemetryStageSummary>
  };
  private schemaRecovery = emptySchemaRecoverySummary();
  private stage7SchemaRepairSummary = emptyStage7SchemaRepairSummary();
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
    this.directoryName = opts.directoryNameFactory?.() ?? this.runId;
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
      snapshotStageTimings: () => this.snapshotStageTimings(),
      snapshotContextPressure: () => this.snapshotContextPressure(),
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

    const runDir = path.join(runsRoot, this.directoryName);
    mkdirSync(runDir, { recursive: true });
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
    const codegenieRuntime = resolveCodegenieRuntimeProvenance();
    this.writeArtifactJson("run.json", {
      schemaVersion: 1,
      runId: this.runId,
      codegenieVersion: codegenieRuntime.packageVersion,
      codegenieRuntime,
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
    this.writeArtifactJson("telemetry.json", {
      schemaVersion: 1,
      runId: this.runId,
      codegenieRuntime,
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
      schemaRecovery: this.finalSchemaRecoverySummary(),
      schemaRepair: {
        stage7: this.stage7SchemaRepairSummary
      },
      modelCalls: modelSummary,
      toolCalls: this.finalToolSummary()
    });
    this.writeArtifactJson("model-calls-summary.json", modelSummary);
    this.writeArtifactJson("tool-calls-summary.json", this.finalToolSummary());
    this.writeArtifactJson("cost-profile.json", this.costProfile());
    this.writeArtifactJson("artifact-manifest.json", this.artifactManifest());
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
    this.updatePipelineSummaryFromEvent(capped);
    this.updateContextPressureFromEvent(capped);
    this.updateSchemaRecoveryFromEvent(capped);
    this.updateStage7SchemaRepairSummaryFromEvent(capped);
    this.updateFinalArgumentOutcomeFromEvent(capped);
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
      data: {
        status: record.status,
        resultChars: record.resultChars,
        cacheStatus: record.cacheStatus,
        backendExecuted: record.backendExecuted
      }
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
    const artifactPath = canonicalArtifactPath(relPath);
    assertAllowedResolvedArtifactPath(artifactPath);
    if (normalizeArtifactPath(relPath) === "final-review.md") {
      this.writeText(artifactPath, typeof data === "string" ? data : serialize(data, 2));
      return;
    }
    this.writeJson(artifactPath, data);
  }

  private writeArtifactJson(relPath: LogicalArtifactName, data: unknown): void {
    const artifactPath = canonicalArtifactPath(relPath);
    assertAllowedResolvedArtifactPath(artifactPath);
    this.writeJson(artifactPath, data);
  }

  private artifactManifest(): ArtifactManifest {
    const entries: ArtifactManifestEntry[] = [];
    const seen = new Set<string>();
    for (const [logicalName, relPath] of Object.entries(ARTIFACT_LOCATION)) {
      if (logicalName !== "artifact-manifest.json" && !this.artifactExists(relPath)) {
        continue;
      }
      entries.push(manifestEntry(logicalName, relPath));
      seen.add(relPath);
    }
    for (const relPath of ROOT_STREAM_ARTIFACTS) {
      if (seen.has(relPath) || !this.artifactExists(relPath)) {
        continue;
      }
      entries.push(manifestEntry(relPath, relPath));
      seen.add(relPath);
    }
    for (const relPath of this.packetArtifactPaths()) {
      if (seen.has(relPath)) {
        continue;
      }
      const packetId = path.basename(relPath, ".json");
      entries.push(manifestEntry(`packet:${packetId}`, relPath));
      seen.add(relPath);
    }

    return {
      schemaVersion: 1,
      layoutVersion: 2,
      generatedAt: this.clock().toISOString(),
      artifacts: entries.sort((left, right) => left.path.localeCompare(right.path))
    };
  }

  private artifactExists(relPath: string): boolean {
    return this.runDirectory !== undefined && existsSync(path.join(this.runDirectory, relPath));
  }

  private packetArtifactPaths(): string[] {
    if (!this.runDirectory) {
      return [];
    }
    const packetDir = path.join(this.runDirectory, "stages", "06-packets", "packets");
    let entries: string[];
    try {
      entries = readdirSync(packetDir);
    } catch {
      return [];
    }
    return entries
      .filter((entry) => entry.endsWith(".json"))
      .sort()
      .map((entry) => path.posix.join("stages", "06-packets", "packets", entry));
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
      this.modelSummary.reasoningTokens += record.reasoningTokens ?? 0;
      this.modelSummary.totalTokens += record.totalTokens ?? 0;
    }
    updateModelCacheCounts(this.modelSummary.cache, record.cacheStatus);
    this.modelSummary.retryAttempts += providerCallCount > 0 && record.attempt > 1 ? 1 : 0;
    this.modelSummary.repairCalls += record.kind === "repair" ? 1 : 0;
    this.modelSummary.schemaInvalidCalls += record.status === "schema_invalid" ? 1 : 0;
    if (providerCallCount > 0 && record.finalArgumentState !== undefined) {
      this.modelSummary.finalArgumentStates[record.finalArgumentState] += 1;
    }
    if (providerCallCount > 0 && record.finalArgumentErrorKind !== undefined) {
      this.modelSummary.finalArgumentErrorKinds[record.finalArgumentErrorKind] += 1;
    }
    this.modelSummary.toolChoiceDowngradedCalls += providerCallCount > 0 && record.toolChoiceDowngraded === true ? 1 : 0;
    this.updateSchemaRecoveryFromModelCall(record);
    this.updateStage7SchemaRepairSummaryFromModelCall(record);
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
    updateFinalizeSummary(this.modelSummary.finalize, record, providerCallCount);

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
      bucket.reasoningTokens += record.reasoningTokens ?? 0;
      bucket.totalTokens += record.totalTokens ?? 0;
    }
    updateModelCacheCounts(bucket.cache, record.cacheStatus);
    bucket.retryAttempts += providerCallCount > 0 && record.attempt > 1 ? 1 : 0;
    bucket.repairCalls += record.kind === "repair" ? 1 : 0;
    bucket.schemaInvalidCalls += record.status === "schema_invalid" ? 1 : 0;
    bucket.statuses[record.status] += 1;
    updateFinalizeSummary(bucket.finalize, record, providerCallCount);
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
    updateToolResultCacheSummary(this.toolSummary.resultCache, record);
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
    this.updateContextPressure(record);
  }

  private updateContextPressure(record: ToolCallRecord): void {
    if (record.status === "rejected") {
      const reason = record.degradationReason ?? record.errorCode ?? "rejected";
      if (isLocalToolBudgetRejectionReason(reason)) {
        this.contextPressure.toolBudgetRejections += 1;
        addStageCount(this.contextPressure.toolBudgetRejectionsByStage, record.stage, 1);
        this.contextPressure.rejectionReasons[reason] = (this.contextPressure.rejectionReasons[reason] ?? 0) + 1;
      }
      return;
    }

    if (record.degraded) {
      this.contextPressure.degradedToolResults += 1;
      addStageCount(this.contextPressure.degradedToolResultsByStage, record.stage, 1);
    }
  }

  private updateContextPressureFromEvent(event: TelemetryEvent): void {
    if (event.message === "tool_budget_extension_granted") {
      this.contextPressure.toolBudgetExtensions.granted += 1;
      if (event.stage !== 0) {
        addStageCount(this.contextPressure.toolBudgetExtensions.grantedByStage, event.stage, 1);
      }
      this.contextPressure.toolBudgetExtensions.resultChars += numberPath(event.data, ["resultChars"]) ?? 0;
    } else if (event.message === "tool_budget_extension_denied") {
      this.contextPressure.toolBudgetExtensions.denied += 1;
      if (event.stage !== 0) {
        addStageCount(this.contextPressure.toolBudgetExtensions.deniedByStage, event.stage, 1);
      }
    }
  }

  // A stage still executing at snapshot time (run cut short by a budget or
  // time stop) reports its elapsed-so-far runtime instead of being dropped —
  // the interrupted stage is exactly the one a timing reader is looking for.
  private snapshotStageTimings(): Array<{ stage: number; runtimeMs: number }> {
    const now = this.clock().toISOString();
    return Object.entries(this.telemetrySummary.byStage)
      .map(([stage, bucket]) => ({
        stage: Number(stage),
        runtimeMs: bucket.startedAt !== undefined && bucket.completedAt === undefined
          ? bucket.runtimeMs + durationBetween(bucket.startedAt, now)
          : bucket.runtimeMs
      }))
      .filter((entry) => Number.isInteger(entry.stage) && entry.stage > 0 && entry.runtimeMs > 0)
      .sort((left, right) => left.stage - right.stage);
  }

  private snapshotContextPressure(): Pick<
    ContextPressureSummary,
    | "toolBudgetRejections"
    | "toolBudgetRejectionsByStage"
    | "toolBudgetExtensions"
    | "degradedToolResults"
    | "degradedToolResultsByStage"
    | "rejectionReasons"
  > {
    return {
      toolBudgetRejections: this.contextPressure.toolBudgetRejections,
      toolBudgetRejectionsByStage: { ...this.contextPressure.toolBudgetRejectionsByStage },
      toolBudgetExtensions: {
        granted: this.contextPressure.toolBudgetExtensions.granted,
        denied: this.contextPressure.toolBudgetExtensions.denied,
        resultChars: this.contextPressure.toolBudgetExtensions.resultChars,
        grantedByStage: { ...this.contextPressure.toolBudgetExtensions.grantedByStage },
        deniedByStage: { ...this.contextPressure.toolBudgetExtensions.deniedByStage }
      },
      degradedToolResults: this.contextPressure.degradedToolResults,
      degradedToolResultsByStage: { ...this.contextPressure.degradedToolResultsByStage },
      rejectionReasons: Object.entries(this.contextPressure.rejectionReasons)
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
    };
  }

  private finalToolSummary(): unknown {
    return {
      totalCalls: this.toolSummary.totalCalls,
      resultCache: { ...this.toolSummary.resultCache },
      byTool: averageToolBuckets(this.toolSummary.byTool),
      byStage: averageToolBuckets(this.toolSummary.byStage)
    };
  }

  private finalModelSummary(): unknown {
    const schemaRecovery = this.finalSchemaRecoverySummary();
    const byStage = Object.fromEntries(
      Object.entries(this.modelSummary.byStage).map(([stage, bucket]) => [
        stage,
        {
          ...withCacheAliases(bucket),
          schemaRecovery: schemaRecovery.byStage[stage] ?? finalSchemaRecoveryCounters(emptySchemaRecoveryCounters())
        }
      ])
    );
    return {
      ...this.modelSummary,
      localModelCallCache: copyCacheCounts(this.modelSummary.cache),
      providerPromptCache: providerPromptCacheSummary(this.modelSummary),
      schemaRecovery,
      byStage
    };
  }

  private finalSchemaRecoverySummary(): SchemaRecoverySummary {
    return finalSchemaRecoverySummary(this.schemaRecovery);
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
        reasoningTokens: this.modelSummary.reasoningTokens,
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
    if ((event.message === "stage_completed" || event.message === "stage_failed") && bucket.completedAt === undefined) {
      bucket.completedAt = event.timestamp;
      if (bucket.startedAt !== undefined) {
        bucket.runtimeMs += durationBetween(bucket.startedAt, event.timestamp);
      }
    }
  }

  private updateFinalArgumentOutcomeFromEvent(event: TelemetryEvent): void {
    if (event.message !== "final_argument_repair_outcome" || event.data === undefined) {
      return;
    }
    const outcome = event.data.outcome;
    if (outcome === "recovered" || outcome === "terminal_invalid" || outcome === "not_dispatched") {
      this.modelSummary.finalArgumentOutcomes[outcome] += 1;
    }
  }

  private runTotals(): unknown {
    return {
      events: this.eventSeq,
      modelCallRecords: this.modelSummary.totalRecords,
      modelCalls: this.modelSummary.providerCalls,
      providerCalls: this.modelSummary.providerCalls,
      toolCalls: this.toolSummary.totalCalls,
      toolResultCache: { ...this.toolSummary.resultCache },
      inputTokens: this.modelSummary.inputTokens,
      uncachedInputTokens: this.modelSummary.uncachedInputTokens,
      cacheReadTokens: this.modelSummary.cacheReadTokens,
      cacheWriteTokens: this.modelSummary.cacheWriteTokens,
      billableInputTokens: this.modelSummary.billableInputTokens,
      outputTokens: this.modelSummary.outputTokens,
      reasoningTokens: this.modelSummary.reasoningTokens,
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
      schemaRecovery: this.finalSchemaRecoverySummary(),
      stage7SchemaRepair: this.stage7SchemaRepairSummary,
      logOverflow: this.logOverflow,
      ...this.pipelineTotals
    };
  }

  private updateSchemaRecoveryFromModelCall(record: LlmCallRecord): void {
    if (record.status === "schema_invalid") {
      addSchemaRecovery(this.schemaRecovery, record.stage, { schemaInvalidCalls: 1 });
    }
    if (record.kind !== "repair") {
      return;
    }
    if (record.status === "ok") {
      addSchemaRecovery(this.schemaRecovery, record.stage, {
        schemaRepairAttempts: 1,
        schemaRepairRecovered: 1,
        schemaInvalidRecovered: 1
      });
      return;
    }
    addSchemaRecovery(this.schemaRecovery, record.stage, { schemaRepairAttempts: 1 });
    if (record.status === "schema_invalid" && record.stage !== 7 && record.stage !== 9) {
      addSchemaRecovery(this.schemaRecovery, record.stage, { schemaRecoveryFailed: 1 });
    }
  }

  private updateSchemaRecoveryFromEvent(event: TelemetryEvent): void {
    if (event.message === "schema_invalid_submit_recovered") {
      const data = objectField(event.data);
      const recoveredCalls = data?.schemaRepairUsed === true ? 2 : 1;
      addSchemaRecovery(this.schemaRecovery, event.stage, {
        deterministicSchemaRecovered: recoveredCalls,
        schemaInvalidRecovered: recoveredCalls
      });
      return;
    }
    if (event.message === "stage7_schema_cleanup_recovered") {
      addSchemaRecovery(this.schemaRecovery, event.stage, {
        deterministicSchemaRecovered: 1,
        schemaInvalidRecovered: 1
      });
      return;
    }
    if (
      event.message === "schema_invalid_submit_recovery_invalid" ||
      event.message === "stage7_schema_cleanup_rejected" ||
      event.message === "stage7_schema_repair_failed" ||
      event.message === "verification_schema_repair_failed"
    ) {
      addSchemaRecovery(this.schemaRecovery, event.stage, { schemaRecoveryFailed: 1 });
    }
  }

  private updateStage7SchemaRepairSummaryFromEvent(event: TelemetryEvent): void {
    if (event.stage !== 7) {
      return;
    }
    const data = objectField(event.data);
    const classification = typeof data?.classification === "string" ? data.classification : "";
    const payloadKind = typeof data?.payloadKind === "string" ? data.payloadKind : "";
    if (event.message === "stage7_schema_repair_attempted") {
      if (payloadKind === "no_findings" || classification === "empty_no_findings_missing_fields") {
        this.stage7SchemaRepairSummary.noFindingInvalidSubmits += 1;
      } else {
        this.stage7SchemaRepairSummary.candidateInvalidSubmits += 1;
      }
      return;
    }
    if (event.message === "stage7_schema_cleanup_attempted") {
      this.stage7SchemaRepairSummary.cleanupAttempted += 1;
      return;
    }
    if (event.message === "stage7_schema_cleanup_recovered") {
      this.stage7SchemaRepairSummary.cleanupRecovered += 1;
      return;
    }
    if (event.message === "stage7_schema_cleanup_rejected") {
      this.stage7SchemaRepairSummary.cleanupRejected += 1;
      return;
    }
    if (event.message === "stage7_schema_compact_repair_scheduled") {
      this.stage7SchemaRepairSummary.compactRepairScheduled += 1;
      const promptChars = numberField(data?.repairPromptChars);
      this.stage7SchemaRepairSummary.repairPromptChars += promptChars;
      this.stage7SchemaRepairSummary.compactRepairPromptChars += promptChars;
      return;
    }
    if (event.message === "schema_repair_scheduled") {
      const replaceConversation = data?.replaceConversation === true;
      if (!replaceConversation) {
        this.stage7SchemaRepairSummary.appendRepairScheduled += 1;
        const promptChars = numberField(data?.repairPromptChars);
        this.stage7SchemaRepairSummary.repairPromptChars += promptChars;
        this.stage7SchemaRepairSummary.appendRepairPromptChars += promptChars;
      }
      return;
    }
    if (event.message === "stage7_schema_repair_recovered") {
      if (classification === "schema_valid_after_retry") {
        this.stage7SchemaRepairSummary.repairRecovered += 1;
      }
      return;
    }
    if (event.message === "stage7_schema_repair_failed") {
      this.stage7SchemaRepairSummary.repairFailed += 1;
    }
  }

  private updateStage7SchemaRepairSummaryFromModelCall(record: LlmCallRecord): void {
    if (record.stage !== 7 || record.kind !== "repair") {
      return;
    }
    this.stage7SchemaRepairSummary.actualRepairCalls += 1;
    this.stage7SchemaRepairSummary.actualRepairPromptChars += record.promptChars;
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
      concurrency: review.concurrency ?? null,
      budgetBoost: review.budgetBoost ?? null,
      llmMaxConcurrentCalls: review.llmMaxConcurrentCalls ?? null,
      lenses: review.lenses ?? [],
      format: review.format ?? null,
      postGithubComments: review.postGithubComments ?? false
    };
  }

  private allStageSummaries(): Record<string, TelemetryStageSummary> {
    const stages: Record<string, TelemetryStageSummary> = {};
    const schemaRecovery = this.finalSchemaRecoverySummary();
    for (const stage of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) {
      const key = String(stage);
      stages[String(stage)] = {
        ...emptyTelemetryStageSummary(),
        ...(this.telemetrySummary.byStage[key] ?? {}),
        schemaRecovery: schemaRecovery.byStage[key] ?? finalSchemaRecoveryCounters(emptySchemaRecoveryCounters())
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
  backendExecutions: number;
  savedBackendCalls: number;
  totalDurationMs: number;
  totalResultChars: number;
  resultCache: ToolResultCacheSummary;
};

function emptyCacheCounts(): CacheCounts {
  return {
    hit: 0,
    miss: 0,
    disabled: 0,
    write: 0
  };
}

function emptySchemaRecoveryCounters(): SchemaRecoveryCounters {
  return {
    schemaInvalidCalls: 0,
    schemaInvalidRecovered: 0,
    schemaInvalidUnrecovered: 0,
    schemaRepairAttempts: 0,
    schemaRepairRecovered: 0,
    deterministicSchemaRecovered: 0,
    schemaRecoveryFailed: 0
  };
}

function emptySchemaRecoverySummary(): SchemaRecoverySummary {
  return {
    ...emptySchemaRecoveryCounters(),
    byStage: {}
  };
}

function finalSchemaRecoveryCounters(input: SchemaRecoveryCounters): SchemaRecoveryCounters {
  const recovered = Math.min(input.schemaInvalidRecovered, input.schemaInvalidCalls);
  return {
    ...input,
    schemaInvalidRecovered: recovered,
    schemaInvalidUnrecovered: Math.max(0, input.schemaInvalidCalls - recovered)
  };
}

function finalSchemaRecoverySummary(input: SchemaRecoverySummary): SchemaRecoverySummary {
  return {
    ...finalSchemaRecoveryCounters(input),
    byStage: Object.fromEntries(
      Object.entries(input.byStage).map(([stage, counters]) => [stage, finalSchemaRecoveryCounters(counters)])
    )
  };
}

function addSchemaRecovery(
  summary: SchemaRecoverySummary,
  stage: ReviewStage | 0,
  delta: Partial<Omit<SchemaRecoveryCounters, "schemaInvalidUnrecovered">>
): void {
  addSchemaRecoveryCounters(summary, delta);
  if (stage === 0) {
    return;
  }
  const bucket = summary.byStage[String(stage)] ?? (summary.byStage[String(stage)] = emptySchemaRecoveryCounters());
  addSchemaRecoveryCounters(bucket, delta);
}

function addSchemaRecoveryCounters(
  target: SchemaRecoveryCounters,
  delta: Partial<Omit<SchemaRecoveryCounters, "schemaInvalidUnrecovered">>
): void {
  target.schemaInvalidCalls += delta.schemaInvalidCalls ?? 0;
  target.schemaInvalidRecovered += delta.schemaInvalidRecovered ?? 0;
  target.schemaRepairAttempts += delta.schemaRepairAttempts ?? 0;
  target.schemaRepairRecovered += delta.schemaRepairRecovered ?? 0;
  target.deterministicSchemaRecovered += delta.deterministicSchemaRecovered ?? 0;
  target.schemaRecoveryFailed += delta.schemaRecoveryFailed ?? 0;
}

function copyCacheCounts(cache: CacheCounts): CacheCounts {
  return {
    hit: cache.hit,
    miss: cache.miss,
    disabled: cache.disabled,
    write: cache.write
  };
}

function updateModelCacheCounts(cache: CacheCounts, status: keyof CacheCounts): void {
  if (status === "write") {
    cache.miss += 1;
    cache.write += 1;
    return;
  }
  cache[status] += 1;
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

function emptyFinalArgumentStateCounts(): FinalArgumentStateCounts {
  return {
    strict: 0,
    repaired: 0,
    partial: 0,
    invalid: 0,
    length_stopped: 0,
    event_capture_missing: 0,
    event_final_mismatch: 0
  };
}

function emptyFinalArgumentErrorKindCounts(): FinalArgumentErrorKindCounts {
  return {
    unexpected_end: 0,
    unterminated: 0,
    invalid_syntax: 0,
    non_object_root: 0
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
    reasoningTokens: 0,
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
    statuses: emptyModelStatusCounts(),
    finalize: emptyModelFinalizeSummary()
  };
}

function emptyModelFinalizeSummary(): ModelFinalizeSummary {
  return {
    compactCalls: 0,
    fullCalls: 0,
    noFindingCalls: 0,
    candidateOrUnknownCalls: 0,
    promptChars: 0,
    noFindingPromptChars: 0,
    candidateOrUnknownPromptChars: 0,
    costUSD: 0,
    noFindingCostUSD: 0,
    candidateOrUnknownCostUSD: 0,
    unknownCostCalls: 0
  };
}

function updateFinalizeSummary(summary: ModelFinalizeSummary, record: LlmCallRecord, providerCallCount: number): void {
  if (providerCallCount <= 0 || record.finalizeMode === undefined) {
    return;
  }
  if (record.finalizeMode === "compact") {
    summary.compactCalls += 1;
  } else {
    summary.fullCalls += 1;
  }
  if (record.finalizeTarget === "no_findings") {
    summary.noFindingCalls += 1;
    summary.noFindingPromptChars += record.promptChars;
    summary.noFindingCostUSD += record.costUSD ?? 0;
  } else if (record.finalizeTarget === "candidate_or_unknown") {
    summary.candidateOrUnknownCalls += 1;
    summary.candidateOrUnknownPromptChars += record.promptChars;
    summary.candidateOrUnknownCostUSD += record.costUSD ?? 0;
  }
  summary.promptChars += record.promptChars;
  if (record.costUSD === undefined) {
    summary.unknownCostCalls += 1;
  } else {
    summary.costUSD += record.costUSD;
  }
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
      finalFindings: 0,
      compositionMode: null,
      fallbackReason: null
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
    runtimeMs: 0,
    schemaRecovery: finalSchemaRecoveryCounters(emptySchemaRecoveryCounters())
  };
}

function emptyStage7SchemaRepairSummary(): Stage7SchemaRepairSummary {
  return {
    candidateInvalidSubmits: 0,
    noFindingInvalidSubmits: 0,
    cleanupAttempted: 0,
    cleanupRecovered: 0,
    cleanupRejected: 0,
    compactRepairScheduled: 0,
    appendRepairScheduled: 0,
    repairRecovered: 0,
    repairFailed: 0,
    repairPromptChars: 0,
    compactRepairPromptChars: 0,
    appendRepairPromptChars: 0,
    actualRepairCalls: 0,
    actualRepairPromptChars: 0
  };
}

function emptyToolBucket(): ToolBucket {
  return {
    count: 0,
    errors: 0,
    rejections: 0,
    degraded: 0,
    backendExecutions: 0,
    savedBackendCalls: 0,
    totalDurationMs: 0,
    totalResultChars: 0,
    resultCache: emptyToolResultCacheSummary()
  };
}

function updateToolBucket(bucket: ToolBucket, record: ToolCallRecord): void {
  bucket.count += 1;
  bucket.errors += record.status === "error" ? 1 : 0;
  bucket.rejections += record.status === "rejected" ? 1 : 0;
  bucket.degraded += record.degraded ? 1 : 0;
  bucket.backendExecutions += record.backendExecuted === true ? 1 : 0;
  bucket.savedBackendCalls += record.cacheStatus === "hit" ? 1 : 0;
  updateToolResultCacheSummary(bucket.resultCache, record);
  bucket.totalDurationMs += record.durationMs;
  bucket.totalResultChars += record.resultChars;
}

function emptyToolResultCacheSummary(): ToolResultCacheSummary {
  return {
    hits: 0,
    misses: 0,
    writes: 0,
    disabled: 0,
    inflightHits: 0,
    evictions: 0,
    backendExecutions: 0,
    savedBackendCalls: 0
  };
}

function updateToolResultCacheSummary(summary: ToolResultCacheSummary, record: ToolCallRecord): void {
  if (record.backendExecuted === true) {
    summary.backendExecutions += 1;
  }
  if (record.cacheStatus === "hit") {
    summary.hits += 1;
    summary.savedBackendCalls += 1;
    if (record.cacheHitKind === "inflight") {
      summary.inflightHits += 1;
    }
  } else if (record.cacheStatus === "write") {
    summary.misses += 1;
    summary.writes += 1;
  } else if (record.cacheStatus === "miss") {
    summary.misses += 1;
  } else {
    summary.disabled += 1;
  }
  summary.evictions += record.cacheEvictedEntries ?? 0;
}

function addStageCount(target: Partial<Record<ReviewStage, number>>, stage: ReviewStage, amount: number): void {
  target[stage] = (target[stage] ?? 0) + amount;
}

function numberPath(input: unknown, pathParts: string[]): number | undefined {
  let current = input;
  for (const part of pathParts) {
    if (!current || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === "number" && Number.isFinite(current) ? current : undefined;
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
  addNumber(target, "generated", source.generated);
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
  setString(target, "compositionMode", source.compositionMode);
  setString(target, "fallbackReason", source.fallbackReason);
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

function numberField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function setNumber(target: Record<string, unknown>, key: string, value: unknown): void {
  if (typeof value === "number" && Number.isFinite(value)) {
    target[key] = value;
  }
}

function setString(target: Record<string, unknown>, key: string, value: unknown): void {
  if (typeof value === "string" && value.length > 0) {
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
  const codegenieDir = path.resolve(repoRoot, ".codegenie");
  if (!isPathInside(codegenieDir, runsRoot) && path.resolve(runsRoot) !== path.join(codegenieDir, "runs")) {
    return;
  }

  provisionCodegenieGitignore(repoRoot);
}

export function provisionCodegenieGitignore(repoRoot: string): void {
  const codegenieDir = path.resolve(repoRoot, ".codegenie");
  mkdirSync(codegenieDir, { recursive: true });
  const gitignorePath = path.join(codegenieDir, ".gitignore");
  if (existsSync(gitignorePath)) {
    return;
  }
  writeFileSync(gitignorePath, "runs/\ncache/\nlocks/\n");
}

type PruneResult = {
  deleted: string[];
  failures: Array<{ path: string; error: string }>;
};

function pruneRuns(runsRoot: string, activeRunDir: string, retainRuns: number): PruneResult {
  const result: PruneResult = { deleted: [], failures: [] };
  const keepCount = Math.max(1, retainRuns);
  const active = path.resolve(activeRunDir);

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
        return stats.isDirectory() && path.resolve(entry) !== active ? { path: entry, mtimeMs: stats.mtimeMs } : undefined;
      } catch (error) {
        result.failures.push({ path: entry, error: errorMessage(error) });
        return undefined;
      }
    })
    .filter((entry): entry is { path: string; mtimeMs: number } => entry !== undefined)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const dir of dirs.slice(keepCount)) {
    try {
      rmSync(dir.path, { recursive: true, force: true });
      result.deleted.push(dir.path);
    } catch (error) {
      result.failures.push({ path: dir.path, error: errorMessage(error) });
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

export function canonicalArtifactPath(relPath: string): string {
  const normalized = normalizeArtifactPath(relPath);
  assertSafeRelativeArtifactPath(normalized, relPath);
  if (PACKET_ARTIFACT_RE.test(normalized)) {
    return path.posix.join("stages", "06-packets", normalized);
  }
  const artifactPath = ARTIFACT_LOCATION[normalized as LogicalArtifactName];
  if (artifactPath === undefined) {
    throw new Error(`unknown run artifact path: ${relPath}`);
  }
  return artifactPath;
}

function assertAllowedResolvedArtifactPath(relPath: string): void {
  const normalized = normalizeArtifactPath(relPath);
  assertSafeRelativeArtifactPath(normalized, relPath);
  if (CANONICAL_ARTIFACT_PATHS.has(normalized) || CANONICAL_PACKET_ARTIFACT_RE.test(normalized)) {
    return;
  }
  throw new Error(`unknown canonical run artifact path: ${relPath}`);
}

function normalizeArtifactPath(relPath: string): string {
  return relPath.replace(/\\/gu, "/");
}

function assertSafeRelativeArtifactPath(normalized: string, original: string): void {
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    normalized.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`unsafe run artifact path: ${original}`);
  }
}

function manifestEntry(id: string, relPath: string): ArtifactManifestEntry {
  const stage = manifestStage(relPath);
  return {
    id: artifactId(id),
    stage,
    stageName: STAGE_LABELS[stage],
    kind: artifactKind(relPath),
    path: relPath
  };
}

function manifestStage(relPath: string): ReviewStage | 0 {
  const match = /^stages\/(\d{2})-[^/]+\//u.exec(relPath);
  if (!match) {
    return 0;
  }
  const stage = Number(match[1]);
  return STAGES.some((entry) => entry.stage === stage) ? (stage as ReviewStage | 0) : 0;
}

function artifactKind(relPath: string): ArtifactKind {
  if (relPath.endsWith(".jsonl")) {
    return "jsonl";
  }
  if (relPath.endsWith(".json")) {
    return "json";
  }
  if (relPath.endsWith(".md")) {
    return "markdown";
  }
  return "text";
}

function artifactId(id: string): string {
  return id.replace(/\.(?:jsonl|json|md)$/u, "");
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
