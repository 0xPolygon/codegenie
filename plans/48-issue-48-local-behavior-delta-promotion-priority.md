# Issue 48: Prioritize Local Behavior-Delta Uncertainty Promotions

Status: COMPLETE
Planned from: trails-api eval runs 6/11/14 comparison, 2026-06-17
Planned at: commit `9471756`
Recommended priority: next quality item; implement before more prompt tuning

## Problem

Run 14 completed the review and was generally healthy, but missed the exact `amountfromusd-zero-decimal-token` required expectation:

```text
run 14: fail | 6 reported | 3/4 required expectations | 1/1 optional expectations
  FAIL amountfromusd-zero-decimal-token: partial-match
```

This was not a verifier or composer loss:

- `missed-before-candidate-generation=0`
- `lost-at-verification=0`
- `lost-at-composition=0`
- `partial-match=1`

The same finding was reported in both run 6 and run 11 as `a81d5adf-f1`. In run 14, the packet reviewer did surface the relevant concern as a low-confidence hint/uncertainty, but the uncertainty-promotion lane did not promote it. It was marked `promotion_lane_limited`, while broader cross-route hypotheses consumed the bounded promotion slots and were later rejected by the verifier.

The core issue is therefore candidate recovery under nondeterministic Stage 7 output: when Stage 7 raises a concrete changed-symbol behavior-delta as a hint instead of a direct finding, the promotion layer should reliably send that hint to Stage 9 verification before broader, less local hypotheses.

## Evidence

Run 6 and run 11 both produced the exact final finding:

```text
run 6:
  amountfromusd-zero-decimal-token -> pass
  matched final finding: a81d5adf-f1
  title: AmountFromUSD rejects 0-decimal origin tokens that the old code handled

run 11:
  amountfromusd-zero-decimal-token -> pass
  matched final finding: a81d5adf-f1
  title: AmountFromUSD rejects 0-decimal origin tokens that the old DecimalsFactor path accepted
```

Run 14 produced related final findings on the same file, but not the exact local helper behavior delta:

```text
run 14 final findings on lib/intentmachine/feecalculator/fee_calculator.go:
  e97afeca-f1: ParseNonNegativeBigInt rejects negative amounts...
  72a8ab63-f1: CalculateAmountUSD adds price/amount validation...

missing direct candidate:
  a81d5adf-f1: AmountFromUSD rejects 0-decimal origin tokens...
```

Run 14 did capture the relevant local concern in `uncertainty-promotion.json`, but did not promote it:

```json
{
  "packetId": "a81d5adf7f1c93af10a84828a95d65ee047da2880970b8edc71e9a067ea92f73",
  "promoted": false,
  "reason": "promotion_lane_limited",
  "question": "Is it acceptable that AmountFromUSD now returns a hard error (failing the entire CalculateIntentFees) when priceUSD<=0 or decimals==0, whereas the previous big.Float path would not error on priceUSD==0 ...",
  "files": [
    "lib/intentmachine/feecalculator/fee_calculator.go",
    "lib/quotes/fees.go"
  ],
  "symbols": [
    "AmountFromUSD",
    "CalculateIntentFees",
    "originTokenForTotals"
  ]
}
```

This is exactly the class of issue the harness should recover:

- changed-line anchored packet,
- concrete helper replacement,
- concrete old-vs-new behavior predicate,
- local changed symbol,
- refactor / behavior-preserving intent,
- verifier can adjudicate it with source tools.

## Current State

The promotion stage lives in `src/pipeline/uncertainty-promotion.ts`.

Important current behavior:

```ts
const MAX_PROMOTIONS = 4;
const MIN_PROMOTIONS_WHEN_AVAILABLE = 2;
```

The current selector ranks all eligible sources, picks the top `maxPromotions`, then ensures one concrete behavior-delta source is present:

```ts
function selectPromotionSources(eligible: RankedPromotionSource[], maxPromotions: number): RankedPromotionSource[] {
  if (maxPromotions <= 0 || eligible.length === 0) {
    return [];
  }
  const selected = eligible.slice(0, maxPromotions);
  const behaviorDelta = eligible.find((item) => isConcreteBehaviorDeltaSource(item.source));
  if (behaviorDelta === undefined || selected.includes(behaviorDelta)) {
    return selected;
  }
  if (selected.length < maxPromotions) {
    return [...selected, behaviorDelta];
  }
  return [...selected.slice(0, Math.max(0, maxPromotions - 1)), behaviorDelta];
}
```

This is good but not enough. Because `eligible` is globally rank-sorted, the reserved behavior-delta slot can still go to a broad multi-file or cross-system hypothesis instead of a more local changed-symbol contract issue.

Current ranking is mostly category/confidence/priority based:

