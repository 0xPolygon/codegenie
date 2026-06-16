# Issue 38: Eval and Runtime Concurrency Tuning

Status: PENDING
Planned from: trails-api eval run 6 review and Opus 4.8 notes, 2026-06-16
Planned at: commit `506fa43`

## Problem

Higher concurrency is a good wall-clock speed lever for large reviews and evals, but it does not reduce model-call count, token use, or cost. Opus 4.8 suggested raising eval concurrency from 4 to 8 could reduce runtime substantially because Stage 7 and Stage 9 are highly parallel.

This should be treated as runtime/eval tuning, not as a core quality fix.

## Current State

Relevant files:

- `src/config/schema.ts` defines default `review.concurrency` and `llm.maxConcurrentCalls`.
- `src/evals/eval-runner.ts` applies eval YAML overrides.
- `README.md` documents high-cost eval concurrency settings.
- `tests/evals.test.ts` verifies eval concurrency override behavior.

Current default and documentation:

```ts
// src/config/schema.ts currently defaults both to 4
review: { concurrency: 4, ... }
llm: { maxConcurrentCalls: 4, ... }
```

Current eval override path:

```ts
// src/evals/eval-runner.ts:644-675
if (review?.concurrency !== undefined) {
  config.review.concurrency = review.concurrency;
}
...
if (llm?.maxConcurrentCalls !== undefined) {
  config.llm.maxConcurrentCalls = llm.maxConcurrentCalls;
}
```

README already shows the intended knobs:

```toml
[review]
concurrency = 6

[llm]
maxConcurrentCalls = 6
```

## Plan

1. Keep product defaults conservative.
   - Do not globally raise the default from 4 to 8 without broader provider-rate-limit evidence.
   - The normal CLI default should remain safe for common provider limits and developer laptops.
   - Treat higher values as explicit eval/runtime tuning.

2. Add a run/eval tuning guide.
   - Update README or a dedicated eval docs section with a clear explanation:
     - `review.concurrency` controls packet/verifier worker scheduling.
     - `llm.maxConcurrentCalls` controls simultaneous provider calls.
     - For eval speed, set both to the same value unless intentionally throttling provider calls.
     - 6 is a reasonable first high-throughput value.
     - 8 is worth trying if provider limits allow it.
   - State explicitly that higher concurrency can lower wall-clock time but not token/cost totals.

3. Add a runtime warning for mismatched concurrency when useful.
   - If `review.concurrency > llm.maxConcurrentCalls`, many workers may sit waiting on provider slots.
   - Emit an info or debug telemetry event at run start:
     - `concurrency_mismatch`
     - review concurrency
     - provider concurrency
     - likely effect
   - Do not fail the run. Mismatches can be intentional.

4. Make eval output expose effective concurrency clearly.
   - `evalEffectiveConfig` already records `review.concurrency` and `llm.maxConcurrentCalls`.
   - Ensure run summaries and eval CLI output include both values when debug/stats are enabled.
   - If already present, do not duplicate fields. Add a regression test only.

5. Tune private eval configs outside the source repo.
   - For the trails-api private eval, use:
     - `review.concurrency: 6` or `8`
     - `llm.maxConcurrentCalls: 6` or `8`
   - Prefer 6 first if provider rate limits are uncertain.
   - Compare against run 6:
     - wall-clock time
     - provider errors/rate-limit retries
     - cost
     - final recall
   - If rate limits or transient errors increase, reduce provider concurrency first.

6. Add tests if source changes are made.
   - Eval YAML applies both concurrency settings.
   - Effective config records both settings.
   - Mismatch warning is emitted when `review.concurrency > llm.maxConcurrentCalls`.
   - No warning or a lower-level note is emitted when `review.concurrency === llm.maxConcurrentCalls`.

## Opus 4.8 Comparison

This plan agrees with Opus's speed finding but keeps the scope narrow:

- raising concurrency can reduce wall-clock runtime.
- it is not a cost-efficiency fix.
- it should be tuned per eval/provider, not hard-coded as a universal default.

## Likely Files

- `README.md`
- `src/evals/eval-runner.ts`
- `src/telemetry/run-artifacts.ts`
- `tests/evals.test.ts`
- private eval YAML outside this repo, if the operator chooses to tune a specific eval

## Verification Commands

- `pnpm test -- tests/evals.test.ts`
- `pnpm test -- tests/telemetry.test.ts`
- `pnpm run build`

Expected result: all commands exit 0.

## Acceptance Criteria

- The docs explain concurrency vs provider-call concurrency clearly.
- Effective eval/run artifacts expose both values.
- A useful telemetry warning exists for likely-unintentional mismatches.
- Defaults remain conservative unless a later benchmark justifies changing them.
- Private eval configs can use 6/6 or 8/8 without source changes.

## Stop Conditions

- Stop if the change starts altering model-call budgets, cost caps, or review quality policy.
- Stop if the only way to tune concurrency is to change global defaults.
- Stop if provider rate-limit behavior becomes worse in eval runs.
