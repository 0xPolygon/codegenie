---
status: complete
---

# Architecture: codeninja

## Architecture Scope

codeninja is a TypeScript CLI that reviews pull-request-style diffs using a staged, telemetry-rich AI review pipeline. The architecture is intentionally split into:

- `architecture.md`: system-level components, data contracts, and cross-component flow.
- `components/*.md`: detailed designs for the complex internals after this architecture is approved.

Component docs are required because the review pipeline, repository intelligence layer, GitHub posting, skills/lenses, LLM runner, verifier/composer, and telemetry/eval support each have enough complexity to warrant separate designs. Those component docs should preserve a minimal v1 path rather than turning every possible enhancement into a first implementation requirement.

## Implementation Philosophy

codeninja should be a specialized review workflow harness, not a generic agent asked to remember the workflow from a skill file. The harness owns the stage order, data contracts, concurrency, validation, GitHub anchoring, and telemetry. Pi agents and Markdown skills provide reasoning inside those stages.

The v1 flow:

- Resolve target and collect diff.
- Filter ignored, generated, vendored, binary, and lock files.
- Classify files into simple processing facts such as language, processing mode, package root, test/generated/vendor/lock/binary status, configured labels, and configured priority.
- Build a review plan with focus areas, coverage decisions, and per-hunk priorities.
- Build review packets from files and hunks.
- Route selected skills/lenses to those packets.
- Retrieve seed context and expose read-only repo tools.
- Run model review per scheduled packet.
- Verify, dedupe, compose, and optionally publish.

The first implementation should favor simple deterministic heuristics plus structured model calls over an elaborate semantic-analysis platform. Advanced repository intelligence should be added behind stable interfaces when telemetry shows it improves review quality.

The build order should be a tracer bullet: stand up the minimal end-to-end path (resolve → parse → filter → classify → single planner call → packets → packet review → verification → composition → stdout) before any machinery listed under Future Considerations.

## Technology Choices

Runtime and package management:

- Node.js with TypeScript.
- `pnpm` for package management.
- ESM modules.

Core dependencies:

- using pnpm for package management
- `@earendil-works/pi-ai` for LLM/agent execution, wrapped behind an internal adapter.
- `commander` for CLI parsing.
- `zod` for config validation; TypeBox (via pi-ai) for LLM I/O schemas.
- `p-limit` for bounded concurrency.
- A TOML parser for `codeninja.toml` and a YAML parser for eval case files.
- `picomatch` for path-rule and tool globs.
- `execa` or Node subprocess APIs for `git` and `gh`.
- `@vscode/ripgrep` for bundled text search, used as a fast path only when the checkout matches the reviewed head. Pinned to >=1.18.0, which ships per-platform binaries in the tarball with no postinstall download.
- `web-tree-sitter` plus Go and TypeScript/JavaScript grammars for v1 syntax parsing.
  - `tree-sitter-go` for Go
  - `tree-sitter-typescript` for Typescript: `.ts`/`.mts`/`.cts`/`.d.ts` route to the typescript grammar; `.tsx` routes to the tsx grammar
  - `tree-sitter-javascript` for Javascript: `.js`/`.jsx`/`.mjs`/`.cjs`
  - Tree-sitter runs entirely via WASM: the `web-tree-sitter` runtime (`tree-sitter.wasm`) plus one `.wasm` grammar per language, all shipped inside their npm tarballs.
  - Grammar files are referenced directly from `node_modules` at runtime (e.g. `require.resolve("tree-sitter-go/tree-sitter-go.wasm")` via `createRequire` under ESM); no copy step into an `assets/` folder is needed because codeninja is distributed as a normal npm package. An asset-copy step becomes necessary only if single-file bundling is introduced, which is out of scope for v1.
  - `web-tree-sitter` and the three grammar packages are pinned together; ABI compatibility is enforced at `Language.load`.

Exact dependency versions are pinned via the pnpm lockfile; `@vscode/ripgrep` and tree-sitter grammar wasm artifacts ship inside their npm tarballs (no postinstall downloads permitted).

External CLI dependencies:

- `git` is required for all review modes.
- `gh` is required for `--pr` mode and `--post-github-comments`. The minimum supported `gh` version is the first that exposes `baseRefOid`/`headRefOid` in `gh pr view --json`, with a `gh api repos/<owner>/<repo>/pulls/<n>` REST fallback when those fields are unavailable.

The implementation should keep library-specific APIs behind small internal interfaces. The coding surface should depend on `LlmRunner`, `GitClient`, `GitHubClient`, and `RepositoryIndex` interfaces rather than directly coupling the full pipeline to third-party APIs.

## High-Level Flow

```text
CLI args
  -> config loader
  -> review input resolver
  -> git/GitHub metadata collection
  -> diff parser
  -> file filtering and simple file classification
  -> optional syntax index (changed-symbol extraction)
  -> planner
  -> review packet builder
  -> selected lens runners with bounded concurrency
  -> verifier workers
  -> deduper/ranker/composer
  -> optional GitHub publisher
  -> stdout renderer
  -> telemetry artifacts
```

The pipeline must never require loading the entire repository into model context. It gives each model call focused packets and read-only repository tools.

## Project Layout

```text
src/
  cli/
    main.ts
    review-command.ts
    provider-command.ts
  config/
    config-loader.ts
    schema.ts
    paths.ts
  provider/
    provider-services.ts
    provider-settings.ts
    model-resolver.ts
  git/
    git-client.ts
    review-input-resolver.ts
    diff-parser.ts
    detectors.ts
    file-classifier.ts
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
    worker-runner.ts
    verifier.ts
    composer.ts
  llm/
    llm-runner.ts
    pi-runner.ts
    schemas.ts
  telemetry/
    telemetry-recorder.ts
    run-artifacts.ts
  evals/
    eval-command.ts
    eval-runner.ts
    eval-scoring.ts
    eval-artifacts.ts
    eval-compare.ts
  output/
    markdown-renderer.ts
    json-renderer.ts
    stdout-renderer.ts
  util/
    errors.ts
    result.ts
    hashing.ts
bundled-skills/   # Markdown review skills shipped with codeninja
  core/
  lang/
  domain/
```

Repo-local user data:

```text
.codeninja/
  skills/              # user-provided Markdown skills, trackable by git
  runs/<run-id>/       # local telemetry/debug artifacts, ignored by git
  cache/               # local model-call cache, ignored by git
codeninja.toml
```

`.codeninja/runs/` and `.codeninja/cache/` are git-ignored. `.codeninja/skills/` should remain trackable so teams can version project review policy.

User-local provider/auth state:

```text
~/.codeninja/             # overridable with CODENINJA_HOME
  auth.json               # Pi provider credentials, chmod 0600
  models.json             # Pi custom provider/model registry data when supported
  settings.json           # default provider/model/depth/reasoning, chmod 0600
  config.toml             # optional user-level CodeninjaConfig overrides and trust opt-ins
  sessions/               # provider/session state when Pi needs it
```

This state is user-scoped, never repo-tracked, and is the only place codeninja itself stores provider credentials.

codeninja is distributed as a normal npm package; wasm grammars and the ripgrep binary resolve from `node_modules` at runtime. Single-file bundling is out of scope for v1.

## Core Data Model

Naming convention: type-name prefixes mark the scope a record describes. `Diff*` is the parsed change as truth (files, hunks, lines, anchors); `File*` is per-file derived facts; `Hunk*` is per-hunk derived data; `Packet*` belongs to the review unit (one or more hunks reviewed together); `Finding*` is review results; `Run*` is whole-run aggregates. `ReviewPacket` itself keeps the longer name as the flagship type crossing component boundaries; its member records use the bare `Packet` prefix.

Pipeline stages are identified by the numeric stage ids from the functional spec:

```ts
// 1 diff parsing, 2 filtering, 3 classification, 4 symbol extraction,
// 5 planning, 6 packet construction, 7 lens review,
// 8 optional targeted system follow-up for repeated scoped hints,
// 9 verification, 10 composition, 11 publishing
// Logging and telemetry additionally use stage 0 for pre-pipeline events
// (CLI parse, config load, input validation).
type ReviewStage = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11
```

Stage ids are stable for telemetry and evals. Mentally the pipeline is six phases: Inventory (1-4), Plan (5), Review (6-7 plus optional Stage 8), Verify (9), Compose (10), Publish (11). Stage 8 is narrow: it runs only when repeated scoped follow-up hints justify a focused system task.

### Review Input

```ts
type ReviewMode = "github_pr" | "branch" | "commit_range"

type ReviewInput =
  | { mode: "github_pr"; prNumber: number }
  | { mode: "branch"; branchName: string; baseBranch?: string }
  | { mode: "commit_range"; startCommit: string; endCommit?: string }

type ResolvedReviewInput = {
  mode: ReviewMode
  repoRoot: string
  baseRef?: string
  headRef?: string
  startCommit?: string
  endCommit?: string
  mergeBase?: string // populated in every mode: the effective base revision (first parent for single-commit review)
  headSha?: string
  pr?: PullRequestMetadata
  commits: CommitInfo[]
  rawDiff: string // unparsed unified diff text; the diff parser owns parsing
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

// Shape returned by GitHubClient.listOwnComments: codeninja's own prior
// review comments, summarized for rerun duplicate detection.
type ExistingReviewThread = {
  id: string
  path?: string
  line?: number
  side?: "RIGHT" | "LEFT"
  author: string
  isCodeninja: boolean
  fingerprint?: string
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
  status: "added" | "modified" | "deleted" | "renamed" | "copied"
  isBinary?: boolean
  modeOnly?: boolean
  isSymlink?: boolean
  isSubmodule?: boolean
  language: string // provisional extension-based hint from the parser; FileFacts.language (Stage 3) is the authoritative fact
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
// Closed generic categories, stable across languages. The language's own
// word lives in nativeKind ("struct", "trait", "contract", "protocol", ...),
// so adding a language never changes this enum.
type SymbolKind =
  | "function"   // free-standing callables
  | "method"     // callables attached to a type: Go receiver funcs, Rust impl fns, class members, constructors, accessors
  | "type"       // concrete type definitions: class, struct, enum, type alias, Solidity contract/event/error
  | "interface"  // contract-defining types: interface, trait, protocol
  | "value"      // const, var, let, static, Solidity state variables
  | "container"  // module, namespace, package, Rust mod/impl block, Swift extension, Solidity library
  | "other"      // macros, Solidity modifiers, anything unmapped

type SymbolRef = {
  path: string
  name: string
  kind: SymbolKind
  nativeKind?: string // the language's own word for this symbol; preferred in prompts
  lineRange: [number, number]
}

type SymbolInfo = SymbolRef & {
  exported?: boolean
  ownerType?: string // the type a method belongs to: Go receiver, Rust impl target, class in TS/Swift
  packageName?: string
  signature?: string
}

type ChangedSymbol = SymbolInfo & {
  changedLines: number[]
}

type HunkSymbolFacts = {
  path: string
  hunkId: string
  enclosingSymbol?: string
  symbolKind?: SymbolKind
  symbolNativeKind?: string
  symbolRange?: [number, number]
  changedLines: number[]
  changedLinesSide: "old" | "new" // old-side for deletion-only hunks, new-side otherwise
  signature?: string
  source: "tree-sitter" | "fallback"
  confidence: "syntactic" | "heuristic"
}

type StaticSignal = {
  ruleId: string
  path: string
  line?: number
  side?: "RIGHT" | "LEFT"
  category: string
  lensHint?: string
  confidence: "high" | "medium" | "low"
  explanation: string
  snippet?: string
}

// "skip" appears in config path rules and FileFilterDecisions (Stage 2);
// FileFacts of kept files carry only "per-hunk" | "whole-file".
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
  testStatus: "test" | "source" | "unknown"
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
  degraded?: { reason: string } // carrier for "degraded or partially reviewed"; disclosed in the coverage summary
}

type FileFilterDecision = {
  path: string
  action: "skip" | "keep"
  reason: string
  provenance: FactProvenance[]
}
```

