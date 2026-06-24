# Issue 79: Eval Recall-Variance Harness and Relay Wrong-Chain Regression Case

Status: PENDING
Planned from: trails-api Opus/GPT recall comparison (5 runs over the same diff), 2026-06-24
Planned at: commit `7ffa1e8` (branch `next`)
Recommended priority: high. This is the measurement foundation for the Stage 7 recall problem. Without per-case repeats and a recall-rate metric, every recall claim is a single noisy sample; with them, the harness can quantify recall variance and gate any future redundancy fix.

> Executor instructions: keep single-run eval semantics byte-identical when `repeat` is absent or `1`. Do NOT add an LLM judge to scoring — scoring must stay deterministic. Do NOT change any review-pipeline behavior in this plan; this is eval-harness-only plus one regression case. The Relay case must distinguish the *material* wrong-chain bug from two look-alikes on the same line (see Background).
>
> Drift check: `git diff --stat 7ffa1e8..HEAD -- src/evals/eval-runner.ts src/evals/eval-scoring.ts src/evals/eval-artifacts.ts src/evals/eval-command.ts src/evals/eval-compare.ts src/types.ts tests/evals.test.ts evals/fixtures`
> If in-scope files changed since this plan was written, compare the "Current State" excerpts below against live code before editing.

## Background: why this exists

Five real reviews of the *same* trails-api diff (relay.go `deep` in all five) recalled the one material MEDIUM bug — Relay fill gas priced via `EstimateGasCostUSD(req.OriginChainID, …)` when the fill executes on the **destination** chain — as a published finding in **only 1 of 5 runs** (Opus boost=1: FINDING then MISS; Opus boost=2: MISS; gpt-5.5: NOTE then MISS). The bug is not depth- or budget-gated; it is lost to Stage 7 per-pass non-determinism. See memory `stage7-recall-bottleneck`.

Two measurement problems blocked turning that observation into an actionable, gateable metric:

1. **The eval harness runs each case exactly once.** There is no way to run a case N times and aggregate a recall rate, so variance is invisible to it.
2. **Ad-hoc text matching is unreliable.** A throwaway script (`trails-api/.codegenie/analyze-relay-recall.py`) scored recall by regex and produced at least two false positives: it matched the unrelated Relay *duration-constant* finding (10s→30s, via the `relayFillGasEstimate` token) and the *zero-guard* concern (`OriginChainID == 0` errors), neither of which is the wrong-chain mispricing bug. Three distinct findings live on the same lines of `relay.go`:
   - **WC** (wrong-chain mispricing) — the material MEDIUM bug; discriminator is the origin-vs-**destination** framing.
   - **ZG** (zero-guard) — `EstimateGasCostUSD` errors when `OriginChainID == 0`; robustness, not correctness.
   - **DUR** (duration constant) — `defaultDurationSeconds` 10→30; unrelated, mentions `relayFillGasEstimate` only incidentally.

The eval harness's existing multi-field matching (path + lineRange + category + severity + two regex patterns, all required) is strong enough to isolate WC from ZG/DUR — it just was never given a case, and it cannot yet express "recall rate across repeats."

## Current State

`src/evals/eval-runner.ts` defines the case/expectation schemas (Zod) and runs each case once.

- `expectationSchema` (around lines 50–101): `id`, `tier` (`required` | `optional`), `path`, `lineRange`, `category`, `severityAtLeast`, `titlePattern` (case-insensitive regex), `failureModePattern` (case-insensitive regex); `superRefine` requires at least one matchable field and compilable regexes.
- `caseSchema` (around lines 103–235): `name`, `repo` (`external` | `fixture`), `command` (`pr`/`branch`/`head`/`base`/`target`), `review` (incl. `budgetBoost`, `verify`, `cache`, `provider`, `model`, `reasoning`), `expect` (count/budget/completeness bounds), `should_find[]`, `should_find_candidate[]`, `should_not_find[]`.
- Suite load (around lines 237–270) reads `*.yaml`/`*.yml` from `--eval-dir`.

