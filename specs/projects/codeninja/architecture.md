---
status: draft
---

# Architecture: codeninja

## Architecture Scope

codeninja is a TypeScript CLI that reviews pull-request-style diffs using a staged, telemetry-rich AI review pipeline. The architecture is intentionally split into:

- `architecture.md`: system-level components, data contracts, and cross-component flow.
- `components/*.md`: detailed designs for the complex internals after this architecture is approved.

Component docs are required because the review pipeline, repository intelligence layer, GitHub posting, skills/lenses, LLM runner, verifier/composer, and telemetry/eval support each have enough complexity to warrant separate designs. Those component docs should preserve a minimal v1 path rather than turning every possible enhancement into a first implementation requirement.

## Implementation Philosophy

codeninja should be a specialized review workflow harness, not a generic agent asked to remember the workflow from a skill file. The harness owns the stage order, data contracts, concurrency, validation, GitHub anchoring, and telemetry. Pi agents and Markdown skills provide reasoning inside those stages.

The v1 implementation should stay close to a CodeGenie-style backbone:

1. Resolve target and collect diff.
2. Filter ignored, generated, vendored, binary, and lock files.
3. Classify files into simple processing facts such as language, processing mode, package root, test/generated/vendor/lock/binary status, configured labels, and configured priority.
4. Build a review plan with focus areas, coverage decisions, and file/hunk groups.
5. Build review packets from files and hunks.
6. Route selected skills/lenses to those packets.
7. Retrieve seed context and expose read-only repo tools.
8. Run model review per scheduled packet.
9. Verify, dedupe, compose, and optionally publish.

The first implementation should favor simple deterministic heuristics plus structured model calls over an elaborate semantic-analysis platform. Advanced repository intelligence should be added behind stable interfaces when telemetry shows it improves review quality.

## Technology Choices

Runtime and package management:

- Node.js with TypeScript.
- `pnpm` for package management.
- ESM modules.

Core dependencies:

- `@earendil-works/pi-ai` for LLM/agent execution, wrapped behind an internal adapter.
- `commander` for CLI parsing.
- `zod` for config and LLM output validation.
- `p-limit` for bounded concurrency.
- A TOML parser for `codeninja.toml`.
- `execa` or Node subprocess APIs for `git` and `gh`.
- `web-tree-sitter` plus Go and TypeScript/JavaScript grammars for v1 syntax parsing.

External CLI dependencies:

- `git` is required for all review modes.
- `gh` is required for `--pr` mode and `--post-github-comments`.

The implementation should keep library-specific APIs behind small internal interfaces. The coding surface should depend on `LlmRunner`, `GitClient`, `GitHubClient`, and `RepositoryIndex` interfaces rather than directly coupling the full pipeline to third-party APIs.

## High-Level Flow

```text
CLI args
  -> config loader
  -> review input resolver
  -> git/GitHub metadata collection
  -> diff parser
  -> file filtering and simple file classification
  -> optional syntax index and changed-symbol graph
  -> scout/planner
  -> review packet builder
  -> selected lens runners with bounded concurrency
  -> cross-file/system pass
  -> verifier workers
  -> deduper/ranker/composer
  -> stdout renderer
  -> optional GitHub publisher
  -> telemetry artifacts
```

The pipeline must never require loading the entire repository into model context. It gives each model call focused packets and read-only repository tools.

## Project Layout

```text
src/
  cli/
    main.ts
    review-command.ts
  config/
    config-loader.ts
    schema.ts
  git/
    git-client.ts
    review-input-resolver.ts
    diff-parser.ts
  github/
    github-client.ts
    publisher.ts
    duplicate-detector.ts
  repo/
    repository-index.ts
    language-adapter.ts
    tree-sitter/
      tree-sitter-service.ts
      go-adapter.ts
      typescript-adapter.ts
      generic-adapter.ts
  skills/
    skill-loader.ts
    lens-registry.ts
    prompt-builder.ts
  pipeline/
    review-runner.ts
    planner.ts
    packet-builder.ts
    lens-runner.ts
    system-reviewer.ts
    verifier.ts
    composer.ts
  llm/
    llm-runner.ts
    pi-runner.ts
    schemas.ts
  telemetry/
    telemetry-recorder.ts
    run-artifacts.ts
  output/
    markdown-renderer.ts
    stdout-renderer.ts
  util/
    errors.ts
    result.ts
    hashing.ts
skills/
  core/
  lang/
  domain/
```

Repo-local user data:

```text
.codeninja/
  skills/              # user-provided Markdown skills, trackable by git
  runs/<run-id>/       # local telemetry/debug artifacts, ignored by git
codeninja.toml
```

Only `.codeninja/runs/` is git-ignored. `.codeninja/skills/` should remain trackable so teams can version project review policy.