`filterDiffFiles` runs first: it executes the skip-relevant detectors, returns the kept files plus one `FileFilterDecision` per changed file (carrying the detection provenance the policy used), and memoizes detection results. Classification then runs on kept files only, reusing those results. Decisions flow to the planner dossier (counts and paths) and into `coverage.json`.

V1 ships exactly two cross-language static-signal rules: `core/deleted-test-file` and `core/exported-api-change`. Per-language rule packs are deferred (see Future Considerations).

Adapter authors map each symbol with one question: callable-free (`function`), callable-attached (`method`), type-defining (`type`), contract-defining (`interface`), value-binding (`value`), container (`container`), or `other` — and always pass the language's native word through `nativeKind`. The generic kind is a coarse, stable category for harness behavior and telemetry; `nativeKind` is what prompts show the model.

Tree-sitter-backed symbol facts are syntactic or heuristic unless a richer language adapter provides semantic evidence. A changed-symbol graph (caller/implements/imports/tests edges) is deferred to Future Considerations; v1 reviewers answer relationship questions on demand through `find_symbol_mentions` and `find_likely_tests`.

Changed-symbol extraction is a local indexing step, not an LLM stage. It parses changed files, maps hunk line ranges to enclosing symbols, and emits compact `HunkSymbolFacts` for planner and packet construction. If parsing fails, the pipeline falls back to hunk/file metadata without blocking review.

File classification is deterministic, narrow, and auditable by default. It uses path rules, filenames, extensions, package-root detection, generated/vendor/lockfile/binary detectors, diff metadata, and `codeninja.toml` rules. The LLM is not part of the default classifier.

The core classifier must not ship with hardcoded business/domain risk keyword lists. Labels and criticality come from explicit project configuration, while the planner and skills may reason about risk from the diff, symbols, static signals, and configured labels.

### Review Planning

```ts
type DiffUnderstanding = {
  declaredIntent: string
  inferredBehavior: string
}

type SurroundingContextHint = {
  kind:
    | "enclosing_symbol"
    | "sibling_pattern"
    | "call_site"
    | "test"
    | "config"
    | "lifecycle"
    | "resource_management"
    | "authorization"
    | "other"
  path?: string
  symbol?: string
  lineRange?: [number, number]
  reason: string
  expectedUse: "packet_context" | "tool_lookup"
}

type ReviewPlan = {
  diffUnderstanding: DiffUnderstanding
  riskAreas: Array<{
    area: string
    reason: string
    files: string[]
    suggestedLenses: string[]
  }>
  coverage: HunkCoverageDecision[]
  partialReview?: {
    isPartial: boolean
    reason: string
    reviewedHunks: number
    totalHunks: number
  }
}

type CoverageLevel = "deep" | "normal" | "light" | "skip"
type PacketKind = "hunk" | "coalesced-hunks" | "file-diff" | "whole-file"

type HunkCoverageDecision = {
  hunkId: string
  path: string
  coverage: CoverageLevel
  lenses: string[]
  surroundingContextHints: SurroundingContextHint[]
  reason: string
}
```

The packet builder is the sole owner of packet identity and physical grouping. The planner emits targeted per-hunk coverage/lens overrides only; it does not emit scheduling groups in v1 (see Future Considerations). Packet scheduling order is derived from effective coverage level and configured priority, and all packets may run concurrently because v1 packets never span files and workers are context-isolated.

The planner is the only stage allowed to raise or lower coverage, select non-default lenses, or skip a hunk. It must not select every lens for every packet by default. Omitted changed hunks are not planner failures; Stage 6 reviews them with deterministic `normal` coverage and default core/language lenses. Any explicit `skip` still requires a reason.

The planner may request surrounding-code inspection by emitting `SurroundingContextHint` records. It should not broadly inspect files itself by default. Hints are instructions for packet construction or packet reviewers to inspect concrete symbols, files, tests, local patterns, or integration points.

Later stages may validate planner decisions and apply deterministic defaults, but they must not become independent risk classifiers. If a reviewable hunk has no planner coverage, packet construction quietly uses `normal` default coverage. If the planner skips a reviewable hunk without a valid reason, packet construction falls back to `normal` and records the malformed skip in telemetry.

Large PRs use deterministic dossier compaction when the planner dossier exceeds configured model or budget limits:

```text
full deterministic inventory
  -> budgeted dossier (per-directory summaries replace per-hunk detail; omissions recorded)
  -> if still over budget: deterministic chunking by package/directory
  -> one planner call per chunk; per-hunk decisions mechanically concatenated
```

There is no meta-planner and no model-driven grouping in v1; hierarchical planning is deferred (see Future Considerations).

The deterministic inventory is complete even when model context is limited. It includes changed files, hunks, line counts, languages, file processing facts, configured labels/priorities, changed symbols, exported API/interface changes, tests touched, generated/vendor/lockfile detection, package/build/test config summaries, and static signals. Model calls receive budgeted summaries of that inventory.

Coverage rules:

- `deep`: changes with strong risk evidence, including configured critical paths, exported API/interface changes, migrations, lifecycle/concurrency-sensitive code identified by symbols or skills, or planner-inferred risks backed by concrete diff evidence.
- `normal`: ordinary application logic.
- `light`: low-risk, repetitive, or mostly mechanical changes.
- `skip`: generated, vendored, binary, irrelevant, or otherwise intentionally unreviewed hunks.

Partial reviews must be explicit. If the configured runtime, token, or provider-call budget prevents full review, `partialReview.isPartial` must be true and the final output must report coverage counts.

### Review Packets

```ts
type PacketLine = {
  kind: "context" | "add" | "delete"
  oldLine?: number
  newLine?: number
  content: string
}

type PacketHunk = {
  hunkId: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  header?: string
  contentWithLineNumbers: string // rendered view of `lines`
  lines: PacketLine[]
  changedNewLineNumbers: number[]
  changedOldLineNumbers: number[]
  truncated?: boolean // oversized hunk rendered as a changed-line-centered window
  omittedLineCount?: number
}

type ToolBudget = {
  maxToolCalls: number
  maxInvestigationRounds: number
  maxResultChars: number
}

type ReviewProfile = "simple" | "standard" | "investigate"

type ReviewPacket = {
  id: string
  kind: PacketKind
  prSummary: string
  intentText?: string // the dossier's already-fenced declared-intent projection (PR title/body extract), capped at ~1000 chars
  path: string
  fileStatus: DiffFile["status"]
  isDeletedContent: boolean // true for deletion-only packets; reviewers and anchor validation must treat content as old-side
  language: string
  coverage: Exclude<CoverageLevel, "skip">
  reviewProfile: ReviewProfile // execution/cost profile derived deterministically from coverage, priority, hints, and mechanical-change signals
  lenses: string[]
  hunks: PacketHunk[]
  symbolFacts: HunkSymbolFacts[]
  context: PacketContext
  contextText: string // rendered deterministic context (enclosing-symbol source, file outline, likely-tests list) assembled by the packet builder within maxContextChars
  relevantTests: SymbolInfo[]
  surroundingContextHints: SurroundingContextHint[]
  labels: string[]
  riskNotes: string[]
  toolBudget: ToolBudget
  degraded?: { reason: string } // disclosed in the coverage summary
  fileContext?: {
    mode: "file-diff" | "whole-file"
    reason: string
  }
}

type PacketContext = {
  path: string
  packageName?: string
  enclosingFunction?: SymbolInfo
  enclosingType?: SymbolInfo
  enclosingMethod?: SymbolInfo
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
    confidence: "high" | "medium" | "low"
  }>
  uncertainties: StructuredUncertainty[]
  status: "completed" | "incomplete" | "failed" | "skipped"
}

type StructuredUncertainty = {
  question: string
  files: string[]
  symbols: string[]
}
```

`PacketReviewResult` does not duplicate worker tool usage: tool calls and files read live in `tool-calls.jsonl`, and readers join on `workerId`.

Packet `followUpHints` and `uncertainties` are still emitted in v1: they flow to telemetry, to coverage/report notes, and, when multiple packet reviewers raise the same scoped question, into the narrow Stage 8 targeted system follow-up. Single unresolved hints remain human-attention notes rather than review tasks.

Review packets are persisted to telemetry artifacts so evals can inspect what context the reviewer saw. Every packet contains one or more hunks. `ReviewPacket.kind` explains why those hunks are reviewed together, while `ReviewPacket.coverage` and `ReviewPacket.reviewProfile` control execution budget and prompting.

Packet construction algorithm:

1. Build one planned hunk record per changed hunk from diff data, file facts, `HunkSymbolFacts`, planner coverage, selected lenses, processing mode, labels, and estimated size.
2. Validate planner output and apply deterministic fallbacks for missing coverage, invalid skip reasons, or empty lens sets.
3. Apply file processing mode: the skip branch is defensive only — configured-skip files never reach Stage 6 under filter-first — and produces coverage records only; whole-file files produce one file packet when size limits allow; all other files default to hunk-first packets.
4. Group hunks conservatively: one packet per hunk by default; coalesce only same-file hunks that share an enclosing symbol or are very nearby and still fit strict size limits.
5. Never coalesce across files in v1. Cross-file concerns are recorded as follow-up hints; repeated scoped hints may trigger the narrow Stage 8 follow-up, while isolated hints remain telemetry/report notes.
6. Attach cheap deterministic surrounding context when available — enclosing symbol source, file outline, likely tests — rendered into `contextText` within `maxContextChars`, plus planner-provided `surroundingContextHints`.
7. Enforce max hunks, patch chars, context chars, and skill/lens prompt caps. Split oversized packets back into smaller packets. When one hunk alone exceeds `maxPatchChars`, the packet carries a truncated patch window centered on changed lines, with `truncated: true`, omitted-line counts, and a coverage note; never split below hunk granularity, never synthesize sub-hunk ids. Quantified defaults: `maxPatchChars = 12000`, `maxContextChars = 8000`, `maxHunksPerPacket = 5`.
8. Compute packet coverage as the max coverage of included hunks, ordered `deep > normal > light`.
9. Compute packet lenses as the bounded union of included hunk lenses, keeping the primary language lens first, pruning low-value `core/tests` / `core/code-review` from routine source or mechanical packets when another lens remains, and capping the final list.

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
}

