---
created: 2026-11-22T00:37:00Z
author: "architect"
source: "Requested by the operator under the owner's 2026-11-21 directive on independent campaign analyses. Read-only scripts over the telemetry of all 228 reviews of the public version comparison (plan 130), the common-scorer results and the public oracles. Written without reading the other analyst's worksheets. After both analysts' totals were compared, two counts in this note were corrected: one detection in cg-07 and the finding counts for pi-02."
status: verified
---

# Public version comparison: independent analysis

**The two versions find the required defects equally often, and the newer build is the more reliable one.** Over 114 paired reviews, released v0.8.0 published 32 of 84 required defects and master at `1f4c04d` published 33 of 84. The newer build had no partial reviews against seven, and its report stage needed a repair in 5 reviews against 34. Cost and time show no clear per-review difference: total priced spend was $6.07 against $6.01 (median $0.036 per review in both arms), and median elapsed time 2.22 against 2.33 minutes per review. In both versions about half of the required defects are never raised by the reviewer at all, and that is where the detections are lost.

This is one of two independent analyses. It is reconciled with [the other analysis](20261122-021000-public-version-comparison-codex.md): both count 32 of 84 for v0.8.0 and 33 of 84 for master, and agree on the repository splits, the excluded cases, the four false findings on pi-08 and the number of control findings in each arm (11 and 9, none contradicted by the source). They differ on how to class the control findings: the other analysis counts 15 of the 20 as source-supported issues, and this one classes 16 as not introduced by the change and 4 as a real but unreachable gap. [Campaign plan](../../specs/plans/130-issue-138-public-version-comparison.md) · [Public cases](../../evals/public/README.md)

## What ran

- **Arms.** A is v0.8.0 (`286f3c6`). B is master at `1f4c04d`. Both ran OpenRouter GPT-6 Luna at high reasoning with full debug telemetry, verification on and local caching off.
- **Reviews.** 38 public cases from three repositories, three repetitions, two arms: 228 reviews, all completed.
- **Four cases are excluded from the detection figures.** In pi-02, pi-08, pi-09 and pi-12 the labelled behaviour already exists at the base commit, so a reviewer cannot report it as introduced by the change. A separate audit of the labels found this. That leaves 25 positive cases with 28 required defects, 84 observations of a required defect per arm, and 9 negative controls. The four are reported in their own section.
- **Template versions.** The packet-review prompt is the same in both arms (p7.16). The planner, verifier and composer prompts differ (p5.8 to p5.9, p9.28 to p9.31, p10.22 to p10.25).

## How detections were judged

Each review was compared with the case's oracle on a sheet that hid the arm. A defect counts as published only when a published finding states the oracle's cause and consequence; a finding at the right place about something else does not count. For every miss the sheet also shows the unpublished candidates with their verdicts and the open questions, so the miss can be placed at a stage.

- The sheets were judged by sub-agents of this analyst, all of the same model family.
- The judging was done three times from scratch: on the first 133 reviews, on all 228, and on all 228 again with each published finding's full visible text. The first two passes agree on published or not in 103 of 103 shared observations and on every control finding's class.
- **The third pass exists because the other analyst's count exposed an omission.** My sheets had carried each finding's title, failure mode and stated impact, but not the composed body a reader sees. In one review (cg-07, arm A) a second required defect is stated only in that body. With the body included, that one observation changed and the other 191 did not. The figures below are from the third pass. The same comparison corrected the finding counts for pi-02 in the excluded-cases table, which a counting error in my script had inflated.
- I checked by hand the three cases that looked decisive at the first pass (go-05, go-06 and the codegenie case with two defects) and the false finding on pi-08.
- Control findings were checked against the source by the sub-agents; I did not re-check those by hand.
- Findings on positive cases that are not the oracle's defect were counted but, apart from pi-08, not checked against the source. This note gives no false-positive rate for them.

## Detection

