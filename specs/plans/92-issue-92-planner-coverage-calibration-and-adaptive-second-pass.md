# Issue 92: Planner Coverage Calibration and the Adaptive Second Pass

Status: IMPLEMENTED — all three layers landed 2026-07-03; first measurement (run 0c4d5213/52) triggered the plan's stop conditions, fixes applied same day
Run-52 findings (first live run of layers 2+3): E1 escalated exactly the right packets (process_quote_test.go, balance_increase_test.go) with correct provenance — the mechanism works. But three interacting inflations produced the wave era's first budget soft-stop breach (6.27M tokens > 5.95M, completed_partial): (a) the planner itself assigned 14 deep packets (vs the usual 3-5 — coverage variance in the expensive direction), (b) the adaptive cap max(2, deepCount) scaled WITH that explosion to 16, and (c) T1 triggered on 19 packets because mentionsChangedScope's sameRoot leniency qualifies sibling-path hints — and the visible adaptive passes produced zero new candidates. Stop-condition fixes applied: T1 now requires the signal to reference the packet's own path or name a changed symbol (no sameRoot) and rejects broad follow-ups; the adaptive cap is a flat MAX_ADAPTIVE_PASSES_PER_RUN = 4; and a new ensemble guardrail caps ensembled packets at MAX_ENSEMBLED_PACKETS_PER_RUN = 8 (first-in-input-order, capped remainder disclosed via stage7_ensemble_packet_cap). Also noted: the escalated erc20 packet went [0,0] across its K=2 ensemble — even correctly-aimed redundancy is probabilistic, which is what the repeat rates are for.
Layer 2/3 notes: E1 (`applyCoverageEscalations`, `src/pipeline/coverage-escalation.ts`) floors packets with orphaned test-coverage deltas (deleted test symbols + surviving production refs/replacementRisk) to deep with upgraded tool budgets, `coverageEscalation` provenance, and `coverage_escalated` events; escalated packets inherit ensemble eligibility. E2 ships telemetry-only (`coverage_escalation_candidate` on refactor-claimed runs with production deletions), per the plan's weak-signal clause. Layer 3 (`runAdaptiveSecondWave` in lens-runner, dark behind `review.adaptiveSecondPass`): single-pass packets earn one extra independent pass on T1 (concrete near-miss hint/uncertainty — `isAdaptiveNearMissSignal` exported from the promotion lane's admission checks), T2 (silent with test-delta/static signals), or T3 (low-confidence-only output); capped at max(2, deep-packet count), trigger-priority T1>T2>T3; adaptive candidates carry `a2` id markers and pool through plan-84's exact-identity machinery; `stage7_adaptive_summary`/`stage7_adaptive_pass` telemetry; attention records report actual passesRun. One implementation hazard caught by tests: cloning single-pass results broke the stage-7 generation-stats WeakMap keying — results mutate in place.
Layer 1 notes: `buildAttentionRecords`/`aggregateAttentionEfficiency` (`src/pipeline/attention.ts`) join per-packet allotment (coverage, coverageSource planner|deterministic_default, ensemble passes) with production (direct/promoted candidates, hints, uncertainties, kept verdicts, published findings incl. merged-member credit). Written as `attention.json` (stage 10), emitted as an `attention_efficiency` event, loaded tolerantly into eval artifacts, surfaced as `metrics.attentionEfficiency`. Retro-computation for runs 46-50 appended to `specs/reviews/2-baseline-wave2.md`: deep yields ~2-3x normal per packet, but every matched expectation in all five runs came from a normal-coverage packet — the quantitative baseline Layers 2-3 must move.
Planned from: eval evidence `0c4d5213` runs 47/49/50 and `49f4645b` runs 26-32 (2026-07-03). The three consecutive `0c4d5213` failures each lost a *different* expectation through a *different* mechanism, but all three losses share one property: the losing packet was coverage `normal` (or unplanned deterministic-default) — outside every attention amplifier the pipeline has. Meanwhile plan 84's ensemble spent its redundancy on planner-`deep` packets that produced `[0,0]` in six of eight pass-runs across runs 49-50. Anchor exhibit (run 50): the packet that missed `amountfromusd-zero-decimal-token` emitted the follow-up hint *"Can originTokenForTotals.Decimals be 0 for a real origin token in the gas/bridge-gas fee path?"* — the missed finding verbatim, phrased as a question the pipeline had no mechanism to act on.
Planned at: commit `1de2f8c` (branch `next`)
Recommended priority: high — this is the decision-table outcome of plan 84 ("if misses are not deep-packet draws, revisit planner coverage assignment; do not raise K") and the last systematic loss mechanism visible in the post-wave ledger. Layer 1 is Wave-4-safe (zero behavior change) and should land immediately; layers 2-3 are Wave-3-style behavior changes, landed one at a time, measured.

