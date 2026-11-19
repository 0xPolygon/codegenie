---
created: 2026-11-19T20:31:32Z
author: architect
source: "https://github.com/0xPolygon/codegenie/issues/44 (workstream A addendum: stored-run measurements, and reply to notes/research/20261119-202431-challenge-pipeline-architecture.md)"
status: provisional
---

# Pipeline architecture addendum: what the stored runs say, and replies to the challenge

This amends [the workstream A note](20261119-202121-pipeline-architecture.md). It does two things: it answers that note's open frequency questions from stored eval runs, and it records how @lead-dev's challenge changes sections 5 and 6. Where this addendum and the original disagree, this addendum is the current position.

**Data.** 203 stored runs with telemetry from two private eval cases on one repository, 2026-06-14 to 2026-09-25, codegenie from the first recorded builds through 0.6.3. The owner approved read-only use on 2026-11-19. Only counts and rates appear here. I group runs by version: *early* (55 runs from 2026-06-14 to 06-20 whose eval record carries no version), *0.1–0.4* (56), *0.5.x* (48), *0.6.x* (44). No run is on 0.7.0 or 0.8.0. No model was called.

## 1. What changed in my conclusions

1. **The confidence gate is no longer where found bugs are lost; the data says it is now nearly inert.** A verifier-kept finding was suppressed for low confidence in 8 runs up to 0.5.5 and in 0 of 44 runs on 0.6.x. I ranked this first as a recall fix. It is now a simplification: removing the post-verification gate would have changed nothing in the latest 44 runs.
2. **On the cases being run, recall is at the ceiling, so the suite can no longer say where the next loss is.** All 43 scored expectations on 0.6.x passed. All six failing 0.6.x runs failed a cost, time or completeness limit, not a finding. But every 0.6.x run is on the smaller case, which has one expected finding; the larger case was last run on 0.5.5 (2026-08-05).
3. **The shipped default is unmeasured, confirmed.** Every one of the 92 runs on 0.5.x and 0.6.x had the adaptive second pass on. The product default is off. No stored run since 0.4.x used the configuration users get.
4. **Stage 8 has not fired in 145 consecutive runs** and has never produced a candidate in any stored run.
5. **Reliability, not recall, is the visible problem in the newest runs:** the composer fell back to the deterministic report in 7 of 44 runs on 0.6.x, and 33 of 43 runs ended with at least one unresolved note.

## 2. The frequency questions

### Stage 8 targeted review

| | Early | 0.1–0.4 | 0.5.x | 0.6.x |
|---|---|---|---|---|
| Runs with a stage-8 record | 47 | 54 | 48 | 43 |
| Runs where it made a model call | 9 | 0 | 0 | 0 |
| Candidates it produced | 0 | 0 | 0 | 0 |

In the nine early runs it resolved hints and produced no finding. Since then the trigger has never been met. @lead-dev is right that a low fire rate alone does not justify deletion; the stronger fact is that across 203 runs it never added a candidate, and when it did run its only effect was to remove hints — the unevidenced suppression his challenge describes.

### The low-confidence escape route

| | Early | 0.1–0.4 | 0.5.x | 0.6.x |
|---|---|---|---|---|
| Runs where the hatch published a finding | 3 | 4 | 4 | 2 |
| Verifier-kept findings suppressed for confidence (a ninth suppression predates the exception) | 0 | 4 | 4 | 0 |
| Runs with such a suppression | 0 | 4 | 4 | 0 |

The eight suppressed findings were medium (7) or low (1) severity; seven came from promotion. Three of the eight runs are the known 0.5.x failures where the report said nothing was wrong. On 0.6.x the verdict mix moved from keep to revise (227 revise against 60 keep), which means the verifier now restates confidence on most survivors; that is the likely reason the gate stopped biting.

A keep or revise with `falsePositiveRisk: high` occurred once in 203 runs.

### Evidence-lane overflow

Zero in all 203 runs. The lane verified 215 candidates and kept 53 (25%); its cap of four never bound. The pre-verification gate itself suppressed 14 candidates in total, 3 of them on 0.6.x.

### Is the shipped default measured?

| | Early | 0.1–0.4 | 0.5.x | 0.6.x |
|---|---|---|---|---|
| Adaptive pass on | 0 | 28 | 48 | 44 |
| Adaptive pass off, K=1 (the shipped default) | 55 | 24 | 0 | 0 |
| Local model cache on | 19 | 0 | 0 | 0 |

How much the adaptive pass matters on 0.6.x:

- It was scheduled in 35 of 44 runs: 131 passes, of which 108 produced at least one candidate.
- Of 80 published findings, 70 had a member from the first pass. Ten did not: seven existed only because of the adaptive pass and three only because of promotion. Nine runs had at least one such finding.
- So roughly one published finding in eleven would be absent under the shipped default, on a case where the default was never run.

The cache collision @lead-dev reproduced did **not** contaminate these numbers: no run had both the cache and the adaptive pass on.

## 3. Other measurements that bear on the recommendations

**Promotion.** Kept rate (keep or revise) of promoted candidates: 22% on 0.1–0.4, 30% on 0.5.x, 18% on 0.6.x. By selection rule, all eras: ranked selection 54 kept of 214 (25%); the local-behaviour-delta reserve 15 kept of 71 (21%), and on 0.6.x 3 of 29 (10%) against 10 of 42 (24%). The reserve does not select better candidates than plain ranking. The counterfactual is not known — the pick it displaced might also have been rejected — so this supports testing its removal, not removing it blind.

**Incomplete verification.** 0.5.x: 20 incomplete against 351 completed verdicts (12 worker timeouts, 7 schema failures, 1 other). 0.6.x: 5 against 381 (4 schema failures, 1 timeout). None was a transient provider error.

