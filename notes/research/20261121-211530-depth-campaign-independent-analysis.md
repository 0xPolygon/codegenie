---
created: 2026-11-21T21:15:30Z
author: "architect"
source: "Requested by the operator under the owner's 2026-11-21 directive on independent campaign analyses. Read-only scripts over the telemetry of the 49 depth-campaign reviews on codegenie 54db64b; frozen case expectations. Written before reading the other analyst's worksheets or results."
status: verified
---

# Depth campaign: independent analysis

**Neither rule for changing the default is met. Deep found no required finding that normal missed. Light is faster on the registered measure but no cheaper, and it loses a required finding.** Under the pre-registered rules that leaves one mode with today's normal budgets, so the depth setting can be removed rather than renamed. The larger lessons are elsewhere: Stage 9 rejects the harder required findings, and on Luna Stage 10 rarely produces a valid first submission.

Reconciled with [the other independent analysis](20261121-211400-depth-campaign-independent-codex.md). Both reach one mode at today's normal budgets, from the same required-finding counts per arm and model, cost and time medians, partial causes, padded-call splits, three Stage 10 fallbacks and six false scorer credits. They differ in three places, none of which changes the decision: that note keeps the name deep for the single mode, where this one removes the setting, which is what the operator decided after both analyses; it counts hunks named in the plan, where this one counts coverage after defaults; and under source adjudication it finds an Opus hint for the TypeScript seeded defect in 5 of 9 reviews, where this note's topic mapping first said 7. That note also checked all 177 published entries against the source and found none false, which this one did not do. This note first read light as failing the time limb once padded calls were set aside; the registered measure is the raw median, so that was corrected in review and the two notes agree. [Campaign plan](../../specs/plans/128-issue-124-stage9-and-depth-campaign.md)

## What ran