| Repository | Observations per arm | A published | B published |
| --- | ---: | ---: | ---: |
| codegenie | 39 | 9 | 9 |
| goinfer | 27 | 15 | 13 |
| pi | 18 | 8 | 11 |
| All | 84 | 32 | 33 |

Paired, by defect and repetition: both arms 21, A only 11, B only 12, neither 40.

- **The arms are level.** The discordant pairs split 11 against 12.
- **A varies more between rounds.** By round A published 10, 16 and 6 of 28; B published 11 in each.
- **B is steadier on the defects it finds.** B published nine defects in all three of its reviews; A did so for two. A published 16 different defects at least once and B 13, 17 between them. With three repetitions this is a description, not a tested difference.
- **Detection depends on the case far more than on the version.** Eleven of the 28 defects were published by no review in either arm, and one by all six.
- **The goinfer pattern from the first two rounds did not hold.** After two rounds A had found go-05 and go-06 in every review and B in none. In round three B found go-05 and A missed go-06. The packet covering the defective code had the same coverage, tool budget, context and prompt version in both arms in the eight reviews I compared, so this was run-to-run variation in packet review.
- **pi by introduction date: too little left to say anything.** Three of the four excluded cases are pre-August ones. What remains is two earlier cases (2 of 6 in A, 3 of 6 in B) against four later ones (6 of 12 and 8 of 12).

### Where the misses happen

| Outcome for a required defect | A | B |
| --- | ---: | ---: |
| Published | 32 | 33 |
| Never raised as a candidate or question | 44 | 42 |
| Raised only as a question | 6 | 8 |
| Raised, then rejected by the verifier | 2 | 1 |
| Verified but not published | 0 | 0 |

- **Packet review is the bottleneck on these cases.** Half of the observations (44 and 42 of 84) never produce a candidate or a question. The verifier rejected a required defect three times in 168 observations, each time as unresolved.
- All 65 published detections came from direct candidates. No promoted question became a published detection of a required defect.
- Nothing verified was lost at composition: no required defect was merged away or suppressed.

## Mislabelled cases, excluded

In these four pi cases the behaviour the oracle describes predates the reviewed change. The cases are to be re-pinned or dropped. Their published findings count as ordinary findings.

| Case | Reviews per arm | Oracle behaviour reported, A / B | Findings published, A / B |
| --- | ---: | ---: | ---: |
| pi-02 | 3 | 3 / 3 | 6 / 3 |
| pi-08 | 3 | 0 / 0 | 3 / 1 |
| pi-09 | 3 | 0 / 0 | 0 / 0 |
| pi-12 | 3 | 0 / 0 | 9 / 9 |

- **pi-02** is the one case where every review reported the labelled behaviour. It is real, but it predates the change, so it is not a detection of an introduced defect. It would have added three detections to each arm.
- **pi-08: a false finding, three times in A and once in B.** The finding says undo snapshots keep the live paste map by reference, so undo cannot restore it. The snapshot is pushed through `UndoStack.push`, which deep-clones its argument (`packages/tui/src/undo-stack.ts:12`, called from `packages/tui/src/components/editor.ts:2008`), so the stated failure cannot happen. I checked this against the source at the reviewed head.
- Those four findings are the only ones outside the controls that this note has checked against the source.

## Negative controls

| | A | B |
| --- | ---: | ---: |
| Control reviews | 27 | 27 |
| Reviews with at least one finding | 8 | 7 |
| Findings | 11 | 9 |
| Rated medium | 7 | 5 |
| Without the weak control cg-n3 | 8 of 24 | 7 of 24 |

- All 20 findings come from three of the nine controls (go-11, pi-n2, pi-n3), in both arms. The six others, including cg-n3, drew no finding in any of their 36 reviews.
- Checked against the source, none of the 20 is wrong about the code.
- **Sixteen describe behaviour the change did not introduce.** The findings on go-11 and pi-n3 concern behaviour that is deliberate, documented or unchanged from the base, for example a README snippet whose shape the change did not touch. I class these as policy-dependent. Eleven of them are rated medium; a reader would have to dismiss them.
- **Four describe a real gap the change did introduce, which nothing in the repository can reach.** The pi-n2 change adds tab expansion and says tabs inside terminal string sequences stay untouched, but its scanner does not recognise one such sequence type, so a tab inside it would be rewritten. No code in the repository emits that sequence. Two reviews in each arm reported it: three at low severity and one, in B, at medium. I first classed these as policy-dependent with the rest; after reading the other analysis I think "accurate and minor" is the fairer description, and pi-n2 should not be counted as a clean control.

