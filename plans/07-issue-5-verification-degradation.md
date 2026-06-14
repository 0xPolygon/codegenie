# Issue 5: Verification Degradation

## Problem

The run generated 13 candidates, suppressed 2 low-confidence candidates, scheduled 11 for verification, but only fully verified 4. Six candidates became incomplete/not-dispatched and one verifier call returned schema invalid with no repair attempt recorded.

Verification is the main quality gate. Candidate loss here should be rare, explicit, and recoverable where possible.

## Plan

1. Strengthen Stage 9 budget reservation:
   - Reserve model calls, not only runtime/tokens.
   - Estimate verifier calls as `candidateCount * expectedCallsPerCandidate`.
   - If reserve is insufficient, verify highest-severity/highest-confidence candidates first and record deterministic suppression of the rest as budget-limited.

2. Add verifier scheduling priorities:
   - critical/high first.
   - changed-line anchors before summary-only findings.
   - high confidence before medium.
   - duplicate clusters: verify representative first.

3. Add schema repair for verifier finalization:
   - One repair call for `llm_schema_invalid` if budget permits.
   - If budget does not permit repair, mark `verificationIncomplete` with the schema error summary.
   - Persist invalid response details in debug artifacts.

4. Add deterministic verifier fallback only for narrow cases:
   - If candidate has changed-line anchor, evidence, and explicit related code, a deterministic "needs LLM verification" suppression is safer than publishing.
   - Do not publish unverified findings by default.
   - Optional future mode can surface unverified high-confidence candidates in a separate "unverified candidates" appendix.

5. Improve telemetry:
   - Count `scheduled`, `started`, `completed`, `schema_invalid`, `repair_attempted`, `not_dispatched`, `budget_limited`.
   - Record candidate ids and priority decisions.

## Tests

- Stage 9 verifies candidates in priority order under limited budget.
- Schema-invalid verifier output triggers one repair attempt.
- Budget-limited candidates are recorded as incomplete and suppressed from final findings.
- Verification summary distinguishes gate rejection, verifier rejection, schema failure, and not dispatched.

## Acceptance Criteria

- Stage 9 no longer loses candidates without a precise reason.
- Verifier schema failures are either repaired or explicitly marked incomplete.
- High-value candidates get verification priority when the run is budget-constrained.
