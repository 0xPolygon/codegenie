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

export type CodegenieConfig = {
  lenses: {
    enabled: string[];
    disabled: string[];
    extraSkillPaths: string[];
    restrictTo?: string[];
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
    budgetBoost: number;
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

export type CodegeniePaths = {
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
  | { mode: "head"; headRef: string; baseRef: string }
  | { mode: "single_ref"; ref: string; baseBranch?: string }
  | { mode: "commit_range"; startCommit: string; endCommit?: string };

export type ReviewCommandOptions = {
  format: OutputFormat;
  postGithubComments: boolean;
  cacheOverride?: boolean;
  progress: boolean;
};

export type ParsedReviewCommand = {
  target: ReviewCommandTarget;
  config: CodegenieConfig;
  options: ReviewCommandOptions;
  repoRoot: string;
  warnings: ConfigWarning[];
  configSources: Record<string, ConfigSource>;
};

export type ReviewMode = "github_pr" | "branch" | "head" | "commit_range";

export type ReviewInput =
  | { mode: "github_pr"; prNumber: number }
  | { mode: "branch"; branchName: string; baseBranch?: string }
  | { mode: "head"; headRef: string; baseRef: string }
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

export type InlineCommentInput = {
  path: string;
  line: number;
  side: "RIGHT" | "LEFT";
  start_line?: number;
  start_side?: "RIGHT" | "LEFT";
  body: string;
};

export type ExistingReviewThread = {
  id: string;
  path?: string;
  line?: number;
  side?: "RIGHT" | "LEFT";
  author: string;
  isCodegenie: boolean;
  fingerprint?: string;
};

export interface GitHubClient {
  viewPr(number: number, opts?: { refresh?: boolean }): Promise<PullRequestMetadata>;
  createReview(
    number: number,
    review: { body: string; event: "COMMENT"; comments: InlineCommentInput[] }
  ): Promise<void>;
  listOwnComments(number: number): Promise<ExistingReviewThread[]>;
}

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
  baseRefName?: string;
  headRef?: string;
  headRefName?: string;
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
export type SymbolLookupSourceSelector = SourceSelector | { kind: "auto" };

export type ToolBackend = "tree-sitter" | "text" | "language-analyzer";
export type ToolPrecision = "exact" | "semantic" | "syntactic" | "heuristic" | "text";

export type ToolResultMeta = {
  backend: ToolBackend;
  precision: ToolPrecision;
  degraded: boolean;
  degradationReason?: string;
  truncated?: boolean;
  omittedCount?: number;
  lookupStatus?: "found" | "not_found" | "ambiguous" | "file_missing" | "unavailable";
  deliveryStatus?: "full" | "truncated" | "budget_rejected" | "empty";
  recovery?: {
    tool: "read_range";
    path: string;
    startLine: number;
    endLine: number;
    source: "head" | "base";
    reason: string;
  };
  requestedSource?: "head" | "base" | "auto";
  sourceUsed?: "head" | "base";
  sourceFallback?: boolean;
  baseOnly?: boolean;
};

export type ToolBudgetState = {
  toolCallsUsed: number;
  maxToolCalls: number;
  investigationRoundsUsed: number;
  maxInvestigationRounds: number;
  resultCharsUsed: number;
  maxResultChars: number;
  remainingResultChars: number;
  maxSingleToolResultChars?: number;
  reservedSourceResultChars?: number;
  toolResultCharLimit?: number;
  sourceExtensionCallsUsed?: number;
  sourceExtensionMaxCalls?: number;
  sourceExtensionResultCharsUsed?: number;
  sourceExtensionMaxResultChars?: number;
  sourceExtensionRemainingResultChars?: number;
  sourceExtensionActive?: boolean;
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

export type SymbolMentionOptions = Pick<SearchOptions, "pathGlob" | "contextMode" | "maxResults" | "source">;

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
  staticSignals?: StaticSignal[];
  omittedSignalCount?: number;
  truncated?: boolean;
  omittedLineCount?: number;
  plannerFallbackReason?: string;
};

export type CoverageLevel = "deep" | "normal" | "light" | "skip";
export type PacketKind = "hunk" | "coalesced-hunks" | "file-diff" | "whole-file";
export type ReviewProfile = "simple" | "standard" | "investigate";

export type ToolBudget = {
  maxToolCalls: number;
  maxInvestigationRounds: number;
  maxResultChars: number;
  maxSingleToolResultChars?: number;
  reservedSourceResultChars?: number;
  sourceExtension?: {
    maxToolCalls: number;
    maxResultChars: number;
  };
};

export type SurroundingContextHintKind =
  | "enclosing_symbol"
  | "call_site"
  | "test"
  | "line_range"
  | "other";

export type SurroundingContextHint = {
  /**
   * `enclosing_symbol` asks Stage 6 to read the named symbol body.
   * `call_site` asks Stage 6 to find caller/usage bodies for the named callee/helper.
   * `line_range` names an explicit line range.
   * Use `other` only when a mechanical retrieval mode does not fit; put semantic intent in `reason`.
   */
  kind: SurroundingContextHintKind;
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

export type PacketContextQuality = "full" | "sliced" | "outline_only" | "path_only";

export type RelatedChangedContext = {
  path: string;
  hunkId?: string | undefined;
  relatedHunkIds?: string[] | undefined;
  symbol?: string | undefined;
  lineRange?: [number, number] | undefined;
  reason: string;
  relationshipSource?: "same_symbol" | "symbol_mention" | "planner_hint" | undefined;
  relationshipStrength?: "strong" | "medium" | "weak" | undefined;
  sourceKind?: "source" | "test" | "docs" | "unknown" | undefined;
  sourceSnippet?: string | undefined;
  patchExcerpt?: string | undefined;
};

export type TestCoverageDeltaSymbol = {
  name: string;
  side: "LEFT" | "RIGHT";
  kind: "test" | "helper" | "mock" | "fixture" | "boundary" | "other";
  source: "diff" | "symbol";
  line?: number;
  lineRange?: [number, number];
};

export type TestCoverageDelta = {
  deletedTestSymbols: TestCoverageDeltaSymbol[];
  addedTestSymbols: TestCoverageDeltaSymbol[];
  deletedHelperSymbols: TestCoverageDeltaSymbol[];
  addedHelperSymbols: TestCoverageDeltaSymbol[];
  deletedImports: string[];
  addedImports: string[];
  deletedProductionRefs: string[];
  addedProductionRefs: string[];
  boundaryIndicators: string[];
  replacementRisk?: "specialized_boundary_to_helper";
  summary: string;
};

export type ReviewPacket = {
  id: string;
  kind: PacketKind;
  prSummary: string;
  intentText?: string;
  intentSignals?: IntentSignals;
  path: string;
  oldPath?: string;
  fileStatus: DiffFile["status"];
  isDeletedContent: boolean;
  language: string;
  reviewPriority: ReviewPriority;
  coverage: Exclude<CoverageLevel, "skip">;
  reviewProfile: ReviewProfile;
  lenses: string[];
  hunks: PacketHunk[];
  symbolFacts: HunkSymbolFacts[];
  context: PacketContext;
  contextText: string;
  contextQuality?: PacketContextQuality;
  contextDegradationReasons?: string[];
  testCoverageDelta?: TestCoverageDelta;
  packetSymbols?: SymbolInfo[];
  relevantTests: SymbolInfo[];
  surroundingContextHints: SurroundingContextHint[];
  labels: string[];
  attentionNotes: string[];
  relatedChangedContext: RelatedChangedContext[];
  toolBudget: ToolBudget;
  degraded?: { reason: string };
  fileContext?: {
    mode: "file-diff" | "whole-file";
    reason: string;
  };
};

export type PlannerRecoveryTelemetry = {
  usedSchemaRepair: boolean;
  usedDeterministicRecovery: boolean;
  firstSubmitValid: boolean;
  unwrappedPlanStringCount: number;
  unwrappedPlanObjectCount: number;
  emptySubmitCount: number;
  invalidSubmitCallCount: number;
  strippedRootKeys: string[];
  misplacedRootKeys: string[];
  recoveredRootKeys: number;
  sparseRecoveredPlan: boolean;
  degraded: boolean;
  reason?: string;
  reviewableSourceHunks: number;
  explicitSourceCoverageEntries: number;
  safetyCoverageApplied?: {
    upgradedHunks: number;
    upgradedPackets: number;
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
    source?: SymbolLookupSourceSelector
  ): Promise<{ text?: string; symbol?: SymbolInfo; meta: ToolResultMeta }>;
  readDiffBlocks(input: { packetId?: string; path?: string }): Promise<{ blocks: string[]; meta: ToolResultMeta }>;
  findDefinition(
    symbolName: string,
    options?: { pathGlob?: string; source?: SymbolLookupSourceSelector }
  ): Promise<{ definitions: Array<{ symbol: SymbolInfo; text?: string }>; meta: ToolResultMeta }>;
  searchFiles(query: string, options?: SearchOptions): Promise<{ results: SearchResult[]; meta: ToolResultMeta }>;
  findSymbolMentions(
    symbolName: string,
    options?: SymbolMentionOptions
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
  ): Promise<{
    context: PacketContext;
    outline?: FileOutline;
    relevantTests: SymbolInfo[];
    degradation?: string;
    primarySymbol?: SymbolInfo;
    packetSymbols?: SymbolInfo[];
    noSymbolHunkIds?: string[];
  }>;
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

export type FindingCategory =
  | "logic_bug"
  | "correctness"
  | "security"
  | "performance"
  | "architecture"
  | "testing"
  | "maintainability";

export type BehaviorChangeAssessment =
  | "accidental_regression"
  | "intentional_needs_confirmation"
  | "specified_change"
  | "unknown";

export type IntentSignal = {
  kind: "refactorLike" | "behaviorChangeLike" | "explicitlyBehaviorPreserving";
  source: "pr_title" | "pr_body" | "commit_title" | "commit_body";
  snippet: string;
  reason: string;
  commitSha?: string;
};

export type IntentSignals = {
  refactorLike: boolean;
  behaviorChangeLike: boolean;
  explicitlyBehaviorPreserving: boolean;
  signals: IntentSignal[];
  summary: string;
};

export type DiffUnderstanding = {
  declaredIntent: string;
  inferredBehavior: string;
};

export type HunkCoverageDecision = {
  hunkId: string;
  path: string;
  coverage: CoverageLevel;
  lenses: string[];
  surroundingContextHints: SurroundingContextHint[];
  reason: string;
  focusNotes?: string[];
  relatedSymbols?: string[];
  relatedFiles?: string[];
};

export type ReviewPlan = {
  diffUnderstanding: DiffUnderstanding;
  intentSignals?: IntentSignals;
  coverage: HunkCoverageDecision[];
  plannerRecovery?: PlannerRecoveryTelemetry;
  partialReview?: {
    isPartial: boolean;
    reason: string;
    reviewedHunks: number;
    totalHunks: number;
  };
};

export type FindingProducer = {
  kind: "packet";
  stage: ReviewStage;
  packetId: string;
  lensId: string;
  skillIds: string[];
  workerId?: string;
};

export type CandidateFindingProvenance = {
  source: "uncertainty_promotion";
  sourceKind: "uncertainty" | "follow_up_hint";
  sourcePacketId: string;
  question: string;
  files: string[];
  symbols: string[];
  reason: string;
};

export type CandidateFinding = {
  id: string;
  title: string;
  severity: Severity;
  // Original model-assigned severity preserved when the behaviorChange cap
  // demoted it (plan 82); the never-hide-critical/high guarantees consult
  // max(severity, severityBeforeCap) so a capped critical cannot be silently
  // suppressed at composition.
  severityBeforeCap?: Severity;
  confidence: Confidence;
  path: string;
  anchor?: DiffAnchor;
  changedLine: boolean;
  category: FindingCategory;
  evidence: {
    changedCode: string;
    relatedCode?: Array<{ path: string; lines: string; whyRelevant: string }>;
  };
  failureMode: string;
  whyThisMatters: string;
  suggestedFix?: string;
  suggestedTest?: string;
  verification: string;
  behaviorChange?: BehaviorChangeAssessment;
  intentEvidence?: string[];
  producedBy: FindingProducer;
  provenance?: CandidateFindingProvenance;
  clusterId?: string;
  duplicateOf?: string;
};

export type StructuredUncertainty = {
  question: string;
  files: string[];
  symbols: string[];
};

export type PacketReviewResult = {
  packetId: string;
  lenses: string[];
  findings: CandidateFinding[];
  reviewStatus?: "findings" | "no_findings" | "incomplete";
  noFindingReason?: string;
  followUpHints: Array<{
    question: string;
    files: string[];
    symbols: string[];
    suggestedLenses: string[];
    reason: string;
    confidence: Confidence;
  }>;
  uncertainties: StructuredUncertainty[];
  status: "completed" | "incomplete" | "failed" | "skipped";
};

export type SystemReviewTask = {
  id: string;
  question: string;
  reason: string;
  confidence: Exclude<Confidence, "low">;
  packetIds: string[];
  files: string[];
  symbols: string[];
  suggestedLenses: string[];
  representativeFindings: CandidateFinding[];
  sourceHintKeys?: string[];
  mergedTaskIds?: string[];
};

export type ResolvedFollowUpHint = {
  taskId: string;
  question: string;
  files: string[];
  symbols: string[];
  resolution: string;
};

export type SystemReviewResult = {
  tasks: SystemReviewTask[];
  packetResults: PacketReviewResult[];
  resolvedHints: ResolvedFollowUpHint[];
};

export type VerificationVerdict = {
  candidateId: string;
  // "incomplete" is runner-assigned only (timeout/budget/schema loss before a
  // real verdict); the model-submitted verdict never carries it.
  verdict: "keep" | "reject" | "revise" | "incomplete";
  reason: string;
  requiredEvidencePresent: boolean;
  falsePositiveRisk: "low" | "medium" | "high";
  finalFinding?: CandidateFinding;
  revisedAnchor?: DiffAnchor;
  verificationIncomplete?: boolean;
  behaviorChange?: BehaviorChangeAssessment;
  intentEvidence?: string[];
};

export type FinalFinding = CandidateFinding & {
  fingerprint: string;
  finalBody: string;
  publication: "inline" | "summary-only" | "suppressed";
  mergedCandidateIds: string[];
  mergedCategories?: FindingCategory[];
  mergedSeverities?: Severity[];
  mergedPaths?: string[];
  mergedTitles?: string[];
  mergedAnchors?: DiffAnchor[];
};

export type RunCoverageStatus = {
  totalHunks: number;
  reviewedHunks: number;
  skippedHunks: number;
  failedHunks: number;
  coverageByLevel: Record<CoverageLevel, number>;
  degradedPlanning: boolean;
  budgetStopped: boolean;
  budgetStop?: BudgetStop;
  unreviewedHunksByPath?: Array<{ path: string; hunks: number; reason: string }>;
  verificationIncompleteCount: number;
  verificationSkipped?: boolean;
  partial: boolean;
  reasons: string[];
};

export type NeedsHumanAttentionNote = {
  question: string;
  files: string[];
  symbols: string[];
  reason: string;
  confidence: Exclude<Confidence, "low">;
  sourcePacketIds?: string[];
};

export type PostingPlan = {
  inline: Array<{ findingId: string; anchor: DiffAnchor }>;
  reviewBody: string;
};

export type ReviewRunStats = {
  model?: {
    provider?: string;
    id?: string;
    reasoning?: ReasoningLevel;
  };
  elapsedMs?: number;
  git?: {
    repo: string;
    base: string;
    head: string;
    headSha?: string;
  };
};

export type ReviewResult = {
  summary: string;
  coverage: RunCoverageStatus;
  runStats?: ReviewRunStats;
  budgetSummary?: BudgetSummary;
  findings: FinalFinding[];
  summaryOnlyFindings: FinalFinding[];
  needsHumanAttention: NeedsHumanAttentionNote[];
  needsHumanAttentionOmittedCount?: number;
  noFindings: boolean;
  postingPlan?: PostingPlan;
  posting?: RunPostingRecord;
};

export type EvalFindingExpectation = {
  id: string;
  tier?: "required" | "optional";
  path?: string;
  lineRange?: [number, number];
  category?: FindingCategory;
  severityAtLeast?: Severity;
  titlePattern?: string;
  failureModePattern?: string;
};

export type EvalCase = {
  name: string;
  repo?: {
    external?: string;
    fixture?: string;
  };
  command?: {
    pr?: number;
    branch?: string;
    head?: string;
    base?: string;
    target?: string;
  };
  review?: {
    depth?: ReviewDepth;
    lenses?: string[];
    maxFindings?: number;
    concurrency?: number;
    budgetBoost?: number;
    maxTimeMinutes?: number;
    verify?: boolean;
    cache?: boolean;
    cacheDir?: string;
    debug?: boolean;
    provider?: string;
    model?: string;
    reasoning?: ReasoningLevel;
  };
  llm?: {
    provider?: string;
    model?: string;
    reasoning?: ReasoningLevel;
    maxConcurrentCalls?: number;
  };
  logs?: {
    dir?: string;
  };
  artifacts?: {
    path: string;
  };
  expect?: {
    minFindings?: number;
    maxFindings?: number;
    maxDuplicateGroups?: number;
    maxCostUSD?: number;
    maxElapsedSeconds?: number;
    maxModelCalls?: number;
    maxToolCalls?: number;
    maxPromptCharsByStage?: Partial<Record<ReviewStage | string, number>>;
    reviewCompleteness?: "complete" | "partial";
    maxBudgetOverruns?: number;
    maxToolBudgetRejections?: number;
    maxDegradedHunks?: number;
    maxUnresolvedNotesSuppressed?: number;
  };
  should_find?: EvalFindingExpectation[];
  should_find_candidate?: EvalFindingExpectation[];
  should_not_find?: EvalFindingExpectation[];
};

export type EvalLossLabel =
  | "missed-before-candidate-generation"
  | "lost-at-verification"
  | "lost-at-composition"
  | "partial-match";

export type EvalExpectationList = "should_find" | "should_find_candidate" | "should_not_find";

export type EvalMatchOutcome = {
  matched: boolean;
  fields: Array<{
    field: "path" | "lineRange" | "category" | "severityAtLeast" | "titlePattern" | "failureModePattern";
    present: boolean;
    matched: boolean;
    expected?: string;
    actual?: string;
    via?: string;
  }>;
};

export type EvalAssignment = {
  pairs: Array<{ expectationId: string; findingId: string }>;
  unmatchedExpectationIds: string[];
  unmatchedFindingIds: string[];
};

export type EvalLossDetail = {
  label: EvalLossLabel;
  subReason?: string;
  nearestInstances: Array<{
    findingId?: string;
    artifact: "final-findings" | "final-selection" | "verification" | "candidate-findings" | "events";
    outcome: string;
    fieldMismatches?: EvalMatchOutcome["fields"];
  }>;
  matchingHints?: Array<{
    packetId?: string;
    question: string;
    files: string[];
    symbols: string[];
    confidence: Confidence;
  }>;
  coveringPacketIds?: string[];
  coveringPacketLenses?: string[];
  plannerCoverage?: string;
};

export type EvalExpectationResult = {
  expectationId: string;
  list: EvalExpectationList;
  tier?: "required" | "optional";
  status: "pass" | "fail" | "skipped";
  skipReason?: string;
  fromReplayedArtifacts?: boolean;
  matched: Array<{ findingId: string; artifact: "final-findings" | "candidate-findings" }>;
  loss?: EvalLossDetail;
  note?: string;
};

export type EvalViolation = {
  expectationId: string;
  findingId: string;
  publication: "inline" | "summary-only";
};

export type EvalBudgetResult = {
  check:
    | "minFindings"
    | "maxFindings"
    | "maxDuplicateGroups"
    | "maxCostUSD"
    | "maxElapsedSeconds"
    | "maxModelCalls"
    | "maxToolCalls"
    | "maxPromptCharsByStage"
    | "reviewCompleteness"
    | "maxBudgetOverruns"
    | "maxToolBudgetRejections"
    | "maxDegradedHunks"
    | "maxUnresolvedNotesSuppressed";
  stage?: ReviewStage;
  status: "pass" | "fail" | "skipped";
  skipReason?: string;
  limit?: number;
  actual?: number;
  expected?: string;
  actualText?: string;
  direction: "minimum" | "maximum" | "equals";
  fromReplayedArtifacts?: boolean;
};

export type EvalRunMetrics = {
  reportedFindings: number;
  inlineFindings: number;
  summaryOnlyFindings: number;
  suppressedFindings: number;
  candidateFindings: number;
  duplicateGroups: number;
  costUSD?: number;
  elapsedSeconds?: number;
  modelCalls?: number;
  verificationCalls?: number;
  toolCalls?: number;
  toolChoiceDowngradedCalls?: number;
  maxPromptCharsByStage?: Partial<Record<ReviewStage, number>>;
  reviewCompleteness?: "complete" | "partial";
  budgetOverruns?: number;
  toolBudgetRejections?: number;
  toolBudgetExtensions?: number;
  toolBudgetExtensionDenials?: number;
  degradedHunks?: number;
  unresolvedNotesSuppressed?: number;
  localModelCallCacheHits?: number;
  localModelCallCacheMisses?: number;
  localModelCallCacheWrites?: number;
  providerPromptCacheReadTokens?: number;
  providerPromptCacheWriteTokens?: number;
  providerPromptCacheReadCostUSD?: number;
  providerPromptCacheWriteCostUSD?: number;
  schemaInvalidCalls?: number;
  schemaInvalidRecovered?: number;
  schemaInvalidUnrecovered?: number;
  schemaRepairAttempts?: number;
  schemaRepairRecovered?: number;
  deterministicSchemaRecovered?: number;
  schemaRecoveryFailed?: number;
  /** @deprecated Use localModelCallCacheHits. */
  cacheHits?: number;
  /** @deprecated Use localModelCallCacheMisses. */
  cacheMisses?: number;
  stageLossCounts: Record<EvalLossLabel, number>;
};

export type EvalScore = {
  status: "pass" | "fail" | "error";
  expectationResults: EvalExpectationResult[];
  budgetResults: EvalBudgetResult[];
  violations: EvalViolation[];
  nearViolations: Array<{ expectationId: string; findingId: string; artifact: string }>;
  metrics: EvalRunMetrics;
  error?: { code: import("./util/errors.js").CodegenieErrorCode; message: string };
};

export type CodegenieRuntimeProvenance = {
  packageVersion: string;
  commit?: string;
  shortCommit?: string;
  branch?: string;
  dirty?: boolean;
  source: "build_env" | "git" | "package" | "unknown";
};

export type EvalRunInfo = {
  runNumber: number;
  caseName: string;
  caseFile?: string;
  caseHash: string;
  caseSnapshot: EvalCase;
  mode: "live" | "replay";
  replay?: {
    sourceArtifacts: string;
    caseSource: "yaml" | "snapshot";
  };
  repo?: { root: string; baseSha?: string; headSha?: string; mergeBase?: string };
  reviewRunId?: string;
  codegenieRuntime?: CodegenieRuntimeProvenance;
  cache: { enabled: boolean; source: "cli" | "case" | "config"; dir?: string };
  effectiveConfig?: {
    review: {
      concurrency: number;
      timeoutMs: number;
    };
    llm: {
      provider?: string;
      model?: string;
      reasoning?: ReasoningLevel;
      maxConcurrentCalls: number;
    };
  };
  startedAt: string;
  finishedAt: string;
  score: EvalScore;
};

export type EvalCaseResult = {
  caseName: string;
  runDir: string;
  status: "pass" | "fail" | "error";
  info: EvalRunInfo;
};

export type EvalVerificationRecord =
  | {
      candidateId: string;
      gate: "suppressed" | "gate_anchor_stripped";
      gateDecision?: "suppressed" | "scheduled" | "scheduled_for_evidence_resolution";
      gateReason: string;
      verificationLane?: "standard" | "evidence_resolution";
      gateFacts?: Record<string, unknown>;
      candidateProvenance?: CandidateFindingProvenance;
      duplicateOf?: string;
      clusterId?: string;
    }
  | {
      candidateId: string;
      gate: "passed" | "gate_anchor_stripped";
      verdict: VerificationVerdict;
      gateDecision?: "suppressed" | "scheduled" | "scheduled_for_evidence_resolution";
      gateReason?: string;
      verificationLane?: "standard" | "evidence_resolution";
      gateFacts?: Record<string, unknown>;
      candidateProvenance?: CandidateFindingProvenance;
      duplicateOf?: string;
      clusterId?: string;
    };

export type EvalSelectionRecord = {
  findingId: string;
  decision: "published" | "merged" | "suppressed";
  reason: string;
  mergedIntoFingerprint?: string;
};

export type EvalHintEvent = {
  packetId?: string;
  question: string;
  files: string[];
  symbols: string[];
  reason?: string;
  confidence: Confidence;
};

export type EvalArtifacts = {
  candidates: CandidateFinding[];
  verification: EvalVerificationRecord[];
  finalSelection: EvalSelectionRecord[];
  finalFindings: FinalFinding[];
  reviewPlan?: ReviewPlan;
  packets: ReviewPacket[];
  hintEvents: EvalHintEvent[];
  coverage?: RunCoverageStatus & { hunks?: unknown[] };
  metricsSources: {
    costProfile?: unknown;
    modelCallsSummary?: unknown;
    toolCallsSummary?: unknown;
    budgetSummary?: BudgetSummary;
    runJson?: unknown;
    telemetry?: unknown;
    modelCalls?: unknown[];
    toolCalls?: unknown[];
  };
};

export type EvalCompareReport = {
  caseName: string;
  currentRun: number;
  previousRun: number;
  caseHashChanged: boolean;
  statusChange?: { from: EvalScore["status"]; to: EvalScore["status"] };
  regressions: Array<{ expectationId: string; lossLabel?: EvalLossLabel }>;
  fixes: Array<{ expectationId: string }>;
  lossLabelChanges: Array<{ expectationId: string; from: EvalLossLabel; to: EvalLossLabel }>;
  newViolations: EvalViolation[];
  resolvedViolations: EvalViolation[];
  budgetChanges: Array<{ check: string; from: "pass" | "fail" | "skipped"; to: "pass" | "fail" | "skipped" }>;
  findingDiff: {
    added: Array<{ fingerprint: string; title: string; severity: Severity; publication: string }>;
    removed: Array<{ fingerprint: string; title: string; severity: Severity; publication: string }>;
    changed: Array<{ fingerprint: string; changes: Record<string, { from: string; to: string }> }>;
  };
  metricDeltas: Record<string, { previous?: number; current?: number; delta?: number }>;
};

export type FindingDuplicateDecision = {
  findingId: string;
  action: "post" | "skip_exact_fingerprint" | "skip_fuzzy_proximity";
  matchedCommentId?: string;
  reason: string;
};

export type RunPostingRecord = {
  attempted: boolean;
  status: "posted" | "skipped_no_findings" | "skipped_all_duplicates" | "summary_only_fallback" | "failed";
  inlinePosted: number;
  demotedToBody: number;
  skippedDuplicates: number;
  attempts: Array<{ httpStatus?: number; commentCount: number; outcome: "ok" | "rejected" | "error" }>;
  error?: string;
  duplicateDecisions?: FindingDuplicateDecision[];
};

export type DossierHunkEntry = {
  hunkId: string;
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  changedNewLineNumbers: number[];
  changedOldLineNumbers: number[];
  symbolFacts?: HunkSymbolFacts;
  staticSignals: StaticSignal[];
  omittedSignalCount: number;
  excerpt?: string;
};

export type DossierFileEntry = {
  path: string;
  oldPath?: string;
  status: DiffFile["status"];
  language: string;
  processingMode: ProcessingMode;
  testStatus: FileFacts["testStatus"];
  packageRoot?: string;
  labels: string[];
  reviewPriority: ReviewPriority;
  changedLines: number;
  hunkCount: number;
  degraded?: { reason: string };
  hunks: DossierHunkEntry[];
};

export type DossierDirectoryRollup = {
  root: string;
  fileCount: number;
  hunkCount: number;
  changedLines: number;
  languages: string[];
  labels: string[];
  maxReviewPriority: ReviewPriority;
  testFileCount: number;
  representativePaths: string[];
  hunkIds: string[];
  hunkLanguages: Record<string, string>;
};

export type DossierCompaction = {
  level: "full" | "compacted" | "chunked";
  omitted: Array<{ what: string; count: number; reason: string }>;
  chunkCount?: number;
  chunkIndex?: number;
  chunkRoot?: string;
};

export type PlannerDossier = {
  runId: string;
  mode: ReviewMode;
  depth: ReviewDepth;
  target: {
    baseRef?: string;
    headRef?: string;
    headSha?: string;
    mergeBase?: string;
  };
  pr?: {
    title: string;
    body: string;
    url: string;
    baseRefName: string;
    headRefName: string;
  };
  commits: Array<{ sha: string; title: string; body: string }>;
  intentSignals?: IntentSignals;
  policyFilesChanged: string[];
  files: DossierFileEntry[];
  directories: DossierDirectoryRollup[];
  filterSummary: {
    keptFiles: number;
    skippedFiles: number;
    skipped: Array<{ path: string; reason: string }>;
  };
  lenses: Array<{ id: string; summary: string }>;
  totals: {
    files: number;
    keptFiles: number;
    hunks: number;
    addedLines: number;
    deletedLines: number;
  };
  compaction: DossierCompaction;
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
  lookupStatus?: ToolResultMeta["lookupStatus"];
  deliveryStatus?: ToolResultMeta["deliveryStatus"];
  recovery?: ToolResultMeta["recovery"];
  budgetState?: ToolBudgetState;
  cacheStatus?: "hit" | "miss" | "disabled" | "write";
  backendExecuted?: boolean;
  cacheHitKind?: "stored" | "inflight";
  cacheEvictedEntries?: number;
  resultCount?: number;
  resultChars: number;
  durationMs: number;
  status: "ok" | "error" | "rejected" | "skipped";
  errorCode?: import("./util/errors.js").CodegenieErrorCode;
};

export type RepositoryToolCallContext = {
  stage: ReviewStage;
  initiator: "model" | "harness";
  record?: boolean;
  workerId?: string;
  packetId?: string;
  taskId?: string;
  candidateId?: string;
  modelCallId?: string;
};

export type RunOutcomeStatus = "completed_full" | "completed_partial" | "failed";

export type BudgetStopReason =
  | "runtime_reserved_tail"
  | "max_model_calls"
  | "max_total_tokens"
  | "hard_timeout";

export type BudgetStop = {
  reason: BudgetStopReason;
  stage: ReviewStage | 0;
  elapsedMs: number;
  timeoutMs: number;
  hardTimeoutMs: number;
  remainingRuntimeMs: number;
  reservedTailRuntimeMs: number;
  modelCalls: number;
  inFlightModelCalls: number;
  projectedModelCalls: number;
  maxModelCalls?: number;
  remainingModelCalls?: number;
  reservedModelCalls?: number;
  totalTokens: number;
  inFlightTokens: number;
  projectedTokens: number;
  maxTotalTokens?: number;
  remainingTokens?: number;
  reservedTokens?: number;
};

export type BudgetUsageByStage = {
  stage: ReviewStage;
  modelCalls: number;
  totalTokens: number;
};

export type BudgetLimitEvent = {
  stage: ReviewStage | 0;
  reason: BudgetStopReason;
  elapsedMs: number;
  kind: "runtime" | "model_calls" | "tokens";
  actual: number;
  limit: number;
  totalTokens: number;
  modelCalls: number;
  afterDispatchedCall: boolean;
};

export type ContextPressureSummary = {
  toolBudgetRejections: number;
  toolBudgetRejectionsByStage: Partial<Record<ReviewStage, number>>;
  toolBudgetExtensions?: {
    granted: number;
    denied: number;
    resultChars: number;
    grantedByStage: Partial<Record<ReviewStage, number>>;
    deniedByStage: Partial<Record<ReviewStage, number>>;
  };
  degradedToolResults: number;
  degradedToolResultsByStage: Partial<Record<ReviewStage, number>>;
  degradedHunks: number;
  rejectionReasons: Array<{ reason: string; count: number }>;
  unresolvedNotes: {
    emitted: number;
    omitted: number;
  };
};

export type BudgetSummary = {
  completeness: "complete" | "partial";
  partialReasons: string[];
  multiplier: number;
  configured: {
    timeoutMs: number;
    maxModelCalls?: number;
    maxTotalTokens?: number;
  };
  effective: {
    timeoutMs: number;
    maxModelCalls?: number;
    maxTotalTokens?: number;
  };
  usage: {
    modelCalls: number;
    totalTokens: number;
    costUSD?: number;
    byStage: BudgetUsageByStage[];
  };
  overruns: BudgetLimitEvent[];
  dispatchBlocks: BudgetLimitEvent[];
  contextPressure?: ContextPressureSummary;
};

export type RunOutcome = {
  status: RunOutcomeStatus;
  errorCode?: import("./util/errors.js").CodegenieErrorCode;
  exitCode: number;
  budgetStop?: BudgetStop;
};
