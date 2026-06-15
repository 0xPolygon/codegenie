# Issue 26: Budget Completion, Overrun Telemetry, and Budget Multiplier

Status: PENDING
Planned from: budget/completeness review after plan 25, 2026-06-15

## Problem

codeninja already tracks token usage, model calls, coverage, budget stops, and partial review status. It also already avoids silent coverage gaps: unreviewed hunks, failed packet reviews, incomplete verification, and budget stops are disclosed.

However, the budget model is still too coarse for high-quality large reviews:

- A budget should guide dispatch and accounting, but should not cut off an already-running LLM response midway. Interrupting an in-flight review can lose useful work and create confusing failure modes.
- The final report does not yet summarize total token usage, model calls by stage, or how often work crossed configured budgets.
- The budget ledger records a single stop snapshot, but does not distinguish pre-dispatch budget blocks from post-call budget overruns.
- Operators need a simple way to scale review budget up or down per repo or run, without manually editing every internal stage/tool budget.
- Eval and review output should make "complete" vs "partial" review status obvious and tied to concrete budget/coverage facts.
- Eval runs should be able to assert whether a review was complete or partial, how many budget overruns are acceptable, and whether a per-eval budget multiplier should be used.

The goal is more complete reviews without making cost invisible. Budgets should be explicit, scalable, and auditable.

## Principles

1. Do not interrupt in-flight LLM calls only because a soft token/model-call budget was crossed.
2. Check budgets before dispatching new work.
3. Record actual usage after every call, including post-call overruns.
4. Stop dispatching non-essential future work after budget exhaustion, while preserving final verification/composition/reporting where possible.
5. Report whether the review is complete or partial based on coverage and dispatch outcomes, not merely because a final call crossed a budget after it was already dispatched.
6. Keep hard timeout behavior separate; hard timeout may still abort the run.

## Plan

1. Add a configurable budget multiplier.
   - Add `review.budgetMultiplier` to config.
   - Accept any finite number greater than `0`.
   - Examples:
     - `2` doubles budgets.
     - `1.5` raises budgets by 50%.
     - `0.1` lowers budgets to 10% of defaults.
     - `100` is allowed, but should be visible in telemetry/logging.
   - Apply the multiplier to internal stage budgets: packet tool budgets, verifier/system-review tool budgets, evidence-resolution lanes, promotion lanes, and estimates used for budget reservations.
   - Apply it to configured run caps such as `review.maxTotalTokens` and `review.maxModelCalls` only if those caps are present and are intended as soft review budgets.
   - Do not apply it to output caps such as `maxFindings` or `softCommentCap`.

2. Make budget checks dispatch-oriented.
   - Keep `checkpoint` and `reserve` before dispatching new model work.
   - Allow an already-started model call to finish unless hard timeout or external abort fires.
   - After each model call, record actual usage and detect whether the call crossed `maxTotalTokens` or `maxModelCalls`.
   - Once a budget is crossed, mark the run budget as exhausted so later non-essential work is not dispatched.
   - Do not discard or suppress results from the call that crossed the budget solely because it crossed after dispatch.

3. Track budget overruns explicitly.
   - Add budget ledger counters for:
     - pre-dispatch blocks by stage/reason
     - post-call overruns by stage/reason
     - total model calls at first overrun
     - total tokens at first overrun
     - final total tokens/model calls
   - Emit telemetry events such as `budget_overrun` and `budget_dispatch_blocked`.
   - Include stage, reason, actual, limit, and whether the overrun happened after a dispatched call completed.

4. Improve final coverage/report language.
   - If all review packets were reviewed and verification/composition completed, headline should say a complete review happened, even if a final dispatched call exceeded budget afterward.
   - If budget exhaustion prevented packet review, system review, verification, or composition dispatch, headline should say partial review and name the blocked work.
   - Include a compact budget summary near the bottom of stdout/final markdown:
     - total tokens
     - model calls
     - cost when known
     - budget overruns by stage
     - budget dispatch blocks by stage
   - Avoid noisy output when no budget caps are configured and no overrun occurred.

