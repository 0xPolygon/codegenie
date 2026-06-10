---
status: complete
---

# Component: Evals

## Purpose And Scope

The evals component implements `codeninja eval`: repeatable, end-to-end quality testing of the review pipeline against real repositories, fixture repositories, and previously captured run artifacts. It loads YAML eval cases, executes each case through the normal review engine (or replays captured artifacts), scores the results against the case's expectations with deterministic matching, attributes every missed expectation to the pipeline stage that lost it, writes incrementing run directories under the eval suite, and diffs each run against the previous run of the same case.

This component owns:

- The `codeninja eval` command surface: `--eval-dir`, `--cache` / `--no-cache`, and `--from-artifacts`.
- Eval suite discovery, `EvalCase` YAML loading, and case validation, including the full matching semantics for `EvalFindingExpectation`, `VerifierExpectation`, and `MergeExpectation` (the types are defined in `architecture.md`; this doc elaborates their behavior and must not reshape them).
- Per-case execution: repo resolution for external and fixture repositories, per-case review-setting overlays on top of config, cache toggling per run, and telemetry wiring into the eval run directory.
- Incrementing `logs/<n>` run directories and their layout, including `info.json`, `out.log`, `codeninja-review.out.md`, the embedded `telemetry/` artifact set (the engine's full standard run directory, including `debug/` when debug traces are enabled), and comparison artifacts.
- Scoring: the expectation-matching algorithm (field rules, glob and line-range-overlap and severity-ordering and regex semantics, deterministic assignment when findings and expectations match many-to-many, and `should_not_find` violations).
- Stage-loss attribution: labeling each missed expectation as `missed-before-candidate-generation`, `candidate-only`, `rejected-by-verification`, `merged-deduped-away`, `omitted-by-final-selection`, `hint-only`, or `same-file-partial-match` by walking `candidate-findings.json`, `verification.json`, `final-selection.json`, and `final-findings.json`.
- Replay modes for `--from-artifacts` and artifact-backed cases: `candidate-recall`, `final-report`, and `merge-only`, including which artifacts load and which stages re-run.
- Budget expectations: cost, runtime, model-call, prompt-size, tool-call, finding-count, and duplicate-group checks against run telemetry.
- Compare-to-previous regression diffing between runs of the same case.

Explicitly not this component's responsibility:

- The review engine itself. Evals invoke the engine defined in `components/review_pipeline.md`; they never fork or reimplement any review stage.
- Model-call cache internals (keying, storage, eviction). Evals only toggle and direct the cache per run; the cache is owned by `components/skills_llm_telemetry.md`.
- Git, GitHub, and repository-tool mechanics; evals consume them through the engine (`components/repository_and_github.md`, `components/context_and_tools.md`).
- GitHub posting. Eval runs must never post; `--post-github-comments` is rejected inside eval cases.
- LLM-judged scoring. V1 scoring is deterministic field matching only, per `architecture.md`. Semantic or LLM-assisted matching is deferred.
- Fixture materialization tooling (cloning bundles, unpacking archives). V1 requires fixture paths to already be git worktrees; how they got there (CI clone, setup script) is outside codeninja.

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
// allocates the next run number in the same logs directory, replays, scores.
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
  stages: EvalStageExecution[]
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
// optional artifacts yield empty/undefined sections; missing artifacts that a
// replay mode requires throw invalid_args naming the missing file.
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

`EvalCase`, `EvalFindingExpectation`, `VerifierExpectation`, and `MergeExpectation` are defined in `architecture.md` and are referenced by name throughout this doc — they are not redefined here. The types below are new, owned by this component, and follow the `Eval*` prefix convention.

```ts
type EvalLossLabel =
  | "missed-before-candidate-generation"
  | "candidate-only"
  | "rejected-by-verification"
  | "merged-deduped-away"
  | "omitted-by-final-selection"
  | "hint-only"
  | "same-file-partial-match"

type EvalExpectationList =
  | "should_find"
  | "should_find_candidate"
  | "should_not_find"
  | "verifier_should_decide"
  | "merge_should_keep"
  | "merge_should_drop"
  | "merge_should_merge"
  | "merge_should_not_merge"

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
  matched: Array<{ findingId: string; artifact: "final-findings" | "candidate-findings" | "verification" }>
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
  skipReason?: string // e.g. "stage not executed in replay mode final-report"
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

type EvalStageExecution = {
  stage: ReviewStage
  execution: "executed" | "replayed-from-artifacts" | "not-applicable"
}

type EvalRunInfo = {
  runNumber: number
  caseName: string
  caseFile?: string // suite-relative path when run from a suite
  caseHash: string // sha256 of the raw case YAML bytes
  caseSnapshot: EvalCase // embedded resolved case; makes the run dir self-contained
  mode: "live" | "replay"
  replay?: {
    sourceArtifacts: string
    replayMode: "candidate-recall" | "final-report" | "merge-only"
    caseSource: "yaml" | "snapshot"
  }
  repo?: { root: string; baseSha?: string; headSha?: string; mergeBase?: string }
  reviewRunId?: string // the engine's run id for live runs
  stages: EvalStageExecution[]
  cache: { enabled: boolean; source: "cli" | "case" | "config"; dir?: string }
  startedAt: string
  finishedAt: string
  score: EvalScore
}

type EvalCaseResult = {
  caseName: string
  runDir?: string // absent when logs.enabled is false
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
    runJson?: unknown // run.json
  }
}
```

`EvalVerificationRecord`, `EvalSelectionRecord`, and `EvalHintEvent` are this component's *reader contracts* over artifacts whose writers are owned elsewhere (see Artifact Reader Contract under Internal Design). They name the minimum fields evals depends on; `components/review_pipeline.md` and `components/skills_llm_telemetry.md` own emission and may carry more.

### Error Conditions

There are no eval-specific `CodeninjaErrorCode` members; evals maps onto existing codes:

- `invalid_args`: conflicting/missing flags; `--from-artifacts` path missing or lacking `info.json`; an artifact replay missing a file its mode requires.
- `config_error`: eval case YAML parse or validation failures (cases are user-authored configuration); unresolvable `eval.defaultEvalDir`.
- `not_git_worktree` / `git_ref_missing`: a case's `repo.external`/`repo.fixture` is not a git worktree, or recorded review SHAs cannot be resolved for a `candidate-recall` replay. These are per-case errors (case status `error`), not suite-fatal.
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
           artifacts case -> load source artifacts; replay per mode
         load artifacts from logs/<n>/telemetry/
         score (matching + attribution + budgets)  [pure, artifact-only]
         write info.json, out.log, codeninja-review.out.md, debug views
         compare-to-previous (same case name) -> compare-to-previous.{json,txt}
         print per-case summary line + failures to stdout
  -> print suite totals; exit 0/1/2
```

V1 runs cases sequentially. Sequential execution keeps run numbering, cache behavior, provider rate limits, and budget accounting easy to reason about; parallel case execution is not designed in v1. Within a case the engine parallelizes normally per its own configuration.

Scoring never reads the repository — it consumes artifacts only. Repository access happens in exactly two places: live case execution (the engine) and `candidate-recall` replay (the verifier's read-only tools).

### Eval Suite Loading And Case Validation

Discovery: every `*.yaml` / `*.yml` file directly inside `--eval-dir` is one eval case (one case per file). Subdirectories — including `logs/`, fixtures, and any helper data — are not scanned. Cases execute in lexicographic filename order for deterministic suite runs.

Parsing: YAML is parsed and validated against a strict zod schema mirroring the `EvalCase` type from `architecture.md`. YAML keys map literally to the type's field names (snake_case lists like `should_find`, camelCase members like `severityAtLeast`, `lineRange`, `maxCostUSD`); no case conversion is applied. Unknown keys at any level are validation errors — a typo like `shoud_find` must fail loudly, never silently pass.

Validation rules (all violations are collected across all case files and reported together as one `config_error` before any case runs):

- `name` is required, non-empty, and unique across the suite. It keys previous-run lookup and `info.json`.
- Exactly one execution source must be present: `repo.external`, `repo.fixture`, or `artifacts.path`. Zero or more than one is invalid.
- `repo.external` should be an absolute path (with `~` expansion). `repo.fixture` resolves relative to the suite directory when relative. Both must be existing git worktrees at execution time; v1 does not materialize fixtures (no bundles, no archives) — a missing or non-git path is a per-case `error` at run time, not a load-time failure, so suites with some unavailable private repos still run their other cases.
- `command` is only meaningful with `repo`. At most one of `command.pr`, `command.branch`, `command.target` may be set. `command.base` requires `command.branch`. `command.target` accepts `<commit>` or `<start>..<end>` and maps to the engine's commit / commit-range mode. With no target fields, the engine's default branch-mode resolution applies inside the case repo.
- `command.args` are extra `codeninja review` CLI arguments parsed by the same flag parser the review command uses, appended last (so they win over structured fields on overlap). Target-selection flags (`--pr`, `--branch`, `--base`, `--diff`, positionals) and `--post-github-comments` are forbidden inside `args` — eval runs never post to GitHub.
- `artifacts.mode`, when present, must be one of the three replay modes. `artifacts.path` resolves relative to the suite directory when relative.
- Every `EvalFindingExpectation` must set `id` (unique across `should_find`, `should_find_candidate`, and `should_not_find` together — one id namespace per case) plus at least one matching field. An expectation with only an `id` would match everything (or, under `should_not_find`, ban everything) and is rejected as an authoring error.
- `lineRange` must be `[a, b]` with integers `1 <= a <= b`.
- `category` must be a valid `FindingCategory`; `severityAtLeast` a valid `Severity`.
- `titlePattern` / `failureModePattern` must compile as ECMAScript regular expressions; compilation failures are load-time errors.
- `verifier.should_decide[].expectationId` and every id inside `merge.*` must reference a declared expectation id; dangling references are errors.
- `merge.should_merge[].expectationIds` and `merge.should_not_merge[].expectationIds` must list at least two ids.
- `MergeExpectation.intoOne` must be `true` in v1. `intoOne: false` has no defined semantics in the parent specs and is rejected at validation as reserved.
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
  lenses: ["core/logic-bugs", "lang/go"]
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
verifier:
  should_decide:
    - expectationId: tx-rollback-leak
      verdict: keep
```

### Per-Case Review Settings Overlay And Repo Resolution

A live case invokes the review engine in-process — never via a forked implementation, and not as a subprocess. This requires two seams on the engine entrypoint, owned by `components/review_pipeline.md`: it must accept an explicit repository root (the eval command's cwd is the suite, not the reviewed repo) and an explicit run-artifact directory (so the engine writes its standard run directory at `logs/<n>/telemetry/` instead of `.codeninja/runs/<run-id>/`). The engine's artifact set, stage behavior, telemetry, and failure semantics are otherwise completely unchanged.

Config layering for a case run, reusing the existing precedence chain (CLI flags > environment > `codeninja.toml` > defaults):

1. Built-in defaults.
2. The reviewed repository's `codeninja.toml`, loaded from the case repo root with normal trust partitioning (safe keys only).
3. User-scoped config.
4. The eval case's `review.*` fields and `command.args`, applied at CLI-flag strength — the case file is user-authored and user-invoked, which satisfies the user-level opt-in rule for out-of-repo `cacheDir` and run-dir placement.

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

Repo resolution: the runner resolves the case repo root (`repo.external` expanded, or `repo.fixture` against the suite dir), verifies it is a git worktree, builds the `ReviewInput` from `command` (`pr` → `github_pr`, `branch`/`base` → `branch`, `target` → `commit_range`, none → branch-mode default), and passes both to the engine. Base-branch resolution, merge-base semantics, PR fetching, and all other input-resolution behavior are the engine's, untouched.

`logs.enabled` (default `true`): when `false`, the case still executes and scores against in-memory artifacts, but no run directory is persisted — only the stdout summary and the suite exit code reflect it; replay and compare-to-previous are unavailable for such runs. `logs.dir` overrides the logs directory for the case (relative paths resolve against the suite directory); otherwise the logs directory is `<eval-suite>/<config.eval.logsDir>` (default `logs`).

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
    debug/                   # same layout as the engine run dir, when debug traces are enabled
  compare-to-previous.txt    # only when a previous run of the same case exists
  compare-to-previous.json
```

Rules:

- Run numbers are unpadded positive integers (`logs/1`, `logs/2`, …), ordered numerically, never lexicographically. Allocation scans existing numeric children, takes `max + 1` (starting at `1`), and claims the directory with `mkdir` — on `EEXIST` (a concurrent invocation), it retries with the next number. Non-numeric children of the logs dir are ignored.
- `telemetry/` is the engine's full standard run directory written in place, per `architecture.md`'s eval layout — evals never suppresses or reshapes it. Attribution uses `coverage.json` and `review-plan.json` as enrichment when present.
- `codeninja-review.out.md` is the Markdown rendering of the final `ReviewResult`, written by the eval runner regardless of any `--format` in `command.args`. In `final-report` replay mode it is copied from the source run when present.
- `out.log` is the eval runner's own structured log (case resolution, settings overlay, stage execution, scoring summary, compare results), using the standard `Logger` with stage `0`; the engine's chronological log remains `telemetry/run.log`.
- `info.json` is the single run-info document: it embeds the resolved case snapshot, the case hash, repo identity and reviewed SHAs, per-stage `executed` / `replayed-from-artifacts` / `not-applicable` records, cache resolution, timing, and the full `EvalScore`. It is written last (temp-file-then-rename) so a complete `info.json` marks a complete run.
- Debug traces live in `telemetry/debug/` with the engine run directory's own layout (`llm-calls/<call-id>.json`, `tool-calls/<tool-call-id>.json`), present when `review.debug` enables `telemetry.debugTrace`. Evals derives no separate prompt/result views; the engine's debug artifacts are consumed as-is.

### Artifact Reader Contract

Scoring and attribution read the following artifacts. The expectation-bearing four are required; the rest enrich attribution and metrics and degrade gracefully when absent (the affected attribution rungs or metrics are skipped with a note in the loss detail or budget result).

| Artifact | Evals reads | Writer (owner) |
| --- | --- | --- |
| `candidate-findings.json` | `CandidateFinding[]`: every structurally valid candidate from Stages 7–8, with `id`, matching fields, `producedBy`, `clusterId?`, `duplicateOf?` | `components/review_pipeline.md` |
| `verification.json` | Per candidate id: either a pre-verification-gate record `{ candidateId, gate: "suppressed", gateReason }` or `{ candidateId, gate: "passed", verdict: VerificationVerdict }`; revised findings carry `verdict.finalFinding` | `components/review_pipeline.md` |
| `final-selection.json` | Per verified-kept finding: `{ findingId, decision: "published" \| "merged" \| "suppressed", reason, mergedIntoFingerprint? }` — the telemetry requirement "final-selection decisions and reasons for omitted verified findings" in artifact form | `components/review_pipeline.md` |
| `final-findings.json` | `FinalFinding[]` including suppressed entries, with `publication`, `fingerprint`, `mergedCandidateIds` | `components/review_pipeline.md` |
| `review-plan.json` | `ReviewPlan` (coverage decisions per hunk, skip reasons) | `components/review_pipeline.md` |
| `packets/*.json` | `ReviewPacket[]` (paths, hunk line ranges, lenses) | `components/review_pipeline.md` |
| `coverage.json` | `RunCoverageStatus` + per-hunk records (filter/skip/review_failed status) | `components/review_pipeline.md` |
| `events.jsonl` | Hint events: one event per emitted follow-up hint and structured uncertainty (stage 7/8; `event: "follow_up_hint"` / `"uncertainty"`) carrying `{ packetId, question, files, symbols, reason, confidence }` in `data` (uncertainty events omit `reason`/`confidence`), plus `system_task_scheduled` / `system_task_suppressed` events | `components/skills_llm_telemetry.md` (recorder), `components/review_pipeline.md` (emission) |
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
| `should_find_candidate` | All candidates (`candidate-findings.json`), packet- and system-produced | Satisfied under the assignment |
| `should_not_find` | Reported final findings | No reported finding matches (universal predicate, no assignment) |
| `verifier.should_decide` | Verdicts of candidates matching the referenced expectation | See Verifier Expectations |
| `merge.should_keep` | Verified-kept findings → reported finals | A verified-kept match persists into a reported final finding |
| `merge.should_drop` | Verified-kept findings → reported finals | No reported final finding matches |
| `merge.should_merge` | Reported finals' merge lineage (`mergedCandidateIds`) | See Merge Expectations |
| `merge.should_not_merge` | Reported finals' merge lineage | See Merge Expectations |

The lists are independent predicates: the same finding may satisfy a `should_find` and violate a `should_not_find` in the same run; both results are reported, neither suppresses the other.

#### Assignment And Ambiguity Handling

Within `should_find` (and independently within `should_find_candidate`), expectations and findings can match many-to-many: one loose expectation can match several findings, and one finding can match several expectations. Greedy assignment under-counts; satisfying two distinct-bug expectations with the same single finding hides a miss. Scoring therefore computes a **maximum bipartite matching** between the list's expectations and the target finding set:

1. Build the match matrix with `matchExpectation` (expectations in YAML order, findings in artifact array order).
2. Find a maximum matching via augmenting paths (Hopcroft-Karp or simple augmenting search — sets are small). Each finding satisfies at most one expectation; each expectation is satisfied by at most one finding.
3. Expectations left unmatched are failures (for `should_find`, they proceed to stage-loss attribution). Findings left unmatched are recorded as uncovered findings in the metrics, not failures.
4. Determinism: iteration follows the fixed orders above, so equal-cardinality matchings resolve to the same pairing on every run. Only the matching's cardinality affects pass/fail; the specific pairing affects explanatory output only.

Consequence worth stating: if an author writes two expectations for two aspects of one issue and the composer legitimately merges them into one final finding, one expectation fails with loss label `merged-deduped-away`. That is the intended truthful behavior — the remedy is to model the intended grouping with `merge.should_merge` plus a single `should_find` for the group.

#### Should Not Find Violations

Every reported final finding matching any `should_not_find` expectation produces one `EvalViolation` per (expectation, finding) pair; any violation fails the case. Additionally, candidates and suppressed final findings matching a `should_not_find` expectation are recorded as `nearViolations` — informational only (the pipeline correctly kept them out of the report), surfacing how close a banned finding came to publication.

### Verifier Expectations

`VerifierExpectation` (`{ expectationId, verdict }`) asserts the verifier's verdict for the candidates matching the referenced expectation's predicate (the expectation may be declared in any of the three lists; only its fields are used).

Algorithm:

1. Compute the matching candidate set `C` from `candidate-findings.json` using the referenced expectation's predicate.
2. For each candidate in `C`, resolve its verification outcome from `verification.json`. A candidate with `duplicateOf` set and no verdict of its own inherits its cluster representative's verdict (Stage 9 pre-clustering verifies the representative; the verdict applies to the cluster).
3. Decide:
   - `verdict: "keep"` or `"revise"` — pass iff **at least one** candidate in `C` received exactly that verdict. One surviving instance demonstrates the verifier keeps/revises this real issue.
   - `verdict: "reject"` — pass iff **no** candidate in `C` was kept or revised. A rejection expectation is about the issue class, so one kept duplicate is a failure even if others were rejected. Candidates suppressed by pre-verification gates (no verdict) count as satisfying the rejection intent, recorded with note `satisfied_by: "pre_verification_gate"`.
4. Outcome classes recorded in the result: `pass`; `fail` (a candidate received a contradicting verdict); `fail` with reason `no-matching-candidate` when `C` is empty (the expectation never reached the verifier); `fail` with reason `unverified` for keep/revise expectations whose only matching candidates were pre-gate-suppressed or `verificationIncomplete`.

`keep` vs `revise` is an exact-verdict regression assertion and can be brittle across model wording choices; authors asserting survival should prefer `should_find` or `merge.should_keep`, and reserve `should_decide` for verifier-behavior regression tests. This is guidance, not mechanism.

### Merge Expectations

Merge checks evaluate Stage 10 behavior through final findings' lineage. A reported final finding `F` **covers** a candidate `c` iff `c.id === F.id` or `F.mergedCandidateIds` includes `c.id`.

- `merge.should_keep[]` (`EvalFindingExpectation`): compute the matching verified-kept set (verdicts `keep`/`revise`, using post-revision values). Pass iff at least one member is covered by a reported final finding. If the verified-kept set is empty, fail with reason `unmatched-upstream` — merge behavior cannot be tested for a finding that never reached Stage 10 (the corresponding `should_find` failure carries the real attribution).
- `merge.should_drop[]`: compute the matching verified-kept set. Pass iff no reported final finding matches the expectation's predicate. (The verified-kept set existing but being deduped/suppressed away is exactly the desired outcome; an empty verified-kept set passes with note `unmatched-upstream`, since nothing reached the merge stage to drop.)
- `merge.should_merge[]` (`MergeExpectation`, `intoOne: true` only in v1): for each listed expectation id, compute its matching candidate set. Let `Finals` be the set of reported final findings covering at least one candidate from at least one listed expectation. Pass iff `Finals` has exactly one member and that member covers at least one matching candidate of **every** listed expectation. Fail reasons distinguish `not-merged` (multiple finals), `partially-merged` (one final covering only some listed expectations), and `unmatched-upstream` (a listed expectation matched no candidate).
- `merge.should_not_merge[]` (`{ expectationIds }`): compute per-listed-expectation covering finals as above. Fail iff any single reported final finding covers candidates of two or more distinct listed expectations (they were merged). Listed expectations with no covering final fail with `unmatched-upstream`.

### Stage-Loss Attribution

Every unsatisfied `should_find` expectation gets a loss label explaining where the pipeline lost it. Attribution is a deterministic walk over `candidate-findings.json`, `verification.json`, `final-selection.json`, and `final-findings.json`, enriched by `review-plan.json`, `packets/*.json`, `coverage.json`, and hint events from `events.jsonl` when present. The same `matchExpectation` predicate drives every rung.

#### Outcome Ranking

When multiple instances of the expected issue exist with different terminal outcomes (e.g., one candidate rejected, another merged away), the expectation is attributed to the **most-progressed instance** — the latest pipeline point that still held the finding — and all other instances are listed in `nearestInstances`. Outcome ranks, most-progressed first:

```text
6 omitted-by-final-selection   (survived verification; lost identity at Stage 10 suppression)
5 merged-deduped-away          (survived verification; absorbed into a non-matching final)
4 rejected-by-verification     (reached the verifier; explicit reject verdict)
3 candidate-only               (produced as a candidate; never received a verdict)
2 hint-only                    (only articulated as a follow-up hint or uncertainty)
1 same-file-partial-match      (something in the right file, wrong fields)
0 missed-before-candidate-generation
```

#### Attribution Walk

For a missed expectation `E`:

1. **Suppressed final?** Match `E` against final findings with `publication: "suppressed"`. On match → `omitted-by-final-selection`. `subReason` comes from `final-selection.json` (`report-cap`, `soft-comment-cap`, `confidence-threshold`, `severity-threshold`, `composer-suppressed`) or the finding's selection record; omissions caused by confidence/severity thresholds are this label (the functional spec's "omitted by report caps or confidence thresholds" maps here). If `final-selection.json` is absent or has no record, the label still applies with `subReason: "unrecorded"` plus a warning note.
2. **Merged into a non-matching final?** Match `E` against the verified-kept set (verdicts `keep`/`revise`, post-revision values). For each match `c`, check whether any final finding covers `c` (`c.id ∈ F.mergedCandidateIds` or `c.id === F.id`). If a covering final exists but did not satisfy `E` (otherwise the expectation would have passed) → `merged-deduped-away`; the detail names the absorbing final's fingerprint, title, and which fields of `E` it fails.
3. **Verified-kept but no selection trace?** A verified-kept match with no covering final and no selection record → `omitted-by-final-selection` with `subReason` from `final-selection.json` when available (e.g. `composer-pre-trim`), else `"unrecorded"`.
4. **Rejected?** Match `E` against candidates whose resolved verdict (following `duplicateOf` to the cluster representative) is `reject` → `rejected-by-verification`. The detail carries the verifier's `reason` and `falsePositiveRisk`.
5. **Candidate without a verdict?** Match `E` against all remaining candidates. A match whose verification record is a pre-gate suppression, `verificationIncomplete`, or absent entirely → `candidate-only`. `subReason` from the gate record or coverage: `low-confidence-suppressed`, `invalid-anchor`, `no-evidence`, `verification-incomplete`, `budget-exhausted`, or `unrecorded`.
6. **Hint only?** No candidate matched. Search hint events (follow-up hints, structured uncertainties, system-task records) from `events.jsonl` using **diagnostic-grade reduced matching** — hints carry no severity/category/anchor, so only these fields participate: `path` matches any entry of the hint's `files` (exact-or-glob); `titlePattern`/`failureModePattern` test against the hint's `question`, `reason`, and `symbols` joined; `lineRange`, `category`, and `severityAtLeast` are ignored. An expectation whose only present fields are unmatchable against hints (e.g. category + severity only) skips this rung. On match → `hint-only`; the detail records the hint, its confidence, and whether it was promoted to a system follow-up task (`promoted-task-ran-no-candidate` vs `not-promoted` vs `task-suppressed` from the scheduling events). Reduced matching is acceptable here because `hint-only` is forensic, never a pass.
7. **Same file, wrong fields?** Match `E`'s `path` field alone (exact-or-glob) against all candidates and all final findings. If any instance is in the right file but fails other fields → `same-file-partial-match`. The detail carries the closest instances (fewest failed fields; ties by artifact order) with full per-field mismatch records — e.g. `category: expected security, actual logic_bug`, `lineRange: expected 80–90, actual 120`. An expectation without a `path` field skips this rung.
8. **Otherwise** → `missed-before-candidate-generation`.

Rungs 6 and 7 are ordered hint-first, matching both parent specs' ordering; the detail record includes instances from both rungs regardless of which label wins.

#### Missed-Before-Candidate-Generation Sub-Reasons

When the walk bottoms out at rung 8, attribution sub-diagnoses why nothing was ever produced, using enrichment artifacts when present:

- `path-not-in-diff`: no packet and no coverage/filter record touches the expectation's path. Flagged prominently — the expectation itself may be wrong (stale line numbers, renamed file).
- `file-filtered`: the path appears in filter decisions (`coverage.json` / filter records) with action `skip` (generated/vendored/lock/ignored/config-skipped); the filter reason is included.
- `hunk-skipped-by-planner`: `review-plan.json` shows coverage `skip` for the hunks overlapping the expectation's `lineRange` (or any hunk of the file when no `lineRange`); the planner's reason is included.
- `packet-review-failed`: covering hunks have coverage status `review_failed`.
- `reviewed-no-candidate`: packets covering the expected path/lines were reviewed and produced no matching candidate — the true model-miss case. The detail lists `coveringPacketIds`, the lenses selected for those packets (`coveringPacketLenses`), and the planner coverage level, so a human can spot "the tests lens never ran on this hunk" without evals needing lens-to-category knowledge.
- `unknown`: enrichment artifacts unavailable; label stands without a sub-reason.

Covering packets are located deterministically: packets whose `path` matches the expectation's path predicate and, when `lineRange` is present, whose hunks' new-line or old-line ranges overlap it.

#### Attribution For Candidate Expectations

`should_find_candidate` misses can only be attributed to `missed-before-candidate-generation` (with sub-reasons), `hint-only`, or `same-file-partial-match` — candidate-stage expectations cannot be lost in later stages by definition. The walk runs rungs 6–8 only, with rung 7 restricted to candidates.

#### Worked Example

```json
{
  "expectationId": "tx-rollback-leak",
  "list": "should_find",
  "status": "fail",
  "matched": [],
  "loss": {
    "label": "rejected-by-verification",
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
| `maxCostUSD` | `cost-profile.json` | Total run cost `<=` limit |
| `maxElapsedSeconds` | `run.json` / telemetry totals | Total review runtime `<=` limit |
| `maxModelCalls` | `model-calls-summary.json` (fallback: count `model-calls.jsonl` lines) | Total provider calls `<=` limit |
| `maxToolCalls` | tool-invocation events in `events.jsonl` | Total repository tool calls `<=` limit |
| `maxPromptCharsByStage` | `model-calls.jsonl` (per-call stage + prompt char size) | For every call of stage `s`, prompt chars `<=` limit for `s`; one `EvalBudgetResult` per configured stage key |

Replay semantics: budget checks measure what actually executed in this eval run. In replay modes, checks whose source metrics belong to stages that did not execute are `skipped` with `skipReason: "stage not executed in replay mode <mode>"`. Concretely: `final-report` skips all budget checks except the finding-count and duplicate-group checks (which read replayed artifacts and are marked `fromReplayedArtifacts`); `merge-only` measures Stage 10 calls/cost/runtime only; `candidate-recall` measures Stages 9–10. `verificationCalls` in metrics counts stage-9 entries in `model-calls.jsonl` (fallback: `verification.json` verdict count).

### Replay Modes

Replay reuses captured artifacts to re-run downstream slices of the pipeline — the workhorse for iterating on verification, dedup, and composition without paying for candidate generation, and for re-scoring after editing expectations.

Mode resolution: for an artifact-backed case run via `--eval-dir`, `EvalCase.artifacts.mode`, else `config.eval.replayMode`, else `final-report`. For `--from-artifacts`, `config.eval.replayMode`, else `final-report` (the embedded snapshot's `artifacts.mode` does not apply; the snapshot of a live run has no `artifacts` block).

| Mode | Artifacts loaded (required) | Stages re-run | LLM calls | Repo required |
| --- | --- | --- | --- | --- |
| `final-report` | `final-findings.json`; optional: all others for attribution/metrics | None | None | No |
| `merge-only` | `verification.json` + `candidate-findings.json` (lineage); `packets/` for anchor re-validation | Stage 10 (dedup/rank/compose) | Composer call(s) | No — anchors re-validate against packet hunk line data, not the repo |
| `candidate-recall` | `candidate-findings.json` + `packets/` (verifier context); `review-plan.json` optional | Stages 9–10 | Verifier calls + composer call(s) | Yes — verifiers use read-only repository tools at the recorded base/head SHAs |

Common behavior:

- `--from-artifacts <suite>/logs/<n>` allocates the next run number **in the same logs directory**, so replay runs sit beside their source and compare-to-previous naturally diffs against it. The case definition is re-read from the recorded `caseFile` when it still exists (supporting the expectation-iteration workflow: edit YAML, re-score captured artifacts), falling back to the `info.json` embedded snapshot; `info.json.replay.caseSource` records which was used.
- Stages that re-run write fresh artifacts into the new run's `telemetry/` (`candidate-recall` produces a new `verification.json`, `final-selection.json`, `final-findings.json`; `merge-only` produces new `final-selection.json` and `final-findings.json`). Artifacts consumed without re-running are copied from the source into the new `telemetry/` so every run directory is self-contained for scoring, future replays, and comparison.
- `info.json.stages` records each stage as `executed`, `replayed-from-artifacts`, or `not-applicable` — the architecture requires which stages re-ran vs replayed to be recorded in the eval run info.
- Expectation results computed against replayed inputs are flagged `fromReplayedArtifacts: true` (e.g. `should_find_candidate` results in `candidate-recall` reflect the original run's candidates, not new model behavior).
- `candidate-recall` resolves the repo from the case (`repo.external`/`repo.fixture`) and verifies the recorded `baseSha`/`headSha` resolve (`git rev-parse --verify <sha>^{commit}`); failures are per-case `git_ref_missing` errors. Verifier and composer execution is the engine's (Stage 9/10 entrypoints with the same configs, budgets, and failure policy); evals supplies inputs from artifacts instead of live upstream stages.
- Replay modes honor cache settings: with cache enabled, re-run verifier/composer calls hit the model-call cache when their normalized requests match, making `candidate-recall` + `--cache` an effectively free regression of deterministic downstream behavior.
- Missing required artifacts for the selected mode fail the case with `invalid_args` naming the file; optional artifacts degrade per the reader contract.

### Cache Wiring

Per-run cache resolution, recorded in `info.json.cache` with its source:

```text
--cache / --no-cache (eval CLI)  >  EvalCase.review.cache  >  config.cache.enabled
```

Cache directory: `EvalCase.review.cacheDir` when set (user-level opt-in is satisfied by the eval invocation itself), else the engine default. Evals passes the resolved settings into the engine config for the case run; everything else — keying over the normalized request, storage, eviction, the guarantee that changed targets/diffs/prompts miss naturally — is cache internals owned by `components/skills_llm_telemetry.md`. Cache hit/miss counts flow back into `EvalRunMetrics` from telemetry. The intended workflows: `--no-cache` measures real model-review quality; `--cache` re-runs debug deterministic downstream behavior at near-zero cost.

### Compare-To-Previous

After scoring run `n` of a case, the runner locates the previous run: the highest-numbered run directory `< n` in the same logs directory whose `info.json.caseName` matches. When none exists, no comparison artifacts are written ("when available"). Otherwise `compare-to-previous.json` (the `EvalCompareReport`) and `compare-to-previous.txt` (its human-readable rendering) are written:

- Expectation transitions: regressions (`pass` → `fail`, with the new loss label), fixes (`fail` → `pass`), and loss-label changes for still-failing expectations (e.g. `rejected-by-verification` → `merged-deduped-away` — the issue moved further down the pipeline).
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

- Scoring is a pure function of (case, artifacts, stage-execution record): no LLM, no repo reads, no clock.
- All iteration orders are fixed: case files lexicographic; expectations in YAML order; findings in artifact array order; assignment via deterministic augmenting-path matching.
- Regexes compile with fixed flags (`i`); glob matching uses the single shared matcher; severity ranks and overlap arithmetic are total functions.
- Re-running `final-report` replay over the same artifacts with the same case YAML must produce byte-identical `score` content (modulo timestamps).

## Dependencies

This component depends on:

- `components/review_pipeline.md` — the review engine, invoked in-process and never forked. Required seams: an engine entrypoint accepting an explicit repository root and an explicit run-artifact directory; Stage 9 and Stage 10 entrypoints invocable with artifact-supplied inputs for replay; writer-side guarantees for the artifact reader contract (`candidate-findings.json`, `verification.json` gate+verdict records, `final-selection.json` decision records, `final-findings.json` including suppressed entries, hint/system-task event emission).
- `components/skills_llm_telemetry.md` — the telemetry recorder and artifact files evals reads for metrics (`events.jsonl`, `model-calls.jsonl`, `model-calls-summary.json`, `cost-profile.json`, `run.json`), and the model-call cache evals toggles per run.
- `components/repository_and_github.md` / `components/context_and_tools.md` — git resolution and repository tools, consumed only through the engine; evals itself performs only worktree existence checks and `git rev-parse --verify` for replay SHAs via `GitClient`.
- CLI/config: `commander` registration in `src/cli/main.ts`; the config loader for `eval.defaultEvalDir`, `eval.logsDir`, `eval.replayMode`, and the precedence chain.
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
- `rejects_conflicting_command_targets`: `pr` + `branch`; `base` without `branch`; forbidden flags in `command.args` (`--pr`, `--post-github-comments`).
- `parses_target_forms`: `target: "abc123"` → single commit; `target: "abc123..def456"` → range.
- `rejects_bad_expectations`: duplicate expectation ids across lists; expectation with only `id`; `lineRange` `[10, 5]`; invalid `category`/`severityAtLeast`; uncompilable `titlePattern`; dangling `verifier.should_decide.expectationId`; `merge.should_merge` with one id; `intoOne: false`; non-numeric `maxPromptCharsByStage` key.
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

- `label_omitted_by_final_selection`: matching final with `publication: "suppressed"` and selection reason `report-cap` → label + subReason.
- `label_merged_deduped_away`: verified candidate absorbed via `mergedCandidateIds` into a final failing the expectation's lineRange → label, absorbing fingerprint named.
- `label_rejected_by_verification`: reject verdict with reason/falsePositiveRisk in detail.
- `label_candidate_only_variants`: pre-gate `low_confidence`; `verificationIncomplete`; no verification record at all → subReasons.
- `cluster_verdict_inheritance`: candidate with `duplicateOf` and no own verdict inherits the representative's verdict in rung 4 and in verifier expectations.
- `label_hint_only`: no candidate; matching hint event (path in `files`, pattern in `question`) → label; promotion sub-state (`not-promoted` vs `promoted-task-ran-no-candidate`).
- `hint_reduced_matching_skips_unmatchable`: expectation with only category+severity skips the hint rung.
- `label_same_file_partial_match`: same-path candidate with wrong category → label with field-mismatch records; expectation without `path` skips the rung.
- `label_missed_subreasons`: fixtures for `path-not-in-diff`, `file-filtered`, `hunk-skipped-by-planner`, `packet-review-failed`, `reviewed-no-candidate` (asserts coveringPacketIds + lenses surfaced), and `unknown` when enrichment artifacts are absent.
- `most_progressed_instance_wins`: one rejected candidate + one merged-away candidate for the same expectation → `merged-deduped-away`, both instances in `nearestInstances` ordered by rank.
- `candidate_expectation_attribution_restricted`: a `should_find_candidate` miss never yields verification/selection labels.

Verifier and merge expectations (`verifier-merge-expectations.test.ts`):

- `keep_any_of`: two matching candidates, one kept one rejected, `verdict: keep` passes.
- `reject_all_of`: same fixture with `verdict: reject` fails; all-rejected fixture passes; pre-gate-suppressed-only fixture passes with `satisfied_by: pre_verification_gate`.
- `unverified_keep_fails`: only-incomplete candidates fail a keep expectation with reason `unverified`; empty match set fails with `no-matching-candidate`.
- `should_merge_into_one`: covering-final arithmetic for pass, `not-merged`, `partially-merged`, `unmatched-upstream`.
- `should_not_merge_detects_shared_final`: two expectations covered by one final → fail; distinct finals → pass.
- `should_keep_and_drop`: verified-kept match published → keep passes; matching reported final → drop fails; empty verified-kept set → keep fails `unmatched-upstream`, drop passes with note.

Budgets (`budget-expectations.test.ts`):

- `each_check_pass_fail`: synthetic telemetry exercising every `expect.*` field at, below, and above its limit (boundary `==` passes for max checks, `minFindings` boundary passes).
- `prompt_chars_per_stage`: stage-7 call over limit fails only the `"7"` entry; stages without configured keys are unchecked.
- `replay_skip_semantics`: `final-report` skips cost/runtime/call checks with skipReason; `merge-only` evaluates only stage-10-sourced metrics.

Run directories and artifacts (`eval-run-dirs.test.ts`):

- `incrementing_allocation`: empty logs dir → 1; existing 1,2,7 + `tmp` junk dir → 8 (numeric, junk ignored).
- `concurrent_allocation_retries`: simulated EEXIST claims the next number.
- `previous_run_lookup_by_case_name`: logs with interleaved cases A,B,A finds the right previous A; none for first run.
- `info_written_last_and_complete`: `info.json` exists only after score + compare complete; embeds snapshot, caseHash, stages, cache source.
- `logs_disabled_runs_in_memory`: `logs.enabled: false` scores and reports without creating a run dir.
- `debug_traces_present`: with `review.debug`, the run dir carries the engine's `telemetry/debug/llm-calls/<call-id>.json` and `telemetry/debug/tool-calls/` traces; absent otherwise; no derived prompt/result views exist.

Replay modes (`eval-replay.test.ts`) — fake `LlmRunner` counting calls per stage:

- `final_report_zero_calls`: no LLM calls; scores from saved artifacts; budget checks skipped; `stages` all `replayed-from-artifacts`/`not-applicable`; rendered output copied.
- `merge_only_composer_only`: stage-10 calls only; new `final-selection.json`/`final-findings.json` written; consumed artifacts copied into new telemetry; anchors re-validated against packet hunks with no repo access (test runs without any repo on disk).
- `candidate_recall_runs_9_and_10`: stage-9 + stage-10 calls; missing repo or unresolvable recorded SHAs → case status `error` with `git_ref_missing`; with repo present, new verification artifacts written.
- `mode_resolution_precedence`: case `artifacts.mode` > `config.eval.replayMode` > `final-report` default; `--from-artifacts` ignores snapshot `artifacts.mode`.
- `case_reread_vs_snapshot`: edited case YAML on disk is re-read for `--from-artifacts` re-scoring (`caseSource: "yaml"`); deleted YAML falls back to snapshot (`caseSource: "snapshot"`).
- `missing_required_artifact_fails`: `merge-only` source without `verification.json` → `invalid_args` naming the file.

Cache wiring (`eval-cache-wiring.test.ts`):

- `precedence_cli_case_config`: all eight combinations of CLI flag tri-state x case `review.cache` x config resolve per the precedence chain; `info.json.cache.source` records the winning layer.
- `cache_dir_from_case`: `review.cacheDir` reaches the engine config; default otherwise.

Compare-to-previous (`eval-compare.test.ts`):

- `regressions_fixes_and_label_changes`: pass→fail (with loss label), fail→pass, and `rejected-by-verification`→`merged-deduped-away` transitions detected.
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
- `determinism_replay_idempotent`: running `final-report` replay twice over the same run yields byte-identical scores.
