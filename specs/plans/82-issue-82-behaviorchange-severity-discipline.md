# Issue 82: BehaviorChange Severity Discipline

Status: PENDING
Planned from: fable review D4/§5.1 watch item (`specs/reviews/1-fable-review.md`); eval evidence `49f4645b/logs/24` vs `logs/25` (identical EXACT_OUTPUT under-delivery bug published medium then low, run 25 carrying `behaviorChange: intentional_needs_confirmation`), `0c4d5213/logs/44` (severity rank decided verification survival under budget squeeze: `a81d5adf-f1` scored low/low → queued last → `budget_limited`), historical runs 3/4 (accurate routing candidate rejected over "unintended regression" framing), 2026-07-01
Planned at: commit `73ef963` (branch `next`)
Recommended priority: high. Small mechanical fix plus a measurement hook; the un-spec'd behaviorChange contract is silently deciding rank, publication, and (under squeeze) survival.

## Problem

Two distinct mechanisms, one contract, zero spec coverage:

1. **The mechanical cap.** `capSeverityForBehaviorChange` (`src/pipeline/severity-policy.ts`, verified at current commit) demotes critical/high → medium when `behaviorChange` is `intentional_needs_confirmation` **or `unknown`**. An honest model that marks `unknown` is punished; a model that omits the field entirely is not. Because every "never hide verified critical/high" protection keys off severity, a genuine critical finding marked `unknown` loses its cap immunity and can be silently suppressed at composition. Applied at `verifier.ts` (verdict + promotion paths), `system-reviewer.ts`, `lens-runner.ts`.
2. **Framing-driven scoring variance.** The cap never touched run 25's finding (it was already `low`), yet the same bug scored `medium` in run 24 and `low` in run 25 — with `intentional_needs_confirmation` attached in 25. The behaviorChange rubric in the Stage-7/9 prompts steers the model's own severity assignment run-to-run. Consequences observed this week:
   - Eval matchers with `severityAtLeast: medium` (0c4d5213 routing) will fail on a low-scored draw of a found bug — a framing flake, not a detection miss.
   - Stage-9 dispatch orders by severity (`orderVerifierRepresentatives`); under budget squeeze the low-scored draw of a material finding dies `budget_limited` (run 44).
   - Historical runs 3/4: verifier rejected an accurate candidate purely over intent framing.

## Goal

No severity demotion on `unknown`; the `intentional_needs_confirmation` cap either specified and bounded or removed; severity flapping on identical findings measurable so the Issue-79 harness can track it per expectation.

## Design

1. **Stop demoting on `unknown`** (one-line change in `capSeverityForBehaviorChange`): `unknown` is an honest absence of evidence, equivalent to the omitted field. Cap applies to `intentional_needs_confirmation` only.
2. **Preserve pre-cap severity.** When the cap fires, record `severityBeforeCap` on the finding and thread it through composition suppression decisions: the "never hide verified critical/high" guarantees key off `max(severity, severityBeforeCap)` so a capped critical cannot be silently dropped by count/confidence caps. Telemetry event `severity_capped { findingId, from, to, behaviorChange }`.
3. **Spec the contract.** One paragraph in `review_pipeline.md`: what `behaviorChange` values mean, where the cap applies, and that `unknown`/absent are equivalent. (Fable D4: the whole contract appears in no spec today.)
4. **Measurement hook for framing variance** (no behavior change): emit finding-level `severity`/`confidence`/`behaviorChange` into the per-run scoring artifacts so Issue 79's repeat harness reports per-expectation severity distributions. Whether to *calibrate* prompts is decided later on that data — this plan only makes the variance visible.
5. **Optional, gated:** if the repeat data shows `severityAtLeast` expectations flaking on framing draws, evaluate matching on `max(severity, severityBeforeCap)` in the eval scorer rather than loosening case files.

## Non-Goals

- Rewriting the behaviorChange rubric in prompts (needs Issue-79 data first).
- Changing verifier reject/keep policy on intent framing (watch item; separate plan if the data confirms).
- Removing the `intentional_needs_confirmation` cap outright (it encodes a real product judgment — deliberate-change callouts read differently from regressions; it just must not bypass the critical/high guarantees).

## In-Scope Files

- `src/pipeline/severity-policy.ts` — drop `unknown` from the cap condition.
- `src/types.ts` — `severityBeforeCap?: Severity` on the finding types.
- `src/pipeline/verifier.ts`, `src/pipeline/system-reviewer.ts`, `src/pipeline/lens-runner.ts` — record pre-cap severity at the three application sites.
- `src/pipeline/composer.ts` / `src/pipeline/human-attention.ts` — suppression guarantees consult `severityBeforeCap`.
- `src/evals/eval-scoring.ts` — surface severity/confidence/behaviorChange in scoring artifacts (measurement only).
- `specs/project/components/review_pipeline.md` — document the contract.
- Tests: severity-policy unit tests (existing `capSeverityForBehaviorChange` tests updated), composition-suppression guarantee test with a capped critical.

## Implementation Steps

1. Cap condition change + unit tests (`unknown` → no demotion; absent → no demotion; `intentional_needs_confirmation` critical → medium with `severityBeforeCap: critical`).
2. Thread `severityBeforeCap`; composition/human-attention guarantee test: a capped critical survives maxFindings/softCommentCap pressure.
3. Telemetry event + scoring artifact fields.
4. Spec paragraph.
5. After Issue 79: repeat runs report per-expectation severity distributions; open the calibration/scorer follow-up only if flaking is confirmed.

## Validation

- Unit suite green; a fixture reproducing run-25's finding shape (`low`, `intentional_needs_confirmation`, verifier keep) publishes unchanged — proving the cap fix does not inflate severities.
- A fixture with `critical` + `unknown` retains `critical`.
- One trails-api run each case: no change in findings beyond severity fields; no new `should_not_find` violations.

## Done Criteria

- `unknown` and absent behaviorChange are treated identically everywhere severity policy applies.
- No verified critical/high can be suppressed at composition because a behaviorChange draw demoted it — guaranteed by test.
- Severity flapping is visible per expectation in eval artifacts.

## Stop Conditions

- If removing the `unknown` demotion measurably increases published false-positive severity inflation on `should_not_find`/watch cases, reconsider with data — but prefer fixing the rubric prompt over re-punishing honesty.
