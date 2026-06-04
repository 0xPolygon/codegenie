---
status: draft
---

# Architecture: codeninja

## Architecture Scope

codeninja is a TypeScript CLI that reviews pull-request-style diffs using a staged, telemetry-rich AI review pipeline. The architecture is intentionally split into:

- `architecture.md`: system-level components, data contracts, and cross-component flow.
- `components/*.md`: detailed designs for the complex internals after this architecture is approved.

Component docs are required because the review pipeline, repository intelligence layer, GitHub posting, skills/lenses, LLM runner, verifier/composer, and telemetry/eval support each have enough complexity to warrant separate designs.

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
  -> syntax index and changed-symbol graph
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
type ReviewMode = "github_pr" | "git_range" | "diff_file"

type ReviewInput =
  | { mode: "github_pr"; prNumber: number }
  | { mode: "git_range"; baseRef: string; headRef: string }
  | { mode: "diff_file"; diffPath: string }

type ResolvedReviewInput = {
  mode: ReviewMode
  repoRoot: string
  baseRef?: string
  headRef?: string
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
```

Tree-sitter-backed graph facts are syntactic or heuristic unless a richer language adapter provides semantic evidence. The LLM may reason over the graph, but graph construction itself must be deterministic.

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
  packetGroups: Array<{
    groupId: string
    packetIds: string[]
    lenses: string[]
    canRunInParallel: boolean
    reason: string
  }>
}
```

The planner is the only stage allowed to decide review ordering and lens selection. It must not select every lens for every packet by default.

### Review Packets

```ts
type ReviewPacket = {
  id: string
  prSummary: string
  path: string
  language: string
  hunk: {
    id: string
    oldStart: number
    oldLines: number
    newStart: number
    newLines: number
    contentWithLineNumbers: string
    changedLineNumbers: number[]
  }
  context: HunkContext
  relevantTests: SymbolInfo[]
  relatedFilesHint: string[]
  riskTags: string[]
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
```

Review packets are persisted to telemetry artifacts so evals can inspect what context the reviewer saw.

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
- `telemetry.enabled = true`
- `telemetry.debugTrace = false`
- `telemetry.runDir = ".codeninja/runs"`
- `telemetry.retainRuns = 20`

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

`--base --head` flow:

1. Resolve refs locally.
2. Compute merge base.
3. Diff `mergeBase..head`.
4. Collect commit metadata with `git log mergeBase..head`.

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
  readFileRange(path: string, startLine: number, endLine: number): Promise<string>
  getEnclosingSymbol(path: string, line: number): Promise<SymbolInfo | undefined>
  listSymbols(path: string): Promise<SymbolInfo[]>
  getSymbolSource(path: string, symbolName: string): Promise<string | undefined>
  getChangedSymbols(): Promise<ChangedSymbol[]>
  findImports(path: string): Promise<string[]>
  findLikelyTestsForSymbol(symbol: SymbolRef): Promise<SymbolRef[]>
  searchReferences(query: string, options?: SearchOptions): Promise<SearchResult[]>
}
```

The model should see structured summaries and source snippets, not raw AST dumps.

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
  const repoIndex = await buildRepositoryIndex(resolved, diff, config, run.telemetry)
  const plan = await runPlanner(resolved, diff, repoIndex, config, run.telemetry)
  const packets = await buildReviewPackets(plan, diff, repoIndex, run.telemetry)
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

Non-parallel stages:

- Input resolution.
- Diff parsing.
- Scout/planning.
- Deduplication/ranking/composition.
- Final GitHub publishing.

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
  review-plan.json
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

### Eval Support

V1 should not require a full public `codeninja eval` command, but the architecture must support eval workflows through stable run artifacts.

Eval cases can be represented externally as:

```ts
type EvalCase = {
  id: string
  repoUrl: string
  baseRef: string
  headRef: string
  expectedFindings: Array<{
    category: FindingCategory
    path?: string
    lineRange?: [number, number]
    description: string
    severity?: Severity
  }>
}
```

An eval runner can execute `codeninja review --base <base> --head <head>` in a cloned repo, then compare expected findings to `final-findings.json` and inspect telemetry to diagnose misses.

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

- Temporary git repos for `--base --head`.
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

- `components/review_pipeline.md`
- `components/git_and_github.md`
- `components/repository_intelligence.md`
- `components/skills_and_lenses.md`
- `components/llm_runner.md`
- `components/verifier_and_composer.md`
- `components/telemetry_and_evals.md`
