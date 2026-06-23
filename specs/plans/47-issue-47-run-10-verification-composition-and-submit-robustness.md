# Issue 47: Run 10 Verification, Composition, and Submit Robustness

Status: COMPLETE
Planned from: trails-api eval runs 6/10 comparison, 2026-06-16
Recommended priority: next quality/reliability item after Issue 46; implement in staged order

## Problem

Run 10 recovered Stage 7 candidate generation but still failed the eval:

```text
run 10: fail | 5 reported | 3/5 expectations | $25.6173 | 973.1s | partial review
  FAIL erc20-balanceof-test-coverage: lost-at-verification (verifier-rejected)
  FAIL amountfromusd-zero-decimal-token: lost-at-composition (confidence-threshold)
```

Compared to run 6, the core review engine is no longer starved:

| metric | run 6 | run 10 |
| --- | ---: | ---: |
| candidate findings | 17 | 18 |
| reported findings | 7 | 5 |
| review completeness | complete | partial |
| wall time | 1066s | 973s |
| cost | $22.78 | $25.62 |

This means the remaining failure is not primarily Stage 7 recall. It is a mix of:

- one Stage 7 `submit_review` schema-repair failure that turned the run partial,
- a Stage 9 verifier policy gap for test-coverage regressions,
- a Stage 10 confidence/publication policy that suppresses a verified concrete behavior delta,
- final-review prose that counts suppressed verified findings as if they were published.

## Diagnosis

### Stage 7 Submit Robustness

Run 10 had one failed packet:

- file: `lib/routes/lz_stargate/stargate.go`
- failure: `model submit payload failed schema validation after repair`
- symptom: XML/tool-parameter bleed inside a `submit_review` payload, where the model appeared to express `no_findings` but the structured payload was mangled.

This is similar to the verifier forced-submit schema issue addressed in Issue 37, but it occurred in the Stage 7 packet-review submit path. A single malformed no-finding submit should not make a large review partial when the payload is salvageable or retryable.

### Stage 9 Test-Coverage Verification

The `erc20-balanceof-test-coverage` candidate was generated in run 10, then rejected by the verifier.

Run 6 kept/revised this class of finding: the old tests uniquely covered the `erc20BalanceAt` JSON-RPC/calldata boundary, while the new helper tests covered pure helper behavior. Run 10's verifier rejected because production behavior did not change.

For `testing` findings, production behavior does not need to change. A valid finding can be that a test rewrite or deletion removed coverage for a still-live integration, protocol, serialization, database, migration, or boundary path.

### Stage 10 Confidence Publication

The `amountfromusd-zero-decimal-token` finding was generated and verified/revised in run 10, but suppressed because final confidence was `low`.

The verifier uncertainty was about reachability, not about whether a concrete changed-line behavior delta existed. Suppressing all low-confidence findings is too blunt for verified behavior deltas that are changed-line anchored and have concrete old-vs-new evidence.

### Final Report Count

Run 10's final review prose counted a suppressed verified finding in the summary, while the public findings list contained only the published findings. This makes the report confusing and makes eval/debug interpretation harder.

## Non-Goals

- Do not weaken the verifier globally.
- Do not publish broad speculative findings.
- Do not make this trails-api-specific, Go-specific, or eval-expectation-specific.
- Do not reintroduce compact finalize or other recall-reducing Stage 7 shortcuts.
- Do not change eval expectations as the primary fix.
- Do not hide partial-review state; if a packet truly fails, the report should still say partial.

## Implementation Sequence

This plan should be implemented in stages because the fixes have different value/risk profiles:

1. **Stage 10 confidence exception and final-report count fix first.**
   - Highest value and lowest risk.
   - Should recover the `amountfromusd-zero-decimal-token` path when the verifier keeps/revises a concrete behavior delta but marks confidence low.
   - Also fixes confusing final-review prose without touching model judgment.

2. **Stage 7 submit-repair robustness second.**
   - Medium complexity, improves completeness and reliability.
   - Must be recall-conservative: retry/fail rather than silently converting malformed findings into `no_findings`.

3. **Stage 9 test-coverage verifier policy last.**
   - Highest precision risk and least guaranteed payoff.
   - Implement as verifier prompt/policy guidance, not as a keyword classifier.
   - Treat the `erc20` expectation as best-effort until a rerun proves the policy reliably helps without admitting generic test noise.

## Plan

1. Refine Stage 10 publication for verified low-confidence behavior deltas.
   - Keep low-confidence suppression by default.
   - Add a narrow exception for verified findings that have:
     - changed-line anchor,
     - concrete base-vs-head behavior delta,
     - verifier verdict `keep` or `revise`,
     - concrete evidence in changed or related code,
     - clear suggested test or confirmation path.
   - Publish these as low severity / low confidence / needs-confirmation, rather than silently suppressing them.
   - Do not apply the exception to broad architecture notes, vague possible risks, style issues, or unanchored concerns.
   - Also review whether the verifier can preserve medium confidence when it confirms a real-but-narrower regression after removing an over-claim. Do not change verifier behavior here unless the implementation is small and clearly general; the composition exception is the primary fix.