## Core Data Model

### Review Input

```ts
type ReviewMode = "github_pr" | "branch" | "commit_range" | "diff_file"

type ReviewInput =
  | { mode: "github_pr"; prNumber: number }
  | { mode: "branch"; branchName: string; baseBranch?: string }
  | { mode: "commit_range"; startCommit: string; endCommit?: string }
  | { mode: "diff_file"; diffPath: string }

type ResolvedReviewInput = {
  mode: ReviewMode
  repoRoot: string
  baseRef?: string
  headRef?: string
  startCommit?: string
  endCommit?: string
  mergeBase?: string
  headSha?: string
  pr?: PullRequestMetadata
  commits: CommitInfo[]
  diff: UnifiedDiff
}

type PullRequestMetadata = {
  owner: string
  repo: string
  number: number
  title: string
  body: string
  url: string
  baseRefName: string
  baseSha: string
  headRefName: string
  headSha: string
}

type CommitInfo = {
  sha: string
  title: string
  body: string
  authorName?: string
  authoredAt?: string
}
```

### Diff Model

```ts
type UnifiedDiff = {
  files: DiffFile[]
}

type DiffFile = {
  path: string
  oldPath?: string
  status: "added" | "modified" | "deleted" | "renamed"
  language: string
  hunks: DiffHunk[]
}

type DiffHunk = {
  id: string
  path: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  header: string
  lines: DiffLine[]
}

type DiffLine = {
  kind: "context" | "add" | "delete"
  content: string
  oldLineNumber?: number
  newLineNumber?: number
}
```

Every review packet must include absolute line numbers for hunk lines. Added and context lines use new-file line numbers. Deleted lines use old-file line numbers. GitHub inline publishing is only allowed for anchors validated against the PR diff.

### Repository Intelligence

```ts
type SymbolKind =
  | "function"
  | "method"
  | "class"
  | "type"
  | "interface"
  | "const"
  | "var"
  | "module"

type SymbolRef = {
  path: string
  name: string
  kind: SymbolKind
  lineRange: [number, number]
}

type SymbolInfo = SymbolRef & {
  exported?: boolean
  receiverType?: string
  packageName?: string
  signature?: string
}

type ChangedSymbol = SymbolInfo & {
  changedLines: number[]
  callers?: SymbolRef[]
  tests?: SymbolRef[]
}

type SymbolEdge = {
  from: SymbolRef
  to: SymbolRef
  kind: "calls" | "implements" | "imports" | "tests" | "references"
  confidence: "syntactic" | "heuristic" | "semantic"
  source: "tree-sitter" | "ripgrep" | "lsp" | "compiler" | "custom"
}

type ChangedSymbolGraph = {
  symbols: ChangedSymbol[]
  edges: SymbolEdge[]
}

type HunkSymbolFacts = {
  path: string
  hunkId: string
  enclosingSymbol?: string
  symbolKind?: SymbolKind
  symbolRange?: [number, number]
  changedLines: number[]
  signature?: string
  source: "tree-sitter" | "fallback"
  confidence: "syntactic" | "heuristic"
}

type ProcessingMode = "per-hunk" | "whole-file" | "skip"
type ReviewPriority = "critical" | "high" | "normal" | "low"

type FactProvenance = {
  fact: string
  source: "path" | "filename" | "extension" | "parser" | "git" | "diff" | "config" | "generated_detector"
  confidence: "high" | "medium" | "low"
  reason: string
}

type FileFacts = {
  path: string
  language: string
  packageRoot?: string
  processingMode: ProcessingMode
  testStatus: "test" | "source" | "mixed" | "unknown"
  isGenerated: boolean
  isVendored: boolean
  isLockfile: boolean
  isBinary: boolean
  changedLines: number
  hunkCount: number
  labels: string[]
  reviewPriority: ReviewPriority
  reasons: string[]
  provenance: FactProvenance[]
}
```

Tree-sitter-backed graph facts are syntactic or heuristic unless a richer language adapter provides semantic evidence. The LLM may reason over the graph, but graph construction itself must be deterministic.

Changed-symbol extraction is a local indexing step, not an LLM stage. It parses changed files, maps hunk line ranges to enclosing symbols, and emits compact `HunkSymbolFacts` for planner and packet construction. If parsing fails, the pipeline falls back to hunk/file metadata without blocking review.

File classification is deterministic, narrow, and auditable by default. It uses path rules, filenames, extensions, package-root detection, generated/vendor/lockfile/binary detectors, diff metadata, and `codeninja.toml` rules. The LLM is not part of the default classifier.

The core classifier must not ship with hardcoded business/domain risk keyword lists. Labels and criticality come from explicit project configuration, while the planner and skills may reason about risk from the diff, symbols, static signals, and configured labels.

### Review Planning

