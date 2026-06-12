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

export type ReviewMode = "github_pr" | "branch" | "commit_range";

export type ReviewInput =
  | { mode: "github_pr"; prNumber: number }
  | { mode: "branch"; branchName: string; baseBranch?: string }
  | { mode: "commit_range"; startCommit: string; endCommit?: string };

export type PullRequestMetadata = {
  owner: string;
  repo: string;
  number: number;
  title: string;
  body: string;
  url: string;
  baseRefName: string;
  baseSha: string;
  headRefName: string;
  headSha: string;
};

export type ExistingReviewThread = {
  id: string;
  path?: string;
  line?: number;
  side?: "RIGHT" | "LEFT";
  author: string;
  isCodeninja: boolean;
  fingerprint?: string;
};

export type CommitInfo = {
  sha: string;
  title: string;
  body: string;
  authorName?: string;
  authoredAt?: string;
};

export type ResolvedReviewInput = {
  mode: ReviewMode;
  repoRoot: string;
  baseRef?: string;
  headRef?: string;
  startCommit?: string;
  endCommit?: string;
  mergeBase?: string;
  headSha?: string;
  pr?: PullRequestMetadata;
  commits: CommitInfo[];
  rawDiff: string;
};

export type UnifiedDiff = {
  files: DiffFile[];
};

export type DiffFileStatus = "added" | "modified" | "deleted" | "renamed" | "copied";

export type DiffFile = {
  path: string;
  oldPath?: string;
  status: DiffFileStatus;
  isBinary?: boolean;
  modeOnly?: boolean;
  isSymlink?: boolean;
  isSubmodule?: boolean;
  language: string;
  hunks: DiffHunk[];
};

export type DiffHunk = {
  id: string;
  path: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
  lines: DiffLine[];
};

export type DiffLine = {
  kind: "context" | "add" | "delete";
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
};

export type FactProvenance = {
  fact: string;
  source: "path" | "filename" | "extension" | "parser" | "git" | "diff" | "config" | "generated_detector";
  confidence: "high" | "medium" | "low";
  reason: string;
};

export type FileFacts = {
  path: string;
  language: string;
  packageRoot?: string;
  processingMode: ProcessingMode;
  testStatus: "test" | "source" | "unknown";
  isGenerated: boolean;
  isVendored: boolean;
  isLockfile: boolean;
  isBinary: boolean;
  changedLines: number;
  hunkCount: number;
  labels: string[];
  reviewPriority: ReviewPriority;
  reasons: string[];
  provenance: FactProvenance[];
  degraded?: { reason: string };
};

export type FileFilterDecision = {
  path: string;
  action: "skip" | "keep";
  reason: string;
  provenance: FactProvenance[];
};

export type SymbolKind =
  | "function"
  | "method"
  | "type"
  | "interface"
  | "value"
  | "container"
  | "other";

export type SymbolRef = {
  path: string;
  name: string;
  kind: SymbolKind;
  nativeKind?: string;
  lineRange: [number, number];
};

export type SymbolInfo = SymbolRef & {
  exported?: boolean;
  ownerType?: string;
  packageName?: string;
  signature?: string;
};

export type ChangedSymbol = SymbolInfo & {
  changedLines: number[];
};

export type HunkSymbolFacts = {
  path: string;
  hunkId: string;
  enclosingSymbol?: string;
  symbolKind?: SymbolKind;
  symbolNativeKind?: string;
  symbolRange?: [number, number];
  changedLines: number[];
  changedLinesSide: "old" | "new";
  signature?: string;
  source: "tree-sitter" | "fallback";
  confidence: "syntactic" | "heuristic";
};

export type StaticSignal = {
  ruleId: string;
  path: string;
  line?: number;
  side?: "RIGHT" | "LEFT";
  category: string;
  lensHint?: string;
  confidence: "high" | "medium" | "low";
  explanation: string;
  snippet?: string;
};