```ts
function promotionRank(source: PromotionSource): number {
  const risk = riskProfile(source);
  return (source.sourceKind === "follow_up_hint" ? 8 : source.sourceKind === "unresolved_question" ? 3 : 4) +
    (source.confidence === "high" ? 8 : source.confidence === "medium" ? 4 : 0) +
    (risk.category === "security" ? 12 : risk.category === "correctness" || risk.category === "logic_bug" ? 8 : 6) +
    (source.packet.reviewPriority === "critical" ? 8 : source.packet.reviewPriority === "high" ? 4 : 0) +
    (source.symbols.length > 0 ? 2 : 0) +
    (mentionsChangedTestOrDeletedCoverage(source) ? 2 : 0);
}
```

The current tests in `tests/uncertainty-promotion.test.ts` already cover:

- concrete changed-test coverage promotion,
- bounded promotion and lane-limited decisions,
- low-confidence concrete behavior-delta promotion,
- broad low-confidence hint suppression,
- one generic behavior-delta reserve lane.

This plan should extend that implementation, not replace it.

## Non-Goals

- Do not special-case the Trails eval, Go, `AmountFromUSD`, token decimals, or any specific file path.
- Do not increase the global number of promoted candidates as the primary fix.
- Do not change `MAX_PROMOTIONS`, `MIN_PROMOTIONS_WHEN_AVAILABLE`, or budget-multiplier behavior in this plan.
- Do not loosen Stage 9 verification or publication thresholds.
- Do not make broad speculative hints publishable.
- Do not add another LLM call or another review pass.
- Do not change Stage 7 prompts in this plan unless a tiny wording fix is needed to support promotion telemetry.
- Do not rename or churn existing test fixtures just because older tests use domain-specific names. The generic-fixture rule applies to new tests added for this plan.

## Plan

1. Add a locality-aware behavior-delta priority layer.
   - In `src/pipeline/uncertainty-promotion.ts`, add a helper such as `behaviorDeltaLocalityScore(source)`.
   - Reuse the existing `isConcreteBehaviorDeltaSource(source)` gate for eligibility. The new helper should rank already-eligible behavior deltas; it should not duplicate or weaken the existing concrete-predicate checks.
   - The score should favor sources that:
     - include the changed packet path or old path,
     - name an enclosing changed symbol from `packet.symbolFacts`,
     - name a symbol visible in the changed hunk text,
     - mention a concrete helper/guard/fallback/conversion/validation/test-boundary change,
     - include old-vs-new language such as `old`, `previously`, `before`, `now`, `new`, `removed`, `replaced`, `no longer`, or `instead`.
   - The score should penalize sources that:
     - mention many unrelated files,
     - use broad phrases such as `across all`, `every route`, `all call sites`, `system-wide`, or `cross-system`,
     - have no overlap with changed packet symbols.
   - Keep the helper purely textual/metadata based. It must not know about a specific language, repo, eval, symbol name, or domain.
   - Use existing normalized text, hunk text, file path, and symbol-fact data. Do not add AST or tree-sitter work for this ranking layer.

2. Reserve the behavior-delta lane for the best **local** behavior delta, not the first globally ranked behavior delta.
   - Update `selectPromotionSources`.
   - Instead of:
     - `eligible.find((item) => isConcreteBehaviorDeltaSource(item.source))`
   - Use:
     - all eligible concrete behavior-delta sources,
     - sort them by `behaviorDeltaLocalityScore`, then by existing `promotionRank`,
     - reserve the highest local behavior-delta source.
   - Preserve the existing max-promotion budget.
   - If the best local behavior-delta source is already selected, do nothing.
   - If not selected and the lane is full, replace the lowest-ranked selected source that is not itself a stronger local behavior-delta source.
   - A local correctness behavior-delta should be allowed to outrank a broader security-labeled hypothesis when the broad source lacks local changed-symbol evidence. This only affects which candidates reach verification; Stage 9 remains the precision gate.

3. Keep broad hypotheses eligible, but lower priority than local contract deltas.
   - Broad cross-file hypotheses can still be useful, especially in deep reviews.
   - They should not consume the only behavior-delta reserve slot when a changed-symbol-local old-vs-new predicate is available.
   - Do not suppress broad hypotheses outright unless they already fail the existing promotion gates.

4. Add telemetry fields to promotion decisions.
   - Extend `PromotionDecision` with optional fields such as:
     - `rank`
     - `promotionClass`
     - `localityScore`
     - `selectedBy`
   - Suggested `promotionClass` values:
     - `local_behavior_delta`
     - `broad_behavior_delta`
     - `test_boundary`
     - `security_boundary`
     - `other`
   - Suggested `selectedBy` values:
     - `rank`
     - `local_behavior_delta_reserve`
   - Keep the artifact backward-compatible: adding fields is fine; renaming/removing existing fields is not.
   - Treat these fields as diagnostic artifact data for `uncertainty-promotion.json`, not as public review-output fields.