// V1 findings are always packet-produced; static signals are prompt hints only.
// producedBy.lensId is stamped deterministically by Stage 7 validation as the
// packet's first (primary) lens; the model does not claim lenses.
type FindingProducer = { kind: "packet"; stage: ReviewStage; packetId: string; lensId: string; skillIds: string[]; workerId?: string }

type CandidateFinding = {
  id: string
  title: string
  severity: Severity
  confidence: Confidence
  path: string
  anchor?: DiffAnchor // required for inline-intended candidates; unanchored candidates are summary-only
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
  producedBy: FindingProducer
  clusterId?: string // Stage 9 pre-cluster lineage
  duplicateOf?: string
}

type VerificationVerdict = {
  candidateId: string
  verdict: "keep" | "reject" | "revise"
  reason: string
  requiredEvidencePresent: boolean
  falsePositiveRisk: "low" | "medium" | "high"
  finalFinding?: CandidateFinding // finalFinding.id must equal the original candidate id; revisions preserve identity
  revisedAnchor?: DiffAnchor
  verificationIncomplete?: boolean
}

type FinalFinding = CandidateFinding & {
  fingerprint: string
  finalBody: string
  publication: "inline" | "summary-only" | "suppressed"
  mergedCandidateIds: string[]
}
```

Path semantics: for deleted files, `DiffFile.path` and `FileFacts.path` carry the old path; for renames, `path` is the new path and `oldPath` the old. `DiffAnchor.path` must use the side-appropriate path (LEFT anchors → old path, RIGHT anchors → new path). Hunk ids hash the same path the `DiffFile` carries.

Candidate findings are invalid unless they include evidence and a concrete failure mode. Pre-verification gates require an anchor only for inline-intended candidates; unanchored candidates are summary-only candidates. Inline GitHub publishing also requires a valid changed-line anchor.

### Deferred Type Definitions

Some referenced types are intentionally deferred to component docs:

- `SearchOptions`, `SearchResult` → `components/context_and_tools.md`
- `ParseInput`, `ParsedFile` → `components/context_and_tools.md`
- `ToolDefinition` → `components/skills_llm_telemetry.md`
- `EvalFindingExpectation` → `components/evals.md` (sketch in Eval Support below; full matching detail in the component doc)
- Planner dossier type → `components/review_pipeline.md`

The three mandated interface seams have minimal signatures defined here:

```ts
interface GitClient {
  revParse(ref: string): Promise<string>
  catFile(ref: string, path: string): Promise<string>
  lsTree(ref: string, glob?: string): Promise<string[]>
  grep(ref: string, pattern: string, opts?: { glob?: string; maxResults?: number }): Promise<SearchResult[]>
  mergeBase(a: string, b: string): Promise<string>
  log(range: string): Promise<CommitInfo[]>
  diff(base: string, head: string): Promise<string>
  fetch(refspec: string): Promise<void>
  isShallow(): Promise<boolean>
}

interface GitHubClient {
  viewPr(number: number): Promise<PullRequestMetadata>
  createReview(number: number, review: { body: string; event: "COMMENT"; comments: InlineCommentInput[] }): Promise<void>
  listOwnComments(number: number): Promise<ExistingReviewThread[]>
}

type RepositoryIndex = {
  facts: FileFacts[]
  symbolFacts: HunkSymbolFacts[]
  staticSignals: StaticSignal[]
  tools: RepositoryTools
}
```

`InlineCommentInput` carries `path`/`line`/`side`/`start_line`/`start_side`/`body`.

## Component Breakdown

### CLI And Config

Responsibilities:

- Parse `codeninja review` arguments, including target selection (defaulting to current branch vs resolved base when no target is passed), `--depth`, repeatable `--lens`, `--provider`, `--model`, `--reasoning`, `--format markdown|json`, `--post-github-comments`, and `--cache`/`--no-cache` (overriding `cache.enabled` per run).
- Parse `codeninja provider ...` arguments and dispatch to the provider command layer.
- Enforce flag rules: `--pr`, `--branch`, and positional commits are mutually exclusive — passing more than one is `invalid_args`. `--post-github-comments` outside `--pr` mode is `invalid_args`.
- Load `codeninja.toml`.
- Merge review config from defaults, user-scoped config, repo config, the four provider/home environment variables, and CLI flags, while enforcing the trust partition.
- Validate config with `zod`.
- Start a run and create `.codeninja/runs/<run-id>/`.

Review behavior precedence for safe keys (project policy outranks personal defaults; per-run flags outrank both). The only codeninja environment variables in v1 are `CODENINJA_PROVIDER`, `CODENINJA_MODEL`, `CODENINJA_REASONING`, and `CODENINJA_HOME`, so safe review keys have no environment layer:

```text
CLI flags > codeninja.toml > user-scoped config > defaults
```

Provider/model selection precedence (trust-partitioned: repo `codeninja.toml` is ignored entirely for these keys):

```text
CLI flags > environment variables > ~/.codeninja/settings.json > ~/.codeninja/config.toml > Pi/provider defaults
```

Within user scope, `settings.json` outranks `config.toml` because the dedicated `provider config set-*` commands write `settings.json`.

Review depth also has no environment layer; stored `defaultDepth` in `settings.json` participates as user-scoped config:

```text
--depth > repo codeninja.toml > settings.json defaultDepth > config.toml > built-in normal
```

Per-key config sources (normative; Trust Boundaries defers to this table):

| Keys | Allowed sources |
| --- | --- |
| `review.depth`, `review.maxFindings`, `review.softCommentCap`, `git.baseBranch`, `lenses.enabled` / `lenses.disabled`, `classification.pathRules` (incl. labels) | Repo `codeninja.toml`, user-scoped config, or CLI |
| `review.verify`, `review.minSeverity`, `review.minConfidence`, `review.minInlineConfidence`, `review.timeoutMs`, `review.perPassTimeoutMs`, `review.maxTotalTokens`, `review.maxModelCalls`, `review.concurrency`, `llm.*`, `lenses.extraSkillPaths`, `cache.*`, `telemetry.*`, `eval.*` | User-scoped config or CLI only |

The loader enforces this via per-key source tracking; repo values for user-scope keys are ignored with a warning.

All merging happens once, in the config loader, which tracks per-key sources to enforce the trust partition and produces the single resolved `CodeninjaConfig`. Downstream components — including the LLM runner — consume the resolved config only and never read user state directly.

Default config:

```ts
// Providers exposing different reasoning scales map onto these four levels.
// "auto" is CLI-only and clears the CLI layer; resolution then continues
// CODENINJA_REASONING > settings.json > config.toml > the built-in "high" default.
type ReasoningLevel = "low" | "medium" | "high" | "xhigh"

type CodeninjaConfig = {
  lenses: {
    enabled: string[]
    disabled: string[]
    extraSkillPaths: string[]
  }
  review: {
    depth: "light" | "normal" | "deep"
    verify: boolean
    minSeverity?: Severity
    maxFindings: number
    softCommentCap: number
    minConfidence: Confidence
    minInlineConfidence: Confidence
    concurrency: number
    timeoutMs: number
    perPassTimeoutMs: number
    maxTotalTokens?: number
    maxModelCalls?: number
  }
  github: {
    summaryWhenNoFindings: boolean
  }
  git: {
    baseBranch?: string
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
    reasoning?: ReasoningLevel
    maxConcurrentCalls: number
  }
  cache: {
    enabled: boolean
    dir: string
  }
  telemetry: {
    enabled: boolean
    logLevel: "debug" | "info" | "warn" | "error"
    debugTrace: boolean
    runDir: string
    retainRuns: number
  }
  eval: {
    defaultEvalDir?: string
    logsDir: string
  }
}
```

GitHub posting is enabled only by the `--post-github-comments` flag in v1; it cannot be enabled from configuration. `summaryWhenNoFindings` is a flag-scoped behavior option.

Provider/model defaults are user-level state, not repo policy. Repo `codeninja.toml` must reject credential-bearing fields and ignore provider-routing fields (`llm.provider`, `llm.model`, `llm.reasoning`) unless they came from CLI, environment, `~/.codeninja/settings.json`, or another user-scoped config source.

Chosen defaults:

- `review.depth = "normal"`
- `review.verify = true`
- `review.maxFindings = 25` (report cap)
- `review.softCommentCap = 7` (inline target)
- `review.concurrency = 4`
- `llm.maxConcurrentCalls = 4`
- `review.timeoutMs = 30 * 60 * 1000`
- `review.perPassTimeoutMs = 5 * 60 * 1000` (per model task/worker, not per stage)
- `review.minConfidence = "medium"`
- `review.minInlineConfidence = "medium"`
- `review.maxTotalTokens` and `review.maxModelCalls` unset (no cap)
- `github.summaryWhenNoFindings = false`
- `git.baseBranch = undefined`
- `classification.pathRules = []`
- `llm.provider`, `llm.model`, and `llm.reasoning` unset unless supplied by CLI, environment, or user-level config; unresolved reasoning falls back to the built-in `high` default at runner construction
- `cache.enabled = false`
- `cache.dir = ".codeninja/cache"`
- `telemetry.enabled = true`
- `telemetry.logLevel = "warn"`
- `telemetry.debugTrace = false`
- `telemetry.runDir = ".codeninja/runs"`
- `telemetry.retainRuns = 20`
- `eval.logsDir = "logs"`
- Default-enabled lens set = all four bundled lenses.

Neither `review.maxFindings` nor `review.softCommentCap` suppresses verified critical/high findings.

Example path classification config:

```toml
[git]
baseBranch = "main"

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

### Provider/Auth CLI

Responsibilities:

- Implement `codeninja provider list`, `login`, `logout`, `auth-status`, `models`, and `config` subcommands.
- Use Pi's provider/model registry and auth storage through a codeninja wrapper; pipeline code must not import Pi provider/auth classes directly.
- Store credentials and provider defaults under `~/.codeninja/` by default, with `CODENINJA_HOME` as an override.
- Create the user home directory with mode `0700` where supported; write `auth.json` and `settings.json` with mode `0600`.
- Register every concrete credential value with the redaction layer before any logger, telemetry, artifact, cache, debug trace, or error context can observe it.