export type SourceSelector = { kind: "head" } | { kind: "base" };

export type ToolBackend = "tree-sitter" | "text" | "language-analyzer";
export type ToolPrecision = "exact" | "semantic" | "syntactic" | "heuristic" | "text";

export type ToolResultMeta = {
  backend: ToolBackend;
  precision: ToolPrecision;
  degraded: boolean;
  degradationReason?: string;
  truncated?: boolean;
  omittedCount?: number;
};

export type FileOutline = {
  path: string;
  language: string;
  packageName?: string;
  imports: string[];
  topLevelSymbols: SymbolInfo[];
  testSymbols: SymbolInfo[];
  notes: string[];
};

export type SearchContextMode = "none" | "lines" | "symbols";

export type SearchOptions = {
  pathGlob?: string;
  contextMode?: SearchContextMode;
  maxResults?: number;
  caseSensitive?: boolean;
  source?: SourceSelector;
};

export type ParseInput = {
  path: string;
  language: string;
  content: string;
  source: SourceSelector;
  contentSha?: string;
};

export type ParsedFile = {
  path: string;
  language: string;
  adapterId: string;
  source: SourceSelector;
  contentSha?: string;
  content: string;
  tree?: unknown;
  hasErrors: boolean;
};

export interface LanguageAdapter {
  id: string;
  extensions: string[];
  init(): Promise<void>;
  parse(input: ParseInput): Promise<ParsedFile>;
  listSymbols(file: ParsedFile): SymbolInfo[];
  getEnclosingSymbol(file: ParsedFile, line: number): SymbolInfo | undefined;
  getImports(file: ParsedFile): string[];
  getChangedSymbols(file: ParsedFile, hunk: DiffHunk): ChangedSymbol[];
  getStaticSignals?(file: ParsedFile, hunk: DiffHunk): StaticSignal[];
  findLikelyTests?(symbol: SymbolInfo, index: RepositoryIndex): SymbolInfo[];
}

export type PacketLine = {
  kind: "context" | "add" | "delete";
  oldLine?: number;
  newLine?: number;
  content: string;
};

export type PacketHunk = {
  hunkId: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header?: string;
  contentWithLineNumbers: string;
  lines: PacketLine[];
  changedNewLineNumbers: number[];
  changedOldLineNumbers: number[];
  truncated?: boolean;
  omittedLineCount?: number;
};

export type CoverageLevel = "deep" | "normal" | "light" | "skip";
export type PacketKind = "hunk" | "coalesced-hunks" | "file-diff" | "whole-file";

export type ToolBudget = {
  maxToolCalls: number;
  maxInvestigationRounds: number;
  maxResultChars: number;
};

export type SurroundingContextHint = {
  kind:
    | "enclosing_symbol"
    | "sibling_pattern"
    | "call_site"
    | "test"
    | "config"
    | "lifecycle"
    | "resource_management"
    | "authorization"
    | "other";
  path?: string;
  symbol?: string;
  lineRange?: [number, number];
  reason: string;
  expectedUse: "packet_context" | "tool_lookup";
};

export type PacketContext = {
  path: string;
  packageName?: string;
  enclosingFunction?: SymbolInfo;
  enclosingType?: SymbolInfo;
  enclosingMethod?: SymbolInfo;
};

export type ReviewPacket = {
  id: string;
  kind: PacketKind;
  prSummary: string;
  intentText?: string;
  path: string;
  fileStatus: DiffFile["status"];
  isDeletedContent: boolean;
  language: string;
  coverage: Exclude<CoverageLevel, "skip">;
  lenses: string[];
  hunks: PacketHunk[];
  symbolFacts: HunkSymbolFacts[];
  context: PacketContext;
  contextText: string;
  relevantTests: SymbolInfo[];
  surroundingContextHints: SurroundingContextHint[];
  labels: string[];
  riskNotes: string[];
  toolBudget: ToolBudget;
  degraded?: { reason: string };
  fileContext?: {
    mode: "file-diff" | "whole-file";
    reason: string;
  };
};