## The scorer against these judgements

- The common scorer and the adjudication disagree on 24 of 168 observations: 13 detections the scorer missed and 11 it credited wrongly.
- Missed credits come from anchors and wording. Five are the go-04 defect stated in terms the pattern does not expect, and one states the go-06 defect exactly but is anchored in the changelog.
- Wrong credits are findings at the right place about a different problem. In cg-10 the finding about primitive rejections is credited as the write-failure defect five times, while the primitive-rejection defect it actually states is scored as missed.
- The scorer's totals, 30 for A and 33 for B, land close to the adjudicated 32 and 33 only because its errors cancel. One observation in seven is scored wrongly.

## Stage by stage

Totals over the 114 reviews of each arm, all 38 cases.

| | A | B |
| --- | ---: | ---: |
| **Stage 5** reviews whose first plan was invalid | 14 | 33 |
| Plan entries at deep / normal / light | 610 / 294 / 75 | 532 / 516 / 23 |
| Hunks at deep coverage after defaults | 836 | 777 |
| **Stage 6** packets built | 1,307 | 1,314 |
| Hunks reviewed (of 2,193; 111 excluded by configuration) | 2,075 | 2,082 |
| **Stage 7** reviews with an invalid submission | 48 | 51 |
| Repair calls | 87 | 84 |
| Tool-budget refusals | 61 | 62 |
| Candidates | 212 | 208 |
| **Stage 9** verdicts keep / revise / reject | 41 / 110 / 54 | 41 / 118 / 45 |
| Rejections refuted / unresolved | 24 / 29 | 22 / 23 |
| Calls cut at the deadline | 8 | 0 |
| Calls stopped by the stream limit and retried | 0 | 5 |
| Verifications left incomplete | 1 | 0 |
| Stage wall time, minutes | 112.1 | 79.5 |
| **Stage 10** reviews whose first report was invalid | 34 | 5 |
| Deterministic fallbacks | 0 | 1 |
| Findings published | 116 | 128 |
| Published severity high / medium / low | 1 / 83 / 32 | 1 / 83 / 44 |
| Reviews with no finding | 51 | 47 |
| **Health** completed / unresolved / incomplete | 75 / 32 / 7 | 82 / 32 / 0 |

- **Stage 5 got worse in B, and the fix came after the pin.** B's first plan was invalid in 33 of 114 reviews against 14. All but one failure was a plan entry without a reason. All were repaired, and one B plan was flagged degraded.
- **A's planner could still skip hunks.** Seven plan entries in A are skips, and A reviewed seven fewer hunks. B reviews every eligible hunk.
- **Stage 7 is unchanged**, as expected with the same prompt: candidate counts, repairs and tool-budget refusals are within 4% of each other.
- **Stage 9 no longer loses work to stalled calls.** A lost eight calls to the eight-minute deadline in five reviews, which left one verification incomplete. In B the stream limit stopped five runaway calls early and every retry completed. B's verifier stage took 29% less wall time. B also rejected fewer candidates (45 against 54), mostly fewer unresolved ones.
- **Stage 10 is the clearest improvement.** First-report failures fall from 34 to 5 of 114. B had the campaign's only fallback, after a repair of evidence references failed twice.
- **Partial reviews: 7 in A, 0 in B.** Six of A's were tool-budget refusals on packets that had completed, which B no longer counts as partial; the seventh was the incomplete verification.

## What has merged since B

Arm B is `1f4c04d`. Current master has later fixes in the stages where B still shows repairs, so B understates it. The table classifies B's 147 repair calls by their recorded validation errors; the submissions were not replayed through the fixed code.

