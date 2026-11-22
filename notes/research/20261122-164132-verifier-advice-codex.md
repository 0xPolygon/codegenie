---
created: 2026-11-22T16:41:32Z
author: architect-2
source: "Plan 131, frozen verifier inputs, downstream artifacts, public oracles and source at the reviewed revisions."
status: provisional
---

# Retain verifier advice labels after the plan 131 stop

**Stop the experiment and retain the current labels.** On the public go-06 input, B published a wholly false finding once in three draws. A rejected the same candidate in all three. This meets the registered stop condition for a false B publication unique to B on an input. The low severity was sufficient on this positive case. The three draws establish the decision under the rule. They provide little precision about how often the treatment would cause such an outcome. [Registered comparison and decision rules](../../specs/plans/131-issue-146-verifier-advice-comparison.md)

The finding claimed that the hardware coverage manifest named a nonexistent source. The census scanner calls `scanTree(t, root, "goinfer", found)`. Under that convention, `goinfer/metal/workingset.go` refers to the existing file `metal/workingset.go`. The manifest uses the prefix on 27 file references, including all three listed on this entry. Removing it would introduce an inconsistency. The finding reached users in B draw 1, with a proposed edit. Both verifiers rejected it in draws 2 and 3. No review of this input published the required speculative-page accounting defect.

I originally marked the path edit valid after checking the file on disk. The other analyst identified the scanner convention. I verified it at the pinned head and corrected my finding and advice classifications, preserving both original worksheets. The corrected classification is a reconciliation. I also saw arm-labelled finding summaries before completing my first go-06 advice worksheet, which weakens blinding for that pair.

The two analyses agree on the stop, sample, spend and verifier health. We differ on three B cleanup fixes on go-06. I count those as wrong, giving B 7/54 wrong classifiable published fixes. The other analyst counts them as valid close calls, giving B 4/54 on the same denominator. Both analyses set aside the six disputed go-05 picker fixes. [Independent analysis and reconciliation](20261122-165831-verifier-advice-independent-analysis.md)

## Sample and cost

A used `a3437f2ff68f092846b01103b0af6635ca62c979`, B used `1607a8bc2b105f35f8b40b429aec3fa3ce85677c`. Both included the runaway-argument detector and predated #165. Stage 9 and Stage 10 were rerun on the same frozen upstream input in each pair. B changed verifier output and removed the advice labels from composition.

| Luna high | A | B |
| --- | ---: | ---: |
| Completed reviews | 70 | 70 |
| Public reviews, 20 inputs and three draws each | 60 | 60 |
| Existing captures, two inputs and five draws each | 10 | 10 |
| Priced downstream spend | $1.22822 | $0.90563 |
| Additional unpriced calls | 3 | 1 |

The stop left 108 of 248 Luna slots unrun. Total known Luna spend was $2.13385. The three unpriced A calls were Stage 9 aborts, and the unpriced B call was a Stage 10 timeout. The four reservations totalled $1.434 against the $10 ceiling. The registered nine-control sample is incomplete.

## Advice visible to the reader

I scored each distinct published fix or test section against the public source, tracking withheld suggestions separately. The table gives wrong suggestions over all classifiable suggestions in each cell. Six published go-05 picker fixes are disputed and reported separately, three per arm. Those six would bring the published-fix denominators to 46 and 57. No advice was withheld in B.

| Public Luna advice | A published | B published | A withheld |
| --- | ---: | ---: | ---: |
| Fix | 1/43 | 7/54 | 2/6 |
| Test | 0/34 | 0/37 | 0/2 |

The seven wrong B fixes came from three distinct claims. Three would remove an intentional credential check on cg-01. One would change the valid coverage path on go-06. Three conditioned group cleanup on the leader still running on go-06, which can leave a child in the process group alive. I classified that last remedy as wrong because the recommendation can skip the group signal entirely. At the same time, catching a vanished-group error while preserving signaling is a valid fix. Repeat draws are correlated.