```ts
type ReviewPlan = {
  intent: string
  riskAreas: Array<{
    area: string
    reason: string
    files: string[]
    suggestedLenses: string[]
  }>
  changedAPIs: string[]
  testsTouched: string[]
  missingTestSuspicions: string[]
  reviewOrder: string[]
  coverage: PlannedReviewTarget[]
  packetGroups: Array<{
    groupId: string
    packetIds: string[]
    lenses: string[]
    priority: "high" | "medium" | "low"
    canRunInParallel: boolean
    reason: string
  }>
  systemReviewTasks: Array<{
    topic: string
    files: string[]
    symbols: string[]
    lenses: string[]
    question: string
  }>
  partialReview?: {
    isPartial: boolean
    reason: string
    reviewedHunks: number
    totalHunks: number
  }
}

type CoverageLevel = "deep" | "normal" | "light" | "skip"
type ReviewPacketKind = "hunk" | "coalesced-hunks" | "file-diff" | "whole-file"

type PlannedReviewTarget = {
  hunkId: string
  path: string
  coverage: CoverageLevel
  lenses: string[]
  reason: string
}
```

The planner is the only stage allowed to decide review ordering, lens selection, and coverage level. It must not select every lens for every packet by default. Every changed hunk must either be assigned a coverage level or explicitly skipped with a reason.

Later stages may validate planner decisions and apply deterministic fallbacks, but they must not become independent risk classifiers. If a reviewable hunk has no valid planner coverage, packet construction falls back to `normal` and records the fallback reason in telemetry. If the planner skips a reviewable hunk without a valid reason, packet construction also falls back to `normal`.

Large PRs use hierarchical planning when the deterministic planner dossier exceeds configured model or budget limits:

```text
full deterministic inventory
  -> group by subsystem/package/language/file type/configured labels/planner risk area
  -> compact group summaries
  -> optional sub-plans per group
  -> meta-plan merged into ReviewPlan
```

The deterministic inventory is complete even when model context is limited. It includes changed files, hunks, line counts, languages, file processing facts, configured labels/priorities, changed symbols, exported API/interface changes, tests touched, generated/vendor/lockfile detection, package/build/test config summaries, and static signals. Model calls receive budgeted summaries of that inventory.

Coverage rules:

- `deep`: changes with strong risk evidence, including configured critical paths, exported API/interface changes, migrations, lifecycle/concurrency-sensitive code identified by symbols or skills, or planner-inferred risks backed by concrete diff evidence.
- `normal`: ordinary application logic.
- `light`: low-risk, repetitive, or mostly mechanical changes.
- `skip`: generated, vendored, binary, irrelevant, or otherwise intentionally unreviewed hunks.

Partial reviews must be explicit. If the configured runtime, token, or provider-call budget prevents full review, `partialReview.isPartial` must be true and the final output must report coverage counts.

### Review Packets

```ts
type ReviewPacketHunk = {
  hunkId: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  header?: string
  contentWithLineNumbers: string
  changedLineNumbers: number[]
}

type ToolBudget = {
  maxToolCalls: number
  maxInvestigationRounds: number
  maxResultChars: number
}

type ReviewPacket = {
  id: string
  kind: ReviewPacketKind
  prSummary: string
  path: string
  language: string
  coverage: Exclude<CoverageLevel, "skip">
  lenses: string[]
  hunks: ReviewPacketHunk[]
  symbolFacts: HunkSymbolFacts[]
  context: HunkContext
  relevantTests: SymbolInfo[]
  relatedFilesHint: string[]
  labels: string[]
  riskNotes: string[]
  toolBudget: ToolBudget
  fileContext?: {
    mode: "file-diff" | "whole-file"
    reason: string
  }
}

type HunkContext = {
  path: string
  packageName?: string
  enclosingFunction?: SymbolInfo
  enclosingType?: SymbolInfo
  enclosingMethod?: SymbolInfo
  changedNodes: AstNodeSummary[]
  importsUsedNearby: string[]
  nearbySiblingFunctions: SymbolInfo[]
  testsForSymbol: SymbolInfo[]
}

type AstNodeSummary = {
  type: string
  name?: string
  lineRange: [number, number]
  summary: string
}

type PacketReviewResult = {
  packetId: string
  lenses: string[]
  findings: CandidateFinding[]
  followUpHints: Array<{
    question: string
    files: string[]
    symbols: string[]
    suggestedLenses: string[]
    reason: string
  }>
  uncertainties: string[]
  filesRead: string[]
  toolCalls: Array<{
    tool: string
    target?: string
    durationMs: number
    status: "ok" | "error" | "skipped"
  }>
  status: "completed" | "incomplete" | "failed" | "skipped"
}
```

