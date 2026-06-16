# Issue 44: Stage 7 Recall Recalibration (Generate Liberally, Verify Strictly)

Status: PENDING
Planned from: trails-api eval runs 6/8/9 comparison, 2026-06-16
Recommended priority: highest open quality item; run next

## Problem

Run 6 (before plans 32-43) was the recall high-water mark: it published 7 findings, hit all 4 expected, and avoided the false positive. Runs 8 and 9 produce far fewer candidates, and the three expected correctness/test findings that run 6 caught as **direct** findings are no longer generated.

The collapse is at the top of the funnel — Stage 7 candidate generation — not context, not scoring, not infrastructure.

Funnel comparison (run 9 completed Stages 1-9 before a transient compose error; its candidate/verification data is intact):

| metric | run 6 (PASS) | run 9 |
| --- | --- | --- |
| Stage 7 direct candidates | 14 | 4 |
| Stage 7 promoted candidates | 3 | 3 |
| Stage 7 total candidates | 17 | 7 |
| `packet_review_no_findings` | not instrumented | 69 / 73 |
| hints/uncertainties considered for promotion | 92 | 13 |
| Stage 9 verified keep / reject | 8 / 7 | 3 / 4 |

The three expected-finding packets:

| expected packet | run 6 | run 9 |
| --- | --- | --- |
| amountfromusd (`a81d5adf`) | `a81d5adf-f1` direct finding + uncertainty | NO CANDIDATE |
| zero-native-price (`72a8ab63`) | `72a8ab63-f1` direct finding | NO CANDIDATE |
| erc20 (`46897188`) | `46897188-f1` direct finding | only a weak `-u2` uncertainty |

Crucially, **Stage 6 context is better than ever in run 9** (Issue 42 working: `adaptiveFull: 24`, `adaptiveSliced: 17`, `defaultSliced` down 28 -> 10; the `CalculateIntentFees` packet now gets a 5000-char changed-line-centered slice). Better context, fewer candidates. That rules out degraded context as the cause and isolates the regression to Stage 7 **review policy**.

## Diagnosis

codeninja is designed to **generate candidates liberally at Stage 7 and filter strictly at Stage 9 (verifier)**. Run 6 did exactly that: 17 candidates -> verifier -> 7 good findings. The verifier is demonstrably good at filtering (in run 8 it correctly rejected speculative promoted uncertainties with rigorous reasoning).

Several precision/cost hardening changes moved too much filtering **upstream into generation** with conservative prompt guidance, so reviewers now self-censor candidates before the verifier can adjudicate them. This is not a request to broadly roll back plans 33 or 36; it is a surgical correction to the live Stage 7 packet-review prompt and the uncertainty-promotion gates.

The accumulated guidance lives in `src/skills/prompt-builder.ts` `buildPacketReviewPrompt`:

- Line 113: "Review the packet for **real defects only** ... Return no findings when there is no concrete failure mode."
- Line 114: "**No finding is a successful high-quality review outcome.** ... submit_review with reviewStatus:\"no_findings\", findings: [], `followUpHints: [], uncertainties: []` ... **instead of continuing broad exploration.**"
- Line 115: "Use followUpHints and uncertainties **sparingly** ... **prefer no finding/no hint when the concern is speculative.** At most two followUpHints and one uncertainty will be kept."
- `depthCloseGuidance` (lines ~198/201/203): "Close quickly: submit no findings ...", "submit findings or no findings immediately", "Do not continue broad exploration after the likely risk is resolved."

Two concrete consequences are visible in the data:

1. **69 of 73 packets submit explicit `no_findings`** in run 9. This is not directly comparable to run 6 because the event was not instrumented there, but it is a useful run-9 symptom when paired with the direct-candidate collapse.
2. **Hint emission cratered 92 -> 13.** Line 114 still tells the model to submit `followUpHints: [], uncertainties: []` on the no-findings path — this is the directive Issue 40 removed from the lens-runner finalize instruction but **never removed from the primary packet-review prompt**. With hints starved, uncertainty promotion (which surfaced `amountfromusd` in run 6) has almost nothing to promote.