A’s wrong published fix on go-05 copied a first-prompt boundary when the copy stopped one token short of the complete prompt. This permits different conversations to inherit that boundary. The other analyst revised their original judgment after comparing the fixes. A withheld the wrong cg-01 fix twice, both on the same input. It also withheld four valid fixes and two valid tests. This is evidence that the existing gate sometimes helps and sometimes hides useful advice. The stop on the false finding decides this experiment independently of the withheld-share comparison.

Among composed public finding groups, A lacked published fix advice on 12/58 and test advice on 24/58. B lacked fix advice on 6/63 and test advice on 26/63. An A public fallback accounted for five further groups. Fallback content and the two existing captures are outside these public advice-quality cells.

## Verifier and composer health at the stop

| Luna Stage 9 | A | B |
| --- | ---: | ---: |
| Logical verifier requests | 197 | 197 |
| Physical calls | 732 | 686 |
| Keep / revise / reject | 45 / 101 / 51 | 73 / 72 / 52 |
| Deterministically suppressed / incomplete verdicts | 11 / 0 | 11 / 0 |
| Proof established / unresolved / refuted | 147 / 22 / 28 | 145 / 17 / 35 |
| Whitespace-detector trips per 100 requests | 3/197 (1.52) | 0/197 (0) |
| Field repairs scheduled per 100 requests | 7/197 (3.55) | 0/197 (0) |
| Calls exceeding 64,000 argument characters / Stage 9 timeouts | 0 / 0 | 0 / 0 |
| Largest recorded argument stream, characters | 8,467 | 4,632 |
| Stage 9 priced spend | $0.9846 | $0.7399 |
| Stage 9 summed wall time | 3,222 s | 2,013 s |
| Mean wall time per input, public / existing | 34.0 / 118.2 s | 20.9 / 76.2 s |

Wall time includes the observed stage from start through completion. The per-input comparison averages draws within an input and then weights inputs equally. Empty captures are observations. B reduced repair work and elapsed time on this stopped sample. A stopped three whitespace streams before they reached the 64,000-character proxy. The detector and the size threshold measure different events.

| Public input | A mean seconds | B mean seconds |
| --- | ---: | ---: |
| cg-01 / cg-02 | 47.1 / 56.6 | 36.7 / 26.0 |
| cg-03 / cg-04 | 0.0 / 0.0 | 0.0 / 0.0 |
| cg-05 / cg-06 | 53.9 / 20.6 | 26.9 / 15.4 |
| cg-07 / cg-08 | 13.5 / 46.1 | 16.1 / 31.2 |
| cg-09 / cg-10 | 0.0 / 56.5 | 0.0 / 35.9 |
| cg-n1 through cg-n4, each | 0.0 | 0.0 |
| go-01 / go-02 | 80.5 / 52.5 | 37.6 / 31.8 |
| go-03 / go-04 | 51.3 / 71.6 | 39.1 / 48.5 |
| go-05 / go-06 | 77.3 / 52.4 | 47.3 / 24.7 |

On the larger existing capture, Stage 9 averaged 166.9 s on A and 122.4 s on B. On the smaller capture the means were 69.5 s and 29.9 s. The larger input's first registered cause published in all five draws per arm. Its second registered cause published in four A and three B draws, but a change in user-visible request success for that cause remains disputed.

At Stage 10, first submissions were invalid in 5/60 public reviews on A and 1/60 on B. On the two existing captures they were invalid in 4/10 and 2/10. One A public review and one B existing-capture review used fallback. On the latter the published result lost composed advice. These figures describe the experiment’s older composer pins.

## Incomplete Opus cross-check

Only three Opus slots qualified for quality analysis. On cg-10 A published the required primitive-rejection finding and B rejected it over a reachability doubt. One draw per arm leaves attribution unresolved. Across the qualified public slots A published one wrong fix and one valid test, and B published three valid fixes and two valid tests. These cells cover different input mixes. Four further receipts, including a failed attempt, were pricing-only. Total priced Opus spend was $3.05787. The forecast of $29.60 exceeded the separate $25 ceiling, so the remaining Opus slots did not run. Opus did not contribute to the Luna stop or its quality rates.