## Problem

Stage 5's coverage assignment (deep/normal/light/skip) is the pipeline's attention-allocation decision: deep buys bigger tool budgets, more investigation rounds, earlier dispatch, and — since plan 84 — K ensemble passes. That allocation is currently mis-calibrated, and the miscalibration is now the dominant loss source:

- **Deep does not point at variance.** Runs 49-50: deep went to `helpers.go`, `process_quote.go`, `stargate.go`, `utils.go` — apparent complexity (large hunks, core-looking churn). Six of eight deep-packet ensemble runs produced zero candidates in both passes. Redundancy was provably spent on empty packets.
- **The flip-prone packets are normal or unplanned.** `balance_increase_test.go` (erc20, lost in 47 at generation and 49 at verification) is `normal` in every recorded run. `fee_calculator.go` (amountfromusd, lost in 50 at generation) has never appeared in the planner's explicit coverage list at all — it reviews under deterministic default. Run 44's erc20 loss was the planner *demoting* that packet deep→normal — coverage assignment itself is a sampled judgment with run-to-run variance and zero feedback.
- **The near-miss signal already exists in-run and is discarded.** Run 50's missed finding surfaced as a concrete-predicate follow-up hint from the very packet that failed to produce the candidate. Historically (runs 24/28/30), the promotion lane rescued exactly such hints — by fabricating a synthetic template candidate for the verifier to wrestle, the compensation machinery plan 81 documents. The signal is real; the response to it is the wrong mechanism.
- **No decision in the pipeline is less observable.** Every other major decision (gate, verdict, publication, budget) has per-decision telemetry and eval metrics. Coverage assignment has none: nothing records whether deep packets yielded anything or where matched expectations' packets sat. Miscalibration only becomes visible when an eval fails.

Root causes, named: (a) coverage is a one-draw LLM judgment with no floor from deterministic signals codegenie already computes; (b) the planner's "deep" prior tracks apparent complexity, not expected finding-variance; (c) attention is allocated entirely *a priori* — the pipeline never updates allocation on what pass 1 actually reveals.

## Goal

Attention lands where variance lives, on any codebase, without domain heuristics:

1. Coverage decisions are scored — attention efficiency is measurable per run and comparable across runs (the instrument).
2. A small set of deterministic, structural, codebase-agnostic escalators floor obviously-underweighted packets to deep (the prior).
3. Packets whose first pass shows near-miss evidence earn one additional real review pass, bounded by budget (the posterior). Redundancy follows observed uncertainty instead of prophecy.

## Design

### Layer 1 — score coverage decisions (measurement; zero behavior change; land first)

Per-packet attention record, joined at run end from existing artifacts (plan/packets/candidates/verification/composition):

```
attention: {
  packetId, path, coverage, coverageSource: "planner" | "deterministic_default" | "escalated:<rule>",
  ensemblePasses, candidates, hintsEmitted, uncertaintiesEmitted,
  gatePassed, verified, published
}
```

- Stage-7 `pipeline_metrics` gains yield-by-coverage totals (candidates/kept per deep vs normal vs default packet).
- Eval `info.json` metrics: for every matched (or lost) expectation, the producing packet's coverage + coverageSource + whether any amplifier (ensemble/adaptive pass) touched it. A run-level `attentionEfficiency` block makes runs 49/50's "deep yielded nothing, normal held the findings" shape a first-class, comparable number.
- The baseline for layers 2-3 A/Bs = these metrics on the current system (retroactively computable for runs 46-50 from artifacts; do so in the findings note).

