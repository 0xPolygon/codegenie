# Issue 80: Degrade-and-Disclose Failure Semantics for LLM Errors

Status: COMPLETE
Completed: 2026-07-02. Implementation notes: the "provider-wide" run-fatal predicate is concretized as `isProviderOutageError` (transient-exhausted `llm_call_failed`) enforced at the planner — the run's opening call — since after any LLM success a provider blip should degrade the unit, not the run. The Stage-7 re-dispatch needed only the classifier fix (pinned by the `badPacketAttempts === 2` test). Composer fallback gate reduced to `isBudgetExhaustedError || isRecoverableLlmError`. Spec ladder table updated to match.
Planned from: fable review D1/bugs 1,7 (`specs/reviews/1-fable-review.md`); eval error runs `0c4d5213/logs/{1,9,16}` and `49f4645b/logs/7` (whole reviews destroyed by one unrecovered submit; run 16 discarded 8 verified findings at the composer), 2026-07-01
Planned at: commit `73ef963` (branch `next`)
Recommended priority: highest of the P0 batch. Small diff, converts the four historical whole-run losses into disclosed partial reviews. Every future eval run carries this exposure until fixed.

## Problem

The spec (review_pipeline.md; functional_spec "Failure And Budget Semantics") prescribes degrade-and-disclose: planner terminal failure → deterministic default plan + degraded-planning disclosure; packet terminal failure → `review_failed` hunks + partial disclosure; run-fatal reserved for auth/provider-wide failures. The code inverts this:

- `isFatalLlmError` (`src/pipeline/pipeline-utils.ts:5-9`) treats **any** `llm_call_failed` / `llm_schema_invalid` (non-budget) as fatal and never consults `recoverable` — verified at current commit.
- `planner.ts:236-237` rethrows fatal LLM errors instead of building the spec'd default plan, so the default-plan fallback is unreachable for LLM failures.
- `lens-runner.ts:88` rethrows any packet-worker `llm_call_failed` (only schema-invalid is exempted), killing the entire run over one packet.
- `canUseComposerFallback` (`composer.ts:625-643`) requires `!coverage.partial && !coverage.budgetStopped && verificationIncompleteCount === 0` when there are zero groups — i.e. it **throws in exactly the budget-stopped partial-run cases where the spec mandates fallback composition**. Run `0c4d5213/9` is this scenario; run 16 is the schema variant.
- The spec'd Stage-7 re-dispatch ("one full re-dispatch after transient or post-repair schema failure") never fires for LLM failures (`worker-runner.ts:110-124` routes through `isRetriableError`, which is `pipeline-utils.ts`'s fatal classification).

Tests pin the current fail-fast behavior (`tests/pipeline-phase5.test.ts:7096` area), so this was a deliberate but undocumented reversal — the fix must update the pinned tests and the spec note together.

## Evidence

4 of the 6 error runs across both eval log directories are unrecovered schema/submit failures aborting whole runs (Stage 7 finalize ×2, Stage 10 composer ×2). One of those discarded 8 verified findings. All four would have been disclosed partial reviews under the spec'd semantics. Separately, runs 43/44 (July 2026 provider-slowness runs) demonstrate that the partial-review path itself works well when it is reachable — the machinery to degrade gracefully already exists; the failure ladder just refuses to route LLM errors into it.

## Goal

Recoverable LLM failures degrade the affected unit (plan, packet, composition) and disclose; only auth/provider-wide failures (and hard timeout) remain run-fatal. The four historical error-run shapes replay as `completed_partial` with correct disclosures.

## Design

