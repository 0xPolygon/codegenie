# Issue 84: Stage-7 Ensemble Review for Deep Packets

Status: IMPLEMENTED (2026-07-02) — shipped dark; measurement (K=3 repeat study vs the Wave-2/3 baseline) pending, owner-run
Implementation notes: `review.deepEnsemblePasses` (default 1 = off; user config + eval `review:` block). Eligibility: `coverage: "deep"` only. Each pass is an ordinary worker task (own workerId, own per-worker session key, ordinary budget accounting; deep packets still dispatch first). Pass-2+ candidate ids carry an `e{k}` marker (`packet-d-e2f1`) so ids never collide and pass attribution is greppable; `producedBy.ensemblePass` records the pass on every ensemble candidate. Pooling: candidates union under the verifier's exported exact-duplicate identity (`isExactDuplicateCandidate` — same rule as plan 87, so wording-variant near-duplicates stay separate for the verifier to absorb); hints/uncertainties dedupe by normalized question under the existing per-packet caps; per-pass generation stats summed. Failure semantics: a failed/skipped pass drops out of the pool; any completed pass ⇒ packet completed. Telemetry: per-packet `stage7_ensemble { passes, completedPasses, candidatesPerPass, uniqueAfterDedupe, duplicatesPooled }`. Scorer attribution is id/producer-based (no scorer changes needed for v1 measurement). The after-study decision table in step 4 governs defaults.
Planned from: fable review §6.10/§4 and memory note `stage7-recall-bottleneck`; eval evidence: 49f4645b is a 43% coin flip on one finding across 24 runs (fable §5.1); runs 24 vs 25 found the identical bug via different lanes with different quality; 0c4d5213 runs 42-44 lost different expectations to Stage-7 draw variance (hint-lane leak, planner coverage demotion, severity draw), 2026-07-01
Planned at: commit `73ef963` (branch `next`)
Recommended priority: the recall lever. Every single-mechanism recall patch in the plan history (33/36 tighten → 40/43/44 loosen, 56-65 questions → 66 removal) moved variance around instead of reducing it. Redundancy is the only mechanism that directly attacks draw variance, and the verifier is proven strong enough to absorb the extra candidates (fable §6.10).

## Problem

Material-bug recall is gated by per-run Stage-7 sampling variance, not by missing context or machinery (plan 79's diagnosis, confirmed by this week's runs: the same packets produce a concrete candidate on one run and template hints or nothing on the next, with identical config, model, and `--no-cache`). One review pass per packet means one draw; the eval pass rate *is* the draw probability.

## Goal

For the packets where it matters (deep coverage / high priority), replace one draw with N independent draws whose union feeds the existing verification gate — converting a per-run miss probability p into p^N at bounded cost, with no change to Stage 9's precision role ("generate liberally, verify strictly" is already the validated posture).

## Dependency: Issue 79 first

The harness must exist before this lands, for three reasons:
1. **Baseline:** per-expectation `candidateRecallRate` / `finalRecallRate` over N≥10 repeats defines the current draw probability; without it the ensemble's effect is unmeasurable (the exact trap plans 33-44 fell into).
2. **Sizing:** N and the packet-eligibility rule (deep-only vs deep+high-priority) should be chosen from measured per-expectation rates, not guessed.
3. **Verification:** the after-study uses the same instrument.

## Design