Review packets are persisted to telemetry artifacts so evals can inspect what context the reviewer saw. Every packet contains one or more hunks. `ReviewPacket.kind` explains why those hunks are reviewed together, while `ReviewPacket.coverage` controls execution budget and prompting.

Packet construction algorithm:

1. Build one planned hunk record per changed hunk from diff data, file facts, `HunkSymbolFacts`, planner coverage, selected lenses, processing mode, labels, and estimated size.
2. Validate planner output and apply deterministic fallbacks for missing coverage, invalid skip reasons, or empty lens sets.
3. Apply file processing mode: skip files produce coverage records only; whole-file files produce one file packet when size limits allow; all other files default to hunk-first packets.
4. Group hunks conservatively: one packet per hunk by default; coalesce only same-file hunks that share an enclosing symbol or are very nearby and still fit strict size limits.
5. Never coalesce across files in v1. Cross-file concerns become system review tasks.
6. Enforce max hunks, patch chars, context chars, and skill/lens prompt caps. Split oversized packets back into smaller packets.
7. Compute packet coverage as the max coverage of included hunks, ordered `deep > normal > light`.
8. Compute packet lenses as the bounded union of included hunk lenses, keeping core and primary language lenses when applicable.

### Findings And Anchors

```ts
type Severity = "critical" | "high" | "medium" | "low"
type Confidence = "high" | "medium" | "low"

type FindingCategory =
  | "logic_bug"
  | "correctness"
  | "security"
  | "performance"
  | "architecture"
  | "testing"
  | "maintainability"

type DiffAnchor = {
  path: string
  line: number
  side: "RIGHT" | "LEFT"
  hunkId: string
  startLine?: number
  startSide?: "RIGHT" | "LEFT"
  commitSha?: string
  diffPosition?: number
}

type CandidateFinding = {
  id: string
  title: string
  severity: Severity
  confidence: Confidence
  path: string
  anchor: DiffAnchor
  changedLine: boolean
  category: FindingCategory
  evidence: {
    changedCode: string
    relatedCode?: Array<{ path: string; lines: string; whyRelevant: string }>
  }
  failureMode: string
  whyThisMatters: string
  suggestedFix?: string
  suggestedTest?: string
  verification: string
  producedBy: {
    stage: string
    lensId: string
    skillIds: string[]
    packetId: string
    workerId?: string
  }
}

type VerificationVerdict = {
  verdict: "keep" | "reject" | "revise"
  reason: string
  requiredEvidencePresent: boolean
  falsePositiveRisk: "low" | "medium" | "high"
  finalFinding?: CandidateFinding
}

type FinalFinding = CandidateFinding & {
  fingerprint: string
  finalBody: string
}
```

Candidate findings are invalid unless they include evidence, a concrete failure mode, and an anchor. Inline GitHub publishing also requires a valid changed-line anchor.

## Component Breakdown

### CLI And Config

Responsibilities:

- Parse `codeninja review` arguments.
- Load `codeninja.toml`.
- Merge config from defaults, repo config, environment, and CLI flags.
- Validate config with `zod`.
- Start a run and create `.codeninja/runs/<run-id>/`.

Precedence:

```text
CLI flags > environment variables > codeninja.toml > defaults
```

Default config:

```ts
type CodeninjaConfig = {
  lenses: {
    enabled: string[]
    disabled: string[]
    extraSkillPaths: string[]
  }
  review: {
    maxFindings: number
    softCommentCap: number
    minConfidence: "medium"
    minInlineConfidence: "medium"
    concurrency: number
    timeoutMs: number
    perPassTimeoutMs: number
  }
  github: {
    postComments: boolean
    postSummary: boolean
    summaryWhenNoFindings: boolean
  }
  git: {
    defaultBaseBranch?: string
  }
  classification: {
    pathRules: Array<{
      pattern: string
      processingMode?: ProcessingMode
      reviewPriority?: ReviewPriority
      labels?: string[]
      reason: string
    }>
  }
  llm: {
    provider?: string
    model?: string
    maxConcurrentCalls: number
  }
  tools: {
    allowReadOnly: true
    testCommands: string[]
    testCommandTimeoutMs: number
  }
  telemetry: {
    enabled: boolean
    debugTrace: boolean
    runDir: string
    retainRuns: number
  }
}
```

Chosen defaults:

- `review.concurrency = 4`
- `llm.maxConcurrentCalls = 2`
- `review.timeoutMs = 30 * 60 * 1000`
- `review.perPassTimeoutMs = 5 * 60 * 1000`
- `github.postComments = false`
- `github.postSummary = true`
- `github.summaryWhenNoFindings = false`
- `git.defaultBaseBranch = undefined`
- `classification.pathRules = []`
- `telemetry.enabled = true`
- `telemetry.debugTrace = false`
- `telemetry.runDir = ".codeninja/runs"`
- `telemetry.retainRuns = 20`

