---
created: 2026-11-21T16:43:11Z
author: "@architect"
source: "Requested by @operator under the owner's 2026-11-21 directive on independent campaign analyses. Read-only scripts over the telemetry of the 15 verifier-variance replays on codegenie 0850ed6; frozen case expectations. Written without sight of the other analyst's adjudication or metrics."
status: provisional
---

# Stage 9 verifier variance: independent analysis

**On identical input, the verifier changes its mind on 8 of 18 candidates, and one of the two required findings of the larger case is lost in 2 of 10 replays.** The loss happens when both candidates for that finding are rejected in the same replay, almost always as "unresolved". Stage 9 is also where the time and money go: about 90% of downstream cost, and most replays spend eight minutes waiting on a call that pads its output with whitespace.

This is one of two independent analyses. It is provisional until the operator merges it with the other.

## What ran

Fifteen replays restored the same saved planner and packet-review results and then ran verification and composition fresh: 10 on the larger case (18 candidates) and 5 on the TypeScript case (2 candidates). All used GPT-6 Luna at high reasoning, normal depth, adaptive off, local cache off. Seven replays have full debug traces.

| Case | Replays | Median USD (range) | Median minutes (range) | Final findings |
| --- | ---: | ---: | ---: | ---: |
| Larger | 10 | 0.117 (0.097–0.154) | 10.8 (3.3–12.8) | 6–9 |
| TypeScript | 5 | 0.009 (0.007–0.015) | 1.4 (1.2–1.5) | 1 |

Recorded cost was $1.26 in total. Eleven calls that ran to the pass deadline have no recorded usage.

## Stage 9: verdict stability

The 10 larger-case replays produced 180 verdicts: 42 keep, 87 revise and 51 reject (28 refuted, 23 unresolved).

| Outcome across 10 replays | Candidates |
| --- | ---: |
| Publishable (keep or revise) every time | 8 |
| Rejected every time | 2 |
| Split between publishable and rejected | 8 |

The eight split candidates were publishable in 3, 3, 4, 7, 7, 8, 8 and 9 of 10 replays. Rejections per replay ranged from 3 to 7.

## Stage 9: what happens to the expected findings

Expectations are from the frozen case file. I mapped candidates to them by topic; I did not re-verify each published claim against the source.

| Expectation | Candidates | Published in |
| --- | ---: | ---: |
| Required 1 | 2 | 10 / 10 |
| Required 2 | 2 | 8 / 10 |
| Optional 1 | 0 | 0 / 10 |
| Optional 2 | 2 | 10 / 10 |
| Candidate-only | 1 | present 10 / 10 |
| Negative sentinel | 0 | 0 / 10 |

- Optional 1 never reached verification in this capture, so its loss is upstream of Stage 9. The negative sentinel has no candidate either, so these replays do not test it.
- Required 2 has two candidates that were individually publishable in 4 and 7 of 10 replays. It was lost in the two replays where both were rejected.
- Having two candidates is what protects a finding. The two rates predict a publication rate of 0.82 if the verdicts are independent; the observed rate was 0.80. Required 1 survived every replay for the same reason, although each of its candidates was rejected at least once.
- Of the 9 rejections of Required 2 candidates, 7 were "unresolved" and 2 "refuted".
- 12 of the 180 verdicts were unresolved rejections of candidates that the same verifier publishes in other replays (in 4 to 9 of 10).
- The verifier only lowers severity. Of 86 revisions with a severity record, 23 lowered it (17 by one level, 6 by two) and none raised it. Final findings were 51 medium and 21 low; none was high.

## Stage 9: cost, time and harness health

- Stage 9 cost a median $0.106 of the $0.117 per larger replay, and took a median 9.2 of 10.8 minutes.
- 686 model calls served 180 verdicts: 180 initial, 466 tool continuations, 28 repairs and 12 finalizations.
- Input was 10.6 million tokens, 61% read from the provider cache. Output was 0.92 million tokens, 68% of it reasoning.
- 1,079 tool calls, about six per verdict: 51% range reads, 33% searches, 11% definition lookups. 16% of results were degraded and 21% truncated.
- The verifier reached its tool-budget soft target in 127 of 180 verdicts (71%). All 23 unresolved rejections came after it, but so did 32 of the 36 publishable verdicts on the same candidates, so reaching the target does not by itself explain a rejection.
- Whitespace-padded calls (#143): 15 in 180 verifier requests, in 9 of 10 replays. Eleven ran to the deadline and four completed. Replays with a deadline-cut call took 10.7–12.8 minutes; those without took 3.3–7.1.
- Of the 11 deadline-cut verdicts, 10 still ended keep or revise. One ended as an unresolved rejection of a Required 2 candidate, in one of the two replays that lost Required 2.
- 28 calls were schema-invalid (4% of calls). Every field repair that names a field names the suggestion-assessment block (#146).

## Stage 10

- The composer's first submission was schema-invalid in 6 of 10 larger replays and 0 of 5 TypeScript replays. Twelve repair calls recovered all six; no replay fell back. The fields at fault were retained source references and attention resolutions (4 each), then sections and section source references (2 each).
- The same issue was published as two separate findings in 3 of 10 larger replays. When both candidates of one issue were publishable, the composer merged them in 7 of 10 instances.
- Stage 10 cost a median $0.010 and 1.1 minutes.

## The lexical scorer against these results

For three expectations of the larger case, the scorer disagreed with the mapping above in 13 of 30 checks: it failed Required 1 twice when it was published, credited Required 2 once from a different finding in the same file, and failed the candidate-only expectation in all 10 replays although the candidate was always present. This supports #127.

## TypeScript case

All five replays agree: one candidate revised and published, the other given no verdict. The required expectation was missed in all five, because neither candidate is the seeded defect. Its loss is upstream of Stage 9.

## What this suggests

1. **Paired comparisons need several draws per arm and should be judged per finding.** A single pair can show a loss or a gain that is only verdict noise.
2. **The unresolved rejection is the loss path worth attacking.** A one-time redraw of unresolved rejections is not it: simulated on these 10 replays, it raises Required 2 from 0.80 to 0.89 for 13% more verifier requests, and 10 of those 23 requests go to a candidate that is rejected every time.
3. **Whether the verifier's tool budget is too tight is an open question the data cannot settle.** A replay of the same capture with a larger verifier budget would answer it, if the replay can hold the candidate set fixed.
4. **Stage 10 needs two follow-ups:** the first-submission failure on larger reviews, and duplicate publication of one issue.

## Limits

One capture per case, one model, one build. The candidate-to-expectation mapping is by topic. Counts of this size separate large effects only.
