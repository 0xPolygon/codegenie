---
status: complete
---

# Component: Review Pipeline

## Purpose And Scope

The review pipeline component owns `src/pipeline/*`: the orchestration of review stages 2, 5-7, and 9-10, the data flow between them, and the run-level failure, budget, and coverage semantics. For Stage 2 the ownership split is explicit: `components/repository_and_github.md` owns the detector, classifier, and filter pure functions; this component owns when they run, the `FileFilterDecision`-to-coverage-ledger writes, and the zero-work short-circuit. It is the harness described in `architecture.md`'s Implementation Philosophy — it owns stage order, validation, fallbacks, concurrency, cancellation, and coverage accounting, while model reasoning happens inside the stages it schedules.

This document owns:

- `runReview` stage sequencing, data flow, and the run context that carries budget and coverage state across stages.
- Orchestrating the Stage 2 detect/filter pass (kept files + `FileFilterDecision`s) and the Stage 3 classification of kept files, with the coverage-ledger writes and zero-work short-circuit owned here.
- Planner dossier construction, including the `PlannerDossier` type (delegated to this document by `architecture.md`) and the untrusted-content projection rules the dossier must follow.
- Planner invocation, planner output validation, deterministic planner fallbacks, and the degraded-planning default plan.
- Deterministic dossier compaction and deterministic chunked planning for oversized dossiers, including mechanical plan concatenation.
- The Stage 6 packet builder: the elaborated packet construction algorithm, coalescing rules, size limits, oversized-hunk truncation, packet identity, and coverage/lens fallbacks.
- The worker runner: scheduling, bounded concurrency, prompt isolation, retry policy, timeouts, and cancellation for stage 7 and stage 9 worker-style model tasks.
- Stage 7 lens execution rules, coverage-aware execution profiles, and packet result validation.
- The v1 routing of packet follow-up hints: telemetry hint events plus "needs human attention" report notes (Stage 8 system follow-up itself is deferred to Future Considerations — see architecture.md).
- Stage 9 verification orchestration: deterministic pre-verification gates, duplicate pre-clustering for verifier scheduling, verifier dispatch, and verdict handling.
- Stage 10 composition: deterministic pre-grouping, the single composer LLM call, deterministic post-processing, cap enforcement, needs-human-attention hint notes, and the deterministic fallback composition.
- Failure and budget semantics: per-stage terminal policies, budget checkpoints, the approximately-15% Stage 9-10 reservation, the budget exhaustion ladder, the 2x hard kill, and `RunCoverageStatus` aggregation.
- The zero-work short-circuit.

Explicitly not this component's responsibility (one-line pointers only):

- Repository tool implementations, seed-context retrieval, tree-sitter services, and language adapters: `components/context_and_tools.md`.
- Git/GitHub clients, review input resolution, diff parsing, the shared generated/vendor/lock/binary detector library, Stage 3 classification, anchor validation against the PR diff, duplicate-comment detection, and Stage 11 posting: `components/repository_and_github.md`.
- Skill loading, lens registration, prompt building and skill projection, `LlmRunner` internals (submit-tool mechanics, schema repair, provider retries), the local model-call cache, and telemetry/log recording: `components/skills_llm_telemetry.md`.
- Eval scoring and replay: `components/evals.md`.
- Output rendering (Markdown/JSON/stdout): consumed downstream of `ReviewResult`; this document only defines when `renderOutputs` is invoked.

All data contracts referenced here (`ReviewInput`, `ResolvedReviewInput`, `UnifiedDiff`, `DiffFile`, `DiffHunk`, `FileFacts`, `FileFilterDecision`, `HunkSymbolFacts`, `StaticSignal`, `ReviewPlan`, `HunkCoverageDecision`, `SurroundingContextHint`, `ReviewPacket`, `PacketHunk`, `PacketLine`, `PacketContext`, `ToolBudget`, `PacketReviewResult`, `FollowUpHint`, `CandidateFinding`, `DiffAnchor`, `FindingProducer`, `VerificationVerdict`, `FinalFinding`, `RunCoverageStatus`, `ReviewResult`, `CodeninjaConfig`, `RepositoryIndex`, `LlmRunner`) are defined in `architecture.md` and the functional spec and are not redefined here. The only type this document defines is the planner dossier (`PlannerDossier` and its `Dossier*` member records), which `architecture.md` explicitly delegates to this document.

Anything listed under Future Considerations in the parent specs — hierarchical planning and the meta-planner, the cross-file system follow-up stage (Stage 8) and its cross-packet `ReviewSignal` index, planner scheduling groups, the changed-symbol graph, diff-file input mode, spec-doc discovery, existing-PR-thread hints, per-role model/reasoning tiering, and rich pre-attached packet context — is deferred and not designed here.

## Public Interface

The pipeline's only externally consumed entry point is `runReview`. The per-stage functions below are the internal module seams inside `src/pipeline/`; they are listed because they define the stage contracts, telemetry boundaries, and error behavior an implementer must honor. Signatures follow the main algorithm in `architecture.md`; where a stage must report degradation state that no architecture data contract carries, the return type is refined with an inline structural wrapper rather than a new named type.

### Entry Point

```ts
// src/pipeline/review-runner.ts
async function runReview(
  input: ReviewInput,
  config: CodeninjaConfig,
  overrides?: { repoRoot?: string; runArtifactDir?: string }
): Promise<ReviewResult>
```

- Returns the final `ReviewResult` for every completed run, including degraded, partial, budget-stopped, and zero-work runs. Partial reviews are successful completions; disclosure lives in `ReviewResult.coverage`, not in errors or exit codes.
- `overrides` is the eval seam (`components/evals.md`): `repoRoot` pins the reviewed repository explicitly (the resolver verifies it is a git worktree and runs there instead of the process cwd); `runArtifactDir` makes the telemetry layer write the engine's standard run-directory artifact set at that path (e.g. `logs/<n>/telemetry/`) instead of `.codeninja/runs/<run-id>/`. Stage behavior, artifact contents, and failure semantics are unchanged by either override.
- Throws `CodeninjaError` only for fatal conditions: propagated resolution/parsing failures (`not_git_worktree`, `invalid_args`, `git_ref_missing`, `git_base_branch_unresolved`, `git_fetch_failed`, `pr_not_found`, `gh_missing`, `gh_auth_failed`, `diff_parse_failed`, `config_error`), authentication or provider-wide LLM failures at any stage (`llm_call_failed` with `recoverable: false`), the hard kill at 2x the runtime budget (`timeout`), and `github_post_failed` when `--post-github-comments` was requested.
- `budget_exhausted` is recoverable and never escapes `runReview`; it drives the budget degradation ladder and a disclosed partial review.
- Before exiting on any fatal error after the run directory exists, `runReview` should attempt to flush telemetry artifacts.

### Run Context

`startRun(config)` creates the run context threaded through all stages. It is an internal object, not a published data contract:

```ts
// src/pipeline/review-runner.ts
async function startRun(config: CodeninjaConfig): Promise<RunContext>

// RunContext fields (internal):
//   runId: string                      — "<yyyyMMdd-HHmmss>-<shortid>", also the run directory name
//   telemetry: TelemetryRecorder       — recording owned by components/skills_llm_telemetry.md
//   logger: Logger
//   budget: BudgetLedger               — internal; see Failure And Budget Semantics
//   coverage: CoverageLedger           — internal; per-hunk records aggregated into RunCoverageStatus
//   abort: AbortController             — run-wide cancellation root
```

The coverage ledger accumulates the per-hunk records serialized into `coverage.json` (`{ hunkId, path, coverage, source: "planner" | "deterministic_default" | "config", status: "reviewed" | "skipped" | "review_failed" | "degraded", reason? }`, as defined in `architecture.md`). The budget ledger implements the checkpoints and reservation described under Failure And Budget Semantics.

### Stage Functions

Stage 2 filtering and Stage 3 classification are intentionally not implemented in `src/pipeline/*`. `runReview` calls `filterDiffFiles` and then `classifyChangedFiles` from `src/git/file-classifier.ts` (`components/repository_and_github.md`), and owns writing skip coverage, applying the zero-work short-circuit, and threading the decisions into downstream artifacts.

```ts
// src/pipeline/planner.ts — Stage 5 dossier
async function buildPlannerDossier(
  resolved: ResolvedReviewInput,
  filtered: DiffFile[],
  fileFacts: FileFacts[],
  decisions: FileFilterDecision[],
  repoIndex: RepositoryIndex,
  config: CodeninjaConfig,
  telemetry: TelemetryRecorder
): Promise<PlannerDossier>
```

- Deterministic; never calls the LLM. The dossier is persisted as `planner-dossier.json`.

```ts
// src/pipeline/planner.ts — Stage 5 planner invocation
async function runPlanner(
  dossier: PlannerDossier,
  config: CodeninjaConfig,
  telemetry: TelemetryRecorder
): Promise<{ plan: ReviewPlan; degradedPlanning: boolean; chunked: boolean }>
```

- Returns a validated `ReviewPlan` in all non-fatal cases. On terminal planner failure (after the one schema-repair retry) it returns the deterministic default plan with `degradedPlanning: true` instead of throwing. Throws only authentication or provider-wide `llm_call_failed`. `chunked: true` when deterministic chunked planning ran. The orchestrator destructures this result; the architecture main algorithm's `const plan = await runPlanner(...)` elides the wrapper. The validated plan is persisted as `review-plan.json`.