`src/evals/eval-scoring.ts`:
- `matchExpectation(expectation, finding, artifacts)` (around lines 90–163): all specified fields must match; path is glob via `picomatch`, severity is rank≥, title/failureMode are regex with a token fallback.
- `attributeLoss(expectation, artifacts)` (around lines 200–229) → `EvalLossDetail` with label from `EvalLossLabel` (`types.ts` around 981–985): `missed-before-candidate-generation` | `lost-at-verification` | `lost-at-composition` | `partial-match`. `exactLossInstances()` (around 231–295) ranks final/selection/verification artifacts; `missedSubReason()` (around 971–1005) explains pre-candidate misses.

`src/evals/eval-artifacts.ts` `loadEvalArtifacts(telemetryDir)` (around lines 35–92) reads `candidate-findings.json` (required), `final-findings.json` (required), and optional `verification.json`, `final-selection.json`, `packets/`, `events.jsonl`, `review-plan.json`, `coverage.json`, plus metrics sources. **It does not read `human-attention-notes.json`,** so a lost finding that resurfaced as a `Needs Human Attention` note (our "NOTE" state) is indistinguishable from a silent miss.

`src/evals/eval-command.ts` runs each case once (around lines 63–70), renders one result line per case (around 132–187), and aggregates loss labels across *cases* (around 258–271). `EvalRunInfo` already carries a `runNumber`, but only for one-to-one compare-to-previous in `eval-compare.ts`.

Repeats / sampling / recall-rate: **absent.** No `repeat`/`samples`/`seed`/`passRate`/`recall` anywhere in the schemas or runner.

Real fixtures live in `evals/fixtures/*.yml` with `repo.fixture: repos/<name>` (`base/` + `feature/` dirs) and use the `fake` provider/model (deterministic; no real-LLM variance). Example `evals/fixtures/go.yml` asserts one `should_find` with `path`/`category`/`severityAtLeast`/`titlePattern`.

## Goal

1. Add first-class **repeat support** to the eval harness: run a case N times and aggregate a **recall rate** (and loss-stage histogram) per expectation, with optional recall-rate thresholds as pass/fail gates.
2. Make the harness see the **NOTE** state: load `human-attention-notes.json` and add a loss sub-outcome `surfaced-as-human-attention-note`, so FINDING / NOTE / MISS map onto loss attribution.
3. Author a precise **Relay wrong-chain regression case** that isolates WC from ZG/DUR using existing multi-field matching, tracking both candidate generation (`should_find_candidate`) and final publication (`should_find`).
4. Retire the throwaway regex analyzer in favor of the harness as the source of truth for recall.

## Non-Goals

- No LLM/semantic judge in scoring. Scoring stays deterministic and reproducible; semantic robustness comes from precise multi-field expectations, not a model.
- No change to any review-pipeline stage behavior (no Stage 7 redundancy here — that is a separate downstream plan that this measurement enables).
- No change to single-run eval semantics when `repeat` is unset/`1`.
- Do not require the external trails-api repo for CI: the portable fixture is the durable target; the external-repo target is for local variance studies only.
- Do not split or aggregate across *cases* differently than today; repeats aggregate within a single case.

## Design

### 1. `repeat` (a.k.a. `samples`) case field + run loop

Add to `caseSchema` (and `EvalCase` in `types.ts`):

```text
repeat: integer >= 1, default 1     # number of independent executions of this case
```

In `eval-command.ts`/`eval-runner.ts`, when `repeat > 1`, execute the case `repeat` times, collecting one `EvalArtifacts` + per-expectation score per execution. Each execution is independent (fresh run dir, e.g. `logs/<case>/<k>/`). `repeat = 1` runs exactly as today and aggregates trivially.