2. Fix final-review count semantics.
   - Summary prose should count only published findings as published findings.
   - If suppressed verified findings are mentioned, label them separately as suppressed or not published.
   - Keep artifact-level suppressed findings available for debugging/eval.

3. Harden Stage 7 `submit_review` schema repair and fallback.
   - Reuse the XML/tool-parameter bleed classification patterns from verifier repair where practical.
   - If a Stage 7 submit payload is malformed but clearly contains a valid no-finding decision, salvage a deterministic `no_findings` result instead of marking the packet failed.
   - Never salvage to `no_findings` when the raw payload references a finding, candidate title, failure mode, or non-empty `findings` content. In that case, retry once or fail with debug artifacts.
   - If salvage is unsafe, retry once with a strict "submit valid JSON/tool payload now; no more tool calls" repair prompt.
   - If retry still fails, keep the existing packet-failed behavior and preserve the raw error/debug artifact.
   - Emit telemetry for:
     - `stage7_schema_repair_attempted`
     - `stage7_schema_repair_recovered`
     - `stage7_schema_repair_failed`
     - repair reason, including XML/parameter bleed when detected.

4. Adjust verifier policy for test-coverage findings.
   - Implement this as LLM verifier guidance, not deterministic keyword matching.
   - For `category: "testing"` candidates, explicitly allow findings where changed tests remove or replace coverage for a still-live behavior boundary.
   - The verifier should not require production code to change for this class.
   - Require concrete evidence:
     - the old/base tests covered a named behavior or boundary,
     - the new/head tests no longer cover that boundary or only cover a narrower helper,
     - the boundary remains reachable in production or is still part of the public/system contract.
   - Prefer `revise` over `reject` when the candidate is directionally right but too broad.
   - Keep rejection for generic "add more tests" comments without a specific missing behavior.
   - Do not tune this to one protocol, language, or fixture. The general rule is: test-only changes can still create review-worthy risk when they remove coverage for an important still-live behavior boundary.

5. Add tests.
   - Stage 7 submit repair recovers an XML/parameter-bleed no-finding payload.
   - Stage 7 submit repair does not salvage to no-findings when raw malformed content appears to contain findings.
   - Stage 7 submit repair retries once before failing an unsalvageable malformed payload.
   - Test-coverage verifier prompt/policy allows missing boundary coverage without production behavior changes.
   - Composer publishes only the narrow verified low-confidence behavior-delta class and continues suppressing broad low-confidence speculation.
   - Final review summary counts published findings only.

## Likely Files

- `src/pipeline/lens-runner.ts`
- `src/pipeline/verifier.ts`
- `src/pipeline/composer.ts`
- `src/skills/prompt-builder.ts`
- `src/telemetry/run-artifacts.ts`
- `src/types.ts` if new telemetry fields are required
- `tests/*lens*runner*.test.ts`
- `tests/*verifier*.test.ts`
- `tests/*composer*.test.ts`

## Acceptance Criteria

- A salvageable Stage 7 malformed no-finding submit no longer makes a large review partial.
- Stage 7 repair never silently drops malformed non-empty findings by converting them to no-findings.
- Unsalvageable Stage 7 malformed submits still fail clearly with debug artifacts.
- Test-coverage findings can survive verification when changed tests remove coverage for a still-live behavior boundary.
- Verified low-confidence changed-line behavior deltas can be published as low-confidence findings when evidence is concrete.
- Broad low-confidence speculation remains suppressed.
- Final report prose and finding counts agree with the published findings list.
- Telemetry exposes Stage 7 submit-repair attempts and outcomes.

## Validation

- Run focused Stage 7 schema-repair tests.
- Run focused verifier policy tests for test-coverage findings.
- Run focused composer/publication tests.
- Run the full test suite and `make build`.
- Optionally validate after each implementation stage before moving to the next riskier stage:
  - after Stage 10/report fixes, confirm `amountfromusd-zero-decimal-token` is no longer lost solely at confidence threshold;
  - after Stage 7 repair, confirm the review remains complete unless a packet is truly unsalvageable;
  - after Stage 9 policy, confirm generic missing-test noise does not increase.
- Re-run the trails-api eval and compare against runs 6 and 10:
  - review completeness should return to complete unless a truly unsalvageable packet fails,
  - `erc20-balanceof-test-coverage` should not be rejected merely because production code did not change,
  - `amountfromusd-zero-decimal-token` should not be lost solely at the confidence threshold when the verifier kept/revised a concrete behavior delta,
  - published finding counts should match final-review prose,
  - false-positive expectations must remain avoided.

## Stop Conditions

- Stop if the verifier change starts keeping generic "missing tests" comments.
- Stop if the low-confidence publication exception causes broad speculative findings to appear in final output.
- Stop if Stage 7 repair hides genuinely invalid model behavior without preserving telemetry/debug evidence.
- Stop if Stage 7 repair converts malformed content with apparent findings into `no_findings`.
- Stop if the fix requires eval-specific matching logic inside the review pipeline.
