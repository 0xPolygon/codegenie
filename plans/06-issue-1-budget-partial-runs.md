# Issue 1: Budget And Partial Runs

## Problem

The real run exhausted budget before all packets were dispatched. It reviewed 121/131 hunks, left 10 hunks unreviewed, verified only part of the candidate set, and used fallback composition. `run.json` still reported `status: completed` and `exitCode: 0`.

Partial review is an acceptable product behavior, but it must be explicit, predictable, and easy to act on.

## Plan

1. Introduce a first-class run outcome:
   - `completed_full`
   - `completed_partial`
   - `failed`
   - Preserve CLI exit `0` for partial review unless CI-strict mode is added, but make the status unambiguous in artifacts.

2. Improve budget ladder accounting:
   - Track why budget stopped:
     - `runtime_reserved_tail`
     - `max_model_calls`
     - `max_total_tokens`
     - `hard_timeout`
   - Include remaining budget estimates at stop time.

3. Reserve by all dimensions:
   - Runtime reserve already exists.
   - Add model-call reserve for Stage 9/10.
   - Add token reserve enforcement that accounts for cache tokens clearly.

4. Improve final report language:
   - Replace generic `Reviewed 121/131 hunks` with:
     - `Partial review: 10 hunks were not reviewed because budget was exhausted before dispatch.`
   - List unreviewed files concisely, grouped by path.
   - Do not mix budget stop with planner/default coverage noise.

5. Add user controls:
   - Document how to avoid partial runs:
     - `--depth light`
     - higher timeout/model-call budget
     - narrower target range
     - cache enabled during repeated evals.
   - Add optional `--fail-on-partial` later if needed for CI.

## Tests

- Budget exhaustion during Stage 7 produces `completed_partial` and grouped unreviewed hunks.
- Partial review still writes final artifacts and exits 0 by default.
- `--fail-on-partial` test if implemented.
- Budget stop reason appears in `coverage.json`, `telemetry.json`, `run.json`, and final Markdown.

## Acceptance Criteria

- Users can immediately tell whether a review is full or partial.
- Partial status cannot be mistaken for a full staff-level review.
- Budget stops preserve completed work while clearly identifying missing coverage.