Example path classification config:

```toml
[git]
defaultBaseBranch = "main"

[[classification.pathRules]]
pattern = "lib/payments/**"
reviewPriority = "critical"
labels = ["payments", "critical-path"]
processingMode = "per-hunk"
reason = "Payments code is business-critical and should receive deeper review."

[[classification.pathRules]]
pattern = "generated/**"
labels = ["generated"]
processingMode = "skip"
reason = "Generated files are not reviewed directly."
```

### Git And GitHub Input Resolver

Responsibilities:

- Verify the command runs inside a git worktree.
- Resolve review input into base/head refs, merge base, commits, changed files, and unified diff.
- Fetch missing PR refs for `--pr` without changing the user's current branch.
- Collect commit titles and descriptions across the reviewed range.
- Provide file content at base/head refs for syntax parsing.

`--pr` flow:

1. Run `gh pr view <number>` to fetch title, body, URL, base/head refs, and base/head SHAs.
2. Check whether base and head commits exist locally with `git cat-file -e`.
3. If missing, fetch into internal refs:
   - `refs/codeninja/pr/<number>/base`
   - `refs/codeninja/pr/<number>/head`
4. Do not checkout, reset, stash, or mutate the working tree.
5. Compute merge base and diff locally.
6. Collect commit metadata with `git log <mergeBase>..<head>`.

`--branch --base` flow:

1. Resolve the review branch locally.
2. Resolve the base branch in precedence order: CLI `--base`, `codeninja.toml` `git.defaultBaseBranch`, existing `master`, existing `main`.
3. If no base branch resolves, fail with a clear error asking the user to pass `--base` or configure `git.defaultBaseBranch`.
4. Compute merge base between the base branch and branch head.
5. Diff `mergeBase..branchHead`.
6. Collect commit metadata with `git log mergeBase..branchHead`.

Commit or commit range flow:

1. Resolve the start commit and optional end commit locally.
2. With one commit, diff the commit's first parent against the commit.
3. With two commits, diff the start commit against the end commit.
4. Collect commit metadata for the single commit or reviewed range.

`--diff` flow:

1. Read unified diff file.
2. Use current worktree files for source context when paths exist.
3. Mark commit metadata and PR metadata unavailable.

### Diff Parser

Responsibilities:

- Parse unified diff into `UnifiedDiff`.
- Preserve hunk headers.
- Annotate every line with old and new absolute line numbers.
- Generate stable hunk IDs.
- Detect file status, rename paths, binary files, and unsupported hunks.
- Build maps from changed lines to GitHub-compatible anchors.

Hunk ID format:

```text
sha256(path + oldStart + newStart + normalizedHunkHeader + changedLineNumbers)
```

### Repository Intelligence

Responsibilities:

- Parse changed files at base and head when content is available.
- Build changed-symbol graph.
- Provide read-only repository tools to LLM passes.
- Produce static signals for lenses.
- Degrade gracefully for unsupported languages.

V1 language adapters:

- Go.
- TypeScript/JavaScript.
- Generic fallback for unsupported files.

Language adapter interface:

```ts
interface LanguageAdapter {
  id: string
  extensions: string[]
  init(): Promise<void>
  parse(input: ParseInput): Promise<ParsedFile>
  listSymbols(file: ParsedFile): SymbolInfo[]
  getEnclosingSymbol(file: ParsedFile, line: number): SymbolInfo | undefined
  getImports(file: ParsedFile): string[]
  getChangedSymbols(file: ParsedFile, hunk: DiffHunk): ChangedSymbol[]
  getStaticSignals?(file: ParsedFile, hunk: DiffHunk): StaticSignal[]
  findLikelyTests?(symbol: SymbolInfo, index: RepositoryIndex): SymbolInfo[]
}
```

Repository tool interface:

```ts
interface RepositoryTools {
  readRange(path: string, startLine: number, endLine: number): Promise<string>
  readEnclosingSymbol(path: string, line: number): Promise<string | undefined>
  readSymbol(path: string, selector: { symbolName?: string; line?: number }): Promise<string | undefined>
  listSymbols(path: string): Promise<SymbolInfo[]>
  readDiffBlocks(input: { packetId?: string; path?: string }): Promise<string[]>
  findImports(path: string): Promise<string[]>
  searchFiles(query: string, options?: SearchOptions): Promise<SearchResult[]>
  findReferences(symbolName: string, options?: { pathGlob?: string }): Promise<SearchResult[]>
  findLikelyTests(input: { path?: string; symbol?: SymbolRef }): Promise<SymbolRef[]>
  listFiles(glob: string): Promise<string[]>
}
```