1. **`isFatalLlmError` consults recoverability.** Fatal iff the error is `llm_call_failed`/`llm_schema_invalid` **and** (`recoverable === false` or the cause is auth/provider-wide: invalid credentials, permanently unavailable model, provider-wide outage after retry exhaustion). Budget errors keep their existing separate path. Introduce an explicit `isRunFatalLlmError` name so call sites read as policy, not plumbing.
2. **Planner:** on non-run-fatal terminal LLM failure, build the deterministic default plan (the code for it exists and currently runs only for non-LLM errors), set `degradedPlanning: true`, emit the existing degraded-planning disclosure.
3. **Stage 7 packet workers:** non-run-fatal terminal failure marks the packet's hunks `review_failed` (the path used today for budget-skips), records `packet_review_failed` telemetry with the error code, and continues the run. The spec'd single re-dispatch needs **no new wiring** (verified): `lens-runner.ts:71,80` already passes `isRetriableError: isRecoverableWorkerError` with `retryOnTransient: true`; the re-dispatch is dead only because `isRecoverableWorkerError` (`pipeline-utils.ts:27-29`) delegates to `isFatalLlmError`, which classifies every LLM failure fatal. Fixing the classifier (step 1) activates it automatically. Note the interplay: pi-runner already retries transient provider errors internally (`MAX_PROVIDER_ATTEMPTS`), so the worker-level re-dispatch is the one *additional* full-pass retry after provider retries exhaust — exactly the spec'd behavior. Stage 9 keeps `retryOnTransient: false` (`verifier.ts:285`, unchanged).
4. **Composer:** make fallback composition unconditional for non-auth terminal failures — drop the `!coverage.partial && !coverage.budgetStopped && verificationIncompleteCount === 0` clause; a budget-stopped partial run with zero groups falls back to deterministic composition of verified findings (or an empty review with disclosures) rather than throwing.
5. **Disclosure:** each degradation adds its `partialReasons` entry and coverage annotation so the Stage-11/markdown output states what was lost (reuses the run-43/44 partial rendering, including the Issue-80-adjacent budget banner landed 2026-07-01).

## Non-Goals

- Retrying auth failures or masking misconfiguration (those stay fatal and loud).
- Changing budget-stop semantics (already correct).
- Reworking the schema-repair ladder (separate concern; see fable §2.3).

## In-Scope Files

- `src/pipeline/pipeline-utils.ts` — recoverability-aware fatal classification.
- `src/pipeline/planner.ts` — default-plan fallback on terminal LLM failure.
- `src/pipeline/lens-runner.ts` — packet `review_failed` degradation + one re-dispatch via `isRetriableError`.
- `src/pipeline/composer.ts` — unconditional non-auth fallback in `canUseComposerFallback`.
- `src/pipeline/review-runner.ts` — disclosure plumbing if needed.
- `tests/pipeline-phase5.test.ts` (pinned fail-fast tests) + new degradation tests.
- Spec: `specs/project/components/review_pipeline.md` note that code now matches the spec'd ladder.

## Implementation Steps

1. Add `recoverable`-aware classification with explicit auth/provider-wide predicate; rename call-site helper to `isRunFatalLlmError`.
2. Planner fallback: terminal LLM failure → default plan + `degradedPlanning`; telemetry `planner_degraded { errorCode }`.
3. Lens-runner: terminal LLM failure → `review_failed` hunks + continue; enable one transient re-dispatch.
4. Composer: relax fallback gate; fallback records `composition: "deterministic_fallback"` with reason.
5. Replay-style tests reproducing the four error-run shapes (stage-5 submit failure, stage-7 finalize failure ×2, stage-10 composer failure with verified findings) → all complete partial with disclosures; verified findings are never discarded.
6. Negative tests: auth failure and `recoverable: false` still abort the run.

## Validation

- Unit suite green including updated pinned tests.
- Fault-injection eval run (fake runner or injected failure) for each of the four shapes → `completed_partial`, correct `partialReasons`, findings preserved.
- One clean trails-api run → no behavior change on the happy path.

## Done Criteria

- No single recoverable LLM failure can zero out a review; verified findings survive composer failure.
- Auth/config failures still fail fast.
- Spec and tests agree with the implemented ladder.

## Stop Conditions

- If relaxing the composer gate surfaces junk compositions from empty/degraded inputs, constrain the fallback to verified-findings-only rendering rather than reverting to fail-fast.
