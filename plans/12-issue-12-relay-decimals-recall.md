# Issue 12: Relay Decimals Recall

## Problem

The previous trails-api run published a relay decimals issue: raw provider decimals were no longer validated before `uint8(...)` conversion, so out-of-range values could wrap before helper validation.

The latest run noticed the same risk only as a low-confidence follow-up hint:

```text
Does relay ever return token decimals outside 0-100 (e.g. > 255) that would wrap on uint8(decimals) ...
```

It did not become a candidate finding, so it could not be verified or published. This is a recall concern: Codeninja recognized the shape of the bug but classified it as "ask a human" instead of "candidate with evidence".

## Plan

1. Reproduce the candidate lifecycle:
   - Inspect the packet for `lib/routes/relay/process_quote.go`.
   - Identify why the reviewer produced a follow-up hint instead of a candidate:
     - prompt wording
     - confidence threshold
     - missing changed-line evidence
     - lens selection
     - tool budget.
   - Record the exact packet id and hunk ids in a regression test fixture.

2. Add a generic risky-narrowing signal:
   - Detect changed Go lines containing casts such as `uint8(...)`, `uint16(...)`, or `int32(...)` around external/provider inputs.
   - Raise a static signal when a removed validation function or deleted guard previously checked the raw value.
   - Keep this as a signal, not an automatic finding.
   - Initial target: decimals and amount/price boundaries.

3. Improve reviewer guidance:
   - Add a Go lens rule:
     - "Validate raw external values before narrowing casts; helper validation after a cast may be too late."
   - Add false-positive guidance:
     - If the source type is already bounded or generated enum-like data, do not publish.
     - If the source is provider/API JSON or untrusted metadata, treat as candidate-worthy when changed code moved validation after the cast.
   - Tell packet reviewers:
     - Do not leave concrete deterministic failure modes as follow-up hints when changed-line evidence exists.
     - Emit a medium-confidence candidate and let Stage 9 verify it.

4. Improve follow-up promotion rules cautiously:
   - Do not publish follow-up hints directly.
   - But if a follow-up hint has:
     - concrete failure mode terms (`wrap`, `overflow`, `truncation`, `validation after cast`)
     - changed-line symbols
     - medium/high confidence
     - changed-file path
   - Convert it into a verification-only candidate or require the reviewer to finalize it as a finding.
   - Keep low-confidence hints suppressed unless the static signal also supports them.

5. Add eval coverage:
   - Add or update the trails-api eval expectation for the relay decimals issue.
   - Track both:
     - candidate recall: did Stage 7 emit a candidate?
     - final recall: did Stage 9/10 publish or deliberately reject it with evidence?
   - Ensure the eval fails if the issue only appears as a raw follow-up hint.

## Likely Files

- `src/skills/bundled/lang-go.md` or equivalent bundled Go lens prompt file
- `src/pipeline/planner.ts` or static signal extraction code
- `src/pipeline/lens-runner.ts` if follow-up promotion is implemented there
- `src/pipeline/verifier.ts` if verification-only promoted candidates are introduced
- `tests/pipeline-phase5.test.ts`
- `tests/pipeline-phase6.test.ts`
- eval fixture under `evals/` or external private eval config, depending on current convention

## Tests

- Go static-signal test for `uint8(providerDecimals)` after deleted raw validation.
- Packet-review fake-runner test proving a supported risky-narrowing signal routes to a candidate path, not only a follow-up hint.
- Verifier test proving low-confidence unsupported narrowing concerns remain suppressed.
- Eval/golden test for the relay decimals issue on the trails-api PR.
- Regression test that final output can include the relay decimals finding when verifier keeps it.

## Acceptance Criteria

- The relay decimals truncation issue is emitted as a candidate finding in the trails-api eval.
- Stage 9 verifies or rejects it explicitly; it is not lost as a follow-up hint.
- The change improves a generic class of narrowing-cast review bugs, not just one hard-coded relay case.
- False positives remain controlled by verifier and static-signal evidence.