Commands:

```text
codeninja provider list
codeninja provider login <provider>
codeninja provider logout [provider]
codeninja provider auth-status [provider]
codeninja provider models [provider-or-search] [--all]
codeninja provider config
codeninja provider config set-provider <provider>
codeninja provider config set-model <provider> <model>
codeninja provider config set-depth <light|normal|deep>
codeninja provider config set-reasoning <low|medium|high|xhigh|auto>
```

`provider login` uses Pi OAuth/device-code flow when available, otherwise prompts for an API key. `provider models` lists authenticated models by default and all Pi-known models with `--all`, including context window, max output tokens, reasoning support, and input/vision capability when known. `provider config` emits credential-free JSON containing paths and effective defaults.

### Git And GitHub Input Resolver

Responsibilities:

- Verify the command runs inside a git worktree.
- Resolve review input into base/head refs, merge base, commits, changed files, and unified diff.
- Fetch missing PR refs for `--pr` without changing the user's current branch.
- Collect commit titles and descriptions across the reviewed range.
- Provide file content at base/head refs for syntax parsing.

`--pr` flow:

1. Run `gh pr view <number>` to fetch title, body, URL, base/head refs, and the `baseRefOid`/`headRefOid` SHAs. The reviewed diff revisions come from `baseRefOid`/`headRefOid`, so the reviewed diff matches GitHub's PR diff; the merge base is computed between those SHAs, and the diff is computed with fixed rename-detection flags.
2. List codeninja's own prior review comments (`listOwnComments`) for duplicate avoidance; human review threads are not fetched in v1.
3. Check whether base and head commits exist locally with `git cat-file -e`.
4. If missing, fetch into internal refs: head via `git fetch <base-remote> refs/pull/<n>/head:refs/codeninja/pr/<n>/head` (covers fork PRs); base via fetching the base branch or the `baseRefOid` SHA directly. Failures are `git_fetch_failed`.
5. Do not checkout, reset, stash, or mutate the working tree.
6. Compute merge base and diff locally.
7. Collect commit metadata with `git log <mergeBase>..<head>`.

Ref lifecycle: `refs/codeninja/pr/<n>/*` are force-updated on each run and deleted at run end (best-effort); stale refs from crashed runs are cleaned at the start of the next run for the same PR.

Shallow and partial clones are detected via `git rev-parse --is-shallow-repository`. codeninja attempts a bounded deepen (`git fetch --deepen`) covering the review range; if the range is still unresolvable, it fails with a `git_ref_missing`-class error naming the fix (`git fetch --unshallow`).

`--branch --base` flow:

1. Resolve the review branch locally.
2. Resolve the base branch in precedence order: CLI `--base`, `codeninja.toml` `git.baseBranch`, existing `master`, existing `main`.
3. If no base branch resolves, fail with a clear error asking the user to pass `--base` or configure `git.baseBranch`.
4. Compute merge base between the base branch and branch head.
5. Diff `mergeBase..branchHead`.
6. Collect commit metadata with `git log mergeBase..branchHead`.

With no target arguments, the resolver uses branch mode with the current branch from `git rev-parse --abbrev-ref HEAD`. A detached HEAD, or a current branch that resolves to the base branch itself, fails with a clear error asking for an explicit review target.

Commit or commit range flow:

1. Resolve the start commit and optional end commit locally.
2. With one commit, diff the commit's first parent against the commit.
3. With two commits, diff the start commit against the end commit.
4. Collect commit metadata for the single commit or reviewed range.

Commit-mode boundary cases: a root commit (no parent) diffs against the empty tree (`git hash-object -t tree /dev/null` sentinel). Submodule pointer bumps are classified `skip` with reason "submodule pointer change". Symlink diff entries are inventoried but not content-reviewed (skip with reason).

In every mode the resolver populates `ResolvedReviewInput.mergeBase` with the effective base revision (the first parent for single-commit review, the empty tree for a root commit), so later stages never re-derive it.

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

Packet ID format (computed by the packet builder in Stage 6, stated here next to the hunk-id formula):

```text
sha256(path + sorted hunkIds + kind)
```

Packet ids are stable across reruns of the same diff.

### Repository Intelligence

Responsibilities:

- Parse changed files at base and head when content is available.
- Build changed-symbol facts (`HunkSymbolFacts`).
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
type ToolBackend = "tree-sitter" | "text" | "language-analyzer"

type ToolPrecision = "exact" | "semantic" | "syntactic" | "heuristic" | "text"

type SourceSelector =
  | { kind: "head" }
  | { kind: "base" }

type ToolResultMeta = {
  backend: ToolBackend
  precision: ToolPrecision
  degraded: boolean
  degradationReason?: string
  truncated?: boolean
  omittedCount?: number
}

type FileOutline = {
  path: string
  language: string
  packageName?: string
  imports: string[]
  topLevelSymbols: SymbolInfo[]
  testSymbols: SymbolInfo[]
  notes: string[]
}

interface RepositoryTools {
  readRange(path: string, startLine: number, endLine: number, source?: SourceSelector): Promise<{ text: string; meta: ToolResultMeta }>
  readFileOutline(path: string, source?: SourceSelector): Promise<{ outline: FileOutline; meta: ToolResultMeta }>
  readSymbol(path: string, selector: { symbolName?: string; line?: number }, source?: SourceSelector): Promise<{ text?: string; symbol?: SymbolInfo; meta: ToolResultMeta }>
  readDiffBlocks(input: { packetId?: string; path?: string }): Promise<{ blocks: string[]; meta: ToolResultMeta }>
  findDefinition(symbolName: string, options?: { pathGlob?: string; source?: SourceSelector }): Promise<{ definitions: Array<{ symbol: SymbolInfo; text?: string }>; meta: ToolResultMeta }>
  searchFiles(query: string, options?: SearchOptions): Promise<{ results: SearchResult[]; meta: ToolResultMeta }>
  findSymbolMentions(symbolName: string, options?: { pathGlob?: string; source?: SourceSelector }): Promise<{ results: SearchResult[]; meta: ToolResultMeta }>
  findLikelyTests(input: { path?: string; symbol?: SymbolRef; source?: SourceSelector }): Promise<{ tests: SymbolRef[]; meta: ToolResultMeta }>
  listFiles(glob: string): Promise<{ paths: string[]; meta: ToolResultMeta }>
}
```

Repository tools are stable contracts backed by pluggable implementations:

- Tree-sitter backend: preferred for files with available grammars. It provides symbols, enclosing blocks, imports, syntax-aware snippets, and static signals.
- Text backend: required fallback for every repository. It uses git plumbing reads, bundled ripgrep when the checkout matches the reviewed head, line windows, and simple filename/test conventions.
- Language analyzer backend: optional later enrichment for languages where stronger semantic analysis is available.

Tool callers should not need to know which backend answered. Every tool result should include backend provenance, precision, and degradation metadata. `readRange`, `readDiffBlocks`, and `listFiles` do not require tree-sitter. `readFileOutline`, `readSymbol`, `findDefinition`, `findSymbolMentions`, and `findLikelyTests` should use tree-sitter when available and degrade to text-backed approximations or empty degraded results when unavailable. `readSymbol` with a line selector returns the enclosing symbol at that line; symbol enumeration is answered by `readFileOutline` (its `topLevelSymbols`). Import questions are answered by `readFileOutline`, which includes the file's imports.

`findDefinition` locates definition sites for a symbol name repo-wide: `git grep` finds candidate files at the reviewed revision, tree-sitter parsing filters the matches to definition nodes, and results fall back to text matches marked degraded when parsing is unavailable. Like `findSymbolMentions`, it does not claim semantic resolution; when names collide, multiple candidate definitions are returned with provenance.

`findSymbolMentions` is intentionally named as a mention-finding tool, not a reference-resolution tool. Tree-sitter can find syntactic identifier mentions, but it cannot prove cross-file symbol identity, import resolution, shadowing, dynamic dispatch, interface implementation, or overload resolution by itself. If a future language analyzer backend can prove real references, the result can be marked with `precision: "semantic"` or `precision: "exact"` without changing the reviewer-facing tool contract.

Source-reading tools default to head content and can read base content when available. Base reads are required for deleted-file review and old-side context.

Revision access uses git plumbing rather than the checked-out worktree. File reads use `git show <ref>:<path>`, tree listings use `git ls-tree`, and whole-tree search uses `git grep <ref>`, so base and head trees are fully accessible regardless of what is checked out, without materializing temporary worktrees. Tree-sitter parses revision content in memory and never depends on worktree files. The bundled `@vscode/ripgrep` is a search fast path used only when the checked-out HEAD equals the reviewed head revision and the relevant files are unmodified; the engine that answered (ripgrep or git grep) is recorded in telemetry, not in tool results.

`searchFiles` query contract: the query language is POSIX ERE. The text backend invokes `git grep -E` (revision search) and ripgrep with flags aligned to ERE semantics (worktree fast path). Engine differences that actually affect results (ignore-file handling, binary detection) are recorded via `ToolResultMeta.degradationReason`; engine identity itself lives in telemetry. Queries are treated as patterns, never shell-interpolated.

Tool results must be capped by count and characters, include line numbers, prefer semantic blocks over whole files, and record truncation or omitted-result counts in telemetry. The model should see structured summaries and source snippets, not raw AST dumps.

### Skills And Lenses

Responsibilities:

- Load bundled Markdown skills from the package's `bundled-skills/` directory.
- Load repo-local Markdown skills from `.codeninja/skills/`.
- Validate skill frontmatter and content.
- Register user-facing lenses.
- Map lenses to one or more skills.
- Build prompts for planner, lens review, verifier, and composer stages.

Skill file shape:

```md
---
id: lang/go
title: Go correctness
lenses: ["lang/go"]
languages: ["go"]
categories: ["correctness", "performance"]
enabledByDefault: true
---

# Purpose

# Checks

# False Positives

# Safe Patterns

