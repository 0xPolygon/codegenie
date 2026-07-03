# Issue 90: Token-Denominated Primary Review Budget (`maxBudgetTokens`)

Status: COMPLETE
Completed: 2026-07-02. Default decision history: draft $35≈7.5M → rule-derived 5.85M → rounded to 6M (owner) → **raised to 7,000,000 (owner decision 2026-07-02)** after baseline run `0c4d5213/46` set a new largest observed full review (4,925,828 tokens, within 3.4% of the 6M default's 5.1M soft-stop). 7M = ~42% above largest observed, with headroom for plan 84's ensemble; dispatch soft-stop 5.95M (~21% above run 46). **Watch item: plan 84's ensemble adds packet-review tokens; expect to raise the default (or lean on `--budget-boost`) when it lands, and re-derive from the then-largest observed run.** Rename was a clean break (`maxTotalTokens`/`max_total_tokens` fully removed from src/tests/specs); eval cases can override via `review.maxBudgetTokens`; the value is always visible in `budget-summary.json` configured/effective and `info.json` effectiveConfig.
Planned from: the July 1-2 provider-latency incident and its telemetry (runs `0c4d5213/42` vs `/45`: 4.68M vs 4.61M total tokens for the same review at 12 min vs 53 min wall-clock — the work is latency-invariant, the clock is not) plus the TTFB/rate-limit diagnostics landed 2026-07-02 (p50 50-61s queue wait, decode normal, subscription lane at 23% quota), 2026-07-02
Planned at: commit `16b4c5b` (branch `next`)
Recommended priority: high, before Wave 3 — the baseline evals and all Wave-3 A/Bs should run under work-denominated budgets so provider-lane noise can never again masquerade as a quality change.

## Problem

codegenie's primary review budget is wall-clock time (`review.timeoutMs`, per-pass soft deadlines). Time bounds `work × provider latency`, and provider latency is exogenous noise: the July 1-2 subscription-lane queueing (5-6x, zero 429s, quota at ~20%) converted identical review work into stranded packets, killed finalizes, and eval "regressions" that were pure infrastructure. Waves 1-2 made time pressure degrade-and-disclose instead of silently losing recall, but the budget still measures the wrong thing.

The right primary budget is **work**, denominated in tokens:

- Latency-independent: the run 42/45 pair proves total tokens are stable across a 4.4x wall-clock difference.
- Provider-price-independent: USD is just tokens × a price table, and on subscription OAuth the dollars are nominal anyway.
- Already implemented: `review.maxTotalTokens` exists end-to-end in the budget ladder (reservation, 15% reserved tail, dispatch blocks, overrun records, `budgetStop` fields, `--budget-boost` scaling) — it has simply never been set, and its name does not signal that it is *the* budget.

tokens/sec was considered and rejected as a budget dimension: stopping a run because throughput dropped re-creates the exact pathology just fixed. Throughput stays diagnostic (`ttfbMs`/decode split) and may later drive adaptive concurrency.

## Goal

1. Rename `review.maxTotalTokens` → `review.maxBudgetTokens` (clean break, repo convention per the `budgetMultiplier` → `budgetBoost` precedent; the old key has never been set anywhere, so there is nothing to migrate).
2. Give it a **default**: `7_500_000` tokens ≈ $35 at the observed opus-4-8 blended rate (~$4.7/M with cache-write-heavy traffic; runs 42/45 cost $21-23 at 4.6-4.7M). The full-size trails case uses ~4.7M, so the default never binds on legitimate work — it is a runaway ceiling, not a target. Document the $-to-token basis so it can be revisited when the model or pricing changes.
3. Demote time to a hang-guard in posture (no numeric change in this plan): `timeoutMs` keeps its 30-min default for interactive UX; eval cases already override to 60. The spec text should say which budget owns which job.
4. Expose `maxBudgetTokens` in the eval case `review:` block (config-layer only today) so cases can tighten or loosen it explicitly.

## Design

- `review.maxBudgetTokens?: number` in user config schema, resolved config, config-loader source tracking, and `CodegenieConfig` — with `defaultConfig.review.maxBudgetTokens = 7_500_000`.
- Internal rename: `effectiveMaxTotalTokens` → `effectiveMaxBudgetTokens`; `BudgetStop.maxTotalTokens` → `maxBudgetTokens` (stop records are telemetry-facing; coherence wins over artifact-shape stability — no tooling reads the field today because it was never set).
- Budget-stop reason string `max_total_tokens` → `max_budget_tokens`; the incomplete-review banner names the config key `review.maxBudgetTokens`.
- `--budget-boost` continues to scale it (`scaleOptionalBudgetValue`, unchanged).
- Eval case schema: `review.maxBudgetTokens: positiveIntSchema.optional()` mapped in `applyCaseReviewConfig`; surfaced in `effectiveConfig.review` in `info.json` alongside `timeoutMs`.
- Reserved-tail semantics unchanged: dispatch soft-stops at 85% (6.375M at the default), reserving the tail for verification/composition — comfortably above the ~4.7M a full large-case review needs.
- Spec updates: architecture defaults list, functional spec / review_pipeline budget wording ("tokens are the primary coverage budget; time is a hang-guard").

## Non-Goals

- A USD-denominated budget (tokens is the invariant; dollars are derived and price-coupled).
- tokens/sec enforcement or latency-adaptive concurrency (separate, later; diagnostics already landed).
- Changing `timeoutMs`/`perPassTimeoutMs` numbers or semantics (Wave-1 work, already done).
- Size-aware (per-diff-scaled) token budgets — a fixed protective ceiling is sufficient until evidence says otherwise.

## In-Scope Files

- `src/config/schema.ts`, `src/config/config-loader.ts` — key rename + default + source tracking.
- `src/types.ts` — config type, `BudgetStop`/`BudgetStopReason`, eval case review block.
- `src/pipeline/review-runner.ts` — budget ladder rename; budget-summary `configured`/`effective` keys.
- `src/output/markdown-renderer.ts` — banner wording.
- `src/evals/eval-runner.ts` — eval case schema + apply + effectiveConfig.
- `tests/pipeline-phase5.test.ts`, `tests/config-loader.test.ts`, `tests/evals.test.ts` — renames + a default-binding test.
- Specs: `architecture.md`, `functional_spec.md`, `components/review_pipeline.md`.

## Implementation Steps

1. Mechanical rename across src/tests (clean break; no alias).
2. Set the default; add a `budget_configured`-visible record: the budget summary's `configured`/`effective` blocks now always include `maxBudgetTokens`.
3. Eval case exposure + `effectiveConfig` surfacing.
4. Tests: default resolves to 7.5M; a run whose usage crosses the (test-sized) budget soft-stops with `max_budget_tokens` and discloses via the banner; `--budget-boost 2` doubles it; eval case override applies.
5. Spec text updates.

## Validation

- Full suite + typecheck green.
- One user-run eval on each trails case (the post-plan manual baseline runs) shows `maxBudgetTokens: 7500000` in `budget-summary.json` `configured`/`effective` with no dispatch blocks — the ceiling present but not binding.

## Done Criteria

- `review.maxBudgetTokens` defaulted, documented, boost-scaled, eval-overridable, and disclosed in the banner when it stops a run.
- No occurrence of `maxTotalTokens`/`max_total_tokens` remains in src/tests.
- Specs state the budget-role split: tokens = coverage budget, time = hang-guard.

## Stop Conditions

- If the default ever binds on a legitimate (non-runaway) review in practice, raise the default or introduce size-awareness — never let the token ceiling silently shrink coverage the way time budgets did.
