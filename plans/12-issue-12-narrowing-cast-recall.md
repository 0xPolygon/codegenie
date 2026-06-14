# Issue 12: Narrowing Cast Recall

Status: PENDING

## Problem

Reviewers can notice a concrete narrowing-cast risk but leave it as an unresolved follow-up instead of producing a candidate finding. The general bug class is:

- A raw external value is narrowed with a cast such as `uint8(...)`, `uint16(...)`, or `int32(...)`.
- A previous raw-value validation guard was removed or moved after the cast.
- The new downstream validation checks the already-narrowed value, which may be too late.

This is a recall problem: when changed-line evidence and a deterministic failure mode exist, the packet reviewer should emit a candidate finding and let Stage 9 verify it. It should not remain only as "ask a human" text.

## Plan

1. Add a generic risky-narrowing static signal:
   - Detect changed Go lines containing narrowing casts such as `uint8(...)`, `uint16(...)`, `int8(...)`, `int16(...)`, and `int32(...)`.
   - Prefer cases where the cast input is not a literal and comes from decoded JSON, provider/API data, config, database records, or another boundary value.
   - Raise a static signal when a removed validation function or deleted guard previously checked the raw value.
   - Keep this as a signal, not an automatic finding.
   - Include the changed line, nearby deleted guard if available, and a short explanation.

2. Improve reviewer guidance:
   - Add a Go lens rule:
     - "Validate raw external values before narrowing casts; helper validation after a cast may be too late."
   - Add false-positive guidance:
     - If the source type is already bounded or generated enum-like data, do not publish.
     - If the source is provider/API JSON or untrusted metadata, treat as candidate-worthy when changed code moved validation after the cast.
   - Tell packet reviewers:
     - Do not leave concrete deterministic failure modes as follow-up hints when changed-line evidence exists.
     - Emit a medium-confidence candidate and let Stage 9 verify it.

3. Keep follow-up handling simple:
   - Do not automatically publish or promote follow-up hints.
   - If a static signal supports the issue and the reviewer output is only a follow-up hint, record a telemetry event such as `candidate_recall_missed_signal`.
   - Use that telemetry for evals and prompt tuning, not as an automatic finding path.

4. Add targeted tests/eval coverage:
   - Use a small synthetic fixture where a raw value was validated before a cast and is now cast first.
   - Track both:
     - candidate recall: did Stage 7 emit a candidate?
     - final recall: did Stage 9/10 publish or deliberately reject it with evidence?
   - Ensure the eval fails if the issue only appears as a raw follow-up hint.
   - Existing real-repo evals can include this bug class, but the core regression test should not depend on one repository.

## Likely Files

- `src/skills/bundled/lang-go.md` or equivalent bundled Go lens prompt file
- static signal extraction code, wherever existing Stage 4/6 signals live
- `src/pipeline/lens-runner.ts`
- `src/pipeline/verifier.ts`
- `tests/pipeline-phase6.test.ts`
- `tests/pipeline-phase7.test.ts`
- eval fixture under `evals/`, if current conventions support synthetic AI-eval cases

## Tests

- Go static-signal test for `uint8(externalDecimals)` after deleted raw validation.
- Packet-review fake-runner test proving a supported risky-narrowing signal is present in the packet/reviewer prompt.
- Verifier test proving low-confidence unsupported narrowing concerns remain suppressed.
- Eval/golden test for a generic raw-value narrowing bug.
- Regression test that final output can include the finding when verifier keeps it.

## Acceptance Criteria

- A generic raw-value narrowing-after-validation-removal issue is emitted as a candidate finding in tests/evals.
- Stage 9 verifies or rejects it explicitly; it is not lost as a follow-up hint.
- The change improves a generic class of narrowing-cast review bugs, not one hard-coded case.
- False positives remain controlled by verifier and static-signal evidence.