5. Persist budget summary artifacts.
   - Add a structured `budget-summary.json` or extend run summary artifacts with:
     - configured caps
     - effective caps after multiplier
     - multiplier and config source
     - usage totals
     - by-stage usage
     - overruns
     - blocked dispatches
   - Keep model-call telemetry as the source of truth for raw token/cost data.
   - Keep coverage artifacts as the source of truth for reviewed/skipped/failed hunks.

6. Update eval budget output wording.
   - For minimum checks, render failures as `actual < minimum`.
   - For maximum checks, render failures as `actual > maximum`.
   - Preserve stage labels where relevant.
   - Add tests for `minFindings`, `maxFindings`, and metric budget output.

7. Add eval assertions for completeness and budget overruns.
   - Persist review completeness in eval artifacts using the same status as final review output, for example `complete` or `partial`.
   - Include the concrete reasons when a review is partial: blocked packet review, blocked verification, blocked composition, timeout, failed packet count, or skipped work.
   - Add an eval expectation for completeness, for example:
     - `reviewCompleteness: complete`
     - `reviewCompleteness: partial`
   - Add an eval expectation for allowed budget overruns. Prefer a clear name such as `maxBudgetOverruns`; this is the count threshold for budget crossings.
   - Treat `maxBudgetOverruns: 0` as "no budget overruns allowed"; this is the normal setting for evals expected to be complete within budget.
   - Fail the eval when actual budget overruns exceed the configured threshold.
   - Always print observed completeness and overrun count in eval summaries, even when no threshold is configured.

8. Allow per-eval budget scaling.
   - Allow eval YAML to pass `budgetMultiplier` through the review options for a case or suite.
   - The eval override should behave exactly like `review.budgetMultiplier` in normal config.
   - Record the multiplier in eval logs and budget summary so comparisons remain interpretable.
   - Do not hide cost changes: summaries should include effective caps and actual token/model-call usage.

9. Document budget configuration.
   - Update README config example with `budgetMultiplier`.
   - Explain that the multiplier changes review effort/cost and that high values can be expensive.
   - Document that budget caps are dispatch controls, not mid-call interrupts.
   - Document eval fields for expected completeness, budget overrun threshold, and per-eval `budgetMultiplier`.

## Likely Files

- `src/config/schema.ts`
- `src/config/config-loader.ts`
- `src/types.ts`
- `src/pipeline/review-runner.ts`
- `src/pipeline/packet-builder.ts`
- `src/pipeline/verifier.ts`
- `src/pipeline/system-reviewer.ts`
- `src/pipeline/composer.ts`
- `src/telemetry/run-artifacts.ts`
- `src/util/coverage-summary.ts`
- `src/output/markdown-renderer.ts`
- `src/output/stdout-renderer.ts`
- `src/evals/eval-command.ts`
- `src/evals/eval-scoring.ts`
- `src/evals/eval-types.ts`
- `README.md`
- `tests/config-loader.test.ts`
- `tests/pipeline-phase5.test.ts`
- `tests/telemetry.test.ts`
- `tests/evals.test.ts`

## Acceptance Criteria

- `review.budgetMultiplier` accepts any finite number `> 0` and scales review-stage budgets consistently.
- Budget caps prevent future dispatch but do not interrupt already-running LLM calls except for hard timeout or explicit abort.
- Post-call budget overruns are counted and reported by stage.
- Pre-dispatch budget blocks are counted and reported by stage.
- Final review output clearly distinguishes complete review from partial review.
- Final review output includes compact budget usage only when useful.
- Telemetry persists configured/effective budget caps, usage totals, overruns, and dispatch blocks.
- Eval summaries show review completeness and budget overrun count for every run.
- Eval YAML can assert expected review completeness.
- Eval YAML can fail runs whose budget overrun count exceeds a configured threshold, including `0`.
- Eval YAML can pass a per-case or per-suite `budgetMultiplier`.
- Eval budget failures render directionally correct wording, including `minFindings: 3 < 4`.
- Tests cover multiplier parsing, budget overrun accounting, partial/complete wording, eval budget rendering, and eval completeness/overrun assertions.