1. **Eligibility:** packets with `coverage: "deep"` (optionally `priority: high+`) run K parallel Stage-7 review passes instead of 1. Start K=3 for deep packets (0c4d5213 assigns deep to 3-5 of ~73 packets; 49f4645b to a similar fraction of 5 — cost bounded to a few extra packet-reviews per run). Normal/light packets are untouched.
2. **Independence:** passes share the packet input but run as separate worker tasks with separate conversations. No pass sees another's output. Vary nothing else (same prompt, same budget) — variance in the model's sampling is the ensemble's entropy source; do not add prompt jitter in v1.
3. **Union + dedupe:** candidates from all passes pool per packet; dedupe by per-finding fingerprint (Issue 83's stable identity — soft dependency; near-duplicate candidates that differ only in wording also cluster at the verifier's exact-duplicate rule). FollowUpHints/uncertainties: union with the existing `followUpHintKey` dedup.
4. **Stage 9 unchanged.** The union feeds the same gate/verification path. Expected extra verifier load is bounded: deep packets are few and mostly produce 0-2 candidates per pass; the verifier absorbing look-alikes is its job and its strength (fable §5.1: verifier is not the recall problem).
5. **Budgets:** ensemble passes count as ordinary packet reviews for runtime/token budgets, so the budget-stop machinery (dispatch ordering, reserved tail, `--max-time`) applies unchanged. Deep packets already dispatch first, so ensemble work lands early in the run, not in the squeeze zone.
6. **Telemetry:** per-packet `ensemble { passes, candidatesPerPass, uniqueAfterDedupe, unionKept }`; per-expectation attribution in the eval scorer (which pass produced the matching candidate) so the harness can report marginal value of pass 2 and 3.
7. **Config:** `review.deepEnsemblePasses` (default 1 = off; eval cases opt in via the existing eval `review:` block). Ship dark, enable per-eval, measure, then consider a default.

## Non-Goals

- Cross-provider ensembles ("gigabrain mode") — same-model ensemble first; redundancy pays regardless of provider (fable §4 TODO note), and cross-provider adds the protocol-parity confound (fable §5.2.4).
- Ensembling normal-coverage packets (cost; revisit only with harness data showing misses concentrate outside deep packets — note run 44's erc20 miss was a planner *demotion* to normal, which is a planner-stability question for the 79 study, not an ensemble-scope question).
- Best-of-N selection/judging between passes (union + existing verification is the design; a judge stage re-introduces a single point of variance).

## In-Scope Files

- `src/pipeline/lens-runner.ts` — schedule K passes per eligible packet; pool results.
- `src/pipeline/worker-runner.ts` — no structural change expected (passes are ordinary tasks); confirm workerId uniqueness per pass.
- Candidate dedup at the pooling point (fingerprint-based; reuse verifier exact-duplicate helpers).
- `src/config/schema.ts` / `src/evals/eval-runner.ts` — `deepEnsemblePasses` config + eval override.
- `src/telemetry/*`, `src/evals/eval-scoring.ts` — ensemble telemetry and per-pass attribution.
- Tests: pooling/dedup unit tests; pipeline fixture with a deterministic fake runner emitting different candidates per pass → union verified once each.

## Implementation Steps

1. Land Issue 79; run the baseline study (`repeat: 10` on 49f4645b and 0c4d5213) — record per-expectation candidate/final recall rates.
2. Implement eligibility + K-pass scheduling + pooling/dedup behind `deepEnsemblePasses`.
3. Telemetry + scorer attribution.
4. After-study: same repeats with K=3. Decision table: finalRecallRate up and cost within budget → keep; candidate rate up but final rate flat → the loss moved to Stage 9/10, investigate gate/composition before raising K; both flat → the misses are not deep-packet draws (revisit planner coverage stability instead).
5. Only then consider defaults / K tuning / high-priority-normal eligibility.

## Validation

- 49f4645b `finalRecallRate` moves toward the measured candidate ceiling (baseline: pass runs produce the candidate; failing runs don't — K=3 should push candidate presence to ~1-(1-p)^3).
- Cost: deep-packet ensemble adds ≤ K-1 × (deep packet count) packet-reviews; confirm `maxCostUSD` margins on both cases.
- No `should_not_find` regressions across the repeat set (the false-positive guard is currently 33/33 — it must stay).
- Verification is not budget-squeezed by the union (watch `verificationBudgetLimited` / `budget_limited` incompletes on the repeat set).

## Done Criteria

- Measured, repeat-based recall improvement on at least one coin-flip expectation with flat false-positive rate and bounded cost.
- Ensemble observable end-to-end in telemetry (passes → union → verification → final attribution).
- Off by default; enabled per eval case with documented cost.

## Stop Conditions

- If K=3 on deep packets does not move candidate-level recall on the coin-flip case, do not raise K — the variance is elsewhere (planner coverage assignment, lane routing); take the evidence back to plan-79 data.
- If verifier load or cost breaches case budgets, restrict eligibility (deep+high only) before shrinking K.