Repository tools should use tree-sitter-backed symbols and source blocks when available, with `rg`/line-window fallback when parsing is unavailable. Tool results must be capped by count and characters, include line numbers, prefer semantic blocks over whole files, and record truncation or omitted-result counts in telemetry. The model should see structured summaries and source snippets, not raw AST dumps.

### Skills And Lenses

Responsibilities:

- Load bundled Markdown skills.
- Load repo-local Markdown skills from `.codeninja/skills/`.
- Validate skill frontmatter and content.
- Register user-facing lenses.
- Map lenses to one or more skills.
- Build prompts for scout, lens review, system review, verifier, and composer stages.

Skill file shape:

```md
---
id: lang/go
title: Go correctness
lenses: ["lang/go", "domain/concurrency"]
languages: ["go"]
categories: ["correctness", "performance"]
enabledByDefault: false
---

# Purpose

# Checks

# False Positives

# Safe Patterns

# Examples
```

Bundled v1 lenses:

- `core/code-review`
- `core/logic-bugs`
- `core/architecture`
- `core/tests`
- `lang/go`
- `lang/typescript`

Additional domain lenses can be added after the core pipeline works.

### LLM Runner

Responsibilities:

- Wrap `@earendil-works/pi-ai`.
- Execute model calls with prompt, tools, timeout, and schema expectations.
- Validate structured outputs with `zod`.
- Retry once for invalid JSON/schema output using a repair prompt.
- Record per-call telemetry: model, provider, duration, token usage, prompt hash, output hash, and schema validation result.
- Enforce `llm.maxConcurrentCalls`.

Interface:

```ts
interface LlmRunner {
  runStructured<T>(request: LlmStructuredRequest<T>): Promise<T>
}

type LlmStructuredRequest<T> = {
  stage: ReviewStage
  prompt: string
  schema: z.ZodType<T>
  tools?: ToolDefinition[]
  timeoutMs: number
  telemetryContext: Record<string, unknown>
}
```

Pipeline code must depend on `LlmRunner`, not directly on Pi APIs.

### Review Pipeline

Responsibilities:

- Orchestrate all review stages.
- Enforce stage ordering.
- Enforce timeouts and concurrency limits.
- Persist stage artifacts.
- Emit telemetry events.

Main algorithm:

```ts
async function runReview(input: ReviewInput, config: CodeninjaConfig): Promise<ReviewResult> {
  const run = await startRun(config)
  const resolved = await resolveReviewInput(input, config, run.telemetry)
  const diff = await parseDiff(resolved.diff, run.telemetry)
  const filtered = await filterDiffFiles(diff, config, run.telemetry)
  const fileFacts = await classifyChangedFiles(resolved, filtered, config, run.telemetry)
  const repoIndex = await buildRepositoryIndex(resolved, filtered, fileFacts, config, run.telemetry)
  const dossier = await buildPlannerDossier(resolved, filtered, fileFacts, repoIndex, config, run.telemetry)
  const plan = await runPlanner(dossier, config, run.telemetry)
  const packets = await buildReviewPackets(plan, filtered, fileFacts, repoIndex, run.telemetry)
  const candidates = await runLensPackets(plan, packets, repoIndex.tools, config, run.telemetry)
  const systemCandidates = await runSystemReview(plan, candidates, repoIndex.tools, config, run.telemetry)
  const verified = await verifyFindings([...candidates, ...systemCandidates], repoIndex.tools, config, run.telemetry)
  const finalReview = await composeReview(verified, plan, config, run.telemetry)
  await renderOutputs(finalReview, config, run.telemetry)
  await maybePublishToGitHub(finalReview, resolved, config, run.telemetry)
  return finalReview
}
```

Parallelizable work:

- Packet-level lens review uses `review.concurrency`.
- Verifier calls use `review.concurrency`.
- LLM provider calls are additionally capped by `llm.maxConcurrentCalls`.

Lens execution rules:

- Run one composite model task per scheduled packet, with the selected lenses projected into that task.
- Do not run one model call per lens by default.
- Project and cap skill prompt sections for the review stage so large skill files do not dominate every packet prompt.
- Use coverage-aware execution profiles:
  - `light`: one structured call with a tiny optional read-only tool budget.
  - `normal`: one structured/tool-capable task with real read-only tool access, focused review instructions, and bounded investigation.
  - `deep`: one structured/tool-capable task with real read-only tool access, a larger budget, and more focused investigation rounds.
- Normal and deep packet reviewers may use the same read-only tool suite. The difference is budget, investigation depth, and prompting, not capability.
- The reviewer should submit immediately when packet context is sufficient. Tool calls are for concrete missing evidence, not broad exploration.
- Validate packet review output before verification. Schema-invalid output, missing evidence, low-confidence candidates, and anchors outside changed hunks are recorded in telemetry and suppressed or downgraded before verifier scheduling.

