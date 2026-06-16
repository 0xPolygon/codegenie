# Issue 45: Provider Overload Retry and Composer Fallback

Status: PENDING
Planned from: trails-api eval run 9 compose failure, 2026-06-16
Recommended priority: high reliability item; implement after or alongside Issue 44

## Problem

Run 9 completed Stages 1-9 and had verified findings, but the whole eval errored in Stage 10 because Anthropic returned `overloaded_error` twice during final composition.

The retry path is weaker than it looks:

- `MAX_PROVIDER_ATTEMPTS` is 4.
- The Stage 10 model-call records show only attempts 1 and 2.
- Anthropic returned an error message with `type: "overloaded_error"` but no parsed HTTP status.
- `isRetryableProviderError` retries status-coded 429/5xx errors, network errors, or an unknown error only on attempt 1.
- Therefore a structured provider overload without HTTP status stops after attempt 2, even though more attempts are configured.

This is a reliability issue, not a review-quality issue. It should not be mixed into Stage 7 recall tuning.

## Goals

- Retry known transient provider overload/rate-limit/server errors for all configured attempts.
- Preserve fail-fast behavior for authentication, permission, schema, and user-abort failures.
- Avoid losing an otherwise complete review when Stage 10 composition is the only failed step.
- Keep the fallback simple and auditable.

## Non-Goals

- Do not hide provider instability in telemetry.
- Do not publish unverified candidate findings.
- Do not retry indefinitely.
- Do not make provider-specific logic leak across the whole pipeline; keep provider-string detection narrow and tested.
- Do not change Stage 7/Stage 9 review policy in this plan.

## Plan

1. Harden transient provider retry classification.
   - In `src/llm/pi-runner.ts`, teach retry classification to recognize provider-message transient strings such as:
     - `overloaded_error`
     - `overloaded`
     - `rate_limit`
     - `temporarily unavailable`
     - `server error`
   - Apply this across all configured attempts, not only attempt 1.
   - Continue to honor HTTP 429/5xx and `Retry-After` behavior.
   - Keep auth/permission errors non-retryable.

2. Add retry telemetry clarity.
   - Emit/record enough model-call metadata to show:
     - retryable reason,
     - attempt number,
     - configured max attempts,
     - final exhausted transient reason.
   - Preserve the existing model-call records; do not create noisy duplicate artifacts.

3. Add a deterministic composer fallback for verified findings.
   - If Stage 10 LLM composition fails with a recoverable transient error and there are verified findings, produce a simple deterministic review from verified findings instead of failing the entire run.
   - The fallback should:
     - include verified findings in ranked order using existing fields,
     - include a short warning that LLM composition failed and deterministic fallback formatting was used,
     - preserve inline anchor data and final-finding JSON,
     - mark composition mode in telemetry, e.g. `compositionMode: "deterministic_fallback"`.
   - If there are no verified findings, return the existing recoverable error or a deterministic no-findings report only if earlier stages completed cleanly.

4. Keep eval scoring honest.
   - Eval should score fallback-composed verified findings normally, because the findings were already verified.
   - Eval/run metadata should expose that composition used fallback, so we can track provider instability separately from review quality.

5. Add tests.
   - `overloaded_error` without HTTP status retries through the configured attempt count.
   - Auth errors do not retry.
   - Stage 10 transient failure with verified findings uses deterministic fallback and does not drop findings.
   - Stage 10 fallback telemetry is present.
   - Stage 10 non-transient/schema failures still fail.

## Likely Files

- `src/llm/pi-runner.ts`
- `src/pipeline/composer.ts`
- `src/telemetry/run-artifacts.ts`
- `src/types.ts`
- `src/evals/eval-runner.ts` or eval scoring only if fallback status needs explicit handling
- `tests/phase4-llm.test.ts`
- `tests/pipeline-phase5.test.ts`

## Acceptance Criteria

- Anthropic-style `overloaded_error` receives all configured retry attempts unless the run is aborted.
- Stage 10 transient provider overload does not erase verified findings.
- Fallback output is clearly marked in telemetry and user-facing metadata.
- Verified findings remain the only findings that can be rendered by fallback.
- Unit tests cover retry classification and composer fallback.

## Validation

- Run focused LLM runner and composer tests.
- Run full test suite and build.
- Re-run the trails-api eval after Issue 44 with provider concurrency controlled.
- A provider overload during Stage 10 should be reported as a fallback composition event, not as `0` findings from a failed run.