```ts
// src/pipeline/packet-builder.ts — Stage 6
async function buildReviewPackets(
  plan: ReviewPlan,
  filtered: DiffFile[],
  fileFacts: FileFacts[],
  repoIndex: RepositoryIndex,
  telemetry: TelemetryRecorder
): Promise<ReviewPacket[]>
```

- Deterministic; never calls the LLM. Records malformed planner-fallback reasons and skip coverage records on the coverage ledger via telemetry. Each packet is persisted as `packets/<packet-id>.json`.

```ts
// src/pipeline/lens-runner.ts — Stage 7
async function runLensPackets(
  plan: ReviewPlan,
  packets: ReviewPacket[],
  tools: RepositoryTools,
  config: CodeninjaConfig,
  telemetry: TelemetryRecorder
): Promise<PacketReviewResult[]>
```

- Returns one `PacketReviewResult` per scheduled packet, including `status: "failed"` results for terminal worker failures and `status: "skipped"` results for packets never dispatched due to budget exhaustion. Never throws for per-packet failures; throws only authentication or provider-wide `llm_call_failed`.

```ts
// src/pipeline/verifier.ts — Stage 9
async function verifyFindings(
  input: { packetResults: PacketReviewResult[]; packets: ReviewPacket[] },
  tools: RepositoryTools,
  config: CodeninjaConfig,
  telemetry: TelemetryRecorder
): Promise<{ verified: CandidateFinding[]; verdicts: VerificationVerdict[]; incompleteCount: number; gateRejections: number }>
```

- `verified` contains kept and revised findings (the `finalFinding` when revised, preserving candidate ids). `verdicts` carries every LLM verdict. `verification.json` persists one record per candidate — gate records plus verdicts (shape under Stage 9). Gate-suppressed and pre-clustered-duplicate candidates never reach the verifier. Throws only authentication or provider-wide `llm_call_failed`.

```ts
// src/pipeline/review-runner.ts — coverage aggregation
function aggregateRunCoverage(
  plan: ReviewPlan,
  decisions: FileFilterDecision[],
  packetResults: PacketReviewResult[],
  verified: { incompleteCount: number },
  telemetry: TelemetryRecorder
): RunCoverageStatus
```

- Pure aggregation over the coverage ledger plus stage results; the orchestrator additionally folds in `degradedPlanning` and the budget ledger's stop state. Owner of the run-level coverage truth (not only `ReviewPlan.partialReview`).

```ts
// src/pipeline/composer.ts — Stage 10
async function dedupeRankAndComposeReview(
  verified: { verified: CandidateFinding[]; verdicts: VerificationVerdict[] },
  plan: ReviewPlan,
  resolved: ResolvedReviewInput,
  coverage: RunCoverageStatus,
  config: CodeninjaConfig,
  telemetry: TelemetryRecorder
): Promise<ReviewResult>
```

- Always returns a `ReviewResult`; terminal composer failure (after one repair retry) triggers the deterministic fallback composition instead of throwing. Throws only authentication or provider-wide `llm_call_failed`. Final-selection decisions are persisted as `final-selection.json` and `final-findings.json`.

### Worker Runner

```ts
// src/pipeline/worker-runner.ts
type WorkerTask<T> = {
  workerId: string                 // "w<stage>-<seq>", e.g. "w7-004"
  stage: ReviewStage               // 7 or 9
  priority: ReviewPriority
  packetId?: string
  candidateId?: string
  timeoutMs: number
  retryOnTransient: boolean        // true only for Stage 7 packet workers
  run: (signal: AbortSignal) => Promise<T>
}

interface WorkerRunner {
  schedule<T>(tasks: Array<WorkerTask<T>>): Promise<Array<{ task: WorkerTask<T>; outcome: "completed" | "failed" | "cancelled" | "timed_out" | "not_dispatched"; value?: T; error?: unknown }>>
  cancelAll(reason: string): void
}
```

- `schedule` resolves when all dispatched tasks settle; it never rejects for individual task failures. Tasks not dispatched because of budget checkpoints settle as `not_dispatched`. `WorkerTask` is an internal execution record, not a published data contract.

### Error Conditions Summary

| Condition | Behavior |
| --- | --- |
| Planner terminal failure (non-auth) | Deterministic default plan; `degradedPlanning` in coverage |
| Packet worker terminal failure | Hunks marked `review_failed`; partial disclosure; run continues |
| Verifier per-candidate failure after repair | `verificationIncomplete`; candidate suppressed from publication |
| Composer terminal failure | Deterministic fallback composition with disclosure note |
| Auth or provider-wide failure, any stage | Run fails (`llm_call_failed`, fatal) |
| Soft budget exhaustion | Degradation ladder; partial disclosure; exit 0 |
| 2x runtime budget | Fatal `timeout`; best-effort telemetry flush |

## Internal Design

### Stage Sequencing And Data Flow

`runReview` should execute exactly the main algorithm from `architecture.md`, with stage boundaries instrumented and artifacts persisted at each boundary:

```text
startRun                          -> run.json, run directory
resolveReviewInput   (stage 1)    -> ResolvedReviewInput          [repository_and_github]
parseDiff            (stage 1)    -> UnifiedDiff                  [repository_and_github]
filterDiffFiles      (stage 2)    -> kept DiffFile[], FileFilterDecision[]   [repository_and_github; coverage/zero-work here]
  -- zero-work short-circuit here --
classifyChangedFiles (stage 3)    -> FileFacts[] (kept files)     [repository_and_github]
buildRepositoryIndex (stage 4)    -> RepositoryIndex              [context_and_tools]
buildPlannerDossier  (stage 5)    -> PlannerDossier               -> planner-dossier.json
runPlanner           (stage 5)    -> ReviewPlan                   -> review-plan.json
buildReviewPackets   (stage 6)    -> ReviewPacket[]               -> packets/<id>.json
runLensPackets       (stage 7)    -> PacketReviewResult[]
verifyFindings       (stage 9)    -> verified findings, verdicts  -> candidate-findings.json, verification.json
aggregateRunCoverage              -> RunCoverageStatus            -> coverage.json
dedupeRankAndComposeReview (10)   -> ReviewResult                 -> final-selection.json, final-findings.json, final-review.md
maybePublishToGitHub (stage 11)   -> posting                      [repository_and_github]
renderOutputs                     -> stdout                       [output renderers]
```

Sequencing rules:

- Stages 1-4 are deterministic and strictly sequential, and the implementation order matches the stage numbering: parse → Stage 2 detect/filter → Stage 3 classification of kept files, per `architecture.md`.
- Stage 5 planning must complete before any packet review. Chunked planner calls for oversized dossiers are the only intra-stage-5 parallelism, bounded by `llm.maxConcurrentCalls`.
- After Stage 6 completes and before any Stage 7 dispatch, the orchestrator calls the tools host's `bindPackets(packets)` (`RepositoryToolsHost`, `components/context_and_tools.md`) so `readDiffBlocks(packetId)` lookups resolve for stage 7-9 workers; path lookups work without binding.
- Stage 7 packet workers run with bounded concurrency (`review.concurrency`); packets are independent by construction (never span files, isolated worker context), so all packets may run concurrently up to the limit.
- Stage 9 verifier calls run with bounded concurrency after all Stage 7 workers have settled (completed, failed, cancelled, or not dispatched). Stage 8 never runs: the cross-file system follow-up stage is deferred (see architecture.md Future Considerations); stage id 8 stays reserved.
- Stage 10 composition and stage 11 publishing are strictly sequential and always run (composition runs even under budget exhaustion; publishing only when requested).
- `renderOutputs` runs after `maybePublishToGitHub`, per the architecture main algorithm: in posting mode the concise stdout summary renders from Stage 11's results, and its schema is the publisher's posting record (owned by `components/repository_and_github.md`); in non-posting mode `posting` is empty and rendering is unaffected by the ordering.
- `candidate-findings.json` persists all candidates produced by Stage 7 (pre-gate), so evals can attribute losses to gates, verification, or composition.
- Every stage boundary emits telemetry events with the numeric stage id; every model task and tool call carries `runId`, `stage`, and the relevant `workerId`/`packetId`/`hunkId`/`candidateId`. Every repository tool call — model- or harness-initiated — additionally lands as one `ToolCallRecord` line in the telemetry recorder's always-on `tool-calls.jsonl` artifact.

Cancellation flows from the run context's root `AbortController`: the hard kill aborts it, which cancels in-flight workers and pending LLM calls; budget exhaustion does not abort in-flight work (the ladder only stops new dispatches).

### Stage 2: Detect/Filter Pass

`filterDiffFiles` is owned by `components/repository_and_github.md`: it runs the skip-relevant shared detectors and applies keep/skip policy, emitting kept files plus decisions carrying the detection provenance. Detection results are memoized per file and reused by `classifyChangedFiles` for kept files — nothing detects twice, and filtered files receive no classification, parsing, or review work. This component owns how the orchestrator applies the decisions to coverage, zero-work behavior, and downstream stage inputs.