export interface RepositoryTools {
  readRange(
    path: string,
    startLine: number,
    endLine: number,
    source?: SourceSelector
  ): Promise<{ text: string; meta: ToolResultMeta }>;
  readFileOutline(path: string, source?: SourceSelector): Promise<{ outline: FileOutline; meta: ToolResultMeta }>;
  readSymbol(
    path: string,
    selector: { symbolName?: string; line?: number },
    source?: SourceSelector
  ): Promise<{ text?: string; symbol?: SymbolInfo; meta: ToolResultMeta }>;
  readDiffBlocks(input: { packetId?: string; path?: string }): Promise<{ blocks: string[]; meta: ToolResultMeta }>;
  findDefinition(
    symbolName: string,
    options?: { pathGlob?: string; source?: SourceSelector }
  ): Promise<{ definitions: Array<{ symbol: SymbolInfo; text?: string }>; meta: ToolResultMeta }>;
  searchFiles(query: string, options?: SearchOptions): Promise<{ results: SearchResult[]; meta: ToolResultMeta }>;
  findSymbolMentions(
    symbolName: string,
    options?: { pathGlob?: string; source?: SourceSelector }
  ): Promise<{ results: SearchResult[]; meta: ToolResultMeta }>;
  findLikelyTests(
    input: { path?: string; symbol?: SymbolRef; source?: SourceSelector }
  ): Promise<{ tests: SymbolRef[]; meta: ToolResultMeta }>;
  listFiles(glob: string): Promise<{ paths: string[]; meta: ToolResultMeta }>;
}

export interface RepositoryToolsHost extends RepositoryTools {
  bindPackets(packets: ReviewPacket[]): void;
  buildPacketContext(
    file: DiffFile,
    hunks: DiffHunk[],
    symbolFacts: HunkSymbolFacts[]
  ): Promise<{ context: PacketContext; outline?: FileOutline; relevantTests: SymbolInfo[]; degradation?: string }>;
  withToolCallContext<T>(context: RepositoryToolCallContext, run: () => Promise<T>): Promise<T>;
}

export type RepositoryIndex = {
  facts: FileFacts[];
  symbolFacts: HunkSymbolFacts[];
  staticSignals: StaticSignal[];
  tools: RepositoryTools;
};

export type DiffAnchor = {
  path: string;
  line: number;
  side: "RIGHT" | "LEFT";
  hunkId: string;
  startLine?: number;
  startSide?: "RIGHT" | "LEFT";
  commitSha?: string;
};

export type DiffAnchorValidation = {
  valid: boolean;
  reason?:
    | "unknown_path"
    | "wrong_side_path"
    | "unknown_hunk"
    | "line_not_in_hunk"
    | "line_not_changed"
    | "side_mismatch"
    | "multiline_invalid";
};

export type DiffAnchorIndex = {
  isChangedLine(path: string, line: number, side: "RIGHT" | "LEFT"): boolean;
  hunkIdAt(path: string, line: number, side: "RIGHT" | "LEFT"): string | undefined;
};

export type SearchResult = {
  path: string;
  line: number;
  column?: number;
  matchText: string;
  contextBefore?: string[];
  contextAfter?: string[];
  enclosingSymbol?: SymbolRef;
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
  omittedCount?: number;
  resultCount?: number;
  resultChars: number;
  durationMs: number;
  status: "ok" | "error" | "rejected" | "skipped";
  errorCode?: import("./util/errors.js").CodeninjaErrorCode;
};

export type RepositoryToolCallContext = {
  stage: ReviewStage;
  initiator: "model" | "harness";
  workerId?: string;
  packetId?: string;
  taskId?: string;
  candidateId?: string;
  modelCallId?: string;
};

export type RunOutcome = {
  status: "completed" | "failed";
  errorCode?: import("./util/errors.js").CodeninjaErrorCode;
  exitCode: number;
};