# Examples
```

Bundled v1 lenses:

- `core/code-review` (absorbs logic-bug and architecture review as sections of one skill)
- `core/tests`
- `lang/go`
- `lang/typescript`

Additional domain lenses can be added after the core pipeline works.

Skill load failure: malformed skill files warn, are skipped, and are disclosed in the run summary (recoverable `skill_invalid`); a lens whose only skills failed to load is disabled with disclosure.

Lens registration: a lens exists iff at least one loaded skill declares it in `lenses`. `--lens <unknown>` is a fatal `invalid_args` error listing available lenses. `enabledByDefault` conflicts across skills resolve to enabled unless config explicitly disables the lens; config always wins.

### LLM Runner

Responsibilities:

- Wrap `@earendil-works/pi-ai`.
- Execute model calls with prompt, tools, timeout, and schema expectations.
- Resolve the model once from the resolved `llm.provider`/`llm.model` (already merged from CLI, environment, and user-level settings by the config loader); a single model serves all roles: `llm.model ?? Pi/provider default`.
- Resolve reasoning effort the same way for all roles: `llm.reasoning ?? "high"`. The runner never reads user state directly.
- Record per-call telemetry: model, provider, duration, token usage, prompt hash, output hash, and schema validation result.
- Enforce `llm.maxConcurrentCalls`.

Structured output strategy: every structured stage call uses a forced submit tool. The stage's output schema is exposed as a tool (e.g. `submit_plan`, `submit_review`, `submit_verdict`, `submit_composition`); the model finishes by calling it; the adapter validates the tool arguments against the schema. This composes with read-only repository tools attached to the same call. There is no reliance on a provider response_format.

Schema system: LLM input/output schemas are authored in TypeBox (pi-ai's native schema system), with static types derived via `Static<typeof Schema>`. zod remains for config validation only.

Tool-loop ownership: the agent loop is implemented inside the pi-runner, behind `LlmRunner.runStructured`. It drives pi-ai `complete()` + `validateToolCall` per step, executes repository tool calls, enforces the request's `ToolBudget` (max tool calls, investigation rounds, result chars), injects results, and terminates on submit-tool call, budget exhaustion, or timeout. pi-ai's own `agentLoop` is not used. The worker runner schedules workers and supplies the budget through `LlmStructuredRequest`; it does not run the loop itself.

Timeouts: `timeoutMs` is implemented with `AbortController` passed to pi-ai (pi-ai exposes abort, not timeout).

Retry rule: one repair attempt on a schema-invalid submit, using a repair prompt.

Interface:

```ts
interface LlmRunner {
  runStructured<T>(request: LlmStructuredRequest<T>): Promise<T>
}

type LlmStructuredRequest<T> = {
  stage: ReviewStage
  prompt: string
  schema: TSchema // TypeBox schema; T = Static<typeof schema>
  tools?: ToolDefinition[]
  toolBudget?: ToolBudget
  timeoutMs: number
  telemetryContext: Record<string, unknown>
}
```

Pipeline code must depend on `LlmRunner`, not directly on Pi APIs.

### Local Review Cache

The local cache is optional and disabled by default. It is primarily for development and eval iteration, where cached model-backed stages make it possible to debug deterministic downstream behavior without rerunning every LLM call.

Cache keys are computed over the normalized request (the contract defined in the functional spec). The normalized request must include all prompt-affecting inputs:

- Stage id.
- Prompt template/version.
- Model/provider/reasoning settings.
- Packet, candidate, or verifier input payload.
- Project config affecting review behavior.
- Enabled lenses and skill content hashes.
- Tool budget and relevant repository source revisions.
- Repository identity, review target, base/head SHAs, and normalized diff hash.
- Tool-result context hashes for any tool output included in the prompt.
- Cache schema version.

Caching is per provider call, not per task. In tool-using stages each model→tool→model step is cached individually, keyed on the normalized request including the full conversation prefix (system prompt, packet content, prior tool calls and their results). A changed tool result therefore invalidates only the steps after it. Whole-task results are never cached.

Cache entries should record the pipeline stage (1-10) they came from. Cache data should live under the local repository's `.codeninja/cache` directory by default and must not be shared across repositories unless the key includes repository identity and source/diff hashes.

Cache entries are validated against the cache schema version on read; codeninja refuses a cache directory whose contents are tracked in the repository (prevents committed, attacker-crafted replay entries).

Eviction: at run start, entries older than 14 days or beyond a 500MB cap (oldest first) are removed.

Weak or incomplete results should not be cached as durable truth unless a stage explicitly marks them safe to reuse. Provider/auth failures, schema failures, cancelled calls, and incomplete verification results should not be reused as successful stage outputs. Telemetry and logs must record cache hit/miss/write events with the numeric stage.

### Review Pipeline

Responsibilities:

- Orchestrate all review stages.
- Enforce stage ordering.
- Enforce timeouts, token budgets, and concurrency limits.
- Persist stage artifacts.
- Emit telemetry events.

Main algorithm:

```ts
async function runReview(input: ReviewInput, config: CodeninjaConfig): Promise<ReviewResult> {
  const run = await startRun(config)
  const resolved = await resolveReviewInput(input, config, run.telemetry)
  const diff = await parseDiff(resolved.rawDiff, run.telemetry)
  const { kept: filtered, decisions } = await filterDiffFiles(resolved, diff, config, run.telemetry)
  const fileFacts = await classifyChangedFiles(resolved, filtered, decisions, config, run.telemetry)
  const repoIndex = await buildRepositoryIndex(resolved, filtered, fileFacts, config, run.telemetry)
  const dossier = await buildPlannerDossier(resolved, filtered, fileFacts, decisions, repoIndex, config, run.telemetry)
  const plan = await runPlanner(dossier, config, run.telemetry)
  const packets = await buildReviewPackets(plan, filtered, fileFacts, repoIndex, run.telemetry)
  const packetResults = await runLensPackets(plan, packets, repoIndex.tools, config, run.telemetry)
  const verified = await verifyFindings({ packetResults, packets }, repoIndex.tools, config, run.telemetry)
  const coverage = aggregateRunCoverage(plan, decisions, packetResults, verified, run.telemetry)
  const finalReview = await dedupeRankAndComposeReview(verified, plan, resolved, coverage, config, run.telemetry)
  const posting = await maybePublishToGitHub(finalReview, resolved, config, run.telemetry)
  await renderOutputs(finalReview, posting, config, run.telemetry)
  return finalReview
}
```

`renderOutputs` runs after `maybePublishToGitHub`: in posting mode the concise stdout summary renders from Stage 11's results, and its schema is the publisher's posting record (owned by `components/repository_and_github.md`); in non-posting mode `posting` is empty and rendering is unaffected by the ordering.

`ReviewResult` is the `--format json` output shape:

```ts
type ReviewResult = {
  summary: string
  coverage: RunCoverageStatus
  findings: FinalFinding[] // publication "inline" only; suppressed findings are artifact-only (final-findings.json / final-selection.json)
  summaryOnlyFindings: FinalFinding[] // publication "summary-only"
  needsHumanAttention: Array<{ question: string; files: string[]; symbols: string[]; reason: string; confidence: "high" | "medium" }> // code-assembled notes from medium/high-confidence follow-up hints
  noFindings: boolean
  postingPlan?: { // present only when --post-github-comments was passed
    inline: Array<{ findingId: string; anchor: DiffAnchor }>
    reviewBody: string
  }
}
```

Detection (generated/vendor/lock/binary) is a single shared deterministic detector library. The pipeline order matches the stage numbering: parse → Stage 2 filter (run the detectors the skip policy needs, decide keep/skip, record `FileFilterDecision`s with detection provenance) → Stage 3 classification (enrichment facts — language, package root, test status, counts, labels, priority — for kept files only, reusing the memoized detection results). Filtered files receive no enrichment, no parsing, and no review work. Each decision records one provenance entry.

Parallelizable work:

- Packet-level lens review uses `review.concurrency`.
- Verifier calls use `review.concurrency`.
- LLM provider calls are additionally capped by `llm.maxConcurrentCalls`.

Stage 7 packet review uses an internal sub-agent-like worker runner, not the external `pi-subagents` package. Useful orchestration ideas from Pi subagent systems are still applicable: focused child tasks, fresh or forked context, parallel workers, compact result handoff, saved artifacts, progress/status tracking, cancellation, and parent-controlled synthesis.

Worker runner responsibilities:

- Schedule packet workers with bounded concurrency.
- Give each worker one packet, selected lenses, projected skill guidance, and a tool budget.
- Isolate worker prompt context from other packet workers.
- Attach worker id, packet id, stage, and run id to every log, telemetry event, tool call, model call, and result artifact.
- Support cancellation, timeout, retry policy, and partial-run reporting.
- Return structured results only; workers do not publish comments or mutate the repository.

Lens execution rules:

- Run one composite model task per scheduled packet, with the selected lenses projected into that task.
- Do not run one model call per lens by default.
- Project and cap skill prompt sections for the review stage so large skill files do not dominate every packet prompt. Packet review prompts receive the skill's Checks, False Positives, and Examples sections; verifier prompts receive False Positives and Safe Patterns; the planner receives one-line skill/lens summaries only; the composer receives none. A per-skill projection cap and a total skill-content cap per prompt apply, with truncation recorded in telemetry. Defaults: 4000 chars per skill projection, 12000 chars total per prompt.
- Use coverage-aware execution profiles:
  - `simple`: one structured call with no repository tools; used for light or obvious mechanical packets.
  - `standard`: one structured/tool-capable task with focused review instructions and a reduced normal-mode tool budget.
  - `investigate`: one structured/tool-capable task with a larger budget for deep coverage, high/critical priority, planner hints, or risk notes.
- Standard and investigate packet reviewers may use the same read-only tool suite. The difference is budget, investigation depth, and prompting, not capability. Simple packets receive no repository tools.
- The reviewer should submit immediately when packet context is sufficient. Tool calls are for concrete missing evidence, not broad exploration.
- Packet reviewers should not review hunks in isolation. They should use packet context first, then bounded read-only tools to inspect relevant surrounding code: enclosing symbols, sibling patterns, call sites, tests, setup/cleanup, lifecycle, authorization, configuration, resource-management code, and existing patterns in the same file/package/component.
- Validate packet review output before verification. Schema-invalid output, missing evidence, low-confidence candidates, and anchors outside changed hunks are recorded in telemetry and suppressed or downgraded before verifier scheduling; low-confidence critical/high-severity candidates are not suppressed — they proceed to verification.

Failure and budget handling:

- Every structured LLM call gets one schema-repair retry.
- Per-stage terminal-failure policy:
  - Stage 5 planner → deterministic default plan (all reviewable hunks at `normal` coverage, core lenses plus the file's language lens); the run is marked degraded-planning in coverage disclosure. Later stages run normally.
  - Stage 7 packet workers → one retry for transient or schema failures; terminal failure marks the packet's hunks as `review_failed` in coverage accounting, counts toward partial-review disclosure, and never silently drops hunks.
  - Stage 9 → existing verification failure rules unchanged.
  - Stage 10 composer → one repair retry; terminal failure triggers a deterministic fallback composition (verified findings rendered with template wording, fingerprint-level grouping only, ranked by severity/confidence) with a disclosure note that semantic composition was skipped.
  - Authentication or provider-wide failures at any stage fail the run.
- Budgets (`timeoutMs`, `maxTotalTokens`, `maxModelCalls`) are checked before each new model call or worker dispatch. On exhaustion: stop scheduling new packet reviews → verify already-produced candidates using a reserved budget slice → always run composition and emit a partial-review disclosure.
- Approximately 15% of the configured token and model-call budgets (and a fixed tail of the runtime budget) is reserved for Stages 9-10 so completed review work is never lost to exhaustion. A hard kill at 2x the configured runtime budget is fatal; even then codeninja attempts to write telemetry artifacts before exiting.
- Provider 429 and transient 5xx responses get up to 3 retries with exponential backoff; retries count against budgets.
- The run-level coverage status is owned by the orchestrator, which aggregates plan-time coverage, runtime failures, budget stops, and verification incompleteness into the final coverage summary (run-level, not only `ReviewPlan.partialReview`):

```ts
type RunCoverageStatus = {
  totalHunks: number
  reviewedHunks: number
  skippedHunks: number
  failedHunks: number
  coverageByLevel: Record<"deep" | "normal" | "light" | "skip", number>
  degradedPlanning: boolean
  budgetStopped: boolean
  budgetStop?: BudgetStop
  unreviewedHunksByPath?: Array<{ path: string; hunks: number; reason: string }>
  verificationIncompleteCount: number
  partial: boolean
  reasons: string[]
}