Issue 40 fixed the acute closeout regression and Issue 42 fixed context, but neither touches this generation-conservatism, which is now the binding constraint on recall.

## Non-Goals

- Do not lower the Stage 9 verifier's bar. Precision stays the verifier's job.
- Do not turn speculation into published findings. Liberal generation + strict verification, not liberal publication.
- Do not reintroduce Issue 33's compact forced-closeout (Issue 43 removes it).
- Do not remove the confidence-calibration guidance (prompt-builder line 116) — it is pro-recall and should stay.
- Do not make this trails-api-specific, Go-specific, or expectation-specific.
- Do not raise Stage 7 tool budgets as the primary fix.

## Plan

1. Rebalance the packet-review prompt toward liberal generation.
   - In `src/skills/prompt-builder.ts` `buildPacketReviewPrompt`, rewrite the conservative lines:
     - Keep "return no findings when there is genuinely no concrete failure mode," but remove the framing that elevates no-finding as the preferred/high-quality outcome.
     - State the architecture explicitly to the model: raise a candidate finding (or a concrete hint) whenever changed-line evidence suggests a plausible failure mode; a later verification stage filters false positives, so a plausible-but-unproven changed-line concern should be surfaced, not suppressed.
     - Remove the `followUpHints: [], uncertainties: []` directive from the no-findings instruction (the Issue 40 miss). No-findings submissions should not be told to zero out hints.
     - Replace "use followUpHints and uncertainties sparingly / prefer no finding/no hint when speculative" with guidance to emit concrete, pointer-rich hints for plausible unresolved risks; keep the prohibition on broad "check if this is safe" reminders.
     - Add the explicit rule: when a behavior-preserving refactor changes a changed-line anchored behavior boundary, validation predicate, fallback path, lossy conversion, or test coverage boundary, surface it as a candidate or verifier-bound hint even if reachability needs Stage 9 confirmation.
   - Keep the injection/data-not-instructions framing and the confidence-calibration line unchanged.

2. Soften the early-close depth guidance.
   - In `depthCloseGuidance` and the per-profile lines (`simple`/`investigate`/standard), remove the "close quickly / submit no findings / do not continue broad exploration" bias.
   - Replace with: investigate the concrete suspected failure mode with targeted tools; once the changed-line risk is decided, submit. Do not pad with broad exploration, but do not abandon a plausible changed-line concern unsurfaced because one lookup was inconclusive.
   - Preserve the simple-profile packet-only behavior, but allow surfacing a clear changed-line concern.

3. Revisit the per-packet hint/uncertainty caps from Issue 36 only if needed.
   - The caps (`MAX_FOLLOW_UP_HINTS_PER_PACKET = 2`, `MAX_UNCERTAINTIES_PER_PACKET = 1`) in `src/pipeline/lens-runner.ts` were not the binding constraint in run 9 (avg << cap), but the prompt language around them ("at most two will be kept") discourages emission.
   - First remove the discouraging "at most N will be kept" phrasing from the prompt, so reviewers are not pre-emptively suppressing.
   - Keep the caps and ranking-before-capping logic unless a follow-up eval shows caps, not prompt posture, are still suppressing concrete hints.

4. Relax uncertainty promotion for concrete behavior-change predicates without weakening publication.
   - In `src/pipeline/uncertainty-promotion.ts`, keep broad/nit/speculative suppression.
   - Do not reject a low-confidence follow-up solely for `low_confidence_hint` when it has all of:
     - changed-line anchor,
     - concrete old-vs-new behavior predicate,
     - production or test-coverage impact,
     - file/symbol pointer,
     - behavior-preserving/refactor context or changed validation/fallback/conversion boundary.
   - Avoid global lane starvation for this class. Reserve at least one promotion slot, when available, for concrete correctness behavior-delta predicates before generic security/test/follow-up questions consume the lane.
   - Promoted candidates still go through normal Stage 9 verification and remain unpublished unless kept.

5. Confirm the verifier remains the precision gate.
   - Do not change verifier prompts or policy in this plan.
   - The expectation is that more liberal Stage 7 generation increases candidates and hints, that Stage 9 verification volume rises, and that the verifier rejects the additional weak candidates. This is the intended cost of recall.
   - Watch the false-positive expectation (`lifi-unpriced-fee-false-positive`) to ensure liberal generation plus strict verification still avoids it.