**Stage 7 deterministic submit cleanup.** On 0.6.x it was attempted twice across 35 invalid submits and recovered none; the model repair recovered 82 times. Early runs show the opposite (51 of 51), from a version of the code that no longer exists.

**Notes and reconciliation (0.6.x).** 26 runs had the evidence-backed reconciliation. Of 86 concerns supplied to the composer, 4 were resolved and 18 narrowed. 33 of 43 runs emitted at least one note, 81 notes in all.

**Composition mode (0.6.x).** Model-composed in 36 runs, deterministic fallback in 6, schema-repair fallback in 1. Five of the seven fallbacks were on one model family.

**The gate-only anchor.** The "representative anchor withheld" event fired 85 times up to 0.5.x and 0 times in 44 runs on 0.6.x, matching the code reading that nothing assigns that anchor source any more.

**Planner skips.** 18 hunks in 18 of 48 runs on 0.5.x; 2 hunks in 2 of 44 runs on 0.6.x.

**Where expectations were lost, by scorer label.** Early: 6 missed before a candidate, 5 at verification, 3 at composition, 6 partial matches. 0.1–0.4: 8, 4, 0, 5. 0.5.x: 1, 2, 3, 0. 0.6.x: none. No `should_not_find` violation in any run.

**Cost of the stored configuration on a small change (0.6.x, adaptive pass on, five packets, medians).** This is not the shipped default, which has the adaptive pass off and is unmeasured. The strongest model in the set: 77 model calls, about 9 minutes, about $9.40. The fastest: 35 calls, under 3 minutes, about $3. The cheapest: 91–94 calls, 18–26 minutes, $0.40–$0.50. Fifteen or more model calls per packet is the number a fast lane has to beat. @architect-2's census of 37 complete runs in the same group puts the median share of elapsed time at 31.5% for stage 7 and 38.5% for stage 9, and of cost at 42% and 46%: on small changes verification, not packet review, is the largest stage.

## 4. Replies to the challenge

| Point | Reply |
|---|---|
| **B1 must be split; fix the verdict contract first.** | **Accepted.** Order: (a) reject a keep with high false-positive risk, as the spec says — one affected verdict in 203 runs; (b) stop synthetic `verify=false` keeps from qualifying for the verified exception, which the challenger's probe showed publishing an unverified low-confidence candidate inline; (c) only then remove the post-verification confidence gate and both hatches. Step (c) is now a deletion with no observed effect on 44 recent runs, and its risk is on repositories and models the suite does not cover. The pre-verification lane is a separate question and I withdraw any suggestion to widen it: it suppressed 3 candidates in 44 runs and never overflowed. |
| **Stage 8 can remove a question without evidence.** | **Accepted, and it strengthens the case against stage 8.** Removing concerns was the only thing stage 8 did in the nine runs where it ran. |
| **A planner skip loses its path and reason in the report.** | **Accepted.** My statement that a skip is "counted and listed" was wrong for the report: it is counted, and only the artifact lists it. This supports issue #31. |
| **B4 also affects standard packets.** | **Accepted.** The fix is to decide escalation before the profile, lens and context choices, not to patch the budget afterwards. |
| **B3: build the fallback only on the failure path.** | **Accepted;** that is what I meant. Fallback does not complete note reconciliation, so concerns stay open under it. |
| **B2 and the verifier retry.** | **Accepted; I withdraw the retry recommendation.** Stored incompletes are timeouts and schema failures, which a worker restart does not fix cheaply. With zero overflow in 203 runs, the simplest B2 is to delete the lane cap; if it stays, overflow must count as skipped verification. |
| **B5: test lineage across sparse update, full payload and cluster; related signals reach the verifier prompt.** | **Accepted.** Deleting the related-signal association needs a before-and-after prompt projection, as I noted. |
| **B6: the two default-lens functions differ in inputs too.** | **Accepted.** It stays a decision, not a refactor. |
| **Section 6 priority cannot be established from old studies.** | **Accepted, and the stored runs go further:** on current cases there is no measured loss to rank. Section 5 below replaces the ranking. |

One point I keep: the composer may resolve a note against a finding that caps then suppress ([my challenge note](20261119-202605-challenge-code-audit-tests-evals.md), item 1). With the confidence gate inert on recent runs this is a latent path, and removing the gate (step c) closes it.

## 5. Revised ranking for the synthesis

1. **Re-baseline on master in the shipped default, and run the larger case again.** Nothing else can be ranked honestly until this exists. It needs paid runs and approval.
2. **Decide the adaptive pass:** default it on, which ships what was measured, or measure the default without it. One published finding in eleven depends on it.
3. **Delete what the data shows is inert:** stage 8 (never produced a candidate), the gate-only anchor code (no producer), the stage-7 candidate cleanup (0 recoveries), the legacy note suppression (already unreachable), and, after steps (a) and (b), the post-verification confidence gate with both hatches.
4. **Fix the confirmed bugs** (sent separately to @operator): escalation profile, composer-failure report, lost fallback banner, hatch bypassing `minInlineConfidence`, `verify=false` qualifying for the verified exception, provenance lost on revise.
5. **Make the suite able to see the next loss:** a second repository and language, a false-positive rate from the unmatched findings the scorer already computes, and at least one case hard enough to fail.
6. **Then the measured-but-open mechanisms:** the promotion reserve (no better than ranking), note reconciliation (4 of 86 resolved), verifier remedy assessment, packet enrichment, planner depth.

The fast lane sits beside this list, not inside it; workstream B owns it. The fact it should start from is in section 3: the stored adaptive-on configuration spends 77 calls and about nine minutes on a five-packet change, and the shipped default has never been timed.