The decision algorithm applies to every `DiffFile` in diff order; the first matching rule wins and each decision records the matched detector's `FactProvenance`. The canonical first-match precedence order is owned by `components/repository_and_github.md` (binary → lockfile → generated → vendored → ignored/config-skip/submodule/symlink → mode-only) and is not restated here.

Rules:

- Deleted files pass through the same rules: deleted generated/vendor/lock/binary files skip like ordinary files; deleted reviewable source, test, config, migration, and documentation files are kept. Filtering must never skip a file merely because `status === "deleted"`.
- Kept files preserve diff order. `kept` contains the `DiffFile` records unchanged; filtering never mutates the diff.
- For every skipped file, the coverage ledger records one per-hunk record per hunk of that file: `{ hunkId, path, coverage: "skip", source: "config", status: "skipped", reason }`. Files with zero hunks (e.g. binary, mode-only) record a single file-level telemetry event instead.
- Decisions flow to two consumers: the planner dossier's filter summary (counts and paths as review-scope facts) and `coverage.json`.
- Filtered files must not produce candidate findings; no later stage receives their content.

### Zero-Work Short-Circuit

Immediately after Stage 2, if `diff.files` is empty or `kept` is empty, `runReview` short-circuits before Stage 3 with no LLM calls:

1. Record coverage: every hunk skipped with its filter reason; `RunCoverageStatus = { totalHunks, reviewedHunks: 0, skippedHunks: totalHunks, failedHunks: 0, coverageByLevel: { deep: 0, normal: 0, light: 0, skip: totalHunks }, degradedPlanning: false, budgetStopped: false, verificationIncompleteCount: 0, partial: false, reasons: [...filter summary] }`. A zero-work run is a complete review of nothing, not a partial review.
2. Build `ReviewResult` with a deterministic template summary ("nothing to review" plus the filter summary), `noFindings: true`, empty findings and `needsHumanAttention` arrays, and no posting plan.
3. Render the report (including the filter summary), write all telemetry artifacts, and return; the CLI exits `0`.

Stage 3 classification, Stage 4 index construction, the dossier, and all model stages are skipped entirely.

### Planner Dossier

The dossier is the compact deterministic artifact consumed by the Stage 5 planner. It is a projection of the complete inventory, never full review context, and it is the type `architecture.md` delegates to this document. Member records use the `Dossier` prefix, following the convention that type-name prefixes mark scope.

```ts
type PlannerDossier = {
  runId: string
  mode: ReviewMode
  depth: "light" | "normal" | "deep"           // configured review depth for this run
  target: {
    baseRef?: string
    headRef?: string
    headSha?: string
    mergeBase?: string
  }
  // Untrusted, deterministically truncated; rendered inside fenced data blocks.
  pr?: {
    title: string                              // capped 200 chars
    body: string                               // capped 4000 chars
    url: string
    baseRefName: string
    headRefName: string
  }
  commits: Array<{ sha: string; title: string; body: string }>  // titles capped 200, bodies capped 1000 chars
  // Changed paths matching codeninja.toml or .codeninja/skills/** — a planner risk signal
  // per the Trust Boundaries policy-load rule.
  policyFilesChanged: string[]
  files: DossierFileEntry[]
  directories: DossierDirectoryRollup[]        // non-empty only when compaction collapsed file detail
  filterSummary: {
    keptFiles: number
    skippedFiles: number
    skipped: Array<{ path: string; reason: string }>   // capped at 50 entries; remainder counted in compaction.omitted
  }
  lenses: Array<{ id: string; summary: string }>        // enabled lenses with one-line summaries
  totals: {
    files: number          // all changed files, pre-filter
    keptFiles: number
    hunks: number          // hunks across kept files
    addedLines: number
    deletedLines: number
  }
  compaction: DossierCompaction
}

type DossierFileEntry = {
  path: string
  oldPath?: string
  status: DiffFile["status"]
  language: string
  processingMode: ProcessingMode
  testStatus: FileFacts["testStatus"]
  packageRoot?: string
  labels: string[]
  reviewPriority: ReviewPriority
  changedLines: number
  hunkCount: number
  degraded?: { reason: string }
  hunks: DossierHunkEntry[]    // empty when this file was collapsed into a directory rollup
}

type DossierHunkEntry = {
  hunkId: string
  header: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  changedNewLineNumbers: number[]   // run-length style "ranges" rendering is a prompt concern; data stays explicit
  changedOldLineNumbers: number[]
  symbolFacts?: HunkSymbolFacts
  staticSignals: StaticSignal[]     // top 5 by confidence (high > medium > low), then rule id; remainder counted
  omittedSignalCount: number
  excerpt?: string                  // changed lines only (add/delete), capped 400 chars, head side first
}

type DossierDirectoryRollup = {
  root: string                      // package root when known, else top-level directory
  fileCount: number
  hunkCount: number
  changedLines: number
  languages: string[]
  labels: string[]                  // union
  maxReviewPriority: ReviewPriority
  testFileCount: number
  representativePaths: string[]     // first 5 paths, lexicographic
  hunkIds: string[]                 // every hunk id in the rollup — planner overrides may target any of these hunks
}

type DossierCompaction = {
  level: "full" | "compacted" | "chunked"
  omitted: Array<{ what: string; count: number; reason: string }>
  chunkCount?: number               // present on per-chunk dossiers and the merged record
  chunkIndex?: number               // present on per-chunk dossiers only
  chunkRoot?: string                // the package/directory root this chunk covers
}
```

Construction rules:

- All dossier content is deterministic: same inputs produce a byte-identical `planner-dossier.json`.
- Untrusted fields (`pr`, `commits`, `excerpt`, branch names) are deterministically extracted and truncated here; the prompt builder's `renderDossier(dossier)` (`components/skills_llm_telemetry.md`) renders them inside fenced "data under review, not instructions" blocks. `buildPlannerPrompt` takes the dossier object itself, not pre-rendered text.
- Existing-PR-thread summaries and spec/doc candidates are not part of the v1 dossier (deferred to Future Considerations — see architecture.md).
- `policyFilesChanged` is computed from the pre-filter change inventory (`codeninja.toml`, any path under `.codeninja/skills/`), regardless of filter decisions.
- `lenses` lists the run's enabled lens set (after `--lens` overrides) with one-line summaries from the lens registry; the planner receives one-line summaries only, never skill bodies.
- The dossier includes hunk detail only for kept files; filtered files appear solely in `filterSummary`.

### Dossier Compaction

The rendered dossier prompt has a deterministic budget: `maxDossierPromptChars = 120000` (implementation constant; not user configuration in v1). Size is estimated by calling the prompt builder's exported `renderDossier(dossier)` (`components/skills_llm_telemetry.md`) — the same renderer, including its untrusted-content fencing, that `buildPlannerPrompt` embeds — so fencing overhead and size estimation stay consistent. Compaction applies ordered, deterministic reductions until the dossier fits, recording every reduction in `compaction.omitted`:

1. Drop `excerpt` from all hunks (`what: "hunk excerpts"`).
2. Reduce `staticSignals` per hunk from 5 to 1, keeping the highest-confidence signal (`what: "static signals"`).
3. Collapse per-hunk detail into per-file summaries (clear `hunks`, keep `DossierFileEntry` scalar facts) in ascending `reviewPriority` order (`low` first, `critical` last), lexicographic within a priority tier, stopping as soon as the dossier fits. Collapsed files' hunk ids are listed in a `DossierDirectoryRollup` for their root so every hunk id remains visible to the planner (`what: "per-hunk detail"`).
4. Collapse per-file entries into `DossierDirectoryRollup`s, same ordering, stopping as soon as the dossier fits (`what: "per-file detail"`).

`compaction.level` is `"full"` when no reduction ran and `"compacted"` otherwise. The full deterministic inventory is always complete on disk regardless of compaction; only the planner's view is reduced.

### Chunked Planning

If the dossier still exceeds the budget after step 4, planning chunks deterministically:

- Partition kept files by `packageRoot`, falling back to the top-level directory when no package root is known. Sort roots lexicographically and greedily pack them, in order, into chunks whose rendered size (chunk files at full detail plus the shared preamble) fits the budget. A single root that alone exceeds the budget is split further by subdirectory, then by file; a single file that alone exceeds the budget enters its own chunk with compaction steps 1-3 applied to that chunk only.
- Each chunk dossier carries the shared global sections (`pr`, `commits`, `policyFilesChanged`, `filterSummary`, `lenses`, `totals`) plus only its chunk's `files`, with `compaction = { level: "chunked", chunkCount, chunkIndex, chunkRoot }`.
- The same planner prompt runs once per chunk. Chunk calls may run concurrently, bounded by `llm.maxConcurrentCalls`. There is no meta-planner and no model-driven grouping in v1; hierarchical planning is deferred (Future Considerations).

Mechanical concatenation of per-chunk `ReviewPlan`s, in chunk-index order:

- `coverage`: concatenated. Each hunk belongs to exactly one chunk, so no conflicts arise; a duplicate `hunkId` across chunks keeps the first decision and drops the rest with telemetry.
- `riskAreas`: concatenated with exact-string deduplication (first occurrence wins).
- `diffUnderstanding`: `declaredIntent` from chunk 1 (all chunks saw identical metadata); `inferredBehavior` joins distinct chunk values labeled by chunk root.
- `partialReview`: `isPartial` is the OR; `reviewedHunks`/`totalHunks` summed; reasons joined.