type BudgetStop = {
  reason: "runtime_reserved_tail" | "max_model_calls" | "max_total_tokens" | "hard_timeout"
  stage: ReviewStage | 0
  elapsedMs: number
  timeoutMs: number
  hardTimeoutMs: number
  remainingRuntimeMs: number
  reservedTailRuntimeMs: number
  modelCalls: number
  inFlightModelCalls: number
  projectedModelCalls: number
  maxModelCalls?: number
  remainingModelCalls?: number
  reservedModelCalls?: number
  totalTokens: number
  inFlightTokens: number
  projectedTokens: number
  maxTotalTokens?: number
  remainingTokens?: number
  reservedTokens?: number
}
```

`coverage.json` serializes this plus per-hunk records that include source (`planner`, `deterministic_default`, or `config`) so evals can distinguish explicit planner decisions from routine defaults. Partial-but-successful runs finalize as `completed_partial` with exit code 0; full successful runs finalize as `completed_full`; fatal runs finalize as `failed`.

Non-parallel stages:

- Input resolution.
- Diff parsing.
- Deterministic planner dossier construction.
- Planning, except chunked planner calls for oversized dossiers, which may run concurrently.
- Deduplication/ranking/composition.
- Final GitHub publishing.

Planner dossier construction:

- The dossier is a compact, deterministic artifact, not full review context.
- It includes PR metadata, commit messages, changed file inventory, hunk inventory, line counts, simple file facts, configured labels/priorities, test/config summaries, generated/vendor detection, lockfile detection, the available lens registry with short descriptions, and any available changed-symbol facts, static signals, or surrounding-context hints.
- It records omitted details with counts and reasons when budgeted summaries are required.
- For small and medium reviews, one planner call can consume the dossier.
- For large reviews, code compacts the dossier deterministically and, when necessary, partitions it into chunks planned independently and concatenated mechanically (no meta-planner in v1; see Future Considerations).

V1 repository intelligence can be incremental:

- Required for v1: diff parsing, filtering, simple file classification, package-root hints, test-file detection, configured labels/priorities, absolute hunk line numbers, and seed context retrieval.
- Strongly preferred for v1: tree-sitter enclosing symbol and changed-symbol extraction for Go and TypeScript/JavaScript.
- Deferred to Future Considerations: symbol edges, caller/test relationship graphs, and semantic analyzer integrations.

### Verifier, Deduper, Composer

Verifier responsibilities:

- Reject low-quality candidate findings.
- Revise findings that are real but poorly anchored or worded.
- Preserve candidate lineage and verification telemetry.

Deduper and composer responsibilities:

- Group duplicates and same-root-cause issues.
- Rank findings by severity, confidence, evidence strength, and actionability.
- Produce final Markdown and GitHub comment bodies.

Composer design: deterministic pre-grouping runs first (fingerprint, path, anchor proximity, category), followed by one composer LLM call over all verified findings for semantic same-root-cause grouping, ranking input, and final wording. Deterministic post-processing then enforces the soft comment cap, re-validates anchors, applies confidence/severity thresholds, and preserves lineage. The composer call must not invent findings, and cap enforcement and suppression decisions are code, not model output.

Composer input cap: above 40 verified findings, a deterministic pre-trim by severity/confidence ranking runs before the composer call; trimmed findings are disclosed in coverage/telemetry, and critical/high findings are never trimmed.

Verifier keep criteria:

- Evidence includes changed code.
- Failure mode is concrete.
- Finding is tied to changed behavior.
- Anchor maps to a changed diff line for inline comments.
- False-positive risk is not high.
- Style-only comments are disabled unless the configured lens allows them.

Pre-verification gates run before LLM verification to avoid wasting calls on invalid candidates:

- Schema validation.
- Changed-line anchor validation for inline candidates.
- Required evidence and concrete failure-mode checks.
- Low-confidence suppression by default, except critical/high severity candidates, which proceed to LLM verification instead.
- Exact or obvious duplicate pre-clustering for verifier scheduling only.

LLM verification is enabled by default and runs one candidate at a time with bounded concurrency. The verifier receives the candidate, originating packet context, relevant changed hunk(s), cited evidence, active lens criteria, and read-only semantic tools. It may inspect surrounding code only to validate the candidate's specific claim. It must verify, revise, or reject the candidate; it must not search for new issues or introduce unrelated findings.

Verifier pre-clustering is not final deduplication. It may avoid repeated checks for identical or near-identical candidate copies, but semantic deduplication, same-root-cause grouping, comment-cap handling, ranking, and final wording happen only after verification.

Revision preserves candidate lineage and original validated anchors unless the verifier proposes a new anchor that validates against a changed diff line. Findings that are real but not changed-line anchorable become summary-only findings.

Unverified candidates are not publishable by default. Authentication or provider-wide verifier failures fail the run or mark the review incomplete. Individual verifier schema/parse failures get one repair attempt; candidates still unverified after retry are marked `verificationIncomplete` and suppressed from publication unless explicit config changes that behavior.

Dedup fingerprint:

```text
sha256(path + enclosingSymbolOrHunkIdentity + category + lensId)
```

`enclosingSymbolOrHunkIdentity` is the enclosing symbol name when available, else the hunk id. Inputs are normalized (lowercase, whitespace-collapsed). Model-authored wording (failure mode, evidence, message) is excluded from identity so fingerprints stay stable across runs.

A secondary fuzzy duplicate check runs before posting: same path within ±5 lines of an existing codeninja-authored comment counts as a duplicate. Category is not part of the fuzzy rule; it is hashed inside the fingerprint and not recoverable from posted markers.

Comment marker:

```html
<!-- codeninja:fingerprint=<fingerprint>;run=<run-id> -->
```

The marker must be appended to GitHub comment bodies and hidden from normal Markdown output where possible.

### Output And GitHub Publishing

Responsibilities:

- Render full Markdown report for stdout-only runs.
- Render the final review object as JSON when `--format json` is used, including a JSON run summary for posting runs.
- Render concise stdout summary for `--post-github-comments` runs.
- Create inline GitHub comments and summary review body when requested.
- Avoid duplicate comments from previous codeninja runs.

GitHub publishing approach:

- Use `gh api` for REST calls.
- Create one pull request review with event type `COMMENT` containing a summary body and inline comments. codeninja never approves or requests changes in v1.
- Inline comments use GitHub review comment fields such as `path`, `line`, `side`, `start_line`, `start_side`, and `commit_id` where applicable.
- Do not use deprecated diff positions as comment anchors.
- Use the PR head SHA as `commit_id`.
- Pre-validate every inline anchor against the parsed (GitHub-matched) diff before posting.

422 recovery: on review-creation 422, drop the identified or suspect-class comments (LEFT-side, deleted-file, multi-line anchors) and move them to the review body; retry up to 3 times; the final fallback posts a summary-only review containing all findings. Posting is fatal only if even the summary-only review fails.

Comment sanitization (deterministic, in code, post-composition): neutralize `@`-mentions by wrapping in backticks; strip HTML comments from model-authored text before appending the genuine fingerprint marker; cap comment body length; run a secret-pattern scrubber over evidence snippets before posting (and before persisting final findings).

Duplicate handling:

1. List existing PR review comments.
2. Parse codeninja fingerprint markers.
3. Skip findings with already-posted matching fingerprints.
4. Do not delete stale comments in v1.
5. If safe update is not possible, prefer posting no duplicate over trying to mutate existing comments.

A fingerprint marker counts as codeninja-authored only when the comment's author matches the authenticated `gh` identity codeninja runs as. Markers in other users' comments are ignored for duplicate suppression.

Publishing rules:

- Inline only verified medium/high-confidence findings with changed-line anchors.
- Broader system concerns go into the review summary.
- If no findings remain, do not post a GitHub summary by default unless `github.summaryWhenNoFindings` is true.
- Posting failures are fatal only when `--post-github-comments` was explicitly requested.

### Telemetry And Run Artifacts

Responsibilities:

- Create local run directory.
- Provide structured application logging.
- Record structured events.
- Record every repository tool call as a structured `ToolCallRecord` (always on, not debug-gated).
- Record aggregate metrics.
- Persist inspectable artifacts for debugging and evals.
- Keep stdout clean.

Run directory:

```text
.codeninja/runs/<yyyyMMdd-HHmmss>-<shortid>/
  run.json
  run.log
  telemetry.json
  events.jsonl
  model-calls.jsonl
  model-calls-summary.json
  tool-calls.jsonl
  tool-calls-summary.json
  planner-dossier.json
  review-plan.json
  coverage.json
  packets/
    <packet-id>.json
  candidate-findings.json
  verification.json
  final-selection.json
  final-findings.json
  cost-profile.json
  final-review.md
  github-posting.json
  debug/
    llm-calls/
      <call-id>.json
    tool-calls/
      <tool-call-id>.json
```

`debug/` is written only when `telemetry.debugTrace` is enabled. Debug artifacts may contain source snippets, prompts, and model outputs.

Logger interface:

```ts
type LogLevel = "debug" | "info" | "warn" | "error"

type LogEvent = {
  timestamp: string
  level: LogLevel
  runId: string
  stage: ReviewStage | 0 // 0 = pre-pipeline (CLI parse, config load, input validation)
  event: string
  message: string
  workerId?: string
  packetId?: string
  hunkId?: string
  path?: string
  candidateId?: string
  findingId?: string
  toolName?: string
  lensId?: string
  data?: Record<string, unknown>
}