Non-parallel stages:

- Input resolution.
- Diff parsing.
- Deterministic planner dossier construction.
- Scout/planning, except optional sub-planners for large grouped reviews.
- Deduplication/ranking/composition.
- Final GitHub publishing.

Planner dossier construction:

- The dossier is a compact, deterministic artifact, not full review context.
- It includes PR metadata, commit messages, changed file inventory, hunk inventory, line counts, simple file facts, configured labels/priorities, test/config summaries, generated/vendor detection, lockfile detection, and any available changed-symbol graph or static signals.
- It records omitted details with counts and reasons when budgeted summaries are required.
- For small and medium reviews, one planner call can consume the dossier.
- For large reviews, code partitions the dossier and invokes sub-planners before a meta-planner merges the final `ReviewPlan`.

V1 repository intelligence can be incremental:

- Required for v1: diff parsing, filtering, simple file classification, package-root hints, test-file detection, configured labels/priorities, absolute hunk line numbers, and seed context retrieval.
- Strongly preferred for v1: tree-sitter enclosing symbol and changed-symbol extraction for Go and TypeScript/JavaScript.
- Optional enhancement: richer symbol edges, caller/test relationships, and semantic analyzer integrations.

### Verifier, Deduper, Composer

Responsibilities:

- Reject low-quality candidate findings.
- Revise findings that are real but poorly anchored or worded.
- Group duplicates and same-root-cause issues.
- Rank findings by severity, confidence, evidence strength, and actionability.
- Produce final Markdown and GitHub comment bodies.

Verifier keep criteria:

- Evidence includes changed code.
- Failure mode is concrete.
- Finding is tied to changed behavior.
- Anchor maps to a changed diff line for inline comments.
- False-positive risk is not high.
- Style-only comments are disabled unless the configured lens allows them.

Dedup fingerprint:

```text
sha256(path + anchor.line + category + normalizedFailureMode + normalizedEvidence)
```

Comment marker:

```html
<!-- codeninja:fingerprint=<fingerprint>;run=<run-id> -->
```

The marker must be appended to GitHub comment bodies and hidden from normal Markdown output where possible.

### Output And GitHub Publishing

Responsibilities:

- Render full Markdown report for stdout-only runs.
- Render concise stdout summary for `--post-github-comments` runs.
- Create inline GitHub comments and summary review body when requested.
- Avoid duplicate comments from previous codeninja runs.

GitHub publishing approach:

- Use `gh api` for REST calls.
- Create one pull request review containing a summary body and inline comments.
- Inline comments use GitHub review comment fields such as `path`, `line`, `side`, `start_line`, `start_side`, and `commit_id` where applicable.
- Do not use deprecated diff positions as the primary anchor, but retain `diffPosition` internally if useful for validation.
- Use the PR head SHA as `commit_id`.
- Pre-validate every inline anchor against the parsed diff before posting.

Duplicate handling:

1. List existing PR review comments.
2. Parse codeninja fingerprint markers.
3. Skip findings with already-posted matching fingerprints.
4. Do not delete stale comments in v1.
5. If safe update is not possible, prefer posting no duplicate over trying to mutate existing comments.

Publishing rules:

- Inline only verified medium/high-confidence findings with changed-line anchors.
- Broader system concerns go into the review summary.
- If no findings remain, do not post a GitHub summary by default unless `github.summaryWhenNoFindings` is true.
- Posting failures are fatal only when `--post-github-comments` was explicitly requested.

### Telemetry And Run Artifacts

Responsibilities:

- Create local run directory.
- Record structured events.
- Record aggregate metrics.
- Persist inspectable artifacts for debugging and evals.
- Keep stdout clean.

Run directory:

```text
.codeninja/runs/<yyyyMMdd-HHmmss>-<shortid>/
  run.json
  telemetry.json
  events.jsonl
  planner-dossier.json
  review-plan.json
  coverage.json
  changed-symbol-graph.json
  packets/
    <packet-id>.json
  candidate-findings.json
  verification.json
  final-findings.json
  final-review.md
  github-posting.json
  debug/
    llm-calls/
      <call-id>.json
    tool-calls/
      <tool-call-id>.json
```

`debug/` is written only when `telemetry.debugTrace` is enabled. Debug artifacts may contain source snippets, prompts, and model outputs.

Telemetry event shape:

```ts
type TelemetryEvent = {
  runId: string
  eventId: string
  timestamp: string
  stage: ReviewStage
  level: "debug" | "info" | "warn" | "error"
  message: string
  file?: string
  lineRange?: [number, number]
  packetId?: string
  lensId?: string
  workerId?: string
  durationMs?: number
  data?: Record<string, unknown>
}
```

The telemetry recorder must support redaction before any future external export. V1 writes local files only.