6. Add telemetry to track the recall recalibration.
   - Continue to record per-packet `reviewStatus`, direct vs promoted candidate counts, hints/uncertainties emitted, and `packet_review_no_findings`.
   - Add or surface an aggregate Stage 7 generation summary so a run review can compare candidate/hint volume against run 6 directly:
     - direct candidates
     - promoted candidates
     - packets producing >= 1 candidate
     - hints + uncertainties emitted (pre-cap and post-cap)
     - no_findings packet count

7. Add tests.
   - The packet-review prompt no longer instructs `followUpHints: []` / `uncertainties: []` on the no-findings path.
   - The packet-review prompt no longer contains the "no finding is a high-quality outcome" / "instead of continuing broad exploration" framing.
   - A packet with a plausible changed-line concern is encouraged (by prompt assertion) to raise a candidate or concrete hint rather than default to no-findings.
   - The Issue 36 caps still rank before capping.
   - A concrete behavior-preserving-refactor predicate is eligible for promotion even when the originating hint is low confidence, while broad low-confidence hints remain suppressed.
   - Promotion lane selection preserves at least one slot for concrete correctness behavior-delta predicates when such a source is eligible.
   - Existing precision tests (broad-reminder suppression, ranking) still pass.

## Likely Files

- `src/skills/prompt-builder.ts`
- `src/pipeline/lens-runner.ts`
- `src/pipeline/uncertainty-promotion.ts`
- `bundled-skills/core/code-review.md` (only if the projected skill text also carries conservative framing)
- `src/telemetry/run-artifacts.ts`
- `src/types.ts` (only if new aggregate telemetry needs a field)
- `tests/phase4-skills-provider.test.ts` or the prompt-builder test file
- `tests/pipeline-phase5.test.ts`

## Acceptance Criteria

- The packet-review prompt no longer frames no-findings as the preferred outcome or instructs empty hints/uncertainties.
- Early-close depth guidance no longer biases reviewers toward quick no-findings submission.
- Concrete behavior-preserving-refactor behavior deltas can reach Stage 9 verification even when Stage 7 cannot fully prove reachability.
- The Stage 9 verifier bar is unchanged; precision filtering stays downstream.
- Telemetry exposes Stage 7 generation volume for direct run-6 comparison.
- Tests lock the prompt and promotion-gate changes.

## Validation

- Run prompt-builder / pipeline unit tests and build.
- Re-run the trails-api eval at `review.concurrency: 4` and `llm.maxConcurrentCalls: 4` to match run 6 and remove concurrency as a confound.
- Compare against run 6 and run 9:
  - direct candidates should recover toward run 6's ~14 (not necessarily exactly).
  - `packet_review_no_findings` should drop materially below 69.
  - hints/uncertainties considered for promotion should recover well above 13.
  - the three expected packets (`a81d5adf`, `72a8ab63`, `46897188`) should produce direct candidates again.
  - `lifi-unpriced-fee-false-positive` must still be avoided (liberal generation must not break the false-positive guard).
  - cost stays under the `maxCostUSD` (30) ceiling; expect cost to rise toward/above run 6's $22.78 as generation and verification volume increase.

## Stop Conditions

- Stop if recall recovery requires weakening the verifier or publishing unverified candidates.
- Stop if the false-positive expectation starts failing (liberal generation must rely on the verifier, not produce published noise).
- Stop if the change reintroduces Issue 33's compact-closeout behavior or the run-7 recall regression.
- Stop if generation volume balloons without verification filtering it (cost spikes with no recall gain).

## Note

This plan reframes the plans 32-43 effort: most of those were precision/cost optimizations, and collectively (chiefly 33 and 36) they over-tuned for precision at the expense of recall. Keep the genuinely good fixes — Issue 40 (closeout recall), Issue 41 (scoring/provenance), Issue 42 (adaptive context), Issue 35 (telemetry), Issue 37 (verifier repair) — and roll back only the Stage 7 generation-conservatism that turned run 6's 17 candidates into run 9's 7.
