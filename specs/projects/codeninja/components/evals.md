---
status: complete
---

# Component: Evals

## Purpose And Scope

The evals component implements `codeninja eval`: repeatable, end-to-end quality testing of the review pipeline against real repositories, fixture repositories, and previously captured run artifacts. It loads YAML eval cases, executes each case through the normal review engine (or re-scores captured artifacts), scores the results against the case's expectations with deterministic matching, attributes every missed expectation to the pipeline stage that lost it, writes incrementing run directories under the eval suite, and diffs each run against the previous run of the same case.

This component owns:

- The `codeninja eval` command surface: `--eval-dir`, `--cache` / `--no-cache`, and `--from-artifacts`.
- Eval suite discovery, `EvalCase` YAML loading, and case validation, including the full matching semantics for `EvalFindingExpectation` (the type is defined in `architecture.md`; this doc elaborates its behavior and must not reshape it).
- Per-case execution: repo resolution for external and fixture repositories, per-case review-setting overlays on top of config, cache toggling per run, and telemetry wiring into the eval run directory.
- Incrementing `logs/<n>` run directories and their layout, including `info.json`, `out.log`, `codeninja-review.out.md`, the embedded `telemetry/` artifact set (the engine's full standard run directory, including `debug/` when debug traces are enabled), and comparison artifacts.
- Scoring: the expectation-matching algorithm (field rules, glob and line-range-overlap and severity-ordering and regex semantics, deterministic assignment when findings and expectations match many-to-many, and `should_not_find` violations).
- Stage-loss attribution: labeling each missed expectation with one of the four coarse loss labels — `missed-before-candidate-generation`, `lost-at-verification` (pre-gate or verifier), `lost-at-composition` (deduped, merged, or capped), or `partial-match` — by walking `candidate-findings.json`, `verification.json`, `final-selection.json`, and `final-findings.json`, with follow-up-hint presence recorded as supporting detail on the label.
- Artifact replay for `--from-artifacts` and artifact-backed cases: re-scoring saved final findings and candidate findings against (possibly edited) expectations; no stages re-run, no repository required.
- Budget expectations: cost, runtime, model-call, prompt-size, tool-call, finding-count, and duplicate-group checks against run telemetry.
- Compare-to-previous regression diffing between runs of the same case.

Explicitly not this component's responsibility:

- The review engine itself. Evals invoke the engine defined in `components/review_pipeline.md`; they never fork or reimplement any review stage.
- Model-call cache internals (keying, storage, eviction). Evals only toggle and direct the cache per run; the cache is owned by `components/skills_llm_telemetry.md`.
- Git, GitHub, and repository-tool mechanics; evals consume them through the engine (`components/repository_and_github.md`, `components/context_and_tools.md`).
- GitHub posting. Eval runs must never post; the case schema offers no posting surface and the engine is always invoked without a posting plan.
- LLM-judged scoring. V1 scoring is deterministic field matching only, per `architecture.md`. Semantic or LLM-assisted matching is deferred.
- Fixture materialization tooling (cloning bundles, unpacking archives). V1 requires fixture paths to already be git worktrees; how they got there (CI clone, setup script) is outside codeninja.
- Stage-level replay (candidate-recall, merge-only), verifier/merge expectations (`VerifierExpectation`, `MergeExpectation`), and the fine-grained loss-label taxonomy — all deferred to Future Considerations (see architecture.md).

## Public Interface

### CLI Surface

```bash
codeninja eval --eval-dir /path/to/evals
codeninja eval --eval-dir /path/to/evals --cache
codeninja eval --eval-dir /path/to/evals --no-cache
codeninja eval --from-artifacts /path/to/eval/logs/42
```

Flag rules:

- `--eval-dir <path>` selects an eval suite directory. When omitted, `config.eval.defaultEvalDir` is used; if that is also unset, the command fails with `invalid_args`.
- `--from-artifacts <path>` replays a single previously captured eval run directory (`<suite>/logs/<n>`). `--eval-dir` and `--from-artifacts` are mutually exclusive; passing both is `invalid_args`.
- `--cache` / `--no-cache` force the model-call cache on or off for every case in the invocation, overriding per-case `EvalCase.review.cache` and `config.cache.enabled`. Passing both is `invalid_args`.

Exit codes (the functional spec's exit-code section covers `codeninja review`; eval semantics are defined here):

- `0`: every case ran and every expectation passed.
- `1`: at least one case failed an expectation, recorded a `should_not_find` violation, failed a budget check, or errored during execution; scoring output was still produced for the cases that ran.
- `2`: the command itself could not run (invalid arguments, unresolvable eval dir, case validation failure before any case executed, config errors).

### Module Interfaces

The component lives in `src/evals/` per the architecture project layout (`eval-command.ts`, `eval-runner.ts`, `eval-scoring.ts`, `eval-artifacts.ts`, `eval-compare.ts`).

```ts
// eval-command.ts — commander wiring and top-level orchestration.
type EvalCommandOptions = {
  evalDir?: string
  fromArtifacts?: string
  // Tri-state: true (--cache), false (--no-cache), undefined (defer to case/config).
  cache?: boolean
}

// Returns the process exit code (0 | 1 | 2). Throws CodeninjaError only for
// pre-run fatal conditions (invalid_args, config_error); per-case operational
// failures are captured as case results with status "error".
export async function runEvalCommand(
  options: EvalCommandOptions,
  config: CodeninjaConfig
): Promise<number>
```

```ts
// eval-runner.ts — suite loading and case execution.
type EvalSuite = {
  dir: string
  cases: Array<{ file: string; evalCase: EvalCase; caseHash: string }>
}

// Discovers and validates every case file. Throws CodeninjaError("config_error")
// carrying ALL validation errors across all files (fail fast before any run).
export async function loadEvalSuite(evalDir: string): Promise<EvalSuite>

type EvalRunOptions = {
  cacheOverride?: boolean // from --cache/--no-cache
  config: CodeninjaConfig
}

// Executes one case (live review or artifact replay per the case), scores it,
// writes the run directory, and produces comparison artifacts. Operational
// failures (missing repo, unresolvable refs, missing artifacts) are caught and
// returned as status "error"; they do not abort the suite.
export async function runEvalCase(
  suite: EvalSuite,
  entry: EvalSuite["cases"][number],
  options: EvalRunOptions
): Promise<EvalCaseResult>

// Implements --from-artifacts: loads info.json from sourceRunDir, re-reads the
// case YAML when still present (falling back to the embedded snapshot),
// allocates the next run number in the same logs directory, re-scores.
// Errors: invalid_args when sourceRunDir is missing or lacks info.json;
// config_error when the re-read case fails validation.
export async function replayFromArtifacts(
  sourceRunDir: string,
  options: EvalRunOptions
): Promise<EvalCaseResult>
```

```ts
// eval-scoring.ts — pure, deterministic; reads artifacts only, never the repo.
export function scoreEvalRun(
  evalCase: EvalCase,
  artifacts: EvalArtifacts,
  mode: "live" | "replay"
): EvalScore

// Single field matcher used for satisfaction AND mismatch diagnostics.
export function matchExpectation(
  expectation: EvalFindingExpectation,
  finding: CandidateFinding | FinalFinding
): EvalMatchOutcome

// Deterministic maximum bipartite matching between expectations and findings.
export function assignExpectations(
  expectations: EvalFindingExpectation[],
  findings: Array<CandidateFinding | FinalFinding>
): EvalAssignment

// Walks artifacts to label one unsatisfied expectation. Pure.
export function attributeLoss(
  expectation: EvalFindingExpectation,
  artifacts: EvalArtifacts
): EvalLossDetail
```

```ts
// eval-artifacts.ts — run directory management and artifact loading.

// Allocates the next numeric run dir under logsDir with mkdir-based atomic
// claiming (retry on EEXIST). Numbers are unpadded, ordered numerically.
export async function allocateRunDir(
  logsDir: string
): Promise<{ runNumber: number; dir: string }>

// Loads the telemetry artifact set into a typed in-memory view. Missing
// optional artifacts yield empty/undefined sections; missing required artifacts
// (final-findings.json, candidate-findings.json) throw invalid_args naming the
// missing file.
export async function loadEvalArtifacts(telemetryDir: string): Promise<EvalArtifacts>

// Highest-numbered run < before in logsDir whose info.json caseName matches.
export async function findPreviousRun(
  logsDir: string,
  caseName: string,
  before: number
): Promise<{ runNumber: number; dir: string } | undefined>

export async function writeEvalRunInfo(dir: string, info: EvalRunInfo): Promise<void>
```

```ts
// eval-compare.ts — regression diffing. Pure given two loaded runs.
export function compareToPrevious(
  current: { info: EvalRunInfo; finalFindings: FinalFinding[] },
  previous: { info: EvalRunInfo; finalFindings: FinalFinding[] }
): EvalCompareReport
```

### Types Owned By This Component

`EvalCase` and `EvalFindingExpectation` are defined in `architecture.md` and are referenced by name throughout this doc — they are not redefined here. (`VerifierExpectation` and `MergeExpectation` are deferred to Future Considerations — see architecture.md.) The types below are new, owned by this component, and follow the `Eval*` prefix convention.

```ts
// The four coarse v1 loss labels from the parent specs. The fine-grained
// taxonomy is deferred to Future Considerations — see architecture.md.
type EvalLossLabel =
  | "missed-before-candidate-generation"
  | "lost-at-verification"            // pre-gate or verifier
  | "lost-at-composition"             // deduped, merged, or capped
  | "partial-match"                   // right file, wrong root cause

type EvalExpectationList =
  | "should_find"
  | "should_find_candidate"
  | "should_not_find"

type EvalMatchOutcome = {
  matched: boolean
  fields: Array<{
    field: "path" | "lineRange" | "category" | "severityAtLeast" | "titlePattern" | "failureModePattern"
    present: boolean
    matched: boolean
    expected?: string
    actual?: string
  }>
}

type EvalAssignment = {
  // Pairs chosen by maximum bipartite matching; deterministic given input order.
  pairs: Array<{ expectationId: string; findingId: string }>
  unmatchedExpectationIds: string[]
  unmatchedFindingIds: string[]
}

type EvalLossDetail = {
  label: EvalLossLabel
  subReason?: string
  // Every matching or near-matching instance found while walking artifacts,
  // ordered by outcome rank (most-progressed first).
  nearestInstances: Array<{
    findingId?: string
    artifact: "final-findings" | "final-selection" | "verification" | "candidate-findings" | "events"
    outcome: string // e.g. "publication=suppressed reason=report-cap", "verdict=reject", "pre-gate=low_confidence"
    fieldMismatches?: EvalMatchOutcome["fields"]
  }>
  // Follow-up-hint presence is supporting detail on the label, never a label
  // of its own: hints from events.jsonl matching the expectation under the
  // reduced hint matching rules, with their confidence.
  matchingHints?: Array<{
    packetId?: string
    question: string
    files: string[]
    symbols: string[]
    confidence: "high" | "medium" | "low"
  }>
  // Enrichment for missed-before-candidate-generation, when artifacts allow.
  coveringPacketIds?: string[]
  coveringPacketLenses?: string[]
  plannerCoverage?: string
}

type EvalExpectationResult = {
  expectationId: string
  list: EvalExpectationList
  status: "pass" | "fail" | "skipped"
  skipReason?: string
  // True when the inputs this expectation was checked against were replayed
  // from saved artifacts rather than produced by stages run in this eval run.
  fromReplayedArtifacts?: boolean
  matched: Array<{ findingId: string; artifact: "final-findings" | "candidate-findings" }>
  loss?: EvalLossDetail
  note?: string
}

type EvalViolation = {
  expectationId: string // should_not_find id
  findingId: string
  publication: "inline" | "summary-only"
}

type EvalBudgetResult = {
  check:
    | "minFindings" | "maxFindings" | "maxDuplicateGroups" | "maxCostUSD"
    | "maxElapsedSeconds" | "maxModelCalls" | "maxToolCalls" | "maxPromptCharsByStage"
  stage?: ReviewStage // for maxPromptCharsByStage entries
  status: "pass" | "fail" | "skipped"
  skipReason?: string // e.g. "stage not executed in artifact replay"
  limit: number
  actual?: number
}

type EvalRunMetrics = {
  reportedFindings: number // publication inline + summary-only
  inlineFindings: number
  summaryOnlyFindings: number
  suppressedFindings: number
  candidateFindings: number
  duplicateGroups: number // final findings with >= 2 merged candidates
  costUSD?: number
  elapsedSeconds?: number
  modelCalls?: number
  verificationCalls?: number
  toolCalls?: number
  maxPromptCharsByStage?: Partial<Record<ReviewStage, number>>
  cacheHits?: number
  cacheMisses?: number
  stageLossCounts: Record<EvalLossLabel, number>
}

type EvalScore = {
  status: "pass" | "fail" | "error"
  expectationResults: EvalExpectationResult[]
  budgetResults: EvalBudgetResult[]
  violations: EvalViolation[]
  // Informational, never failing: candidates or suppressed finals that matched
  // a should_not_find expectation but were correctly kept out of the report.
  nearViolations: Array<{ expectationId: string; findingId: string; artifact: string }>
  metrics: EvalRunMetrics
  error?: { code: CodeninjaErrorCode; message: string }
}

type EvalRunInfo = {
  runNumber: number
  caseName: string
  caseFile?: string // suite-relative path when run from a suite
  caseHash: string // sha256 of the raw case YAML bytes
  caseSnapshot: EvalCase // embedded resolved case; makes the run dir self-contained
  // replay = artifact re-scoring; no stages re-run. Stage-level execution
  // granularity returns with stage-level replay (deferred — see architecture.md
  // Future Considerations).
  mode: "live" | "replay"
  replay?: {
    sourceArtifacts: string
    caseSource: "yaml" | "snapshot"
  }
  repo?: { root: string; baseSha?: string; headSha?: string; mergeBase?: string }
  reviewRunId?: string // the engine's run id for live runs
  cache: { enabled: boolean; source: "cli" | "case" | "config"; dir?: string }
  startedAt: string
  finishedAt: string
  score: EvalScore
}

type EvalCaseResult = {
  caseName: string
  runDir: string // every case run persists its run directory
  status: "pass" | "fail" | "error"
  info: EvalRunInfo
}

type EvalCompareReport = {
  caseName: string
  currentRun: number
  previousRun: number
  caseHashChanged: boolean
  statusChange?: { from: EvalScore["status"]; to: EvalScore["status"] }
  regressions: Array<{ expectationId: string; lossLabel?: EvalLossLabel }> // pass -> fail
  fixes: Array<{ expectationId: string }> // fail -> pass
  lossLabelChanges: Array<{ expectationId: string; from: EvalLossLabel; to: EvalLossLabel }>
  newViolations: EvalViolation[]
  resolvedViolations: EvalViolation[]
  budgetChanges: Array<{ check: string; from: "pass" | "fail" | "skipped"; to: "pass" | "fail" | "skipped" }>
  // Final findings keyed by FinalFinding.fingerprint (stable across runs).
  findingDiff: {
    added: Array<{ fingerprint: string; title: string; severity: Severity; publication: string }>
    removed: Array<{ fingerprint: string; title: string; severity: Severity; publication: string }>
    changed: Array<{ fingerprint: string; changes: Record<string, { from: string; to: string }> }>
  }
  metricDeltas: Record<string, { previous?: number; current?: number; delta?: number }>
}
```

`EvalArtifacts` is the typed in-memory view of one run's telemetry directory:

```ts
type EvalArtifacts = {
  candidates: CandidateFinding[] // candidate-findings.json
  verification: EvalVerificationRecord[] // verification.json
  finalSelection: EvalSelectionRecord[] // final-selection.json (optional; may be empty)
  finalFindings: FinalFinding[] // final-findings.json
  reviewPlan?: ReviewPlan // review-plan.json (optional enrichment)
  packets: ReviewPacket[] // packets/*.json (optional enrichment)
  hintEvents: EvalHintEvent[] // extracted from events.jsonl (optional enrichment)
  coverage?: RunCoverageStatus & { hunks?: unknown[] } // coverage.json when present
  metricsSources: {
    costProfile?: unknown // cost-profile.json
    modelCallsSummary?: unknown // model-calls-summary.json
    toolCallsSummary?: unknown // tool-calls-summary.json
    runJson?: unknown // run.json
  }
}
```

`EvalVerificationRecord`, `EvalSelectionRecord`, and `EvalHintEvent` are this component's *reader contracts* over artifacts whose writers are owned elsewhere (see Artifact Reader Contract under Internal Design). They name the minimum fields evals depends on; `components/review_pipeline.md` and `components/skills_llm_telemetry.md` own emission and may carry more.

### Error Conditions

There are no eval-specific `CodeninjaErrorCode` members; evals maps onto existing codes:

- `invalid_args`: conflicting/missing flags; `--from-artifacts` path missing or lacking `info.json`; an artifact replay missing a file its mode requires.
- `config_error`: eval case YAML parse or validation failures (cases are user-authored configuration); unresolvable `eval.defaultEvalDir`.
- `not_git_worktree` / `git_ref_missing`: a case's `repo.external`/`repo.fixture` is not a git worktree (live cases only; artifact replay needs no repository). These are per-case errors (case status `error`), not suite-fatal.
- Engine errors during a live case run surface unchanged in the case's `score.error` and `out.log`; the suite continues with the next case.

## Internal Design

### Execution Overview

```text
codeninja eval
  -> parse flags, load config (eval does not require cwd to be a git worktree)
  -> --from-artifacts? ── replay single run ──┐
  -> --eval-dir:                              │
       loadEvalSuite (validate ALL cases up front; abort on any error)
       for each case, in case-file name order, sequentially:   <──────────┘
         resolve logs dir, allocate logs/<n>
         resolve execution source:
           repo case  -> resolve repo root + ReviewInput; overlay review settings;
                         invoke review engine in-process with telemetry routed
                         into logs/<n>/telemetry/
           artifacts case -> load source artifacts; re-score (no stages re-run)
         load artifacts from logs/<n>/telemetry/
         score (matching + attribution + budgets)  [pure, artifact-only]
         write info.json, out.log, codeninja-review.out.md, debug views
         compare-to-previous (same case name) -> compare-to-previous.{json,txt}
         print per-case summary line + failures to stdout
  -> print suite totals; exit 0/1/2
```

V1 runs cases sequentially. Sequential execution keeps run numbering, cache behavior, provider rate limits, and budget accounting easy to reason about; parallel case execution is not designed in v1. Within a case the engine parallelizes normally per its own configuration.

Scoring never reads the repository — it consumes artifacts only. Repository access happens in exactly one place: live case execution (the engine). Artifact replay requires no repository.

### Eval Suite Loading And Case Validation

Discovery: every `*.yaml` / `*.yml` file directly inside `--eval-dir` is one eval case (one case per file). Subdirectories — including `logs/`, fixtures, and any helper data — are not scanned. Cases execute in lexicographic filename order for deterministic suite runs.

Parsing: YAML is parsed and validated against a strict zod schema mirroring the `EvalCase` type from `architecture.md`. YAML keys map literally to the type's field names (snake_case lists like `should_find`, camelCase members like `severityAtLeast`, `lineRange`, `maxCostUSD`); no case conversion is applied. Unknown keys at any level are validation errors — a typo like `shoud_find` must fail loudly, never silently pass.

Validation rules (all violations are collected across all case files and reported together as one `config_error` before any case runs):

- `name` is required, non-empty, and unique across the suite. It keys previous-run lookup and `info.json`.
- Exactly one execution source must be present: `repo.external`, `repo.fixture`, or `artifacts.path`. Zero or more than one is invalid.
- `repo.external` should be an absolute path (with `~` expansion). `repo.fixture` resolves relative to the suite directory when relative. Both must be existing git worktrees at execution time; v1 does not materialize fixtures (no bundles, no archives) — a missing or non-git path is a per-case `error` at run time, not a load-time failure, so suites with some unavailable private repos still run their other cases.
- `command` is only meaningful with `repo`. At most one of `command.pr`, `command.branch`, `command.target` may be set. `command.base` requires `command.branch`. `command.target` accepts `<commit>` or `<start>..<end>` and maps to the engine's commit / commit-range mode. With no target fields, the engine's default branch-mode resolution applies inside the case repo. Per-case settings are the structured `review.*` and `command.*` fields only; there is no raw CLI-argument passthrough (an `args` key under `command` is an unknown-key validation error, like any unknown key).
- `artifacts` carries only `path` in v1 (replay-mode selection is deferred with stage-level replay — see architecture.md Future Considerations); unknown keys under `artifacts` are validation errors like everywhere else. `artifacts.path` resolves relative to the suite directory when relative.
- Every `EvalFindingExpectation` must set `id` (unique across `should_find`, `should_find_candidate`, and `should_not_find` together — one id namespace per case) plus at least one matching field. An expectation with only an `id` would match everything (or, under `should_not_find`, ban everything) and is rejected as an authoring error.
- `lineRange` must be `[a, b]` with integers `1 <= a <= b`.
- `category` must be a valid `FindingCategory`; `severityAtLeast` a valid `Severity`.
- `titlePattern` / `failureModePattern` must compile as ECMAScript regular expressions; compilation failures are load-time errors.
- `verifier` and `merge` blocks do not exist in the v1 `EvalCase`; their presence is an unknown-key validation error (verifier/merge expectations are deferred — see architecture.md Future Considerations).
- `expect.maxPromptCharsByStage` keys must parse as numeric stage ids `1`–`11` (YAML keys are strings, e.g. `"7"`); values must be positive integers. All other `expect.*` values must be positive numbers (`minFindings` may be `0`).
- `review.*` values must satisfy the same constraints the config schema applies to the corresponding `CodeninjaConfig` fields.

A complete case, illustrating literal key mapping:

```yaml
name: payments-savetx-rollback
repo:
  external: ~/dev/acme/payments-service
command:
  branch: feature/savetx
  base: main
review:
  depth: normal
  lenses: ["core/code-review", "lang/go"]
  verify: true
  cache: true
expect:
  maxModelCalls: 40
  maxCostUSD: 1.50
  maxElapsedSeconds: 600
  maxPromptCharsByStage:
    "7": 60000
should_find:
  - id: tx-rollback-leak
    path: "store/payments.go"
    lineRange: [118, 142]
    category: logic_bug
    severityAtLeast: high
    failureModePattern: "rollback|connection left open"
should_not_find:
  - id: no-style-nits
    category: maintainability
    titlePattern: "naming|formatting"
```

### Per-Case Review Settings Overlay And Repo Resolution

A live case invokes the review engine in-process — never via a forked implementation, and not as a subprocess. This requires two seams on the engine entrypoint, owned by `components/review_pipeline.md`: it must accept an explicit repository root (the eval command's cwd is the suite, not the reviewed repo) and an explicit run-artifact directory (so the engine writes its standard run directory at `logs/<n>/telemetry/` instead of `.codeninja/runs/<run-id>/`). The engine's artifact set, stage behavior, telemetry, and failure semantics are otherwise completely unchanged.

Config layering for a case run, reusing the existing precedence chain (CLI flags > environment > `codeninja.toml` > user-scoped config > defaults, with provider/model/reasoning keys trust-partitioned so repo `codeninja.toml` never supplies them):

1. Built-in defaults.
2. User-scoped config.
3. The reviewed repository's `codeninja.toml`, loaded from the case repo root with normal trust partitioning (safe keys only).
4. The eval case's `review.*` fields, applied at CLI-flag strength — the case file is user-authored and user-invoked, which satisfies the user-level opt-in rule for out-of-repo `cacheDir`, run-dir placement, and provider/model/reasoning overrides.

`EvalCase.review` field mapping:

| Case field | Engine setting | Notes |
| --- | --- | --- |
| `depth` | `review.depth` | |
| `lenses` | run lens set | Same semantics as repeated `--lens`: restricts the run to the named lenses and may enable default-disabled lenses; the planner still routes lenses per hunk. |
| `maxFindings` | `review.maxFindings` | Engine report cap, distinct from the `expect.maxFindings` assertion. |
| `concurrency` | `review.concurrency` | |
| `verify` | `review.verify` | |
| `cache` | `cache.enabled` | Overridden by the eval CLI flag; see Cache Wiring. |
| `cacheDir` | `cache.dir` | Default: engine default (`.codeninja/cache` inside the reviewed repo). |
| `debug` | `telemetry.debugTrace` | Produces the engine's `telemetry/debug/` traces in the run dir. |
| `provider` | `llm.provider` | Applied at CLI-flag strength (user-authored case file satisfies the trust partition). |
| `model` | `llm.model` | Same. |
| `reasoning` | `llm.reasoning` | Same; values are `low\|medium\|high\|xhigh` (unset falls back to the built-in `high`). |

Repo resolution: the runner resolves the case repo root (`repo.external` expanded, or `repo.fixture` against the suite dir), verifies it is a git worktree, builds the `ReviewInput` from `command` (`pr` → `github_pr`, `branch`/`base` → `branch`, `target` → `commit_range`, none → branch-mode default), and passes both to the engine. Base-branch resolution, merge-base semantics, PR fetching, and all other input-resolution behavior are the engine's, untouched.

Every case run persists its run directory — there is no in-memory-only scoring path. `logs.dir` overrides the logs directory for the case (relative paths resolve against the suite directory); otherwise the logs directory is `<eval-suite>/<config.eval.logsDir>` (default `logs`).

### Eval Run Directories

Run directories follow the architecture's layout exactly:

```text
<eval-suite>/logs/<n>/
  info.json                  # EvalRunInfo, including the full EvalScore
  out.log                    # eval runner's structured log for this case run
  codeninja-review.out.md    # rendered Markdown review output
  telemetry/                 # the engine's full standard run-directory artifact set
    run.json
    run.log
    telemetry.json
    events.jsonl
    planner-dossier.json
    review-plan.json
    coverage.json
    packets/<packet-id>.json
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
    debug/                   # same layout as the engine run dir, when debug traces are enabled
  compare-to-previous.txt    # only when a previous run of the same case exists
  compare-to-previous.json
```

Rules:

- Run numbers are unpadded positive integers (`logs/1`, `logs/2`, …), ordered numerically, never lexicographically. Allocation scans existing numeric children, takes `max + 1` (starting at `1`), and claims the directory with `mkdir` — on `EEXIST` (a concurrent invocation), it retries with the next number. Non-numeric children of the logs dir are ignored.
- `telemetry/` is the engine's full standard run directory written in place, per `architecture.md`'s eval layout — evals never suppresses or reshapes it. Attribution uses `coverage.json` and `review-plan.json` as enrichment when present.
- `codeninja-review.out.md` is the Markdown rendering of the final `ReviewResult`, written by the eval runner (cases carry no output-format setting). In artifact replay it is copied from the source run when present.
- `out.log` is the eval runner's own structured log (case resolution, settings overlay, stage execution, scoring summary, compare results), using the standard `Logger` with stage `0`; the engine's chronological log remains `telemetry/run.log`.
- `info.json` is the single run-info document: it embeds the resolved case snapshot, the case hash, repo identity and reviewed SHAs, the run mode (`live` / `replay`), cache resolution, timing, and the full `EvalScore`. It is written last (temp-file-then-rename) so a complete `info.json` marks a complete run.
- Debug traces live in `telemetry/debug/` with the engine run directory's own layout (`llm-calls/<call-id>.json`, `tool-calls/<tool-call-id>.json`), present when `review.debug` enables `telemetry.debugTrace`. Evals derives no separate prompt/result views; the engine's debug artifacts are consumed as-is.

### Artifact Reader Contract

Scoring and attribution read the following artifacts. The expectation-bearing four are required; the rest enrich attribution and metrics and degrade gracefully when absent (the affected attribution rungs or metrics are skipped with a note in the loss detail or budget result).

| Artifact | Evals reads | Writer (owner) |
| --- | --- | --- |
| `candidate-findings.json` | `CandidateFinding[]`: every structurally valid candidate from Stage 7, with `id`, matching fields, `producedBy`, `clusterId?`, `duplicateOf?` | `components/review_pipeline.md` |
| `verification.json` | Per candidate id: either a pre-verification-gate record `{ candidateId, gate: "suppressed", gateReason }` or `{ candidateId, gate: "passed", verdict: VerificationVerdict }`; revised findings carry `verdict.finalFinding`. Pre-clustered duplicate members carry no record of their own — the reader resolves them through the candidate's `duplicateOf` chain to the representative's record | `components/review_pipeline.md` |
| `final-selection.json` | Per verified-kept finding: `{ findingId, decision: "published" \| "merged" \| "suppressed", reason, mergedIntoFingerprint? }` — the telemetry requirement "final-selection decisions and reasons for omitted verified findings" in artifact form | `components/review_pipeline.md` |
| `final-findings.json` | `FinalFinding[]` including suppressed entries, with `publication`, `fingerprint`, `mergedCandidateIds` | `components/review_pipeline.md` |
| `review-plan.json` | `ReviewPlan` (coverage decisions per hunk, skip reasons) | `components/review_pipeline.md` |
| `packets/*.json` | `ReviewPacket[]` (paths, hunk line ranges, lenses) | `components/review_pipeline.md` |
| `coverage.json` | `RunCoverageStatus` + per-hunk records (filter/skip/review_failed status) | `components/review_pipeline.md` |
| `events.jsonl` | Hint events: one event per emitted follow-up hint and structured uncertainty (stage 7; `event: "follow_up_hint"` / `"uncertainty"`) carrying `{ packetId, question, files, symbols, reason, confidence }` in `data` (uncertainty events omit `reason`/`confidence`) | `components/skills_llm_telemetry.md` (recorder), `components/review_pipeline.md` (emission) |
| `tool-calls.jsonl`, `tool-calls-summary.json` | Per-call `ToolCallRecord`s (tool, stage, initiator, status, normalized args, join ids) and per-tool/per-stage aggregates — the source for tool-call counts and the `maxToolCalls` check | `components/skills_llm_telemetry.md` |
| `cost-profile.json`, `model-calls.jsonl`, `model-calls-summary.json`, `run.json` | Total cost; per-call stage + prompt char size; per-stage call counts; total runtime; cache hit/miss counts | `components/skills_llm_telemetry.md` |

These reader contracts are interface requirements on the writers: if a listed field is renamed or dropped, evals breaks. Component docs for the writers should treat them as consumed contracts.

### Expectation Matching Semantics

The architecture's rule is law: a finding matches an expectation when **all present fields match** — path exact-or-glob, lineRange overlap, category equality, severity at least `severityAtLeast`, regex test for patterns. No LLM judging in v1 scoring. This section pins every detail of that rule.

#### Field-Match Rules

A field that is absent from the expectation imposes no constraint. A present field must match; the conjunction of all present fields decides the outcome. `matchExpectation` evaluates every present field even after one fails, so the per-field results can power partial-match diagnostics.

- `path` — compared against the finding's `path` (side-appropriate per the architecture's path semantics: old path for deleted files, new path for renames). Both sides are normalized first: repo-root-relative, forward slashes, no leading `./`. If the expectation path contains any glob metacharacter (`*`, `?`, `[`, `]`, `{`, `}`), it is matched as a glob using the same matcher and dialect as `classification.pathRules` patterns (including `**`); otherwise it is exact, case-sensitive string equality.
- `lineRange` — `[a, b]` is inclusive on both ends. The finding's line interval is derived from its anchor: `[min(anchor.startLine ?? anchor.line, anchor.line), max(anchor.startLine ?? anchor.line, anchor.line)]`. Intervals `[a, b]` and `[c, d]` overlap iff `max(a, c) <= min(b, d)`. A finding without an anchor (summary-only candidate) fails any expectation that includes `lineRange` — if the author expects a location, the finding must be located. Line comparison is side-blind in v1: `DiffAnchor.line` is compared numerically whether the anchor side is `RIGHT` (new-file numbering) or `LEFT` (old-file numbering); `EvalFindingExpectation` has no side field, so authors disambiguate with `path`, `category`, or patterns when old/new numbering could collide.
- `category` — strict equality against the finding's `FindingCategory`.
- `severityAtLeast` — severity ordering is `critical > high > medium > low` (ranks 4 > 3 > 2 > 1). The field matches iff `rank(finding.severity) >= rank(severityAtLeast)`.
- `titlePattern` / `failureModePattern` — compiled once at case load as ECMAScript `RegExp` with the `i` flag (model wording capitalization is unstable; no other flags). Matching uses `RegExp.test` against the finding's `title` / `failureMode` structured fields — never against `finalBody` or rendered Markdown. Patterns are unanchored substring searches unless the author writes `^`/`$`.

When matching against final findings, the post-revision field values apply (a `revise` verdict's `finalFinding` replaces the original wording, and `final-findings.json` carries the revised values). When attribution matches against the verified-kept set, it uses `verdict.finalFinding ??` the original candidate.

#### Matching Targets Per Expectation List

"Reported" final findings are those with `publication` of `inline` or `summary-only`. Suppressed final findings are not reported; they exist precisely so scoring can attribute cap/threshold omissions.

| List | Matched against | Pass condition |
| --- | --- | --- |
| `should_find` | Reported final findings (`final-findings.json`) | Expectation satisfied under the assignment (below) |
| `should_find_candidate` | All candidates (`candidate-findings.json`) | Satisfied under the assignment |
| `should_not_find` | Reported final findings | No reported finding matches (universal predicate, no assignment) |

The lists are independent predicates: the same finding may satisfy a `should_find` and violate a `should_not_find` in the same run; both results are reported, neither suppresses the other. (Verifier and merge expectation lists are deferred to Future Considerations — see architecture.md.)

#### Assignment And Ambiguity Handling

Within `should_find` (and independently within `should_find_candidate`), expectations and findings can match many-to-many: one loose expectation can match several findings, and one finding can match several expectations. Greedy assignment under-counts; satisfying two distinct-bug expectations with the same single finding hides a miss. Scoring therefore computes a **maximum bipartite matching** between the list's expectations and the target finding set:

1. Build the match matrix with `matchExpectation` (expectations in YAML order, findings in artifact array order).
2. Find a maximum matching via augmenting paths (Hopcroft-Karp or simple augmenting search — sets are small). Each finding satisfies at most one expectation; each expectation is satisfied by at most one finding.
3. Expectations left unmatched are failures (for `should_find`, they proceed to stage-loss attribution). Findings left unmatched are recorded as uncovered findings in the metrics, not failures.
4. Determinism: iteration follows the fixed orders above, so equal-cardinality matchings resolve to the same pairing on every run. Only the matching's cardinality affects pass/fail; the specific pairing affects explanatory output only.

Consequence worth stating: if an author writes two expectations for two aspects of one issue and the composer legitimately merges them into one final finding, one expectation fails with loss label `lost-at-composition` (merged/deduped detail). That is the intended truthful behavior — the remedy is to write one expectation per final finding the report should carry.

#### Should Not Find Violations

Every reported final finding matching any `should_not_find` expectation produces one `EvalViolation` per (expectation, finding) pair; any violation fails the case. Additionally, candidates and suppressed final findings matching a `should_not_find` expectation are recorded as `nearViolations` — informational only (the pipeline correctly kept them out of the report), surfacing how close a banned finding came to publication.

### Verifier And Merge Expectations (Deferred)

Verifier-verdict expectations (`VerifierExpectation`, `verifier.should_decide`) and merge expectations (`MergeExpectation`, `merge.should_keep`/`should_drop`/`should_merge`/`should_not_merge`) are deferred to Future Considerations — see architecture.md. Verification and composition behavior is still observable in v1 through stage-loss attribution (below), which reads `verification.json` and `final-selection.json` to assign the coarse loss labels.

### Stage-Loss Attribution

Every unsatisfied `should_find` expectation gets one of the four coarse loss labels from the parent specs. Attribution is a deterministic walk over `candidate-findings.json`, `verification.json`, `final-selection.json`, and `final-findings.json`, enriched by `review-plan.json`, `packets/*.json`, `coverage.json`, and hint events from `events.jsonl` when present. The same `matchExpectation` predicate drives every rung. Follow-up-hint presence is recorded as supporting detail on whichever label applies (`matchingHints`), never as a label of its own; the fine-grained taxonomy is deferred (see architecture.md Future Considerations).

#### Outcome Ranking

When multiple instances of the expected issue exist with different terminal outcomes (e.g., one candidate rejected, another merged away), the expectation is attributed to the **most-progressed instance** — the latest pipeline point that still held the finding — and all other instances are listed in `nearestInstances`. Outcome ranks, most-progressed first:

```text
3 lost-at-composition    (survived verification; suppressed, merged away, or capped at Stage 10)
2 lost-at-verification   (reached Stage 9; pre-gate suppression, verifier rejection, or incomplete verification)
1 partial-match          (right file, wrong root cause — matched the path but failed other fields)
0 missed-before-candidate-generation
```

#### Attribution Walk

For a missed expectation `E`:

1. **Suppressed final?** Match `E` against final findings with `publication: "suppressed"`. On match → `lost-at-composition`. `subReason` comes from `final-selection.json` (`report-cap`, `soft-comment-cap`, `confidence-threshold`, `severity-threshold`, `composer-pre-trim`, `composer-suppressed`) or the finding's selection record; omissions caused by confidence/severity thresholds are this label (the functional spec's "lost at composition — deduped, merged, or capped" maps here). If `final-selection.json` is absent or has no record, the label still applies with `subReason: "unrecorded"` plus a warning note.
2. **Merged into a non-matching final?** Match `E` against the verified-kept set (verdicts `keep`/`revise`, post-revision values). For each match `c`, check whether any final finding covers `c` (`c.id ∈ F.mergedCandidateIds` or `c.id === F.id`). If a covering final exists but did not satisfy `E` (otherwise the expectation would have passed) → `lost-at-composition` with `subReason: "merged-deduped-away"`; the detail names the absorbing final's fingerprint, title, and which fields of `E` it fails. A verified-kept match with no covering final and no selection record is also `lost-at-composition`, `subReason: "unrecorded"`.
3. **Lost at verification?** Match `E` against the remaining candidates. A match whose resolved verification outcome (following `duplicateOf` to the cluster representative) is a verifier `reject`, a pre-verification-gate suppression, `verificationIncomplete`, or absent entirely → `lost-at-verification`. `subReason` distinguishes `verifier-rejected` (detail carries the verifier's `reason` and `falsePositiveRisk`), `low-confidence-suppressed`, `invalid-anchor`, `no-evidence`, `no-failure-mode`, `verification-incomplete`, `budget-exhausted`, and `unrecorded`.
4. **Partial match?** Match `E`'s `path` field alone (exact-or-glob) against all candidates and all final findings. If any instance is in the right file but fails other fields → `partial-match`. The detail carries the closest instances (fewest failed fields; ties by artifact order) with full per-field mismatch records — e.g. `category: expected security, actual logic_bug`, `lineRange: expected 80–90, actual 120`. An expectation without a `path` field skips this rung.
5. **Otherwise** → `missed-before-candidate-generation`.

Hint detail, applied at every rung: hint events (follow-up hints and structured uncertainties) from `events.jsonl` are searched with **diagnostic-grade reduced matching** — hints carry no severity/category/anchor, so only these fields participate: `path` matches any entry of the hint's `files` (exact-or-glob); `titlePattern`/`failureModePattern` test deterministically over the hint's text and symbols (the exact reduction is pinned by the implementation); `lineRange`, `category`, and `severityAtLeast` are ignored. Matches are recorded in `EvalLossDetail.matchingHints` with the hint's confidence — supporting detail showing a reviewer articulated the question (most useful on `missed-before-candidate-generation` losses), never a pass and never a label. An expectation whose only present fields are unmatchable against hints (e.g. category + severity only) records no hint detail. Reduced matching is acceptable here because hint detail is forensic.

#### Missed-Before-Candidate-Generation Sub-Reasons

When the walk bottoms out at rung 5, attribution sub-diagnoses why nothing was ever produced, using enrichment artifacts when present:

- `path-not-in-diff`: no packet and no coverage/filter record touches the expectation's path. Flagged prominently — the expectation itself may be wrong (stale line numbers, renamed file).
- `file-filtered`: the path appears in filter decisions (`coverage.json` / filter records) with action `skip` (generated/vendored/lock/ignored/config-skipped); the filter reason is included.
- `hunk-skipped-by-planner`: `review-plan.json` shows coverage `skip` for the hunks overlapping the expectation's `lineRange` (or any hunk of the file when no `lineRange`); the planner's reason is included.
- `packet-review-failed`: covering hunks have coverage status `review_failed`.
- `reviewed-no-candidate`: packets covering the expected path/lines were reviewed and produced no matching candidate — the true model-miss case. The detail lists `coveringPacketIds`, the lenses selected for those packets (`coveringPacketLenses`), and the planner coverage level, so a human can spot "the tests lens never ran on this hunk" without evals needing lens-to-category knowledge.
- `unknown`: enrichment artifacts unavailable; label stands without a sub-reason.

Covering packets are located deterministically: packets whose `path` matches the expectation's path predicate and, when `lineRange` is present, whose hunks' new-line or old-line ranges overlap it.

#### Attribution For Candidate Expectations

`should_find_candidate` misses can only be attributed to `missed-before-candidate-generation` (with sub-reasons) or `partial-match` — candidate-stage expectations cannot be lost in later stages by definition. The walk runs rungs 4–5 only, with rung 4 restricted to candidates; hint detail is still recorded.

#### Worked Example

```json
{
  "expectationId": "tx-rollback-leak",
  "list": "should_find",
  "status": "fail",
  "matched": [],
  "loss": {
    "label": "lost-at-verification",
    "subReason": "verifier-rejected",
    "nearestInstances": [
      {
        "findingId": "cand-7f3a",
        "artifact": "verification",
        "outcome": "verdict=reject reason=\"surrounding defer mitigates\" falsePositiveRisk=medium"
      },
      {
        "findingId": "cand-91bc",
        "artifact": "candidate-findings",
        "outcome": "pre-gate=low_confidence",
        "fieldMismatches": [
          { "field": "severityAtLeast", "present": true, "matched": false, "expected": "high", "actual": "medium" }
        ]
      }
    ]
  }
}
```

### Budget Expectations

`EvalCase.expect` checks evaluate against the run's telemetry artifacts. Each check is independent; every violation is listed and any violation fails the case.

| Check | Source | Rule |
| --- | --- | --- |
| `minFindings` / `maxFindings` | `final-findings.json` | Count of reported findings (`inline` + `summary-only`; suppressed excluded) within `[min, max]` |
| `maxDuplicateGroups` | `final-findings.json` | Count of final findings with `mergedCandidateIds.length >= 2` must be `<=` limit |
| `maxCostUSD` | `cost-profile.json` | Observed total run cost `<=` limit |
| `maxElapsedSeconds` | `run.json` / telemetry totals | Total review runtime `<=` limit |
| `maxModelCalls` | `model-calls-summary.json` (fallback: count `model-calls.jsonl` lines) | Total provider calls `<=` limit |
| `maxToolCalls` | `tool-calls.jsonl` (fallback: `tool-calls-summary.json` totals) | Total repository tool calls `<=` limit |
| `maxPromptCharsByStage` | `model-calls.jsonl` (per-call stage + prompt char size) | For every call of stage `s`, prompt chars `<=` limit for `s`; one `EvalBudgetResult` per configured stage key |

`maxCostUSD` is an observed-cost assertion read from `cost-profile.json`, not a run budget: the engine has no cost budget in v1 (unknown-cost calls are disclosed in the cost profile; cost-based run budgets are deferred — see architecture.md Future Considerations).

Replay semantics: budget checks measure what actually executed in this eval run. In artifact replay no stages execute, so every budget check except the finding-count and duplicate-group checks is `skipped` with `skipReason: "stage not executed in artifact replay"`; the finding-count and duplicate-group checks read replayed artifacts and their results are marked `fromReplayedArtifacts`. `verificationCalls` in metrics counts stage-9 entries in `model-calls.jsonl` (fallback: `verification.json` verdict count); `toolCalls` in metrics counts `tool-calls.jsonl` lines the same way, never derived events.

### Artifact Replay (Re-Scoring)

Artifact replay re-scores a previously captured run against (possibly edited) expectations: saved final findings and candidate findings are loaded and scored, and attribution walks the saved `verification.json`, `final-selection.json`, and hint events. No stages re-run, no LLM calls are made, and no repository is required. Stage-level replay modes — `candidate-recall` re-entering Stage 9 and `merge-only` re-entering Stage 10 — are deferred to Future Considerations (see architecture.md); there is no replay-mode configuration in v1.

Behavior:

- `--from-artifacts <suite>/logs/<n>` allocates the next run number **in the same logs directory**, so replay runs sit beside their source and compare-to-previous naturally diffs against it. The case definition is re-read from the recorded `caseFile` when it still exists (supporting the expectation-iteration workflow: edit YAML, re-score captured artifacts), falling back to the `info.json` embedded snapshot; `info.json.replay.caseSource` records which was used.
- An artifact-backed suite case (`artifacts.path`) re-scores the referenced run directory's `telemetry/` artifact set the same way. Both entry points are kept deliberately: suite-pinned artifact cases serve CI regression against frozen artifacts; `--from-artifacts` serves ad-hoc re-scoring.
- Consumed artifacts are copied from the source into the new run's `telemetry/` so every run directory is self-contained for scoring, future replays, and comparison; `codeninja-review.out.md` is copied when present.
- `info.json.mode` records `"replay"`; expectation results are flagged `fromReplayedArtifacts: true`.
- Required artifacts: `final-findings.json` and `candidate-findings.json` — missing either fails the case with `invalid_args` naming the file. `verification.json` and `final-selection.json` are strongly expected for attribution and degrade to `subReason: "unrecorded"` notes when absent; the enrichment artifacts degrade per the reader contract.
- The model-call cache is irrelevant to artifact replay (no model calls); cache flags affect live cases only.

### Cache Wiring

Per-run cache resolution, recorded in `info.json.cache` with its source:

```text
--cache / --no-cache (eval CLI)  >  EvalCase.review.cache  >  config.cache.enabled
```

Cache directory: `EvalCase.review.cacheDir` when set (user-level opt-in is satisfied by the eval invocation itself), else the engine default. Evals passes the resolved settings into the engine config for the case run; everything else — keying over the normalized request, storage, eviction, the guarantee that changed targets/diffs/prompts miss naturally — is cache internals owned by `components/skills_llm_telemetry.md`. Cache hit/miss counts flow back into `EvalRunMetrics` from telemetry. The intended workflows: `--no-cache` measures real model-review quality; `--cache` re-runs debug deterministic downstream behavior at near-zero cost.

### Compare-To-Previous

After scoring run `n` of a case, the runner locates the previous run: the highest-numbered run directory `< n` in the same logs directory whose `info.json.caseName` matches. When none exists, no comparison artifacts are written ("when available"). Otherwise `compare-to-previous.json` (the `EvalCompareReport`) and `compare-to-previous.txt` (its human-readable rendering) are written:

- Expectation transitions: regressions (`pass` → `fail`, with the new loss label), fixes (`fail` → `pass`), and loss-label changes for still-failing expectations (e.g. `lost-at-verification` → `lost-at-composition` — the issue moved further down the pipeline).
- Violation churn: new and resolved `should_not_find` violations; budget-check status changes.
- Finding-set diff keyed by `FinalFinding.fingerprint` (stable across runs by design — model wording is excluded from fingerprint identity): added, removed, and changed findings, where "changed" reports field-level transitions (severity, confidence, publication, anchor line, title).
- Metric deltas: every `EvalRunMetrics` numeric field as previous/current/delta.
- `caseHashChanged: true` when the case YAML content hash differs between the runs — the comparison is still produced, with a prominent header note that expectations changed between runs, so transitions are interpreted accordingly.

Comparison is informational: it never affects case pass/fail or the exit code.

### Scoring Output And Stdout

Case status: `pass` iff every expectation result is `pass` or `skipped`, there are no violations, and every budget result is `pass` or `skipped`. The suite result aggregates case statuses; stage-loss counts aggregate across cases for the suite summary.

Stdout (the eval command's report; the review Markdown lives in each run dir):

- One line per case: name, run number, status, reported/expected counts, cost, runtime, cache hits.
- For failing cases: each failed expectation with its loss label and one-line sub-reason; violations; failed budget checks with limit vs actual.
- Suite totals: cases passed/failed/errored, aggregate stage-loss counts by label, total cost and runtime.

All structured results live in each run's `info.json` (`EvalRunInfo.score`); there is no separate suite-level artifact in v1.

### Determinism Rules

- Scoring is a pure function of (case, artifacts, run mode): no LLM, no repo reads, no clock.
- All iteration orders are fixed: case files lexicographic; expectations in YAML order; findings in artifact array order; assignment via deterministic augmenting-path matching.
- Regexes compile with fixed flags (`i`); glob matching uses the single shared matcher; severity ranks and overlap arithmetic are total functions.
- Re-running artifact replay over the same artifacts with the same case YAML must produce byte-identical `score` content (modulo timestamps).

## Dependencies

This component depends on:

- `components/review_pipeline.md` — the review engine, invoked in-process and never forked. Required seams: an engine entrypoint accepting an explicit repository root and an explicit run-artifact directory; writer-side guarantees for the artifact reader contract (`candidate-findings.json`, `verification.json` gate+verdict records, `final-selection.json` decision records, `final-findings.json` including suppressed entries, follow-up-hint event emission).
- `components/skills_llm_telemetry.md` — the telemetry recorder and artifact files evals reads for metrics (`events.jsonl`, `model-calls.jsonl`, `model-calls-summary.json`, `tool-calls.jsonl`, `tool-calls-summary.json`, `cost-profile.json`, `run.json`), and the model-call cache evals toggles per run.
- `components/repository_and_github.md` / `components/context_and_tools.md` — git resolution and repository tools, consumed only through the engine; evals itself performs only worktree existence checks for live cases via `GitClient`.
- CLI/config: `commander` registration in `src/cli/main.ts`; the config loader for `eval.defaultEvalDir`, `eval.logsDir`, and the precedence chain.
- Libraries: `zod` for case validation; a YAML parser for eval case files, per `architecture.md`'s dependency choices; the shared glob matcher used by `classification.pathRules`; Node `fs` for run-dir management.

Depends on this component:

- Nothing in the review path — the dependency is strictly one-way; `codeninja review` must build and run without `src/evals/*`.
- Development and CI workflows: private real-repo regression suites, public fixture suites in CI (exit codes 0/1/2), and skill/lens/prompt iteration driven by stage-loss counts and compare-to-previous reports. The eval suite is a compounding asset: models swap underneath it.

## Test Plan

All tests use Vitest. Engine-touching tests use the fake `LlmRunner` from the architecture's testing strategy; scoring tests use synthetic artifact fixtures (hand-written JSON matching the reader contract).

Case loading and validation (`eval-case-loader.test.ts`):

- `loads_minimal_valid_case`: name + fixture repo + one should_find parses; defaults applied.
- `rejects_unknown_keys`: a case with `shoud_find` fails with an error naming the key and file.
- `rejects_missing_or_duplicate_names`: missing `name`; two files sharing a name.
- `rejects_ambiguous_execution_source`: both `repo.external` and `artifacts.path`; neither; `external` + `fixture` together.
- `rejects_conflicting_command_targets`: `pr` + `branch`; `base` without `branch`; an `args` key under `command` rejected as an unknown key (no raw CLI passthrough).
- `parses_target_forms`: `target: "abc123"` → single commit; `target: "abc123..def456"` → range.
- `rejects_bad_expectations`: duplicate expectation ids across lists; expectation with only `id`; `lineRange` `[10, 5]`; invalid `category`/`severityAtLeast`; uncompilable `titlePattern`; a `verifier` or `merge` block (unknown keys); non-numeric `maxPromptCharsByStage` key.
- `collects_all_errors_before_failing`: a suite with three invalid files reports all errors in one `config_error`.

Field matching (`expectation-matcher.test.ts`):

- `path_exact_vs_glob`: exact match; `src/**/*.go` glob; metacharacter detection (a literal path without metacharacters never globs); normalization of `./`-prefixed and backslash paths; case sensitivity.
- `line_range_overlap_boundaries`: `[10,20]` vs anchor 20 (inclusive touch matches); vs 21 (no match); multi-line anchor `[startLine 5, line 12]` vs `[12,30]`; reversed startLine normalization.
- `line_range_requires_anchor`: unanchored finding fails a lineRange expectation but can pass a path-only expectation.
- `severity_ordering_table`: full 4x4 matrix of `severityAtLeast` vs finding severity.
- `regex_semantics`: case-insensitive match; unanchored substring; `^`/`$` honored; pattern tested against `title`/`failureMode`, never `finalBody`.
- `conjunction_all_present_fields`: four-field expectation failing exactly one field does not match, and the outcome's per-field results identify the failing field.

Assignment (`expectation-assignment.test.ts`):

- `one_finding_two_expectations`: both expectations match one finding → exactly one pass, one miss.
- `two_findings_one_expectation`: one pass; the spare finding is reported uncovered, not a failure.
- `crossing_assignment_maximizes`: E1 matches F1+F2, E2 matches F1 only → matching assigns E2→F1, E1→F2 (cardinality 2), deterministically.
- `deterministic_pairing`: shuffled-equivalent fixtures in fixed artifact order produce identical pairings across runs.

Should-not-find (`should-not-find.test.ts`):

- `violation_on_reported_final`: inline and summary-only matches each fail the case with one violation per (expectation, finding) pair.
- `suppressed_and_candidates_are_near_violations`: matches in candidates or suppressed finals produce `nearViolations` only; case passes.
- `same_finding_pass_and_violation`: a finding satisfying a should_find while violating a should_not_find reports both results.

Stage-loss attribution (`stage-loss-attribution.test.ts`) — one synthetic artifact set per label:

- `label_lost_at_composition_suppressed`: matching final with `publication: "suppressed"` and selection reason `report-cap` → `lost-at-composition` + subReason.
- `label_lost_at_composition_merged`: verified candidate absorbed via `mergedCandidateIds` into a final failing the expectation's lineRange → `lost-at-composition`, subReason `merged-deduped-away`, absorbing fingerprint named.
- `label_lost_at_verification_rejected`: reject verdict → `lost-at-verification`, subReason `verifier-rejected`, with reason/falsePositiveRisk in detail.
- `label_lost_at_verification_gate_variants`: pre-gate `low_confidence`; `verificationIncomplete`; no verification record at all → `lost-at-verification` with the corresponding subReasons.
- `cluster_verdict_inheritance`: candidate with `duplicateOf` and no own verdict inherits the representative's verdict in rung 3.
- `hint_support_recorded`: no candidate; matching hint event (path in `files`, pattern in `question`) → `missed-before-candidate-generation` with the hint and its confidence in `matchingHints`; hint presence never changes the label.
- `hint_reduced_matching_skips_unmatchable`: expectation with only category+severity records no hint detail.
- `label_partial_match`: same-path candidate with wrong category → `partial-match` with field-mismatch records; expectation without `path` skips the rung.
- `label_missed_subreasons`: fixtures for `path-not-in-diff`, `file-filtered`, `hunk-skipped-by-planner`, `packet-review-failed`, `reviewed-no-candidate` (asserts coveringPacketIds + lenses surfaced), and `unknown` when enrichment artifacts are absent.
- `most_progressed_instance_wins`: one rejected candidate + one merged-away candidate for the same expectation → `lost-at-composition`, both instances in `nearestInstances` ordered by rank.
- `candidate_expectation_attribution_restricted`: a `should_find_candidate` miss never yields verification or composition labels.

Budgets (`budget-expectations.test.ts`):

- `each_check_pass_fail`: synthetic telemetry exercising every `expect.*` field at, below, and above its limit (boundary `==` passes for max checks, `minFindings` boundary passes).
- `prompt_chars_per_stage`: stage-7 call over limit fails only the `"7"` entry; stages without configured keys are unchecked.
- `replay_skip_semantics`: artifact replay skips cost/runtime/call checks with skipReason; finding-count and duplicate-group checks still evaluate against the replayed artifacts and are marked `fromReplayedArtifacts`.

Run directories and artifacts (`eval-run-dirs.test.ts`):

- `incrementing_allocation`: empty logs dir → 1; existing 1,2,7 + `tmp` junk dir → 8 (numeric, junk ignored).
- `concurrent_allocation_retries`: simulated EEXIST claims the next number.
- `previous_run_lookup_by_case_name`: logs with interleaved cases A,B,A finds the right previous A; none for first run.
- `info_written_last_and_complete`: `info.json` exists only after score + compare complete; embeds snapshot, caseHash, mode, cache source.
- `every_case_persists_run_dir`: every executed case — pass, fail, or error — leaves a complete run directory; there is no in-memory-only path.
- `debug_traces_present`: with `review.debug`, the run dir carries the engine's `telemetry/debug/llm-calls/<call-id>.json` and `telemetry/debug/tool-calls/` traces; absent otherwise; no derived prompt/result views exist.

Artifact replay (`eval-replay.test.ts`) — fake `LlmRunner` counting calls per stage:

- `replay_zero_calls_no_repo`: no LLM calls; scores from saved artifacts; budget checks skipped; `info.json.mode` is `"replay"`; rendered output and consumed artifacts copied into the new `telemetry/`; the test runs without any repo on disk.
- `case_reread_vs_snapshot`: edited case YAML on disk is re-read for `--from-artifacts` re-scoring (`caseSource: "yaml"`); deleted YAML falls back to snapshot (`caseSource: "snapshot"`).
- `replay_rescores_edited_expectations`: editing an expectation's `lineRange` between source run and replay flips its result without any stage executing.
- `missing_required_artifact_fails`: a source without `final-findings.json` or `candidate-findings.json` fails with `invalid_args` naming the missing file; absent `verification.json`/`final-selection.json` degrade attribution to `unrecorded` sub-reasons instead of failing.

Cache wiring (`eval-cache-wiring.test.ts`):

- `precedence_cli_case_config`: all eight combinations of CLI flag tri-state x case `review.cache` x config resolve per the precedence chain; `info.json.cache.source` records the winning layer.
- `cache_dir_from_case`: `review.cacheDir` reaches the engine config; default otherwise.

Compare-to-previous (`eval-compare.test.ts`):

- `regressions_fixes_and_label_changes`: pass→fail (with loss label), fail→pass, and `lost-at-verification`→`lost-at-composition` transitions detected.
- `fingerprint_finding_diff`: added/removed/changed findings keyed by fingerprint; severity and publication transitions reported field-level.
- `case_hash_drift_flagged`: differing caseHash sets `caseHashChanged` and the txt header note; comparison still produced.
- `no_previous_run`: first run of a case writes no compare artifacts.
- `compare_is_informational`: a regression-heavy compare does not alter case status or exit code.

End-to-end (`eval-suite-e2e.test.ts`) — temporary fixture git repo + fake `LlmRunner`:

- `suite_pass_exit_0`: two passing cases; run dirs laid out per spec; suite summary totals.
- `expectation_failure_exit_1`: one failing should_find yields exit 1, loss label in stdout and `info.json`.
- `case_error_continues_suite`: case 1 repo missing (status `error`), case 2 still runs; exit 1.
- `pre_run_validation_exit_2`: invalid case YAML aborts before any run dir is created; exit 2.
- `never_posts_github`: a PR-mode case run asserts zero GitHub posting calls on the fake `GitHubClient`.
- `determinism_replay_idempotent`: running artifact replay twice over the same run yields byte-identical scores.