5. Add focused tests.
   - Add tests in `tests/uncertainty-promotion.test.ts`.
   - Test 1: local behavior-delta beats broad behavior-delta for the reserve slot.
     - Build a packet with changed symbol `computeFees`.
     - Include one local low-confidence hint:
       - same file,
       - symbols `convertFromUsd`, `computeFees`,
       - question says a behavior-preserving refactor now errors for a concrete edge input that old code accepted.
     - Include one broad hint:
       - many files,
       - question says all modules might have a conversion issue.
     - Add enough eligible sources that the promotion budget is saturated. The current minimum promotion count is two, so the test should prove the local hint displaces a broader lower-locality source rather than relying on a one-slot budget.
     - Expect the local hint to be promoted and the displaced broad hint to be lane-limited.
   - Test 2: broad behavior-delta can still promote when no local behavior-delta exists.
   - Test 3: low-confidence broad hint without concrete old-vs-new predicate remains suppressed or lane-limited as today.
   - Test 4: promotion telemetry includes class/locality/rank fields for selected and lane-limited decisions.
   - For new tests added in this plan, do not use `AmountFromUSD`, token decimals, Go file names, or Trails paths in test fixture names. Use generic names like `convertFromUsd`, `computeFees`, `src/billing/fees.ts`, or similar.

6. Review existing tests for brittle expectations.
   - Existing tests that assert exact `laneLimited` counts may need small updates if local behavior-delta selection changes ordering.
   - Preserve the semantic intent of those tests:
     - promotion remains bounded,
     - lane-limited decisions are explained,
     - broad low-confidence hints do not become candidates,
     - concrete behavior deltas still pass to verification.

## Likely Files

- `src/pipeline/uncertainty-promotion.ts`
- `tests/uncertainty-promotion.test.ts`
- `src/types.ts` only if shared exported telemetry types need to move out of the promotion module

## Commands

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Focused tests | `pnpm exec vitest run tests/uncertainty-promotion.test.ts` | exits 0; all uncertainty-promotion tests pass |
| Full tests | `pnpm test` | exits 0 |
| Typecheck | `pnpm run typecheck` | exits 0 |
| Build | `pnpm run build` | exits 0 |

## Acceptance Criteria

- A concrete changed-symbol-local behavior-delta hint is promoted ahead of a broader cross-file behavior-delta hypothesis when promotion slots are scarce.
- Broad behavior-delta hypotheses remain eligible when no better local behavior-delta exists.
- Promotion remains bounded by the existing budget.
- Promotion budget constants and budget-multiplier semantics are unchanged.
- Stage 9 verification remains the precision gate; promoted candidates are not published without verifier keep/revise.
- `uncertainty-promotion.json` explains why each selected source was selected, including rank/class/locality data.
- Tests prove the behavior without naming Trails, Go, `AmountFromUSD`, token decimals, or eval expectation IDs.

## Stop Conditions

- Stop and reassess if the implementation needs an eval-specific term, source path, helper name, or exact review sentence to make the test pass.
- Stop and reassess if the best fix appears to require increasing promotion budgets instead of improving selection order.
- Stop and reassess if the change makes broad low-confidence hints eligible without a concrete old-vs-new predicate.

## Validation

1. Run `pnpm exec vitest run tests/uncertainty-promotion.test.ts`.
2. Run `pnpm run typecheck`.
3. Run `pnpm run build`.
4. Run `pnpm test` if the focused suite and build pass.
5. On the next trails-api eval, compare against runs 11 and 14:
   - `amountfromusd-zero-decimal-token` should either be a direct candidate or a promoted candidate reaching verification.
   - The broad rejected cross-route hypotheses should not consume the only behavior-delta reserve slot when a more local predicate exists.
   - False-positive expectations must remain avoided.
   - Cost and model calls should stay close to run 14 because this plan changes ordering, not budget size.

## Stop Conditions

Stop and report back instead of improvising if:

- Implementing this requires increasing the global promotion budget to recover recall.
- The implementation needs language-specific parsing or domain-specific names.
- Existing broad-hint suppression tests start failing because broad speculative hints become eligible.
- The local behavior-delta test can only pass by hard-coding words from the Trails eval.
- The change requires weakening verifier gates or composer publication rules.

## Maintenance Notes

This plan keeps codeninja's intended architecture: Stage 7 can be nondeterministic, Stage 9 stays strict, and the harness recovers high-value missed candidates through bounded promotion. The important distinction is between a local, changed-symbol behavior predicate and a broad cross-system hypothesis. Future promotion changes should preserve that distinction and should be judged with funnel metrics: direct candidates, promoted candidates, verifier keep/reject, and false-positive expectations.