interface Logger {
  debug(event: Omit<LogEvent, "timestamp" | "level">): void
  info(event: Omit<LogEvent, "timestamp" | "level">): void
  warn(event: Omit<LogEvent, "timestamp" | "level">): void
  error(event: Omit<LogEvent, "timestamp" | "level">): void
}
```

The logger writes timestamped structured lines to `run.log`. Human-facing stdout remains reserved for the final Markdown report or concise posting summary. Warnings and errors may also be mirrored to stderr. Every pipeline log must include the numeric `stage` from the functional spec so evals and later LLM analysis can reconstruct stage behavior from the log.

Telemetry event shape:

```ts
type TelemetryEvent = {
  runId: string
  eventId: string
  timestamp: string
  stage: ReviewStage | 0 // 0 = pre-pipeline (CLI parse, config load, input validation)
  level: "debug" | "info" | "warn" | "error"
  message: string
  file?: string
  lineRange?: [number, number]
  packetId?: string
  lensId?: string
  workerId?: string
  durationMs?: number
  cacheStatus?: "hit" | "miss" | "disabled" | "write"
  data?: Record<string, unknown>
}
```

The sinks are the contract for these two types — `run.log` for `LogEvent`, `events.jsonl` for `TelemetryEvent` — and a single emit API may fan one call out to both. Every stage emits `stage_started` / `stage_completed` lifecycle events carrying the numeric stage id; these are the source for per-stage runtimes in `telemetry.json`.

Tool-call records are first-class and always on. Every repository tool invocation — model-initiated inside an LLM tool loop or harness-initiated during deterministic stages — is recorded as one `ToolCallRecord` line in `tool-calls.jsonl`, regardless of debug settings:

```ts
type ToolCallRecord = {
  runId: string
  toolCallId: string
  timestamp: string
  stage: ReviewStage
  initiator: "model" | "harness" // model = issued inside an LLM tool loop; harness = deterministic pipeline use
  workerId?: string
  packetId?: string
  taskId?: string // Stage 8 targeted system follow-up task id
  candidateId?: string // verifier-issued calls
  modelCallId?: string // joins to model-calls.jsonl: the LLM call whose loop step issued this tool call
  tool: string
  args: {
    path?: string
    symbolName?: string
    line?: number
    startLine?: number
    endLine?: number
    query?: string
    glob?: string
    source?: string // "head" | "base"
    contextMode?: string
  }
  backend: ToolBackend
  precision: ToolPrecision
  engine?: "git-grep" | "ripgrep" // search-engine provenance for text-search-backed calls
  degraded: boolean
  degradationReason?: string
  truncated?: boolean
  resultCount?: number // matches/symbols/tests returned, when applicable
  resultChars: number
  durationMs: number
  status: "ok" | "error" | "rejected" | "skipped" // rejected = budget or containment denial
  errorCode?: CodeninjaErrorCode
}
```

`tool-calls-summary.json` aggregates per tool and per stage: call counts, error/rejection/degradation rates, average duration, and average result size. Full result payloads still live only under `debug/tool-calls/` when debug traces are enabled. Each tool call also emits a debug-level `tool_call` log event carrying `toolName`, `path`, and the line range. The `modelCallId` join gives evals a complete picture of how reviewers and verifiers actually used tools per packet, lens, and coverage level.

The telemetry recorder must support redaction before any future external export. V1 writes local files only. Typed telemetry artifacts should be the source of truth for metrics; `run.log` is the chronological narrative.

`coverage.json` serializes the run-level `RunCoverageStatus` plus per-hunk records `{ hunkId, path, coverage, source: "planner" | "deterministic_default" | "config", status: "reviewed" | "skipped" | "review_failed" | "degraded", reason? }`, including skipped reasons.

Run lifecycle:

- Run pruning: at run start, the telemetry recorder prunes `.codeninja/runs/` to the newest `retainRuns` directories (by mtime), never touching the active run.
- First-run provisioning: codeninja writes `.codeninja/.gitignore` (containing `runs/` and `cache/`) when creating `.codeninja/`.
- Concurrent runs: run directories are unique per run id; cache writes use write-temp-then-rename; an advisory lock file under `.codeninja/` guards ref cleanup. Concurrent runs are otherwise supported.

### Eval Support

V1 should include a `codeninja eval` command for repeatable quality testing against real repositories, fixtures, and captured artifacts. Eval support reuses the normal review engine and run artifacts; it must not fork a separate review implementation.

Eval command examples:

```bash
codeninja eval --eval-dir /path/to/evals
codeninja eval --eval-dir /path/to/evals --cache
codeninja eval --eval-dir /path/to/evals --no-cache
codeninja eval --from-artifacts /path/to/eval/logs/42
```

Eval cases are YAML files. Private eval cases should live outside the codeninja repository and may point to external local repositories. Public eval cases may use fixtures.

```ts
type EvalCase = {
  name: string
  repo?: {
    external?: string
    fixture?: string
  }
  command?: {
    pr?: number
    branch?: string
    base?: string
    target?: string
  }
  review?: {
    depth?: "light" | "normal" | "deep"
    lenses?: string[]
    maxFindings?: number
    concurrency?: number
    verify?: boolean
    cache?: boolean
    cacheDir?: string
    debug?: boolean
    provider?: string
    model?: string
    reasoning?: ReasoningLevel
  }
  logs?: {
    dir?: string
  }
  artifacts?: {
    path: string // artifact replay re-scores saved findings only
  }
  expect?: {
    minFindings?: number
    maxFindings?: number
    maxDuplicateGroups?: number
    maxCostUSD?: number // assertion on observed cost from cost-profile.json, not a run budget (cost-based run budgets are deferred)
    maxElapsedSeconds?: number
    maxModelCalls?: number
    maxToolCalls?: number
    maxPromptCharsByStage?: Record<ReviewStage | string, number> // keys are numeric stage ids
  }
  should_find?: EvalFindingExpectation[]
  should_find_candidate?: EvalFindingExpectation[]
  should_not_find?: EvalFindingExpectation[]
}
```

Expectation type (full matching detail delegated to `components/evals.md`):

```ts
type EvalFindingExpectation = {
  id: string
  path?: string
  lineRange?: [number, number]
  category?: FindingCategory
  severityAtLeast?: Severity
  titlePattern?: string      // regex
  failureModePattern?: string // regex
}
```

Matching semantics are deterministic field matching: a finding matches an expectation when all present fields match (path exact or glob, lineRange overlap, category equality, severity >= `severityAtLeast`, regex test for patterns). No LLM judging in v1 scoring.

Artifact replay (`--from-artifacts`) re-scores saved final findings and candidate findings against (possibly edited) expectations; no stages re-run.

Eval run directories:

```text
<eval-suite>/logs/<n>/
  info.json
  out.log
  codeninja-review.out.md
  telemetry/           # the engine's full standard run-directory artifact set
    run.json
    run.log
    telemetry.json
    events.jsonl
    planner-dossier.json
    review-plan.json
    coverage.json
    packets/
      <packet-id>.json
    candidate-findings.json
    verification.json
    final-selection.json
    final-findings.json
    cost-profile.json
    final-review.md
    model-calls.jsonl
    model-calls-summary.json
    tool-calls.jsonl
    tool-calls-summary.json
    debug/             # same layout as the engine run dir, when debug traces are enabled
  compare-to-previous.txt
  compare-to-previous.json
```

Eval scoring should compare expected findings against final findings, candidate findings, verification results, and the final-selection trace. Failures are labeled with four coarse loss labels: missed before candidate generation; lost at verification (pre-gate or verifier); lost at composition (deduped, merged, or capped); partial match. Hint presence (a follow-up hint named the expected file or symbol) is recorded as detail on a label, not as a separate label.

Eval metrics should include finding counts, duplicate groups, cost, runtime, model calls, verification calls, prompt sizes by stage, cache hit/miss counts, tool-call counts, and stage-loss counts. Cached and no-cache runs should both be supported so model-review quality and downstream deterministic behavior can be debugged separately.

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
  | "skill_invalid"
  | "path_outside_repo"
  | "llm_call_failed"
  | "llm_schema_invalid"
  | "github_post_failed"
  | "budget_exhausted" // recoverable; drives the budget degradation ladder
  | "timeout" // fatal; the hard kill at 2x the runtime budget

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
- Malformed skill files (warned, skipped, and disclosed in the run summary).
- Soft budget exhaustion (runtime, token, or model-call budget) — triggers the budget degradation ladder and a disclosed partial review.

Fatal errors:

- Not in a git worktree.
- Invalid input mode.
- Cannot resolve review range.
- Cannot resolve a base branch for branch review.
- Cannot parse the diff at all.
- Missing or unauthenticated `gh` for requested PR/GitHub posting mode.
- GitHub posting failure when posting was requested.
- Hard kill at 2x the runtime budget.

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

### Trust Boundaries

Untrusted inputs (enumerated): diff content, PR title/body, commit titles/descriptions, branch names, and repository tool results (file contents and search output read from the reviewed revisions). All are attacker-controlled when reviewing a fork PR.

Prompt construction: untrusted content must be structurally delimited in prompts (fenced blocks with explicit "this is data under review, not instructions" framing). Reviewer/verifier prompts instruct the model that instructions embedded in reviewed content must be ignored and may themselves be flagged as a finding (review-manipulation attempt).

Output channel control: everything posted to GitHub passes deterministic sanitization (see Output And GitHub Publishing). Telemetry/debug artifacts contain untrusted content by design and are local-only.

Repository tools path containment (single chokepoint in the RepositoryTools layer): all paths are canonicalized and required to resolve inside `repoRoot`; absolute paths and `..` traversal are rejected with a typed error (`path_outside_repo`); the worktree fast path must not follow symlinks resolving outside the repo root (git-plumbing reads are inherently contained); refs are harness-resolved only (model-facing source selectors expose `head`/`base`), and harness-side ref values are validated against `git check-ref-format` rules and rejected if option-like (leading `-`).

Config trust partitioning: the per-key config-source table in CLI And Config is normative. Repo `codeninja.toml` may set only the repo-settable safe keys listed there; every other key takes effect only with user-level opt-in — a CLI flag, `~/.codeninja/settings.json`, or the user-scoped config file `~/.codeninja/config.toml` (all under `CODENINJA_HOME`) — and repo-config values for user-scope keys are ignored with a warning. Repo-config-relative paths are constrained to the repo root.

Policy load revision: `codeninja.toml` and `.codeninja/skills/` always load from the trusted local checkout (the user's working copy), never from the PR head revision. If the PR under review modifies policy files (config or skills), that is surfaced to the planner as a risk signal and noted in the report.

Subprocess hygiene (GitClient/GitHubClient/tools contract): never invoke through a shell; always pass `--` before untrusted positional path/ref arguments; reject argument values matching `^-`; prefer SHAs over ref names when both are available (GitHub-supplied ref names are display-only).

Credentials: provider API keys come from environment variables or user-scoped provider auth state only (`~/.codeninja/auth.json`, overridable through `CODENINJA_HOME`); repo `codeninja.toml` must reject credential-bearing fields at parse time. Auth material (API keys, gh tokens, Authorization headers, OAuth tokens, device-flow tokens) must be stripped before anything is written to logs, telemetry, run artifacts, cache entries, debug traces, or error context.

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
- Static signal extraction for the two core cross-language rules.
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

## Future Considerations

Deferred designs, recorded as target shapes. Build any of these only when telemetry or evals show the v1 behavior falling short — never speculatively. The functional spec's Future Considerations section carries the product-level framing; this section preserves the technical shapes.

### Hierarchical planning

Group summaries, per-group sub-planners, and a meta-planner merging group plans into one `ReviewPlan`. V1 uses deterministic dossier compaction plus chunked planning with mechanical concatenation. Trigger: chunked planning measurably degrades plan quality (bad coverage decisions, missed risk areas) on large reviews.

### Broad Cross-File System Review

The shipped Stage 8 is intentionally narrow: it builds at most a few focused system-review tasks only from repeated, scoped Stage 7 follow-up hints. A broader cross-file system review remains deferred. Deferred shapes:

```ts
type SystemFollowUpTask = {
  topic: string
  files: string[]
  symbols: string[]
  lenses: string[]
  question: string
  toolBudget: ToolBudget
}