49 reviews on build `54db64b`: normal depth (A), deep (B) and light (L), adaptive off in all. Luna ran at high reasoning, five repetitions per arm per case; Opus ran three. One small-case Luna review was a price pilot. 45 of 49 have full debug traces. This build predates the fix for whitespace-padded calls (#143).

| | Reviews | Recorded USD |
| --- | ---: | ---: |
| Luna | 31 | 5.62 |
| Opus | 18 | 132.74 |
| Total | 49 | 138.36 |

Expected findings are mapped by topic from the frozen case files. I did not re-verify every published claim against the source, so this note gives no false-positive count.

## The two decision rules

### Deep against normal

| Case, model | Required finding | Normal | Deep |
| --- | --- | ---: | ---: |
| Larger, Luna | Required 1 | 5 / 5 | 5 / 5 |
| Larger, Luna | Required 2 | 4 / 5 | 4 / 5 |
| Larger, Opus | Required 1 | 3 / 3 | 3 / 3 |
| Larger, Opus | Required 2 | 1 / 3 | 0 / 3 |
| TypeScript, Luna | Seeded defect | 0 / 5 | 0 / 5 |
| TypeScript, Opus | Seeded defect | 1 / 3 | 0 / 3 |

- Deep gains nothing on Luna and is one detection lower on Opus in both cases. Each Opus difference is a single review.
- Deep does what it is built to do in Stage 7: tool calls rise 8% on Luna and 21% on Opus, and candidates rise by one. It costs 9% more on Luna and 1% less on Opus.
- Partial reviews: one in each arm on the larger Luna case, none elsewhere. The longest review took 18.7 minutes.
- The rule needs a gain on Luna that Opus does not reverse. There is none, so the result is "tied or too sparse": deep gets no recall claim, and the 1.5x budget has no evidence behind it.

### Light against the 30% bar (larger case)

| Model | Median USD, normal | Median USD, light | Change |
| --- | ---: | ---: | ---: |
| Luna | 0.320 | 0.318 | -1% |
| Opus | 14.06 | 13.68 | -3% |

- Cost does not move. Light halves Stage 7 tool calls (421 to 186 on Luna, 181 to 113 on Opus), but tool calls are not what a review costs: Stage 7 cost falls 13% on Luna and rises 2% on Opus.
- Raw elapsed time on Luna is 41% lower (8.3 against 14.0 minutes), which meets the registered 30% bar on time. Among reviews without a padded call, light takes 6.9 minutes against 8.6, 19% lower, so much of the raw gap comes from which reviews hit one. On Opus it is 5% lower.
- Detections are not held. Required 2 on Luna is published in 2 of 5 light reviews against 4 of 5 normal ones.
- Light misses the fast criteria because required detections are not held (Required 2 is 2 of 5 against 4 of 5) and its cost saving is 1 to 3%. On raw elapsed time, the registered measure, it is about 41% faster (8.3 against 14.0 minutes) and passes that limb; with padded calls set aside the gain is 19%, which is a sensitivity result.

## Stage 5: planner

- Cost is negligible on Luna (under one cent) and about 2.5% of an Opus review. It takes under a minute.
- The plan lists only part of the diff. On the larger case Luna listed 20 to 40 of 131 hunks in 14 of 15 reviews; Opus listed 34 to 55. Unlisted hunks default to normal coverage. Planning was flagged degraded in 6 of 15 larger Luna reviews and in no Opus review.
- **The plans show no consistent shift with the depth setting, but the label's effect is unresolved.** Share of hunks at deep coverage, after unlisted hunks default to normal:

  | Model | Normal | Deep | Light |
  | --- | ---: | ---: | ---: |
  | Luna | 26% | 19% | 23% |
  | Opus | 19% | 24% | 18% |

- Assignments did differ between arms. Hunks the plans named at deep coverage, summed over the five larger Luna reviews: 128 under normal, 78 under deep and 92 under light.
- Luna never assigned light coverage (0 of 1,965 hunk instances). Opus used it for 4%.
- Every eligible hunk was dispatched: 1,964 of 1,965 on Luna and 1,179 of 1,179 on Opus were reviewed.

## Stage 6: packets

- 73 packets in every larger review, in every arm and on both models.
- 76 of the 131 hunks sit in packets whose context was degraded, in 23 of the 24 larger reviews (74 in the other). This is a property of the case and the context budget, not of an arm or a model.

## Stage 7: packet review

Medians on the larger case:

| | Luna normal | Luna deep | Luna light | Opus normal | Opus deep | Opus light |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| USD | 0.234 | 0.242 | 0.204 | 9.70 | 10.04 | 9.91 |
| Minutes | 3.4 | 4.1 | 2.7 | 2.8 | 3.2 | 2.5 |
| Model calls | 226 | 251 | 183 | 200 | 222 | 164 |
| Tool calls | 421 | 453 | 186 | 181 | 219 | 113 |
| Packets at the tool soft target (of 73) | 45 | 36 | 58 | 32 | 20 | 50 |
| Candidates | 15 | 16 | 18 | 13 | 14 | 14 |

- Stage 7 is about 70% of the cost of a review on both models.
- Tool-budget refusals at the hard ceiling: Luna 0 in normal, 5 in deep, 11 in light. Opus none.
- Schema-invalid calls: Luna 98 of 3,326 (2.9%), Opus 0 of 1,760.
- Where required findings are missed before verification:
  - Required 2 was a candidate in 14 of 15 Luna reviews, and in 5 of 9 Opus reviews.
  - Optional 1 was never a candidate on Luna and was one in 2 of 9 Opus reviews.
  - The TypeScript seeded defect was never a candidate on Luna (0 of 15). Luna instead published a different, real-looking finding about primitive rejections in all 15. Opus raised the seeded defect as a question in 6 of 9 reviews (a seventh named the same error replacement without the failed artifact write) and never raised the primitive-rejection finding.

## Stage 9: verification

| Larger case | Luna normal | Luna deep | Luna light | Opus normal | Opus deep | Opus light |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Median USD | 0.076 | 0.082 | 0.095 | 2.81 | 2.92 | 2.85 |
| Median minutes | 8.6 | 2.5 | 3.2 | 1.3 | 1.4 | 1.3 |
| Verdicts | 83 | 87 | 89 | 41 | 41 | 42 |
| Rejected | 26 | 23 | 25 | 7 | 8 | 13 |
| Rejected as unresolved | 11 | 14 | 13 | 2 | 2 | 2 |
| Calls cut at the deadline | 5 | 2 | 2 | 0 | 0 | 0 |

- **Stage 9 is where the harder required findings are lost.**
  - Required 2 on Luna: 14 reviews had a candidate and 10 published it. The four losses were rejections, three of them "unresolved".
  - Required 2 on Opus: 5 reviews had a candidate and 1 published it, at low severity.
  - The TypeScript seeded defect on Opus: 6 reviews had a candidate and 1 published it, at low severity. The verifier's reasons, on this public case, include "The mechanism exists in code, but nothing shows it can actually happen" and "The mechanism is real, but it does not cause a meaningful regression". The defect was later fixed upstream.
- Opus rejects fewer candidates overall than Luna, but its rejections fall on exactly these findings.
- Schema-invalid calls: Luna 26 of 903 (2.9%), Opus 1 of 412.

## Stage 10: composition

- **First submission invalid:** 14 of 15 larger Luna reviews, against 1 of 9 on Opus. On the TypeScript case: 1 of 15 and 1 of 9.
- **Fallback:** in 3 of 15 larger Luna reviews the repair also failed and the report used the deterministic fallback (2 normal, 1 deep). Those three are the reviews with 11, 12 and 14 published entries; the others have 3 to 8. The fallback does not merge, so it inflates the count.
- Cost is small on Luna (one to two cents). On Opus it is about 5% of the cost but 2 to 2.5 of 7.3 minutes.

## Time with and without padded calls

Larger case on Luna, minutes per review:

| | Normal | Deep | Light |
| --- | ---: | ---: | ---: |
| Reviews with a deadline-cut call | 3 of 5 | 2 of 5 | 2 of 5 |
| Median without one | 8.6 | 8.5 | 6.9 |
| Median with one | 14.1 | 16.0 | 13.6 |

- A padded call adds five and a half to seven and a half minutes. Outside the larger case it appeared three times: once in Stage 9 and once in Stage 7 on the TypeScript case, and once in the small-case pilot.
- 14 Luna calls have no recorded usage, so Luna cost is slightly understated. Opus had no deadline-cut call.

## Partial reviews by cause

Four of 49 reviews were marked partial, all on the larger Luna case.

| Cause | Reviews | Real unfinished work? |
| --- | ---: | --- |
| Tool-result refusal on a packet that was fully reviewed (#126) | 2 (both light) | No |
| The same refusal, plus one verification left incomplete by a deadline-cut call | 1 (deep) | Yes, the verification |
| One hunk failed review | 1 (normal) | Yes |

So two of the four partial labels describe complete work, and both are in the light arm.

## The lexical scorer against these results

- TypeScript on Luna: the scorer credited the seeded defect in 6 of 15 reviews (4 normal, 1 deep, 1 light). None of them found it; all six are the primitive-rejection finding. Read from the scorer alone, normal would have looked better than deep on a difference that does not exist.
- Required 2 on Opus: the one published detection was scored as a miss, because its wording uses a digit where the pattern expects a word.
- The candidate-only expectation was scored as absent in 11 Luna reviews. By topic it was present in all 10 deep and light reviews but in only 1 of 5 normal ones. I have no explanation for the normal arm and would not read it as an effect of depth, since light has it too.

## What this suggests

1. **Remove the depth setting instead of renaming it.** Deep has no measured benefit and light holds neither required detections nor a meaningful cost saving. The aggregate share of hunks at deep coverage was similar across arms (26%, 19% and 23% on Luna), but planner assignments differed between arms, so the effect of the label on the planner is unresolved. One mode at today's normal budgets is what the data supports.
2. **Work on Stage 9 before Stage 7 budgets.** The harder findings are found and then rejected, most often as "unresolved". On Opus this is nearly the whole loss.
3. **Fix Stage 10 on Luna.** 14 of 15 invalid first submissions and 3 fallbacks on the larger case is the least reliable part of the pipeline on the primary model.
4. **Treat Luna's miss of the TypeScript seeded defect as a Stage 7 recall problem.** No depth setting changed it in 15 reviews.
5. **Look at what the planner buys on Luna.** It lists a third of the hunks, never uses light coverage, and is flagged degraded in 6 of 15 larger reviews.
6. **Read the "partial" label and raw time from this build with their harness artifacts in view.** Raw time is the registered measure and stands, but two of the four partial labels describe complete work, and padded calls account for much of the raw time gap between arms. Both artifacts are already ticketed.

## Limits

Three to five repetitions per cell. One build, two models, two discriminating cases. Topic mapping without source adjudication of every published claim. Differences of one review are not effects.