`coverage.json` must include total hunk count, reviewed hunk count, skipped hunk count, coverage level counts, skipped reasons, partial-review status, and the planner group that decided each hunk's coverage.

### Eval Support

V1 should not require a full public `codeninja eval` command, but the architecture must support eval workflows through stable run artifacts.

Eval cases can be represented externally as:

```ts
type EvalCase = {
  id: string
  repoUrl: string
  target:
    | { kind: "branch"; branchName: string; baseBranch?: string }
    | { kind: "commit_range"; startCommit: string; endCommit?: string }
  expectedFindings: Array<{
    category: FindingCategory
    path?: string
    lineRange?: [number, number]
    description: string
    severity?: Severity
  }>
}
```

An eval runner can execute `codeninja review --branch <branch> --base <base>` or `codeninja review <start-commit> <end-commit>` in a cloned repo, then compare expected findings to `final-findings.json` and inspect telemetry to diagnose misses.

## Error Handling

Use typed errors with stable codes:

```ts
type CodeninjaErrorCode =
  | "not_git_worktree"
  | "invalid_args"
  | "config_error"
  | "gh_missing"
  | "gh_auth_failed"
  | "pr_not_found"
  | "git_ref_missing"
  | "git_base_branch_unresolved"
  | "git_fetch_failed"
  | "diff_parse_failed"
  | "parser_unavailable"
  | "llm_call_failed"
  | "llm_schema_invalid"
  | "github_post_failed"
  | "timeout"

class CodeninjaError extends Error {
  code: CodeninjaErrorCode
  recoverable: boolean
  context?: Record<string, unknown>
}
```

Recoverable degradation:

- Unsupported language parser for a file.
- Failed static signal extraction for one file.
- Missing likely tests.
- Tool call timeout during candidate generation when the finding can be rejected.

Fatal errors:

- Not in a git worktree.
- Invalid input mode.
- Cannot resolve review range.
- Cannot resolve a base branch for branch review.
- Cannot parse the diff at all.
- Missing or unauthenticated `gh` for requested PR/GitHub posting mode.
- GitHub posting failure when posting was requested.
- Run-level timeout.

Progress and warnings go to stderr. Normal review Markdown goes to stdout only when not posting GitHub comments.

## Security And Permissions

Default behavior is read-only.

Allowed by default:

- Read files from the repository.
- Run `git` read operations.
- Run `gh` read operations for PR metadata.
- Write local run artifacts under `.codeninja/runs/`.
- Post GitHub comments only when `--post-github-comments` is explicitly set.

Not allowed by default:

- Editing repository files.
- Running arbitrary shell commands.
- Running tests/typecheck/build commands.
- Sending telemetry to external services.

Configured test/typecheck commands may be enabled later with explicit config and timeouts. Their output becomes evidence, not automatic findings.

## Testing Strategy

Use Vitest for unit and integration tests.

Unit tests:

- Config precedence and validation.
- Diff parser line-number mapping.
- Hunk ID stability.
- GitHub anchor validation.
- Skill frontmatter validation.
- Lens selection rules.
- Candidate finding schema validation.
- Dedup fingerprint stability.
- Telemetry event serialization.

Fixture tests:

- Go changed-function extraction.
- TypeScript/JavaScript changed-function extraction.
- Review packet construction with absolute line numbers.
- Static signal extraction for Go and TypeScript patterns.
- Unsupported language fallback.

Integration tests:

- Temporary git repos for `--branch --base` and commit range review.
- Simulated PR metadata for `--pr`.
- Missing local PR refs causing internal fetch calls, with git/gh clients mocked.
- stdout-only run with fake LLM outputs.
- `--post-github-comments` run with fake GitHub API payload capture.
- Duplicate comment detection from existing comment fixtures.

LLM-independent pipeline tests:

- Use a fake `LlmRunner` that returns deterministic planner, candidate, verifier, and composer outputs.
- Validate pipeline stage order, concurrency boundaries, telemetry events, and final artifacts.

Eval-style regression tests:

- Store small real-world or synthetic review cases with expected findings.
- Compare `final-findings.json` against expected categories, paths, and failure modes.
- Use telemetry artifacts to diagnose misses.

## Component Docs To Write Next

After architecture approval, write detailed component docs for:

- `components/review_pipeline.md`: orchestration, filtering, planning, packet construction, lens scheduling, verification, and composition.
- `components/repository_and_github.md`: local git resolution, PR metadata, diff parsing, file classification, GitHub anchor validation, duplicate detection, and posting.
- `components/context_and_tools.md`: seed context retrieval, tree-sitter-backed syntax helpers, read-only repository tools, and progressive language adapter support.
- `components/skills_llm_telemetry.md`: Markdown skill loading, Pi runner integration, structured schemas, telemetry artifacts, and eval support.