type SystemReviewResult = {
  taskId: string
  findings: CandidateFinding[]
  hintResolutions: Array<{ source: { kind: "planner" | "packet_hint" | "candidate" | "uncertainty"; packetId?: string }; outcome: "confirmed" | "rejected" | "unresolved"; note: string }>
  uncertainties: StructuredUncertainty[]
  status: "completed" | "incomplete" | "failed" | "skipped"
}
```

With the broad stage, the following return: `ReviewPlan.systemFollowUpTasks` (planner-emitted tasks that must name files or symbols), richer promotion rules (packet hints, candidate findings, and structured uncertainties become tasks through a typed signal index), context-isolated system workers with per-task file/symbol constraints and larger but explicit budgets, the `{ kind: "system_task"; stage; taskId; relatedPacketIds; lensId; skillIds; workerId? }` `FindingProducer` variant if distinct producer provenance is needed, the `"system_follow_up"` value in `SurroundingContextHint.expectedUse`, and a `systemReview` config block (`maxTasks`, `maxFilesPerTask`, `maxToolCallsPerTask`, `maxResultChars`, `taskTimeoutMs`). The cross-packet `ReviewSignal` index (next subsection) belongs to this same future. Trigger: hint-only eval losses show real cross-file misses that packet review plus the narrow repeated-hint Stage 8 do not surface.

### Cross-packet ReviewSignal index

Normalize planner tasks, packet hints, candidate findings, and uncertainties into typed signal records indexed by symbol, file, category, and configured labels, with graded promotion rules replacing the simple two-independent-mentions rule above:

```ts
type ReviewSignal = {
  id: string
  source: "planner" | "packet_hint" | "candidate" | "uncertainty"
  packetIds: string[]
  files: string[]
  symbols: string[]
  lenses: string[]
  category?: string
  question?: string
  reason: string
  priority: "critical" | "high" | "normal" | "low"
}
```

Trigger: evals show missed cross-file findings or noisy/duplicated Stage 8 tasks under the simple repeated-hint rule.

### Planner scheduling groups

Planner-emitted hunk groups carrying ordering and parallelism intent (`hunkGroups` with `groupId`, `hunkIds`, `canRunInParallel`). V1 scheduling is priority-only over independent packets. Trigger: cross-packet context sharing or genuinely dependent review ordering is introduced.

### Changed-symbol graph

Relationship edges over changed symbols, precomputed at index time:

```ts
type SymbolEdge = {
  from: SymbolRef
  to: SymbolRef
  kind: "calls" | "implements" | "extends" | "imports" | "tests" | "references"
  confidence: "syntactic" | "heuristic" | "semantic"
  source: "tree-sitter" | "ripgrep" | "lsp" | "compiler" | "custom"
}

type ChangedSymbolGraph = {
  symbols: ChangedSymbol[]
  edges: SymbolEdge[]
}
```

V1 ships `HunkSymbolFacts` and outlines; relationship questions are answered on demand by `find_symbol_mentions` and `find_likely_tests`. Trigger: evals show reviewer/verifier misses attributable to missing precomputed relationships. If built, it returns to `RepositoryIndex` as an optional field and a `changed-symbol-graph.json` run artifact.

### Language analyzer backends

Semantic enrichment (gopls / go-packages, TypeScript compiler API, Rust Analyzer) behind the existing `ToolBackend`/`ToolPrecision` contract, upgrading `find_symbol_mentions` results to `semantic`/`exact` without changing the reviewer-facing tools.

### Diff-file input mode

`--diff <path>` review of a loose unified diff without git revisions: `ReviewMode` regains `"diff_file"` and `ReviewInput` the `{ mode: "diff_file"; diffPath: string }` variant (mutually exclusive with the other target flags; commit/PR metadata unavailable; `mergeBase` unset). Preserved semantics: `SourceSelector { kind: "head" }` resolves to the checked-out worktree with `degraded: true` provenance and `{ kind: "base" }` returns a degraded empty result; before review each hunk's context lines are validated against the worktree, with mismatching files marked degraded (`FileFacts.degraded`), their packets carrying the degraded flag, and the mismatch disclosed in the coverage summary; diff file paths get the same repo-root containment validation as tool paths. Trigger: a consumer needs loose-patch review that `git apply` onto a temporary ref cannot serve.

### Spec-doc discovery for planning

`DiffUnderstanding` regains `relevantSpecs: Array<{ path: string; title?: string; whyRelevant: string }>` and `specAlignmentQuestions: string[]`, fed by a `specs.paths` config block (default `["specs/**/*.md", "docs/**/*.md", "adr/**/*.md"]`); the `"spec"` `SurroundingContextHint.kind` returns with it. Discovery stays deterministic: glob match, rank by path proximity to changed package roots then filename/title keyword overlap, top 5 docs as capped 2000-char snippets in the planner dossier; the planner selects from those candidates only, no LLM-driven discovery. Matched docs/specs rejoin the untrusted-input enumeration. Trigger: evals show intent-only alignment (`declaredIntent`/`inferredBehavior`) is insufficient to catch spec drift.

### Existing-PR-thread planner hints and overlap recording

V1 fetches only codeninja's own prior comments (`listOwnComments`) for rerun duplicate suppression; human threads are never fetched. Deferred: `GitHubClient.fetchReviewThreads(number, cap)` via `gh api graphql` over `pullRequest.reviewThreads` (`isResolved`, `isOutdated`, `path`, `line`, `comments`) with cursor pagination capped at 100 threads; `PullRequestMetadata.existingThreads: ExistingReviewThread[]` plus `omittedThreadCount` disclosure; thread summaries entering the planner dossier as hints only (deterministically extracted and truncated, never passed verbatim, never findings); and `FinalFinding.overlappingThreadIds` with the composer overlap rules (may acknowledge overlap in wording, must not drop a verified finding because a human raised a similar point, must never adopt an existing comment as a finding). Trigger: observed re-raising of points humans already made on the PR.

### Configured command execution

Opt-in execution of configured test/typecheck commands (`tools.testCommands` plus a timeout, honored only with user-level opt-in, never from repo config), with command output becoming evidence for reviewers, never automatic findings.

### Per-role model and reasoning tiering

`llm.roleModels` and `llm.roleReasoning` maps keyed by role (`planner`, `packetReview`, `systemReview`, `verifier`, `composer`) overriding the single `llm.model`/`llm.reasoning` per role. They remain provider-routing keys under the config trust partition (user-scoped sources only). Trigger: evals identify roles where cheaper models or lower reasoning hold review quality.

### Rich pre-attached packet context

`PacketContext` regains `changedNodes: AstNodeSummary[]`, `importsUsedNearby: string[]`, and `nearbySiblingFunctions: SymbolInfo[]`, pre-attached at packet construction:

```ts
type AstNodeSummary = {
  type: string
  name?: string
  lineRange: [number, number]
  summary: string
}
```

Trigger: tool-call telemetry shows packet reviewers repeatedly refetching the same local context (imports, sibling symbols, changed-node summaries) that pre-attachment would cover.

### Per-language static-signal packs

Per-language `StaticSignal` rules via `LanguageAdapter.getStaticSignals`, beyond the two bundled cross-language rules. Signal-promoted finding attribution (the `static_signal` `FindingProducer` variant plus a submit-schema citation field) returns with the packs. Trigger: telemetry/evals show recurring mechanical miss classes in a language that a deterministic rule would catch.

### Cost-based budgets

`review.maxCostUSD` as a run budget alongside tokens and model calls; in v1, unknown-cost calls counting zero made it a loophole, and `maxTotalTokens` covers the need. Trigger: Pi-reported pricing is reliable.

### Fine-grained eval attribution and replay

Verifier and merge expectations plus stage-level replay modes:

```ts
type VerifierExpectation = {
  expectationId: string
  verdict: "keep" | "reject" | "revise"
}

type MergeExpectation = {
  expectationIds: string[]
  intoOne: boolean
}
```

`EvalCase` regains `verifier.should_decide`, `merge.should_keep` / `should_drop` / `should_merge` / `should_not_merge`, and `artifacts.mode` (with `eval.replayMode`): `candidate-recall` replays saved candidates through verification/dedup/composition and `merge-only` replays saved verified findings through dedup/composition, alongside the v1 re-scoring behavior. Loss labeling refines into fine-grained labels (candidate-only, rejected-by-verification, merged/deduped away, omitted-by-cap, hint-only, same-file partial). Trigger: the four coarse loss labels cannot localize a regression to a specific stage.

## Component Docs

Detailed component docs elaborate this architecture:

- `components/review_pipeline.md`: orchestration, filtering, planning, packet construction, lens scheduling, verification, and composition.
- `components/repository_and_github.md`: local git resolution, PR metadata, diff parsing, file classification, GitHub anchor validation, duplicate detection, and posting.
- `components/context_and_tools.md`: seed context retrieval, tree-sitter-backed syntax helpers, read-only repository tools, and progressive language adapter support.
- `components/skills_llm_telemetry.md`: Markdown skill loading, provider auth and user-level model defaults, Pi runner integration, structured schemas, and telemetry artifacts.
- `components/evals.md`: eval command, YAML case format, cache/artifact replay, scoring, and regression reporting.
