export type ReviewStage = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11;

export type ReviewDepth = "light" | "normal" | "deep";
export type ReasoningLevel = "low" | "medium" | "high" | "xhigh";
export type Severity = "critical" | "high" | "medium" | "low";
export type Confidence = "high" | "medium" | "low";
export type ProcessingMode = "per-hunk" | "whole-file" | "skip";
export type ReviewPriority = "critical" | "high" | "normal" | "low";
export type OutputFormat = "markdown" | "json";
export type LogLevel = "debug" | "info" | "warn" | "error";

export type ConfigSource =
  | "defaults"
  | "user-config"
  | "provider-settings"
  | "repo-config"
  | "environment"
  | "cli";

export type ClassificationPathRule = {
  pattern: string;
  processingMode?: ProcessingMode;
  reviewPriority?: ReviewPriority;
  labels?: string[];
  reason: string;
};

export type CodeninjaConfig = {
  lenses: {
    enabled: string[];
    disabled: string[];
    extraSkillPaths: string[];
  };
  review: {
    depth: ReviewDepth;
    verify: boolean;
    minSeverity?: Severity;
    maxFindings: number;
    softCommentCap: number;
    minConfidence: Confidence;
    minInlineConfidence: Confidence;
    concurrency: number;
    timeoutMs: number;
    perPassTimeoutMs: number;
    maxTotalTokens?: number;
    maxModelCalls?: number;
  };
  github: {
    summaryWhenNoFindings: boolean;
  };
  git: {
    baseBranch?: string;
  };
  classification: {
    pathRules: ClassificationPathRule[];
  };
  llm: {
    provider?: string;
    model?: string;
    reasoning?: ReasoningLevel;
    maxConcurrentCalls: number;
  };
  cache: {
    enabled: boolean;
    dir: string;
  };
  telemetry: {
    enabled: boolean;
    logLevel: LogLevel;
    debugTrace: boolean;
    runDir: string;
    retainRuns: number;
  };
  eval: {
    defaultEvalDir?: string;
    logsDir: string;
  };
};

export type CodeninjaPaths = {
  home: string;
  authPath: string;
  modelsPath: string;
  settingsPath: string;
  configTomlPath: string;
  sessionsDir: string;
};

export type ProviderSettings = {
  defaultProvider?: string;
  defaultModel?: string;
  defaultDepth?: ReviewDepth;
  defaultReasoning?: ReasoningLevel;
};

export type ReviewCommandTarget =
  | { mode: "default_branch"; baseBranch?: string }
  | { mode: "github_pr"; prNumber: number }
  | { mode: "branch"; branchName: string; baseBranch?: string }
  | { mode: "commit_range"; startCommit: string; endCommit?: string };

export type ReviewCommandOptions = {
  format: OutputFormat;
  postGithubComments: boolean;
  cacheOverride?: boolean;
  cliLenses?: string[];
};

export type ParsedReviewCommand = {
  target: ReviewCommandTarget;
  config: CodeninjaConfig;
  options: ReviewCommandOptions;
  repoRoot: string;
  warnings: ConfigWarning[];
  configSources: Record<string, ConfigSource>;
};

export type ConfigWarning = {
  source: ConfigSource;
  key: string;
  message: string;
};

export type LogEvent = {
  timestamp: string;
  level: LogLevel;
  runId: string;
  stage: ReviewStage | 0;
  event: string;
  message: string;
  workerId?: string;
  packetId?: string;
  hunkId?: string;
  path?: string;
  candidateId?: string;
  findingId?: string;
  toolName?: string;
  lensId?: string;
  data?: Record<string, unknown>;
};

export interface Logger {
  debug(event: Omit<LogEvent, "timestamp" | "level">): void;
  info(event: Omit<LogEvent, "timestamp" | "level">): void;
  warn(event: Omit<LogEvent, "timestamp" | "level">): void;
  error(event: Omit<LogEvent, "timestamp" | "level">): void;
}

export type TelemetryEvent = {
  runId: string;
  eventId: string;
  timestamp: string;
  stage: ReviewStage | 0;
  level: LogLevel;
  message: string;
  file?: string;
  lineRange?: [number, number];
  packetId?: string;
  lensId?: string;
  workerId?: string;
  durationMs?: number;
  cacheStatus?: "hit" | "miss" | "disabled" | "write";
  data?: Record<string, unknown>;
};

export type ToolBackend = "git" | "worktree" | "tree-sitter" | "ripgrep" | "fallback";
export type ToolPrecision = "exact" | "syntactic" | "heuristic" | "text";

export type ToolCallRecord = {
  runId: string;
  toolCallId: string;
  timestamp: string;
  stage: ReviewStage;
  initiator: "model" | "harness";
  workerId?: string;
  packetId?: string;
  taskId?: string;
  candidateId?: string;
  modelCallId?: string;
  tool: string;
  args: {
    path?: string;
    symbolName?: string;
    line?: number;
    startLine?: number;
    endLine?: number;
    query?: string;
    glob?: string;
    source?: string;
    contextMode?: string;
  };
  backend: ToolBackend;
  precision: ToolPrecision;
  engine?: "git-grep" | "ripgrep";
  degraded: boolean;
  degradationReason?: string;
  truncated?: boolean;
  resultCount?: number;
  resultChars: number;
  durationMs: number;
  status: "ok" | "error" | "rejected" | "skipped";
  errorCode?: import("./util/errors.js").CodeninjaErrorCode;
};

export type RunOutcome = {
  status: "completed" | "failed";
  errorCode?: import("./util/errors.js").CodeninjaErrorCode;
  exitCode: number;
};