Determinism guard: repeats only produce variance with a real provider and **caching off**. When `repeat > 1`:
- require `review.cache: false` (and `--no-cache` semantics); if cache is enabled, fail the case with a config error explaining repeats need fresh sampling.
- if `provider: fake`, allow it (so harness tests can exercise aggregation) but `log()`/note that variance will be degenerate.

### 2. Recall-rate aggregation + thresholds

For each `should_find` / `should_find_candidate` expectation, aggregate across the `repeat` executions:

```text
finalRecallRate      = (# executions where it matched in final-findings) / repeat
candidateRecallRate  = (# executions where it matched a candidate)       / repeat
noteRate             = (# executions where it was lost but surfaced as a human-attention note) / repeat
lossHistogram        = counts per EvalLossLabel (+ surfaced-as-human-attention-note) across executions
```

Add optional threshold fields to the expectation schema:

```text
minRecallRate:    number 0..1   # gate on finalRecallRate    (optional)
minCandidateRate: number 0..1   # gate on candidateRecallRate (optional)
```

Semantics:
- If a threshold is present, the expectation passes when the corresponding rate `>=` threshold.
- If absent, the expectation is **measured but not gated** (report the rate; do not fail). This is the default posture for a freshly-characterized bug like Relay WC, whose current rate (~0.2) we want to record and ratchet up *after* a redundancy fix, not hard-fail on today.
- Back-compat: with `repeat = 1` and no thresholds, behavior equals today's required/optional pass/fail (rate is 0 or 1).

### 3. NOTE outcome via human-attention-notes