If an individual chunk's planner call fails terminally, only that chunk's hunks fall back to the default plan (below); the merged result sets `degradedPlanning: true` with a reason naming the failed chunk roots.

### Planner Invocation And Validation

The planner call is one `LlmRunner.runStructured` per dossier (or per chunk) with the `submit_plan` TypeBox schema, the run's single resolved model, `review.perPassTimeoutMs`, and no repository tools — the v1 planner decides from the dossier and marks uncertainty rather than opening files. Schema repair (one retry) and provider retry/backoff live inside `LlmRunner` (`components/skills_llm_telemetry.md`).

Semantic validation runs in pipeline code on every schema-valid plan, before the plan is persisted:

- Coverage decisions referencing unknown or filtered `hunkId`s are dropped with telemetry (`planner_unknown_hunk`).
- A `skip` decision with an empty (after trimming) `reason` is invalid; it is recorded (`planner_invalid_skip`) and the hunk is treated as having no decision. The packet builder applies the `normal` fallback.
- Lens names not in the run's enabled lens set are dropped from each decision (`planner_unknown_lens`); a decision left with zero lenses is treated as having an empty lens set, which the packet builder fills with the default lens set.
- `surroundingContextHints` with paths outside the kept change set and no symbol are kept but marked tool-lookup-only; path containment itself is enforced at the repository tool chokepoint (`components/context_and_tools.md`).
- Hunks with no surviving decision are left undecided; the packet builder owns the `normal` fallback so that later stages do not become independent risk classifiers.

Validation never re-invokes the model. The persisted `review-plan.json` is the post-validation plan.

### Degraded-Planning Default Plan

On terminal planner failure (schema-invalid after repair, transient failure after `LlmRunner` retries, or per-pass timeout — anything except authentication/provider-wide failure, which is fatal), `runPlanner` returns the deterministic default plan:

- `coverage`: every reviewable hunk of every kept file at `normal`, `reason: "degraded planning: deterministic default"`, `surroundingContextHints: []`.
- Per-hunk `lenses`: the default lens set — enabled lenses whose ids begin with `core/`, plus the enabled language lens matching `FileFacts.language` for that file (`lang/go` for `go`, `lang/typescript` for TypeScript/JavaScript), in registry order.
- `riskAreas: []`.
- `diffUnderstanding`: `declaredIntent` is the PR title or first commit title (truncated, template-framed); `inferredBehavior: "unavailable (degraded planning)"`.
- `partialReview` unset — the default plan covers all hunks; degradation is disclosed through `RunCoverageStatus.degradedPlanning` and a `reasons` entry, not through partial coverage.

Later stages run normally on the default plan.

### Stage 6: Packet Builder

The packet builder is deterministic, never calls the LLM, performs no broad repository searches, and is the sole owner of packet identity and physical grouping. It elaborates the nine-step algorithm from `architecture.md`. Size constants (from `architecture.md`): `maxPatchChars = 12000`, `maxContextChars = 8000`, `maxHunksPerPacket = 5`. Additional implementation constants defined here: `nearbyGapLines = 30` (maximum new-side line gap for proximity coalescing), `maxLensesPerPacket = 6`.

Step 1 — planned hunk records. For each hunk of each kept file, assemble an in-memory record: the `DiffHunk`, its `FileFacts`, its `HunkSymbolFacts` (when present in `repoIndex.symbolFacts`), the validated `HunkCoverageDecision` (when present), processing mode, labels, configured priority, and estimated patch size in characters.

Step 2 — planner validation defaults/fallbacks. Applied per hunk:

- No decision → coverage `normal`, default lens set, coverage record source `deterministic_default`, no warning and no final-report disclosure reason.
- Invalid skip (empty reason after trimming) → coverage `normal`, default lens set, coverage record source `planner`, reason `planner_invalid_skip`, and telemetry.
- Decision with empty lens set after validation → default lens set (enabled `core/*` lenses plus the file's enabled language lens), coverage record source `planner`, reason `planner_empty_lenses`.
- Valid `skip` (non-empty reason) → no packet; coverage record `{ coverage: "skip", source: "planner", status: "skipped", reason: <planner reason> }`.

The packet builder validates and assembles; it never makes primary coverage decisions beyond these mechanical defaults/fallbacks.

Step 3 — processing mode application, per file:

- `processingMode === "skip"`: defensive only — such files should already be filtered at Stage 2; if one reaches Stage 6, record skip coverage for its hunks and exclude it, with a telemetry warning.
- `processingMode === "whole-file"`: produce one packet of kind `whole-file` containing all non-skipped hunks when limits allow: head-revision file content ≤ `maxContextChars`, combined hunk patch ≤ `maxPatchChars`, hunk count ≤ `maxHunksPerPacket`. If content exceeds the context cap but the combined patch fits, downgrade to one `file-diff` packet with `fileContext.reason` recording the downgrade. If the combined patch does not fit, fall through to the hunk-first path (step 4) with the downgrade reason recorded.
- `processingMode === "per-hunk"` with `status === "added"` and head content ≤ `maxContextChars` and combined patch ≤ `maxPatchChars` and hunk count ≤ `maxHunksPerPacket`: one `whole-file` packet (small added files are better reviewed as a unit), `fileContext.reason: "small added file"`.
- All other files: hunk-first (step 4).

Step 4 — conservative grouping (hunk-first files). Default is one packet per hunk, kind `hunk`. Iterate the file's non-skipped hunks in diff order with a greedy single-pass grouping; a hunk joins the current group when all hold:

- Same file (cross-file coalescing never happens; step 5).
- Same enclosing symbol (`HunkSymbolFacts.enclosingSymbol` non-empty and equal, same `symbolRange`), or new-side gap to the previous group member ≤ `nearbyGapLines`.
- Combined patch chars ≤ `maxPatchChars` and group size ≤ `maxHunksPerPacket`.

Otherwise the current group closes and a new group starts. Groups of one produce kind `hunk`; groups of more than one produce kind `coalesced-hunks`, except a group containing every hunk of the file, which produces kind `file-diff`. Grouping is stable: same diff and facts produce identical groups.

Step 5 — no cross-file packets. Cross-file concerns are recorded as packet follow-up hints (telemetry plus report notes; the Stage 8 system follow-up is deferred); the builder itself never creates them.

Step 6 — context attachment. For each packet, the builder calls the tools host's `buildPacketContext(file, hunks, symbolFacts)` (`RepositoryToolsHost`, `components/context_and_tools.md` owns retrieval; the builder owns the budget and assembly order). The call returns the `PacketContext` (path, package name, enclosing function/type/method), the file outline, the likely-tests list the builder assigns to `relevantTests` (`ReviewPacket.relevantTests` is the single carrier of likely tests; `PacketContext` has no tests field), and an optional degradation note that sets `ReviewPacket.degraded`. Richer pre-attached context — changed-node summaries, nearby imports, sibling symbols — is deferred (see architecture.md Future Considerations); reviewers fetch it on demand with read-only tools. The planner's `surroundingContextHints` are attached alongside. Hints with `expectedUse: "packet_context"` are resolved into context content now; hints with `expectedUse: "tool_lookup"` are passed through on the packet for the worker. The builder renders the retrieved deterministic context into `ReviewPacket.contextText`, filling `maxContextChars` in priority order — enclosing symbol source, file outline, likely tests, resolved hint extracts — truncating in reverse priority order and recording truncation in telemetry. The builder also fills `ReviewPacket.intentText` with the dossier's declared-intent projection (PR title/body extract, already fenced as untrusted data, capped at ~1000 chars). Deletion-only packets set `isDeletedContent: true` and attach base-revision context when available; when base content is unavailable the packet carries `degraded: { reason }` for coverage disclosure.

Step 7 — size enforcement and truncation:

- A multi-hunk packet exceeding `maxPatchChars` or `maxHunksPerPacket` after assembly splits back into per-hunk packets (deterministically, in hunk order).
- A single hunk whose patch alone exceeds `maxPatchChars` is never split below hunk granularity and never receives synthesized sub-hunk ids. Instead the packet carries a truncated patch window of at most `maxPatchChars` rendered characters; the window selection must be deterministic and centered on changed lines, and the truncation must be disclosed — the exact window heuristic is an implementation detail within that contract. `PacketHunk.lines` contains only the window's lines, with `truncated: true` and `omittedLineCount` set to the count of dropped lines; `contentWithLineNumbers` renders deterministic boundary markers (`[... N lines omitted above ...]`, `[... M lines omitted below ...]`) as the prompt rendering of those fields; the per-hunk coverage record carries `reason: "patch truncated: K of L lines included"`; telemetry records the omitted counts. `changedNewLineNumbers`/`changedOldLineNumbers` still list all changed lines of the hunk so anchor validation remains complete.
- Whole-file content participating in `maxContextChars` is truncated tail-first with the same marker convention.

Step 8 — packet coverage. `coverage` = the maximum coverage of included hunks, ordered `deep > normal > light`. (`skip` hunks never enter packets.)

Step 9 — packet lenses and review profile. `lenses` = the deduplicated union of included hunks' lens lists. If the union exceeds `maxLensesPerPacket`, keep in priority order: the file's language lens, then `core/*` lenses in registry order, then remaining lenses by member frequency descending, then lexicographic; dropped lenses are recorded in telemetry. After that cap, deterministically prune low-value `core/tests` and `core/code-review` when another lens remains: keep `core/tests` for test files, deleted tests, static test signals, planner test hints/risk, or important untested behavior; keep `core/code-review` for real source behavior/design risk, not obvious mechanical import-only packets. Compute `reviewProfile` as `simple`, `standard`, or `investigate` from effective coverage, configured priority, planner hints, risk notes, and mechanical-change signals.

Packet assembly details:

- `id = sha256(path + sorted hunkIds + kind)` per `architecture.md`; stable across reruns of the same diff.
- `prSummary`: deterministic one-paragraph projection of dossier metadata (PR title or first commit title plus totals), capped 500 chars; it is data framing, not model output.
- `PacketHunk` line data is copied from the parsed diff with absolute old/new numbers preserved exactly; `changedNewLineNumbers` (add lines) and `changedOldLineNumbers` (delete lines) are derived from `DiffLine` kinds.
- `toolBudget` is assigned from the review-profile/coverage/depth table below.
- `labels`, `riskNotes`: configured labels from `FileFacts`; risk notes from matching planner `riskAreas` entries (areas whose `files` include the packet path), truncated to 3 entries.
- Every packet is persisted to `packets/<packet-id>.json` before Stage 7 dispatch.

Tool budget table (implementation defaults; base budget by packet profile and coverage, then scaled by configured run depth — `light` depth halves values rounding down with a floor of 1 call / 1 round / 4000 chars for tool-capable profiles, `deep` depth multiplies by 1.5 rounding up):

| Packet profile | Packet coverage | maxToolCalls | maxInvestigationRounds | maxResultChars |
| --- | --- | --- | --- | --- |
| `simple` | any | 0 | 0 | 0 |
| `standard` | `light` | 1 | 1 | 3000 |
| `standard` | `normal` | 4 | 2 | 10000 |
| `standard` | `deep` | 10 | 3 | 20000 |
| `investigate` | `light` | 2 | 1 | 4000 |
| `investigate` | `normal` | 6 | 2 | 12000 |
| `investigate` | `deep` | 15 | 5 | 32000 |

### Worker Runner

The worker runner (`src/pipeline/worker-runner.ts`) is the shared execution substrate for Stage 7 packet workers and Stage 9 verifier calls — one worker type; deferred Stage 8 system workers are not designed here. It is codeninja-owned and sub-agent-like (focused child tasks, fresh context, parallel workers, compact result handoff, parent-controlled synthesis); it must not depend on the `pi-subagents` package.

Scheduling:

- A priority queue ordered by: task priority (`critical > high > normal > low`), then coverage level for packet tasks (`deep > normal > light`), then stable insertion order (packet path, first hunk position for packet tasks; candidate id for verifier tasks). Packet task priority derives from the packet's max configured `reviewPriority` across its hunks' files.
- Bounded concurrency via `p-limit` at `review.concurrency`; LLM provider calls are additionally capped by `llm.maxConcurrentCalls` inside the LLM runner.
- Before each dispatch, the runner calls the budget ledger checkpoint. On exhaustion it stops dispatching: remaining queued tasks settle as `not_dispatched` and the stage records them per the budget ladder (Stage 7: hunks not reviewed, partial disclosure; Stage 9: reserved-slice rules apply).
- Under budget pressure, higher-priority tasks dispatch first — this is the priority queue's only job in v1; there are no planner scheduling groups (Future Considerations).

Isolation:

- Each worker receives exactly one packet or candidate; selected lenses with projected skill guidance (projection rules owned by `components/skills_llm_telemetry.md`); a `reviewProfile`; a `ToolBudget`; and a fresh prompt context. Workers never share mutable conversation state, never publish comments, and never mutate the repository.
- Tool access is read-only and scoped: standard/investigate packet workers receive the full read-only `RepositoryTools` suite; simple packet workers receive no repository tools; verifiers receive the same suite for claim validation only. Path containment is enforced inside the tool layer.

Execution:

- Each worker composes one `LlmStructuredRequest` (stage schema, prompt, tools, `toolBudget`, timeout, telemetry context) and awaits `LlmRunner.runStructured`. Per `architecture.md`, the agent loop lives inside the pi-runner behind `LlmRunner.runStructured` — it executes repository tool calls, enforces the request's `ToolBudget`, and terminates on submit-tool call, budget exhaustion, or timeout. The worker runner schedules workers and supplies the budget through `LlmStructuredRequest`; it does not run the loop itself, and pipeline code never touches Pi APIs directly.
- Per-worker timeout: `review.perPassTimeoutMs` for packet and verifier workers. Timeouts use `AbortController`; the run-wide abort is chained so the 2x hard kill cancels all in-flight workers.
- Worker ids are `"w<stage>-<seq>"` with a per-stage sequence in dispatch order. Every log line, telemetry event, tool call, model call, and result artifact carries `workerId`, `packetId`/`candidateId`, `stage`, and `runId`. The worker runner supplies these stamps through the request's telemetry context; for model-initiated tool calls they become the call-context fields of the always-on `ToolCallRecord`s the agent loop emits into `tool-calls.jsonl` (with `initiator: "model"` and the issuing `modelCallId`).

Retry policy (layered; lower layers are owned by the LLM runner and referenced here):

1. Provider 429/transient 5xx: up to 3 retries with exponential backoff inside `LlmRunner`; retries count against budgets.
2. Schema-invalid submit: one repair attempt inside `LlmRunner` (every structured call, all stages).
3. Worker re-dispatch: Stage 7 packet workers only — one full re-dispatch after a transient failure or post-repair schema failure, subject to a budget checkpoint. Stage 9 workers get no re-dispatch beyond layers 1-2 (Stage 9's repair attempt is layer 2).

Outcome handling:

- `completed` → structured result returned to the stage.
- Stage 7 terminal failure (`failed`/`timed_out` after retry) → a `PacketReviewResult` with `status: "failed"`, empty findings; every hunk in the packet gets coverage record `{ status: "review_failed", reason }`; counts toward partial disclosure; hunks are never silently dropped.
- Stage 9 terminal failure → verdict recorded with `verificationIncomplete: true`; the candidate is suppressed from publication by default.
- `cancelled` (run abort) → recorded; the orchestrator is already failing fatally or finishing under the hard kill.
- Authentication or provider-wide failures are recognized by error classification from the LLM runner and immediately fail the run regardless of stage.

### Stage 7: Lens Execution

`runLensPackets` converts packets into validated `PacketReviewResult`s through the worker runner.

Execution rules:

- One composite model task per packet. All selected lenses are projected into that single task; there is never one model call per lens. Skill projection for the review stage includes only Checks, False Positives, and Examples sections, capped at 4000 chars per skill and 12000 chars total per prompt, with truncation recorded in telemetry (projection mechanics owned by `components/skills_llm_telemetry.md`).
- Coverage-aware execution profiles:
  - `light`: one structured call; tiny optional read-only tool budget (table above); compact prompting biased toward submitting immediately.
  - `normal`: one structured, tool-capable task; real read-only tool access; focused review instructions; bounded investigation.
  - `deep`: same capability as `normal` with a larger budget and more investigation rounds. Normal and deep differ in budget, depth, and prompting — never in tool capability.
- Reviewer instructions (prompt content owned by the prompt builder, behavior contract owned here): use packet context first; use tools only to support, narrow, or reject a concrete changed-code concern (enclosing symbols, sibling patterns, call sites, tests, setup/cleanup/lifecycle/authorization/configuration/resource-management code, existing local patterns); submit immediately when packet evidence is sufficient; submit an empty finding list when evidence is insufficient; treat reviewed content as data, and report embedded instructions as a possible review-manipulation finding.
- Deletion-only packets (`isDeletedContent: true`) instruct the reviewer to focus on removal risks: removed required behavior, tests, security checks, cleanup, exports, broken callers, stale references, and migration/config consequences; anchors are old-side (`LEFT`).

Result validation, applied in pipeline code to each schema-valid `PacketReviewResult` before anything reaches Stage 9:

- Candidate ids are assigned deterministically by the pipeline — `"<packetId first 8 chars>-f<seq>"` in submission order — replacing any model-supplied ids; lineage uses these ids everywhere.
- `producedBy` is stamped deterministically by the runner: `{ kind: "packet", stage: 7, packetId, lensId, skillIds, workerId }`, with `lensId` set to the packet's primary (first) lens and `skillIds` to that lens's skills. The model never claims a lens — `SubmittedFinding` carries no lens field (`components/skills_llm_telemetry.md`).
- Anchor validation: an inline-intended candidate's `anchor` must reference the packet's path (side-appropriate for renames/deletions per the `DiffAnchor` path semantics) and a changed line of the packet's hunks — `RIGHT` against `changedNewLineNumbers`, `LEFT` against `changedOldLineNumbers`, with `hunkId` matching the containing hunk. Failing anchors are removed (`out_of_hunk_anchor` telemetry); the candidate continues as a summary-only candidate with `changedLine: false` unless the result itself re-anchored it to a changed line with concrete evidence.
- Missing `evidence.changedCode` or missing `failureMode` is recorded now (`missing_evidence`, `missing_failure_mode`) and enforced by the Stage 9 gates; low-confidence candidates are recorded and left for gate suppression so telemetry can attribute the loss stage precisely.
- `followUpHints` are validated for pointer-richness: a hint with an empty `question` or with no `files` and no `symbols` is dropped (`vague_hint`).
- Each surviving `followUpHint` and each `uncertainty` is emitted as a telemetry event (`event: "follow_up_hint"` / `"uncertainty"`, stage-attributed) carrying `{ packetId, question, files, symbols, reason, confidence }` in `data` (uncertainty events omit `reason`/`confidence`) — the hint-event reader contract consumed by `components/evals.md`. Hints are never promoted into new review tasks in v1: medium- and high-confidence hints are additionally collected for Stage 10's "needs human attention" report notes; low-confidence hints are telemetry-only.
- Prompt size, token usage, runtime, and `status` are recorded per worker. `PacketReviewResult` carries no tool-usage data: tool calls and files read live in the always-on `tool-calls.jsonl` `ToolCallRecord`s, and readers join them on `workerId`.

All candidates (pre-gate) are persisted to `candidate-findings.json`.

### Stage 8: System Follow-Up (Deferred)

Cross-file/system follow-up review — planner `systemFollowUpTasks`, the two-independent-mentions promotion rule, `SystemFollowUpTask` execution through system workers, and `SystemReviewResult`s — is deferred to Future Considerations (see architecture.md). Stage id 8 stays reserved so stage numbering never changes; no Stage 8 work runs in v1.

V1 behavior for the signals Stage 8 would have consumed:

- Packet `followUpHints` and `uncertainties` are still emitted, validated for pointer-richness, and recorded as the Stage 7 telemetry events above.
- Medium- and high-confidence hints surface as "needs human attention" notes in the composed report (Stage 10); low-confidence hints are telemetry-only.
- Hints never become findings and never schedule new review tasks; verification consumes packet results only.

### Stage 9: Verification Orchestration

Stage 9 is the false-positive control. Its candidate pool is every validated candidate from Stage 7 — v1 findings are always packet-produced; static signals are prompt hints only and never enter the pool as findings of their own.

Deterministic pre-verification gates, in order, each recording the candidate id and gate decision:

1. Schema validity — defensive re-check of required `CandidateFinding` fields.
2. Anchor gate — for inline-intended candidates (anchor present): re-validate the anchor against the parsed diff (side-appropriate path, changed line, matching `hunkId`). Invalid → strip the anchor, set `changedLine: false`, continue as a summary-only candidate (`gate_anchor_stripped`). Candidates without anchors are summary-only candidates and pass this gate.
3. Evidence gate — empty `evidence.changedCode` → reject (`gate_no_evidence`); no verifier call.
4. Failure-mode gate — empty `failureMode` → reject (`gate_no_failure_mode`).
5. Confidence gate — `confidence` below `review.minConfidence` (default suppresses `low`) → suppress (`gate_low_confidence`); recorded, not verified, not published. Exception: critical and high severity candidates are never gate-suppressed for low confidence — they proceed to LLM verification, which is the right place to resolve uncertain-but-critical claims.
6. Pre-clustering — verifier scheduling optimization only, never semantic grouping: candidates cluster when they share path, category, and anchor (same line and side), or share path, category, and enclosing symbol when both are unanchored, and additionally have equal normalized titles or equal normalized `evidence.changedCode` (lowercased, whitespace-collapsed). The representative is the highest confidence, then highest severity, then lowest id. Members get `clusterId` = representative id and `duplicateOf` = representative id; only the representative is verified. The representative's verdict applies to the cluster; member lineage is preserved for Stage 10's `mergedCandidateIds`. No ranking, cap enforcement, or wording happens here.

Verifier dispatch: one candidate per call through the worker runner (stage 9, `review.perPassTimeoutMs`, bounded by `review.concurrency` and `llm.maxConcurrentCalls`); the verifier is an independent call with fresh context, using the run's single resolved model. Verifier `ToolBudget` default: `{ maxToolCalls: 6, maxInvestigationRounds: 2, maxResultChars: 12000 }` (implementation constant). The verifier receives the candidate, its originating packet context, the relevant changed hunk(s), cited evidence, active lens criteria (False Positives and Safe Patterns projections), and the read-only tool suite — for proving, narrowing, or rejecting the specific claim only; it must not search for new issues, and verifier-introduced unrelated findings are dropped in validation with telemetry.

Verdict handling (`VerificationVerdict` per candidate):

- `keep` → the candidate (or `finalFinding` when provided) enters the verified set unchanged in identity.
- `reject` → recorded with reason; excluded.
- `revise` → `finalFinding` must preserve the candidate id (contract); a `revisedAnchor` is accepted only if it validates against a changed diff line, otherwise the original validated anchor is preserved; a real-but-unanchorable issue keeps no anchor and proceeds as summary-only. Severity/confidence/wording/fix/test narrowing is accepted as submitted; lineage is preserved.
- Verdicts referencing unknown candidate ids are discarded with telemetry.

Failure rules: authentication or provider-wide failures fail the run or mark the review incomplete (fatal per the global policy). Individual schema/parse failures get the one repair attempt; candidates still unverified are marked `verificationIncomplete: true`, suppressed from publication by default, and counted into `RunCoverageStatus.verificationIncompleteCount`. When `review.verify === false` (explicit configuration only), gates 1-6 still run, the LLM verifier is skipped, gate-surviving candidates pass through as the verified set, and the coverage summary discloses that verification was skipped.

Telemetry per candidate: pre-gate decision, verifier prompt size, tool calls, token usage, runtime, verdict, revision details, rejection reason, incomplete reason. `verification.json` persists one record per candidate: gate-rejected/suppressed candidates record `{ candidateId, gate: "suppressed", gateReason }`, and verified candidates record `{ candidateId, gate: "passed", verdict: VerificationVerdict }` (revised findings carry `verdict.finalFinding`). Pre-clustered duplicate members carry no record of their own — readers resolve them through `duplicateOf` to the representative's verdict. This is the reader contract consumed by `components/evals.md`. Stage 9 does not decide the final review shape.

### Run Coverage Aggregation

`aggregateRunCoverage` runs after Stage 9 and owns the run-level truth (not only `ReviewPlan.partialReview`):

- `totalHunks`: all parsed hunks across all changed files, including filtered files.
- `skippedHunks`: hunks of Stage 2-filtered files plus valid planner skips.
- `reviewedHunks`: hunks belonging to packets whose `PacketReviewResult.status === "completed"`.
- `failedHunks`: hunks of packets with terminal worker failure (`review_failed`), plus hunks of packets never dispatched due to budget exhaustion (recorded `review_failed` with reason `"budget_stopped before dispatch"`).
- `coverageByLevel`: effective per-hunk coverage — the packet's coverage for packeted hunks (post-fallback, post-coalescing max), `skip` for skipped hunks.
- `degradedPlanning`: from `runPlanner` (full or per-chunk fallback).
- `budgetStopped`: from the budget ledger.
- `verificationIncompleteCount`: from Stage 9.
- `partial`: true when `reviewedHunks + skippedHunks < totalHunks`, or `failedHunks > 0`, or `budgetStopped`, or the planner declared `partialReview.isPartial`.
- `reasons`: deduplicated, ordered notes — filter summary line, malformed planner fallback notes, degraded-planning note, per-chunk failure notes, `review_failed` packet notes, budget-stop notes, verification-incomplete note, truncation notes, degraded packet notes (missing base content). Deterministic default coverage is tracked in per-hunk records, not disclosed as a human-facing warning.

`coverage.json` serializes this `RunCoverageStatus` plus the per-hunk ledger records.

### Stage 10: Composer

Composition is deterministic pre-grouping → one LLM call → deterministic post-processing. The model call shapes wording and semantic grouping; every selection, cap, and suppression decision is code.

Deterministic pre-grouping:

1. Compute each verified finding's fingerprint: `sha256(path + enclosingSymbolOrHunkIdentity + category + lensId)` with normalized inputs (lowercase, whitespace-collapsed); `enclosingSymbolOrHunkIdentity` is the enclosing symbol name when available, else the hunk id. Model-authored wording is excluded.
2. Group findings sharing a fingerprint; then merge groups sharing path and category whose anchors fall within ±5 lines of each other (same side). Group representative: highest severity, then confidence, then earliest anchor line, then lowest id.
3. Pre-trim: above 40 verified findings, rank by severity then confidence then id and trim to 40 before the composer call; critical and high findings are never trimmed. Trimmed findings become `FinalFinding`s with `publication: "suppressed"`, template `finalBody`, and a coverage/telemetry disclosure.

Composer LLM call (one `runStructured`, the run's single resolved model, `review.perPassTimeoutMs`, no repository tools, no skill projections): input is the pre-grouped verified findings (full structured content and anchors), the plan's `diffUnderstanding` (`declaredIntent` and `inferredBehavior`), the `RunCoverageStatus` counts, and the medium/high-confidence follow-up hints collected at Stage 7 (summary framing data only — never findings). Output schema: an ordered list of composed findings, each referencing input finding ids (`mergedCandidateIds`), with `finalBody` wording, a publication recommendation, plus the review `summary` text.

Output validation and deterministic post-processing:

1. Drop composed findings whose referenced ids do not all exist in the input (`composer_invented_finding`); the composer must not invent findings.
2. Re-insert any verified finding the composer omitted, as its own group with template wording (`composer_omitted_finding`); omission is not a suppression decision the model may make.
3. Merge `mergedCandidateIds` with Stage 9 pre-cluster members (`duplicateOf` lineage) so `FinalFinding.mergedCandidateIds` is complete; preserve lineage to packets, lenses, and evidence via `producedBy`.
4. Re-validate anchors. Inline publication requires a valid changed-line anchor; otherwise the finding is `summary-only`. When merged findings offer multiple valid anchors, prefer the representative's (clearest changed-line anchor by the pre-grouping representative rule).
5. Apply thresholds: severity below `review.minSeverity` (when set) → `suppressed`; confidence below `review.minConfidence` → `suppressed`; confidence below `review.minInlineConfidence` → `summary-only`.
6. Rank: a deterministic total order over severity, confidence, evidence strength, and actionability — the exact measures and tiebreakers are an implementation detail within that contract. The composer's ordering is advisory input; this deterministic rank is final.
7. Enforce caps: at most `review.softCommentCap` inline findings — beyond the cap, medium/low-severity findings move to `summary-only`; verified critical and high findings are never displaced or hidden by the cap. At most `review.maxFindings` total reported findings — beyond it, lowest-ranked non-critical/high findings become `suppressed` with disclosure. Neither cap ever suppresses verified critical/high findings.
8. Needs-human-attention notes: deterministically assemble every medium/high-confidence follow-up hint into `ReviewResult.needsHumanAttention` (`{ question, files, symbols, reason, confidence }` records), deduplicated by trimmed question. Renderers consume the field for the report's "needs human attention" section, and in posting mode `postingPlan.reviewBody` embeds the notes as well. The composer's summary wording may reference them, but the notes are code-assembled — they never become findings and are never silently dropped from the report. (Existing-PR-thread overlap recording is deferred to Future Considerations — see architecture.md.)
9. Compute `fingerprint` on each `FinalFinding` (the Stage 11 duplicate-avoidance identity) and assemble `ReviewResult`: `summary` (composer wording, or template on fallback), `coverage` (the aggregated `RunCoverageStatus`, including partial disclosure), `findings` (publication `inline` only — suppressed findings never appear in `ReviewResult`; they are recorded solely in `final-findings.json` and `final-selection.json`), `summaryOnlyFindings`, `needsHumanAttention` (the step 8 notes), `noFindings` when nothing is publishable, and `postingPlan` only when `--post-github-comments` was passed (`inline` entries for `publication: "inline"` findings with validated anchors; `reviewBody` containing the summary, counts, summary-only findings, needs-human-attention notes, and partial-coverage disclosure). Posting itself is Stage 11 (`components/repository_and_github.md`).

Composer terminal failure (after one repair retry, non-auth): deterministic fallback composition — fingerprint-level grouping only (steps 1-2 without semantic merging), template wording per finding (title, failure mode, evidence, why it matters, suggested fix/test), ranking, caps, and needs-human-attention notes per steps 4-8, and a coverage `reasons` disclosure note that semantic composition was skipped. The fallback never loses verified findings.

`final-selection.json` records one decision record per verified finding — `{ findingId, decision: "published" | "merged" | "suppressed", reason, mergedIntoFingerprint? }`, where `merged` names the absorbing final finding's fingerprint and `reason` is a stable selection-reason string (`report-cap`, `soft-comment-cap`, `severity-threshold`, `confidence-threshold`, `composer-pre-trim`, ...) — plus the run-level selection trace (group memberships, cap displacements, trim decisions). The per-finding records are the reader contract consumed by `components/evals.md`. `final-findings.json` records the resulting `FinalFinding`s, including `publication: "suppressed"` entries.

### Failure And Budget Semantics

The budget ledger tracks, per run: elapsed wall-clock time against `review.timeoutMs`, total tokens against `review.maxTotalTokens`, and model-call count against `review.maxModelCalls`. There is no cost budget in v1 (cost-based run budgets are deferred — see architecture.md Future Considerations); cost is observability only, disclosed through `cost-profile.json`. The LLM runner reports usage per call; the ledger is updated synchronously after every call.

Reservation: at run start the ledger reserves approximately 15% of the configured token budget (when set) and a runtime tail of `max(60s, 10% of review.timeoutMs)` for stages 9-10, so completed review work is never lost to exhaustion. Stages 1-7 draw from the remainder; stages 9-10 may draw from both the remainder and the reserve.

Checkpoints: `budget.checkpoint(stage)` is evaluated before every new model call and every worker dispatch. It returns exhausted when any unreserved dimension is depleted for stages 1-7, or any total dimension is depleted for stages 9-10. Checkpoints never cancel in-flight work.

Exhaustion ladder, in order:

1. Stop scheduling new packet reviews; in-flight packet workers run to completion; undispatched packets' hunks are marked `review_failed` with a budget reason.
2. Verify already-produced candidates using the reserved slice; if the reserve also depletes, remaining candidates are marked `verificationIncomplete` and suppressed.
3. Always run composition (the composer call uses the reserve; on depletion the deterministic fallback composition runs) and emit the partial-review disclosure. `budgetStopped: true`.

Hard kill: at 2x `review.timeoutMs` the run aborts fatally (`timeout`): the root `AbortController` cancels all in-flight work, and codeninja attempts to write telemetry artifacts before exiting nonzero.

Per-stage terminal policies, budget interplay, and the recoverable/fatal split are as defined in the Error Conditions Summary table; `budget_exhausted` is the recoverable signal driving this ladder and never escapes the pipeline. Provider rate limiting (429/transient 5xx, 3 retries with exponential backoff) is implemented in the LLM runner; retries count against this ledger.

## Dependencies

This component depends on:

- `components/repository_and_github.md`: `resolveReviewInput`, `parseDiff` (`UnifiedDiff`, hunk ids, changed-line maps), Stage 3 classification (`FileFacts` with detector provenance), and diff-anchor validation primitives used by the Stage 7/9/10 anchor checks. Stage 11 posting consumes this component's `ReviewResult.postingPlan`.
- `components/context_and_tools.md`: `buildRepositoryIndex` (`RepositoryIndex` with `HunkSymbolFacts`, static signals, `RepositoryTools`), the tools-host seams `buildPacketContext` (packet context plus the likely-tests list for `relevantTests`) and `bindPackets` (called between Stage 6 and Stage 7), and base/head source reads for deletion packets. Path containment is enforced in that layer.
- `components/skills_llm_telemetry.md`: lens registry and skill projections, prompt building (including `renderDossier` — used by dossier compaction for size estimation — and untrusted-content fencing), `LlmRunner.runStructured` (submit-tool schemas, schema repair, provider retries, the agent loop, abort/timeout, cache), and the telemetry recorder/logger that persist every artifact named here.
- `src/config/`: validated `CodeninjaConfig` (depth, lens set, caps, budgets, concurrency, and the single run-wide `llm.*` settings).
- Libraries: `p-limit` (worker concurrency), Node `crypto` (sha256 ids/fingerprints), `AbortController` (cancellation).

Depends on this component:

- `src/cli/review-command.ts`: invokes `runReview`, maps `CodeninjaError` to exit codes, triggers rendering/posting.
- Output renderers (`src/output/*`): consume `ReviewResult` for Markdown/JSON/stdout.
- `components/evals.md`: invokes `runReview` with the `overrides` seam (explicit repo root and run-artifact directory) and re-scores this component's persisted artifacts (`final-findings.json` and `candidate-findings.json`) against expectations without re-running any stage; stage-level replay (candidate-recall, merge-only) is deferred to Future Considerations — see architecture.md. Loss attribution consumes the `verification.json`, `final-selection.json`, and follow-up-hint event reader contracts stated above.

## Test Plan

All tests use Vitest with a fake `LlmRunner` returning deterministic structured outputs, fake `RepositoryTools`, and fixture diffs/facts; no network or provider calls. Worker and budget tests use fake timers.

Orchestration:

- `runReview_stage_order_and_artifacts`: a small two-file fixture runs end to end; asserts stage telemetry events appear in pipeline order, Stage 9 starts only after all Stage 7 workers settle, and `planner-dossier.json`, `review-plan.json`, `packets/*.json`, `candidate-findings.json`, `verification.json`, `coverage.json`, `final-selection.json`, `final-findings.json` are all written.
- `runReview_zero_work_empty_diff`: empty diff short-circuits before Stage 3 with zero LLM calls, a "nothing to review" `ReviewResult` (`noFindings: true`, `partial: false`), telemetry written, exit-equivalent success.
- `runReview_zero_work_all_filtered`: every changed file filtered at Stage 2; same short-circuit, and the report includes the filter summary with per-file reasons.
- `runReview_fatal_auth_failure_flushes_telemetry`: provider-wide auth failure at Stage 7 fails the run with `llm_call_failed` and still writes telemetry artifacts.

Stage 2 filtering:

- `filter_skips_each_detector_fact`: one file each for binary, lockfile, generated, vendored, config-skip (`processingMode: "skip"`), and mode-only; each yields a skip decision carrying detector provenance, and skipped hunks get `status: "skipped"` coverage records.
- `filter_keeps_deleted_source_skips_deleted_lockfile`: a deleted `.go` file is kept; a deleted `pnpm-lock.yaml` is skipped; deletion status alone never causes a skip.
- `filter_decisions_complete_and_ordered`: exactly one decision per changed file, kept files preserve diff order, decisions land in the dossier filter summary.

Planner dossier and planning:

- `dossier_full_fidelity_small_pr`: under budget, `compaction.level === "full"`, per-hunk entries carry symbol facts, top-5 capped static signals, and 400-char excerpts; byte-identical JSON across two builds.
- `dossier_untrusted_truncation`: oversized PR body and commit bodies truncate to their caps.
- `dossier_policy_files_risk_signal`: a diff touching `codeninja.toml` and `.codeninja/skills/x.md` populates `policyFilesChanged` even when those files are filtered.
- `dossier_compaction_ordered_reductions`: an oversized dossier drops excerpts first, then trims signals, then collapses files by ascending priority into rollups whose `hunkIds` remain complete; every reduction appears in `compaction.omitted`.
- `planner_chunking_deterministic_merge`: a dossier exceeding the budget after compaction chunks by package root; per-chunk plans concatenate mechanically (coverage concat, dedup of lists, chunk-1 `declaredIntent`); identical chunking across reruns.
- `planner_chunk_partial_failure`: one chunk fails terminally; only its hunks get default-plan coverage; `degradedPlanning: true` with the chunk root named in reasons.
- `planner_validation_rules`: unknown-hunk decisions dropped; empty-reason skip treated as missing; unknown lenses dropped and empty lens sets flagged — each with its telemetry code.
- `planner_terminal_failure_default_plan`: planner fails after repair; default plan covers every reviewable hunk at `normal` with core + language lenses; `degradedPlanning: true`; later stages run.

Packet builder:

- `packets_default_one_per_hunk`: distant unrelated hunks in one file produce one `hunk` packet each with absolute line numbers and changed-line arrays matching the diff.
- `packets_coalesce_same_symbol`: two hunks inside one function coalesce into `coalesced-hunks`; coverage is the member max; lenses are the bounded union.
- `packets_coalesce_nearby_gap`: hunks 20 lines apart coalesce; 40 lines apart do not (`nearbyGapLines = 30`).
- `packets_file_diff_when_all_hunks_group`: a small file whose grouped hunks include every hunk yields kind `file-diff`.
- `packets_whole_file_small_added`: a small added file yields a `whole-file` packet with full content in context; an added file over `maxContextChars` does not.
- `packets_whole_file_mode_downgrade`: configured `whole-file` with oversized content downgrades to `file-diff` with the reason recorded; oversized patch falls through to per-hunk.
- `packets_split_oversized_group`: a coalesced packet exceeding `maxPatchChars` splits back to per-hunk packets deterministically.
- `packets_truncate_oversized_hunk`: a single 20k-char hunk yields one packet with a changed-line-centered window, `truncated: true` and the correct `omittedLineCount` on the `PacketHunk`, omission markers in `contentWithLineNumbers`, complete `changedNewLineNumbers`, a truncation coverage note, and no synthesized hunk ids.
- `packets_deleted_file_old_side`: a deleted file yields a packet with `isDeletedContent: true`, old-side line numbers, base-revision context, and `degraded` set when base content is unavailable.
- `packets_planner_fallbacks`: a hunk without coverage and a hunk with invalid skip both produce `normal` packets with recorded fallback reasons; a valid skip produces a coverage record and no packet.
- `packets_id_stability`: identical diff input across two runs produces identical packet ids; changing the kind or hunk set changes the id.

Worker runner and lens execution:

- `workers_respect_concurrency_and_priority`: with `review.concurrency = 2` and mixed priorities, at most two tasks run concurrently and dispatch follows priority then coverage then stable order.
- `workers_isolated_context`: two packet workers' prompts share no conversation state; each result carries its own `workerId`/`packetId`.
- `workers_stage7_single_retry`: a transient packet failure re-dispatches once; a second failure yields `status: "failed"` and `review_failed` coverage records for all packet hunks.
- `workers_timeout_and_cancellation`: a worker exceeding `perPassTimeoutMs` is aborted and handled as terminal; the 2x hard kill cancels in-flight workers and still writes telemetry.
- `workers_budget_checkpoint_stops_dispatch`: model-call budget exhausts mid-queue; remaining tasks settle `not_dispatched`; their hunks are `review_failed` with the budget reason.
- `lens_one_composite_call_per_packet`: a packet with three lenses produces exactly one model call whose prompt contains all three projections.
- `lens_coverage_profiles`: light/normal/deep packets receive the table's tool budgets, scaled by run depth.
- `lens_out_of_hunk_anchor_stripped`: a candidate anchored to an unchanged line loses its anchor, becomes summary-only with `changedLine: false`, and records `out_of_hunk_anchor`.
- `lens_candidate_ids_and_producer`: candidate ids follow `"<packet8>-f<seq>"`; `producedBy` is stamped deterministically with stage 7, the packet id, the packet's primary (first) lens, that lens's skill ids, and the worker id; the model output contains no lens claim to honor.
- `lens_vague_hints_dropped`: a hint without files and symbols is dropped; a pointer-rich hint survives.

Follow-up hints (Stage 8 deferred):

- `hints_medium_high_surface_as_report_notes`: medium- and high-confidence packet hints land as deduplicated `ReviewResult.needsHumanAttention` entries (question, files, symbols, reason, confidence), which renderers surface in the composed report and `postingPlan.reviewBody` embeds; low-confidence hints are telemetry-only; no hint becomes a finding or schedules a review task, and no Stage 8 telemetry events are emitted.
- `hint_events_recorded_for_evals`: every surviving hint and uncertainty emits its Stage 7 telemetry event carrying packet id, question, files, symbols, and confidence.

Stage 9:

- `verify_gates_order_and_reasons`: candidates missing evidence or failure mode are gate-rejected without verifier calls; a low-confidence medium-severity candidate is suppressed while a low-confidence critical-severity candidate proceeds to verification; an invalid anchor is stripped to summary-only rather than rejected.
- `verify_precluster_representative_only`: three near-identical candidates produce one verifier call; members carry `clusterId`/`duplicateOf`; the verdict applies to the cluster and lineage survives to Stage 10.
- `verify_verdict_handling`: keep/reject/revise are applied; a revised finding preserves the candidate id; a `revisedAnchor` on an unchanged line is discarded in favor of the original anchor.
- `verify_repair_then_incomplete`: a schema-invalid verdict gets one repair; persistent failure marks `verificationIncomplete`, suppresses the candidate, and increments the coverage count.
- `verify_disabled_by_config`: with `review.verify = false`, gates still run, no verifier calls occur, gate-survivors pass through, and the coverage summary discloses skipped verification.

Stage 10:

- `compose_pregroup_fingerprint_and_proximity`: same-fingerprint findings group; same path/category findings within ±5 lines merge groups; the representative anchor is chosen by the documented rule.
- `compose_pretrim_over_40`: 45 verified findings trim to 40 by rank; critical/high are never trimmed; trimmed findings appear as suppressed finals with disclosure.
- `compose_invented_and_omitted_findings`: a composed finding referencing unknown ids is dropped; a verified finding the composer omitted is re-inserted with template wording.
- `compose_caps_protect_critical_high`: 10 inline-eligible findings with `softCommentCap = 7` move the lowest-ranked medium findings to summary-only while all critical/high stay inline; `maxFindings` suppresses only non-critical/high overflow.
- `compose_terminal_failure_fallback`: composer fails after repair; fallback emits template-worded, fingerprint-grouped, severity-ranked findings plus the needs-human-attention notes, with the semantic-composition-skipped disclosure, and loses nothing.
- `compose_posting_plan_pr_mode`: `--pr --post-github-comments` mode yields `postingPlan` with inline anchors only for `publication: "inline"` findings and a review body containing counts and partial disclosure.

Budget and coverage:

- `budget_reservation_math`: with `maxTotalTokens = 100000`, stages 1-7 exhaust at 85000 while stages 9-10 may spend the reserve; the runtime tail is `max(60s, 10% of timeoutMs)`.
- `budget_ladder_order`: exhaustion during Stage 7 stops new packet dispatch, verifies existing candidates from the reserve, and still composes; `budgetStopped: true` with reasons.
- `budget_each_dimension_triggers`: time, token, and model-call budgets each independently trigger the ladder at their checkpoint.
- `coverage_aggregation_matrix`: fixtures combining filtered files, planner skips, completed packets, failed packets, undispatched packets, degraded planning, and incomplete verification produce the expected `RunCoverageStatus` counts, `coverageByLevel`, `partial` flag, and reasons; `coverage.json` includes every hunk exactly once.
- `coverage_partial_definition`: degraded planning alone does not set `partial`; any failed hunk, budget stop, unreviewed hunk, or planner partial flag does.