### Layer 2 — deterministic structural escalators (tiny, codebase-agnostic, provenance-recorded)

Applied after the planner, before packetization — the same posture as the file classifier's deterministic rules: explainable, disclosed, never domain-specific. **No path/keyword/domain patterns** ("fee", "balance", token names are trails-api overfitting and are explicitly out). v1 ships exactly two escalators, each justified by measured evidence:

- **E1 — orphaned test-coverage delta:** the packet's `testCoverageDelta` shows deleted test symbols whose production references survive (`deletedTestSymbols` non-empty and `deletedProductionRefs`/`replacementRisk` indicate the exercised production code still exists). "Tests were deleted for code that still ships" is a borderline-finding factory in any language — it is the erc20 story, structurally. Floor: deep.
- **E2 — intent mismatch:** run-level `intentSignals.refactorLike` (or `explicitlyBehaviorPreserving`) together with packet-level behavior-relevant change signals — the fable review's "refactor that isn't" shape. Floor: deep. (If packet-level behavior signals prove too weak to bind deterministically, E2 ships as telemetry-only in v1 and escalates in v2 with Layer-1 data.)

Escalations record `coverageSource: "escalated:<rule>"` and a coverage reason, visible in the plan artifact and Layer-1 metrics. Escalated-to-deep packets are ensemble-eligible exactly like planner-deep ones (they inherit `deepEnsemblePasses`); the deep-packet count feeding budget expectations includes them.

### Layer 3 — the adaptive second pass (the general mechanism)

After the first Stage-7 wave completes, a packet earns **one** additional review pass — a genuine independent draw, not a synthetic candidate — when its first pass shows near-miss evidence:

- **T1:** it emitted an uncertainty or follow-up hint carrying a concrete failure predicate tied to changed scope (reuse the promotion lane's admission checks — `hasConcreteFailurePredicate`/changed-scope logic — as the concreteness test; run 50's hint passes, "verify X is fine" chaff does not); or
- **T2:** it emitted zero candidates while carrying substantial deterministic signal (non-empty `testCoverageDelta` deletions or bound static signals) — the "silent packet that should not be silent" shape; or
- **T3:** every candidate it emitted was `confidence: low` — the profile one draw away from the pre-gate boundary (run 36's shape).

Mechanics:

- Reuses plan 84's machinery end-to-end: the adaptive pass is an ordinary worker task with an ensemble pass marker (distinct id marker, e.g. `a2`, and `producedBy.ensemblePass`), pooled by the same outcome-identity grouping, deduped by the same exact-duplicate rule, budget-accounted identically. The hint that triggered T1 is NOT injected into the second pass's prompt in v1 — independence is the ensemble's entropy source, and injecting the hint would just re-create promotion-by-other-means; revisit only with measured evidence.
- Bounded: `review.adaptiveSecondPass: boolean` (default false — ships dark; eval cases opt in) plus a hard per-run cap on adaptive passes (default: the run's deep-packet count, and never more than `MAX_DEEP_ENSEMBLE_PASSES - 1` extra passes for any single packet). Adaptive passes dispatch after the first wave, so they land in the budget's mid-run zone, not the reserved tail.
- Telemetry: `stage7_adaptive_pass { packetId, trigger: "concrete_hint" | "silent_with_signal" | "low_confidence_only", produced }` plus Layer-1 attention records marking amplification.

### Why this is the architecture, not a patch

The adaptive pass subsumes the promotion lane's reason for existing: promotion fabricates a synthetic template candidate from a hint for the verifier to refute; the adaptive pass answers the same signal with another *real* draw from the model that produced it. If Layer 3 works, promotion volume decays naturally and plan 81's measurement-gated deletions become safe on their own evidence — the compensation stack (evidence-resolution lane, composer exemptions, human-attention suppression tiers) shrinks behind it. It composes with plan 84 rather than replacing it: planner/escalator deep = the prior allocation; adaptive passes = the posterior update. And it is codebase-agnostic by construction — every trigger keys on pipeline-internal signals (the model's own expressed uncertainty, structural coverage deltas), none on domain vocabulary.

## Non-Goals

- Domain/path keyword heuristics for coverage (overfitting; explicitly rejected).
- Raising `deepEnsemblePasses` or its cap (plan 84's decision table said don't).
- Rewriting the planner prompt wholesale (a targeted coverage-guidance line may ride with Layer 2 if Layer-1 data supports it; a prompt overhaul is its own measured change).
- Injecting first-pass output into second-pass prompts (breaks independence; promotion-by-other-means).
- Deleting the promotion lane in this plan (that remains plan 81's gated step, now with a mechanism that can earn it).

## In-Scope Files

- `src/pipeline/review-runner.ts` — escalator application post-planner; attention-record assembly.
- `src/pipeline/lens-runner.ts` — adaptive second-wave scheduling on plan-84 machinery.
- `src/pipeline/uncertainty-promotion.ts` — export/reuse the concreteness checks for T1 (no behavior change to promotion itself).
- `src/config/schema.ts`, `src/evals/eval-runner.ts`, `src/types.ts` — `review.adaptiveSecondPass` + cap; attention-record types.
- `src/telemetry/*`, `src/evals/eval-scoring.ts` — Layer-1 metrics, `attentionEfficiency`, expectation↔packet-coverage join.
- Tests: escalator unit tests (E1 fixtures from the erc20 shape), adaptive-trigger tests (T1 with run-50's hint shape; T2; T3), cap/budget tests, pooling reuse tests.
- Specs: architecture (coverage assignment section), review_pipeline (Stage-7 adaptive wave), PUNCHLIST.

## Implementation Steps

1. **Layer 1** (no behavior change): attention records + metrics + eval join; retro-compute for runs 46-50 into the findings note. Land alone.
2. **Layer 2**: E1 (and E2 or its telemetry-only variant) behind deterministic rules with provenance; unit fixtures; land alone; owner A/B (expect: erc20 packet becomes deep → ensembled; watch cost).
3. **Layer 3**: adaptive triggers + scheduling + cap behind `adaptiveSecondPass`; land dark; enable in eval cases; owner A/B.
4. Decision table on the repeat data:
   - amountfromusd/erc20 candidate-recall up, cost within budget → keep; consider defaults.
   - Adaptive passes fire but produce nothing → tighten T1 to predicate-only, drop T2/T3, re-measure.
   - Candidate recall up but final recall flat → losses moved to verification judgment; that is the verifier-calibration conversation (separate plan), not more generation.
   - Promotion conversions drop to ~zero with Layer 3 on → execute plan 81's gated deletions on that evidence.

## Validation

- Layer 1: metrics reproduce the known runs-49/50 shape (deep yield ~0, losses on normal/default packets) — the instrument agrees with the forensics that motivated it.
- Layers 2-3 (owner-run repeats, current baseline vs +L2 vs +L2+L3): `candidateRecallRate` on `amountfromusd-zero-decimal-token` and `erc20-balanceof-test-coverage` up; `attentionEfficiency` up (yield per amplified pass); `should_not_find` unchanged; per-run cost delta ≤ the adaptive cap's worst case (~deep-packet-count extra reviews); no dispatch blocks or reserved-tail squeeze.
- Run-50 replay sanity: under L3, the `a81d5adf` packet's concrete hint triggers T1.

## Done Criteria

- Coverage decisions are scored on every run; attention efficiency is a first-class eval metric.
- Escalators and adaptive passes observable end-to-end (provenance, triggers, pass attribution) and capped.
- Measured recall improvement on at least one of the two flip expectations with flat false positives and bounded cost — or a documented negative result that redirects the next lever (per the decision table).

## Stop Conditions

- If adaptive passes inflate cost past the cap's projection or squeeze verification (budget telemetry), restrict to T1-only before touching the cap.
- If second passes on triggered packets still miss (the finding needs more than another draw — e.g. cross-packet context), stop: that is seed-context/planner-context work, not more sampling.
- If escalators over-fire on large repos (many test-delta packets), bound E1 by packet count percentile before shipping defaults — never let the floor rules triple deep volume silently.