Extend `loadEvalArtifacts` to read `human-attention-notes.json` (optional; root-first with `stages/10-composition/` fallback so it composes with Issue 78's stage-grouped layout). Add a loss sub-outcome:

```text
EvalLossLabel (unchanged set) + a new subReason / outcome flag: "surfaced-as-human-attention-note"
```

When `attributeLoss` determines an expectation was not published as a final finding, also check whether a human-attention note matches the same expectation (reuse `matchExpectation`-style field matching against note path/symbols/text). If so, mark the loss `surfaced-as-human-attention-note` (a *less-bad* loss than a silent drop). This is what distinguishes our NOTE from MISS and is the harness equivalent of the manual taxonomy.

### 4. Relay wrong-chain expectation (isolate WC from ZG/DUR)

Author the expectation using existing multi-field matching so only the wrong-chain bug counts:

```yaml
should_find:
  - id: relay-gas-wrong-chain
    tier: required
    path: lib/routes/relay/relay.go
    lineRange: [80, 100]                 # the EstimateGasCostUSD(req.OriginChainID, ...) call site
    category: logic_bug                  # (logic_bug ↔ correctness compatible)
    severityAtLeast: medium
    titlePattern: "(?i)(origin).*(destination)|destination chain"
    failureModePattern: "(?i)gas.*(origin).*(destination)|priced on .*origin.*destination"
    # minRecallRate omitted on purpose: MEASURE first, ratchet after the Stage 7 redundancy fix
should_find_candidate:
  - id: relay-gas-wrong-chain-candidate
    tier: optional
    path: lib/routes/relay/relay.go
    lineRange: [80, 100]
    category: logic_bug
    titlePattern: "(?i)(origin).*(destination)|destination chain"
should_not_find:
  - id: relay-gas-not-zero-guard           # guard the harness against the ZG look-alike
    path: lib/routes/relay/relay.go
    lineRange: [80, 100]
    titlePattern: "(?i)chain 0|== 0|no rpc provider"
```

Rationale: requiring the **destination** framing in `titlePattern` plus the gas-cost line range excludes ZG (no "destination"; about chain 0) and DUR (different line/category; no gas-cost API). The `should_find_candidate` vs `should_find` split lets the recall report separate *generation* (Stage 7 emitted it) from *confirmation* (survived verification+composition) — exactly the FINDING/NOTE/MISS funnel, now semantic and deterministic.

### 5. Fixture target — two phases

- **Phase 1 (local variance study, immediate):** a case with `repo.external: <trails-api>` pinned to a *committed* ref containing the WC bug (e.g. `command.base: master`, `command.head: <sha>` — do not target a dirty working tree). `repeat: 10`, `review.cache: false`, real provider/model. This is the run-now characterization; it stays out of CI (external absolute path).
- **Phase 2 (portable regression, durable):** snapshot a self-contained fixture `evals/fixtures/repos/relay-wrong-chain/{base,feature}/` carrying enough of `relay.go` and the comparison context (the CCTP/Hyperlane analogs and `EstimateGasCostUSD`) for the bug to be *findable* by a real reviewer, wired into a suite `evals/fixtures/relay.yml`. If a minimal-but-findable repro proves heavy to extract, restrict Phase 2 to a follow-up and keep Phase 1 as the interim (see Stop Conditions).

### 6. Aggregate reporting + retire the regex

- Per repeated case, render one aggregate line: `relay-gas-wrong-chain: finalRecall 2/10 (0.20) | candidate 6/10 | note 3/10 | loss{missed=4, verification=3, composition=0}`.
- Emit a machine-readable aggregate (extend `EvalRunInfo`/`info.json` with a `repeats[]` array and an `aggregate` block, or a sibling `eval-aggregate.json`).
- Once the Relay case reproduces the recall measurement, delete `trails-api/.codegenie/analyze-relay-recall.py`; the harness is the source of truth.

## In-Scope Files

- `src/evals/eval-runner.ts` — `repeat`/`minRecallRate`/`minCandidateRate` schema; multi-execution loop; determinism/cache guard.
- `src/evals/eval-scoring.ts` — per-execution scoring already exists; add cross-execution aggregation (recall rates, loss histogram) and `surfaced-as-human-attention-note` handling.
- `src/evals/eval-artifacts.ts` — load `human-attention-notes.json` (root-first, stage fallback).
- `src/evals/eval-command.ts` — orchestrate repeats; aggregate reporting line + JSON.
- `src/types.ts` — `EvalCase.repeat`, expectation thresholds, aggregate/`repeats` types, note-outcome flag.
- `evals/fixtures/relay.yml` (+ Phase 2 `repos/relay-wrong-chain/`) — the regression case.
- `tests/evals.test.ts` — schema, repeat loop, aggregation, note-outcome, WC/ZG/DUR disambiguation.
- `specs/plans/README.md` — index entry; move Issue 79 into the queue.

## Out of Scope

- Any Stage 7 redundancy/ensemble change (the downstream fix this measures).
- LLM/semantic scoring.
- Cross-case statistical machinery beyond per-case repeats.
- Reorganizing or deleting historical runs.
- Splitting JSONL telemetry streams.

## Implementation Steps

1. Add `repeat` to `caseSchema`/`EvalCase` (default 1) and `minRecallRate`/`minCandidateRate` to `expectationSchema`/`EvalFindingExpectation`; extend `superRefine` to validate ranges.
2. Refactor case execution into "run once → artifacts → per-expectation score", then wrap it in a `repeat` loop writing `logs/<case>/<k>/`.
3. Add the cache/provider determinism guard for `repeat > 1`.
4. Add `human-attention-notes.json` loading to `loadEvalArtifacts` (optional, root-first + `stages/10-composition/` fallback).
5. In `eval-scoring.ts`, add `surfaced-as-human-attention-note` detection inside/after `attributeLoss`, and an aggregation function over per-execution scores → recall rates + loss histogram + note rate.
6. Gate expectations on thresholds when present; otherwise measure-only.
7. Render the aggregate line and persist the aggregate JSON.
8. Author `evals/fixtures/relay.yml` (Phase 1 external-repo, `repeat: 10`, cache off). Add Phase 2 portable fixture if extraction is tractable.
9. Update tests.
10. Delete `analyze-relay-recall.py` once the case reproduces the measurement; update `specs/plans/README.md`.

## Tests

- `repeat` defaults to 1; a `repeat: 1` case scores identically to today (golden).
- A `repeat: N` case with the `fake` provider runs N executions and aggregates N identical results (rate 0 or 1) — exercises the loop/aggregation deterministically.
- Recall-rate math: given crafted per-execution scores (e.g. 2/10 final, 6/10 candidate, 3/10 note), aggregation reports the exact rates and loss histogram.
- Threshold gating: `minRecallRate` passes/fails correctly at the boundary; absent threshold is measure-only (never fails).
- Determinism guard: `repeat > 1` with cache enabled fails as a config error.
- NOTE outcome: a fixture where the expectation is absent from final findings but present in `human-attention-notes.json` yields `surfaced-as-human-attention-note`, not `missed-before-candidate-generation`.
- WC/ZG/DUR disambiguation (the core correctness test): synthetic candidate/final/notes artifacts containing
  - a wrong-chain finding (origin↔destination) → matches `relay-gas-wrong-chain`;
  - a zero-guard finding (`chain 0`) → does NOT match WC and DOES trip `should_not_find` if presented as a finding;
  - a duration finding (`relayFillGasEstimate` token, different line) → does NOT match WC.

## Validation

```bash
pnpm typecheck
pnpm test -- tests/evals.test.ts
pnpm test            # if no focused eval-artifact test file exists
```

Local end-to-end (Phase 1, real model, pinned trails-api ref):

```bash
codegenie eval --eval-dir evals/local   # a local suite holding the external-repo Relay case, repeat: 10
```

Confirm the aggregate reproduces the manual finding (WC final-recall ≈ 0.2; candidate-recall higher; some NOTE), and that ZG/DUR never count as WC.

## Risks and Mitigations

- **Repeats are expensive** (N full real-model reviews). Mitigation: `repeat` defaults to 1; high-N cases live in a local suite, not CI; document approximate cost per repeat in the suite file.
- **Mechanical matching still mis-scores a paraphrase of WC.** Mitigation: combine lineRange + category + dual regex + `should_not_find` for ZG; cover paraphrases in tests; if a real run is visibly mis-scored, tighten the patterns (and record the example) rather than reaching for an LLM judge.
- **Note-matching false positives** (a note about a different relay concern counted as the WC note). Mitigation: reuse the same multi-field matcher (incl. lineRange + destination framing) for note matching, not a bare path check.
- **Determinism guard surprises users.** Mitigation: clear config error message naming `review.cache: false` as the fix.

## Stop Conditions

- If extracting a minimal-but-findable portable fixture (Phase 2) loses the bug's cross-file findability, stop and keep Phase 1 (external pinned ref) as the interim; write the portable fixture as a follow-up with the real run as evidence.
- If `repeat` aggregation tempts scope creep into cross-run statistical tests (confidence intervals, seeds), keep this plan to rate + histogram; defer statistics to a follow-up.

## Future Work

- A Stage 7 redundancy/ensemble plan (best-of-N on deep packets) is the *consumer* of this metric: once recall rate is measurable, that plan can set `minRecallRate` on `relay-gas-wrong-chain` and prove the lift. See memory `stage7-recall-bottleneck`.
- Optional later: a curated multi-bug recall suite (several known true positives across repos) to track recall variance as a release gate.

## Success Criteria

- `codegenie eval` can run a case `repeat: N` times and report per-expectation final/candidate recall rates, a NOTE rate, and a loss histogram.
- The Relay case isolates the wrong-chain bug from the zero-guard and duration look-alikes deterministically.
- The 5-run manual observation (~1/5 final recall) is reproduced by the harness, replacing the regex analyzer.
- Single-run eval behavior is unchanged when `repeat` is unset.
