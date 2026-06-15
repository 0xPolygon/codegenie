# Issue 23: Evidence-Aware Verification Recall

Status: COMPLETE
Planned from: trails-api eval run 3, 2026-06-15

## Problem

The latest eval shows that Stage 7 candidate discovery is good enough for the known misses, but Stage 9 is losing too much recall before final composition:

- The routing explicit-preference behavior change was found as a high-confidence candidate, then rejected because same-PR tests asserted the new behavior.
- The AmountFromUSD zero-decimal regression was found with concrete changed-line evidence, but it was suppressed before LLM verification because the packet reviewer marked it low confidence after one unresolved evidence check.
- The zero-native-price behavior change was also found as a low-confidence candidate, but it was suppressed before verification and did not match the eval's expected file path.

Compared with eval run 2, run 3 was faster and cheaper, but worse on final recall:

- final findings dropped from 5 to 2
- verification calls dropped from 34 to 18
- rejected repository-tool calls increased from 15 to 47
- degraded repository-tool results increased from 38 to 82
- the same AmountFromUSD zero-decimal candidate dropped from medium confidence in run 2 to low confidence in run 3

This is not primarily a Stage 6 packet construction problem. It is a Stage 9 policy problem with a Stage 7 confidence-calibration side effect: low-confidence is currently treated as a hard suppressor, and the verifier can over-weight same-PR tests as proof that a semantic behavior change is acceptable.

The fix should improve general review quality without publishing speculative findings or overfitting to one eval.

## Plan

1. Re-review the recently completed verification-related plans:
   - Plan 07 fixed verification degradation, but did not cover evidence-backed low-confidence candidates that should still be verified.
   - Plan 20 reduced duplicate verifier work, but the reduced verifier call count in run 3 shows we should spend some of those savings on high-value low-confidence candidates.
   - Plan 21 added targeted cross-system review, but unresolved follow-up hints should not be the only path for concrete changed-line behavior regressions.
   - Plan 14/05 should be checked only narrowly for whether the current tool budget is downgrading candidate confidence too aggressively.

2. Split the Stage 9 low-confidence gate into evidence-aware outcomes:
   - Continue suppressing low-confidence candidates with no changed-line anchor, no concrete changed code, no related code, or style/nit categories.
   - Schedule verification for low-confidence correctness/security candidates when they have a changed-line anchor plus a concrete failure mode and at least one related-code evidence item.
   - Record the gate decision as `suppressed`, `scheduled`, or `scheduled_for_evidence_resolution` with a precise reason.

3. Add a bounded evidence-resolution lane:
   - Reserve a small verification budget for low-confidence but evidence-backed correctness candidates after higher-priority candidates are scheduled.
   - Keep this lane capped, for example 2-4 candidates or a small percentage of the verification budget.
   - Give the verifier the candidate's explicit missing-evidence question when available.
   - If the verifier cannot resolve the missing predicate, reject or suppress with `evidence_unresolved`; do not publish by default.

4. Refine Stage 7 confidence calibration:
   - Do not downgrade a candidate to low confidence solely because one supporting symbol lookup or range read hit a tool budget limit, if the changed-line evidence and failure mode are concrete.
   - If the reviewer cannot resolve a narrow missing predicate, keep the candidate at medium confidence when the missing predicate is verifier-resolvable and the impact would be correctness/security relevant.
   - Preserve low confidence for candidates whose reachability depends on speculative inputs, ambiguous product behavior, or weak path matching.
   - Record `confidenceReason` or equivalent debug metadata when practical, so eval/debug artifacts can explain why a candidate was downgraded.

5. Refine verifier guidance for semantic changes inside refactors:
   - Same-PR tests that assert new behavior are evidence that behavior changed, not automatic proof that the change is safe.
   - If PR intent says refactor, cleanup, consolidation, behavior-preserving, or similar, the verifier should compare base vs head behavior and treat material semantic changes as potentially actionable even when new tests document them.
   - If the change is clearly an intentional product decision and the PR text/spec explicitly says so, reject or revise the candidate accordingly.
   - If product intent is ambiguous but the behavior change can break callers, keep or revise the finding with precise framing rather than rejecting solely because tests exist.

6. Preserve conservative final output:
   - Verification still owns the keep/reject decision.
   - Do not publish unverified low-confidence findings.
   - Do not increase final comment caps.
   - Prefer a verified finding over a human-attention note when the failure mode is concrete.

7. Improve telemetry and eval diagnostics:
   - Count low-confidence candidates that were suppressed, evidence-scheduled, verified, kept, and rejected.
   - Include gate reason, candidate severity/category, changed-line status, and evidence presence in Stage 9 telemetry.
   - Include candidate confidence changes and degraded/rejected tool counts by packet where practical.
   - Make eval loss attribution distinguish `low-confidence-pre-gate-suppressed` from `evidence-resolution-rejected`.

8. Add focused tests:
   - Low-confidence correctness candidate with changed-line anchor, changed code, related code, and concrete failure mode is scheduled for verification.
   - Low-confidence candidate without evidence remains suppressed.
   - Medium-confidence candidate is not downgraded only because an optional supporting lookup hit a tool budget limit.
   - Same-PR tests do not cause verifier prompt guidance to reject semantic behavior changes automatically.
   - Evidence-resolution lane respects a strict budget cap and records unscheduled candidates explicitly.
   - Final composition still publishes only verified findings.

## Likely Files

- `src/pipeline/verifier.ts`
- `src/pipeline/composer.ts`
- `src/skills/prompt-builder.ts`
- `src/types.ts`
- `src/evals/eval-scoring.ts`
- `src/telemetry/telemetry-recorder.ts`
- `tests/pipeline-phase7.test.ts`
- `tests/pipeline-phase8.test.ts`
- `tests/evals.test.ts`

## Acceptance Criteria

- Evidence-backed low-confidence correctness/security candidates can reach LLM verification under a bounded budget.
- Weak low-confidence candidates are still suppressed deterministically.
- The verifier no longer rejects a base-vs-head semantic behavior change solely because same-PR tests assert the new behavior.
- Stage 9 telemetry clearly explains every low-confidence candidate outcome.
- The change improves recall for behavior-changing refactors generally, without adding project-specific rules for trails-api.
