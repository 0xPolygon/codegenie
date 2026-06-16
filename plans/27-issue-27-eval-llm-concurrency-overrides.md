# Issue 27: Eval LLM Concurrency Overrides

Status: COMPLETE
Planned from: trails-api eval run 5 review, 2026-06-15
Planned at: commit `db41ed7`

## Problem

Eval run 5 used the default concurrency settings:

- `review.concurrency = 4`
- `llm.maxConcurrentCalls = 4`

Stage 7 and Stage 9 already schedule packet/verifier workers with `config.review.concurrency`, so packet review is parallelized. However, an eval YAML case can currently set `review.concurrency` but cannot directly set `llm.maxConcurrentCalls`. If an eval case sets only `review.concurrency: 6`, codeninja can queue six workers, but provider calls can still be capped at the default four concurrent calls.

This makes eval tuning confusing. Operators should be able to make a high-cost eval faster by setting both workflow concurrency and provider-call concurrency in the eval case, while keeping defaults conservative for normal users.

## Current State

- `src/config/schema.ts:195` defaults `review.concurrency` to `4`.
- `src/config/schema.ts:207-208` defaults `llm.maxConcurrentCalls` to `4`.
- `src/pipeline/lens-runner.ts:40-42` uses `config.review.concurrency` for Stage 7 packet workers.
- `src/pipeline/verifier.ts:257-259` uses `config.review.concurrency` for Stage 9 verifier workers.
- `src/evals/eval-runner.ts:119-133` allows eval YAML fields such as `review.concurrency`, `review.provider`, `review.model`, and `review.reasoning`.
- `src/evals/eval-runner.ts:624-625` applies `review.concurrency` to `config.review.concurrency`.
- There is no eval YAML field that applies to `config.llm.maxConcurrentCalls`.

## Plan

1. Add an eval-case `llm` configuration block.
   - Extend the eval case schema in `src/evals/eval-runner.ts` with:
     - `llm.provider?: string`
     - `llm.model?: string`
     - `llm.reasoning?: reasoningLevelSchema`
     - `llm.maxConcurrentCalls?: positiveIntSchema`
   - Keep existing `review.provider`, `review.model`, and `review.reasoning` working for backward compatibility.
   - Prefer the new `llm` block when both old and new fields are present.

2. Apply the eval LLM override.
   - In `applyCaseReviewConfig`, copy `evalCase.llm.maxConcurrentCalls` to `config.llm.maxConcurrentCalls`.
   - Also copy provider/model/reasoning from the new `llm` block.
   - Preserve existing behavior for `review.provider`, `review.model`, and `review.reasoning`.
   - Do not change normal repo config semantics.

3. Persist concurrency settings in eval artifacts.
   - Add `review.concurrency` and `llm.maxConcurrentCalls` to `info.json` or `run.json` snapshots if they are not already present.
   - Ensure operators can confirm whether a run used workflow concurrency 6 and provider concurrency 6 from artifacts without reading config internals.

4. Update docs and examples.
   - Update README eval examples to show:
     ```yaml
     review:
       concurrency: 6
     llm:
       maxConcurrentCalls: 6
     ```
   - Explain that `review.concurrency` controls codeninja workers and `llm.maxConcurrentCalls` controls simultaneous provider calls.
   - Note that increasing both can be faster but may hit provider rate limits or increase burst cost.

5. Add tests.
   - Add an eval schema/config test proving `llm.maxConcurrentCalls: 6` is accepted and applied.
   - Add a backward-compatibility test proving `review.provider/model/reasoning` still works.
   - Add a precedence test if both blocks are present: `llm.*` wins for LLM config.
   - Add a rejection test for `llm.maxConcurrentCalls: 0`.

## Likely Files

- `src/evals/eval-runner.ts`
- `src/evals/eval-artifacts.ts`
- `src/types.ts`
- `README.md`
- `tests/evals.test.ts`
- `tests/config-loader.test.ts` only if shared config types need coverage

## Acceptance Criteria

- Eval YAML can set both `review.concurrency` and `llm.maxConcurrentCalls`.
- Setting `review.concurrency: 6` and `llm.maxConcurrentCalls: 6` results in Stage 7/9 workers and provider calls both being allowed to run up to six concurrent calls.
- Existing eval YAML using `review.provider`, `review.model`, or `review.reasoning` still passes.
- Eval artifacts record the effective workflow concurrency and provider-call concurrency.
- README explains the two concurrency knobs clearly.
- The solution is generic and does not mention or hard-code trails-api.