| Stage | Repair calls in B | Avoidable | Fix on master |
| --- | ---: | ---: | --- |
| 5 | 35, in 33 reviews | 34 | Planner recovery fills absent per-hunk reasons (#174, merged as #186). 34 failed only on missing reasons, 224 in all. |
| 7 | 84, in 51 reviews | 79 | An empty `noFindingReason` sent with findings is dropped (merged as #181). 79 failed on that alone; 5 had other faults. |
| 9 | 20 | 0 | None of these fixes applies. Ten are in the suggestion-assessment block that #146 proposes to remove. |
| 10 | 8 | 0 | The absent-retained-reference fix (#168) does not apply to any of them. Three cite a fix suggestion in a test section, the family the draft for #155 targets. |

- **113 of B's 147 repair calls, 77%, are of a kind master no longer needs.** The same classification on A gives 14 of 14 in Stage 5 and 78 of 87 in Stage 7.
- Master also bounds planner and packet-review streams (#181), which this comparison cannot show: B had one Stage 7 call cut at the deadline.
- None of these fixes changes what is found. They remove repair calls, so the detection figures above should carry over to master; reliability and call counts should improve further.

## Cost and time

| | A | B |
| --- | ---: | ---: |
| Total USD, 114 reviews | 6.07 | 6.01 |
| Median USD per review | 0.036 | 0.036 |
| Total minutes | 288.2 | 259.9 |
| Median minutes per review | 2.22 | 2.33 |
| Longest review, minutes | 11.3 | 11.1 |
| Model calls | 5,659 | 5,716 |
| Calls with no recorded price | 8 | 6 |

- B was cheaper in 62 of 114 pairs and faster in 58: no difference per review. B's lower total time comes from the verifier calls that no longer run to the deadline.
- Stage 7 is 72% of the cost in A and 73% in B.
- The whole campaign cost $12.08, against the $36.96 estimate.

## What this suggests

1. **Make no detection claim for either version.** 32 against 33 of 84, with discordant pairs split 11 to 12, is level. The pattern that looked consistent after two rounds dissolved in the third.
2. **Treat missed discovery in Stage 7 as the main recall problem on public cases.** Half of the observations never produce a candidate, in both versions, and almost nothing is lost afterwards. Proving check: the eleven defects no review published form a fixed probe set; any Stage 7 change should be measured on them first.
3. **Keep the Stage 9 stream limit and the Stage 10 repair routing.** B's reliability gains are visible at no cost: no incomplete verification, no partial review, and 29 fewer reviews needing a report repair.
4. **Confirm the repair fixes on the next comparison.** By classification, 113 of B's 147 repair calls should disappear on master. Proving check: repair calls per stage on a build that includes #186 and #181, against 35 and 84 here.
5. **Do not rank versions with the lexical scorer.** It is wrong on one observation in seven, and its totals agree with the adjudication only by cancellation. Use it to find leads and adjudicate against the oracle.
6. **Look at the three controls that draw findings.** Sixteen accurate findings about behaviour the change did not introduce, eleven of them at medium, is the noise a reader of a clean change would see; the reviewer needs a check for whether the change introduced what it reports. The four on pi-n2 are a real gap that nothing in the repository can reach, so that case is not a clean control.
7. **Audit labels before the next campaign.** Four of 29 positive cases did not test what they claimed, and one of them inflated both arms by three detections.

## Limits

- Three repetitions per case, one model, one reasoning level, three repositories.
- Adjudication by one model family from sheets, with source reads only where the sheet was not enough. The passes agree with each other, which shows consistency, not correctness: the one error found was shared by the first two passes and was caught only by the other analyst's independent count.
- Ordinary findings on positive cases (74 in A, 85 in B, including everything published on the four excluded cases) were not checked against the source, apart from the four on pi-08.
- Arm B is not current master; see the section on what has merged since.
- A difference of one or two reviews in a cell is not an effect.
