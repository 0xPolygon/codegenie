---
created: 2026-11-22T02:10:00Z
author: architect-2
source: "Operator assignment for #138. Plan 130, frozen public diffs and oracles, both pinned builds' full-run artifacts and an independent source worksheet for each of 228 reviews."
status: verified
---

# Public review comparison on Luna high

Reconciled with [the other independent analysis](20261122-003700-public-comparison-independent-analysis.md): after one cg-07 detection was corrected in that note, both count 32 of 84 for v0.8.0 and 33 of 84 for master. They differ on whether some control findings are real defects or policy-dependent.

**Released v0.8.0 published 32 of 84 required-defect observations (38.1%). Pinned master published 33 (39.3%).** Both found the defect in 21 paired observations, only the release in 11, only master in 12, and neither in 40. With three repetitions per case, that one-observation advantage gives little reason to prefer a version on recall. Completion improved from 107/114 to 114/114. Priced spend was $6.0721 and $6.0049 respectively, with 8 and 6 additional calls lacking prices. Neither arm published a wholly false claim on a negative control. Four false publications elsewhere all concerned the same public case.

## What was measured

A is `286f3c6645a423b3ab0cdd66f2713d68ed195928`, B is `1f4c04d36548e225e3220962551306edc3c442e1`. Each reviewed the same 38 public diffs three times with independent discovery, OpenRouter Luna high, verification on, normal depth and adaptive off. All 228 reviews finished, including partials. The first 10 slots per arm ran serially. The other 104 per arm ran in simultaneous version pairs, at up to two pairs concurrently. Shared provider load makes elapsed time secondary. Every first-repetition slot captured the verifier input in pass-through mode (38 per arm); repetitions two and three used the uninstrumented path. Trace, pin and cache checks passed throughout. The full-debug archive has the requested model and tool traces for every served call. Event logging capped the payload of nine events on A and twelve on B.

The comparison uses one scorer, B's, on both sets of artifacts and preserves both native scores. I locked the required-publication and negative-control judgments before comparing them with the other analyst's. I classified ordinary findings on the frozen public sources, counting a claim once per report entry. An issue can be technically accurate even when its importance, intended contract or attribution to the diff is disputed. Source-supported additional issues should therefore be read separately from detections of bugs introduced by the reviewed changes. [Plan 130](../../specs/plans/130-issue-138-public-version-comparison.md) · [Case manifests, oracles and target revisions](../../evals/public)

## Required publication

25 eligible positive directories contain 28 required behaviors. The denominator is 28 behaviors × three reviews per arm. Each behavior counts once per review across inline and summary-only entries. One entry can substantiate two separate behaviors. The optional alternate anchor for pi-05 adds no observation.

| Repository | A | B | Both | A only | B only | Neither | Mean per case, A / B |
|---|---:|---:|---:|---:|---:|---:|---:|
| codegenie | 9/39 | 9/39 | 4 | 5 | 5 | 25 | 18.3% / 23.3% |
| goinfer | 15/27 | 13/27 | 10 | 5 | 3 | 9 | 55.6% / 48.1% |
| pi | 8/18 | 11/18 | 7 | 1 | 4 | 6 | 44.4% / 61.1% |
| All | 32/84 | 33/84 | 21 | 11 | 12 | 40 | 38.0% / 41.3% |

The last column gives each directory one vote, averaging its behaviors and repetitions first. By repetition the A counts were 10, 16 and 6 of 28, versus 11, 11 and 11 on B. A detected 16 distinct behaviors at least once and B detected 13. Eleven of the 28 were never published on either arm.

| Positive directory | A | B | Positive directory | A | B | Positive directory | A | B |
|---|---:|---:|---|---:|---:|---|---:|---:|
| cg-01 | 2/6 | 1/6 | go-01 | 0/3 | 0/3 | pi-01 | 2/3 | 3/3 |
| cg-02 | 2/3 | 3/3 | go-02 | 2/3 | 3/3 | pi-03 | 0/3 | 0/3 |
| cg-03 | 0/3 | 0/3 | go-03 | 2/3 | 3/3 | pi-05 | 2/3 | 3/3 |
| cg-04 | 0/3 | 0/3 | go-04 | 3/3 | 3/3 | pi-06 | 2/3 | 2/3 |
| cg-05 | 0/3 | 0/3 | go-05 | 3/3 | 1/3 | pi-07 | 0/3 | 0/3 |
| cg-06 | 0/3 | 0/3 | go-06 | 2/3 | 0/3 | pi-10 | 2/3 | 3/3 |
| cg-07 | 3/6 | 0/6 | go-07 | 0/3 | 0/3 | | | |
| cg-08 | 0/3 | 2/3 | go-08 | 2/3 | 3/3 | | | |
| cg-09 | 0/3 | 0/3 | go-09 | 1/3 | 0/3 | | | |
| cg-10 | 2/6 | 3/6 | | | | | | |

**Mislabelled; excluded.** The frozen pi-02, pi-08, pi-09 and pi-12 labels describe behavior already present at base. Their 24 reviews remain in operational totals and ordinary-finding adjudication. Before August, A found 2/6 and B 3/6 on the two eligible pi cases, all on pi-05. On the four later cases A found 6/12 and B 8/12. The remaining earlier cases are too few for an inference about training exposure. [Introducing-change audit](https://github.com/0xPolygon/codegenie/issues/203)

**Reconciliation.** The two independent readings initially gave A 32 and 31 and agreed on B 33. In cg-07, repetition two on A, one published entry identifies the obsolete runtime guard and explicitly says the eval config validator accepts a stage-8 budget key that is then silently skipped. Its suggested test rejects key 8 while accepting 7 and 9. The two behaviors have separate oracle labels and different fixes. The other analyst confirmed that the visible body supplies the missing credit. This resolves the original one-observation difference to 32/84 versus 33/84. [cg-07 oracle](../../evals/public/codegenie/cg-07/oracle.md)

## Additional publications and controls

| Population | Published entries A / B | Entries supporting a required defect | Other source-supported | Policy-dependent | Wholly false |
|---|---:|---:|---:|---:|---:|
| Eligible positives, 75 reviews per arm | 87 / 106 | 31 / 34 | 55 / 68 | 1 / 4 | 0 / 0 |
| Mislabelled positives, 12 per arm | 18 / 13 | — | 13 / 12 | 2 / 0 | 3 / 1 |
| Negative controls, 27 per arm | 11 / 9 | — | 8 / 7 | 3 / 2 | 0 / 0 |
| Total, 114 per arm | 116 / 128 | 31 / 34 | 76 / 87 | 6 / 6 | 3 / 1 |

Publication entries and defect observations have different units. A's cg-07 entry supports two distinct defects. Two entries about the same defect in one review can earn only one observation. Across all entries my severity reading was 94 fair, 20 overstated and 2 understated on A; 111 fair, 15 overstated and 2 understated on B. This is analyst judgment, particularly for test gaps and unusual inputs. For example, removing an abort-signal assertion is an observable coverage loss. It does not demonstrate that a production request failed to abort.

- **Mislabelled positives.** A / B published 6 / 3 entries on pi-02, 3 / 1 on pi-08, 0 / 0 on pi-09 and 9 / 9 on pi-12. In pi-08 all four entries claim an undo snapshot aliases a mutable paste map. The caller passes the map into `UndoStack.push`, which immediately deep-copies the snapshot with `structuredClone`. Looking only at the caller gives the wrong answer. On pi-02 an existing metadata-absent behavior can substantiate a new documentation mismatch. On pi-12 the drive-letter and POSIX separator findings are distinct from the excluded search-pattern label. [pi-08 source and oracle pins](../../evals/public/pi/pi-08/oracle.md)
- **Negative controls.** A published in 8/27 and B in 7/27 reviews. Omitting weak cg-n3 gives 8/24 and 7/24. The common scorer raised strict alarms in 7/27 and 5/27, respectively; none of the 20 public claims was wholly contradicted by the source. My source-supported counts include DCS tabs altered by the newly added normalizer, rejected terminal-event listeners invoked a second time, and in-process transport operations that can remain blocked. I classified immediate unsubscribe in the README as a presentation judgment. The other analyst classified all 20 as policy-dependent. The disagreement concerns contract and introducedness, not whether the reported code paths exist. In pi-n2, the base preserves these tabs, the change promises to preserve tabs in terminal strings, and its scanner handles CSI, OSC and APC but omits DCS. That example merits individual reconsideration before treating these controls as clean. [go-11](../../evals/public/goinfer/go-11/oracle.md) · [pi-n2](../../evals/public/pi/pi-n2/oracle.md) · [pi-n3](../../evals/public/pi/pi-n3/oracle.md)
- **Scorer error.** A received six false credits and missed eight true publications; B received five false credits and missed five true publications. The common scores therefore give 30/84 and 33/84 against the adjudicated 32/84 and 33/84. An overlapping location can credit cg-10's artifact-write bug when the report describes only primitive rejection. Wording or an alternate anchor can hide a genuine go-04 or go-06 detection. Keep the native and common machine scores for diagnostics and judge the full visible finding against the source.

## Where required findings were lost

| Matched required observations, out of 84 per arm | A | B |
|---|---:|---:|
| Direct packet-review candidate | 33 | 34 |
| Candidate after promotion, including a question identifying the causal mechanism | 35 | 37 |
| After verification | 32 | 33 |
| In the published report | 32 | 33 |

I read the direct and promoted candidate records at the verifier boundary and compared them with the source, the verdict and the final report. A generic question about an import or caller counts only if it identifies the expected failure mechanism. Unpromoted questions can be useful leads and are outside this boundary count. **Of 52 A publication misses, 48 had no matching candidate after promotion and 4 reached verification but did not survive. Of 51 B misses, those counts were 47 and 4.** One additional A behavior was first explicit in the verified assessment of a related candidate (cg-07). No accepted required behavior was lost by composition in either arm. This attribution includes promoted questions among verifier-boundary losses; the companion analyst also reports a separate question-only category.

The clearest negative result for discovery was shared. Across six reviews per label, neither arm published the required cause on cg-03, cg-04, cg-05, cg-06, cg-09, go-01, go-07, pi-03 or pi-07, nor the header-redaction label of cg-01 or the write-failure label of cg-10. More verification cannot recover an absent candidate. On the other hand, the promoted pi-07 question explicitly asked whether configured defaults disable unlisted extension tools, and one pi-03 review raised the unanswered suffix of tool calls. Those exposures warrant a separate verifier or promotion check.

## Stage time, cost and harness behavior

All table values are A / B, summed across 114 reviews per arm. Tokens include provider cache reads and writes; those columns show the composition of token volume. Minutes are summed stage wall times within reviews, so overlapping reviews contribute to both sums. Prices exclude the 14 unpriced calls.

| Stage | Model calls | Total tokens, millions | Cache read / write, millions (A then B) | Priced USD | Minutes | Invalid submits | Repair attempts |
|---|---:|---:|---|---:|---:|---:|---:|
| 5 Planner | 128 / 149 | 1.64 / 1.82 | 0.00 / 1.28 · 0.03 / 1.43 | 0.334 / 0.350 | 56.9 / 53.9 | 14 / 35 | 14 / 35 |
| 6 Packets | 0 / 0 | 0 / 0 | 0 / 0 · 0 / 0 | 0 / 0 | 1.4 / 1.4 | 0 / 0 | 0 / 0 |
| 7 Packet review | 4,599 / 4,633 | 70.55 / 69.64 | 44.57 / 24.12 · 43.44 / 24.36 | 4.370 / 4.380 | 89.6 / 95.1 | 90 / 85 | 87 / 84 |
| 9 Verifier | 782 / 812 | 12.33 / 12.94 | 7.14 / 4.25 · 7.90 / 4.11 | 1.066 / 1.057 | 112.1 / 79.5 | 25 / 20 | 25 / 20 |
| 10 Composer | 150 / 122 | 1.90 / 1.18 | 0.02 / 1.68 · <0.01 / 0.97 | 0.301 / 0.218 | 27.4 / 29.2 | 36 / 9 | 36 / 8 |

1. **Planner and dispatch.** Each arm saw 2,193 hunk instances. A reviewed 2,075 and B 2,082. The raw planner entries (deep, normal, light, skip) were 610/294/75/7 and 532/516/23/0. Effective hunk coverage was 836/1,184/55/118 and 777/1,285/20/111, respectively. Raw decisions do not cover all hunks. The extra seven eligible hunks on B are consistent with its prohibition on planner skips. B had one degraded plan and 35 planner repair attempts. Compare invalid paths before adding instructions that affect every plan.
2. **Packet build.** A built 1,307 packets and B 1,314. All reached a reviewed packet status; 209 and 211 were marked degraded. The builder recorded 341/5,450 and 339/5,429 degraded tool results. A packet marked reviewed can still have limited context. Truncation events included 185/189 truncated symbol sources and 12/12 truncated hunks.
3. **Packet review.** This stage consumed 72% / 73% of priced spend. A generated 181 direct candidates and promoted 31 of 71 considered uncertainties. B generated 178 and promoted 30 of 80. The stage recorded 1,113/8,499 and 1,133/8,444 degraded tool results. Six A partials cited a Stage 7 tool result budget; no packet had failed status. Compare causal discovery on fixed packets before shortening broad tool budgets or changing the reviewer prompt.
4. **Verification.** A scheduled 206 candidates and returned 41 keep, 110 revise, 54 reject and 1 incomplete. B scheduled 204 and returned 41 keep, 118 revise and 45 reject. Recorded time fell by 32.6 summed minutes despite 30 more model calls. A had eight unpriced timeout calls and one verifier-caused partial. B had five unpriced aborted Stage 9 calls and one unpriced Stage 7 timeout. The summed time includes retries and long outliers; the whole-version experiment does not isolate the reason. The low-confidence evidence lane kept 1 of 18 on A. Source checks on promoted questions remain important even when yields are small.
5. **Composition.** Repairs fell from 36 to 8 attempts, with 28 fewer model calls and about $0.08 less priced spend. B used one deterministic fallback and still published all required behaviors that had survived verification. Aggregate composer wall time rose slightly. A reduction in repair count is an efficiency gain; these runs provide no evidence that changing the composer would recover the absent required defects.

Median wall time was 2.29 / 2.48 minutes in the first 10 serial slots per arm and 2.21 / 2.31 minutes in the 104 simultaneously dispatched slots per arm. Total review time was 288.2 / 259.9 minutes. The campaign ran from 21:10 UTC to 02:03 UTC including schedule transitions. There were zero missing required model or tool traces. The full pair cost $12.077 priced against the $36.96 forecast and $50 stop. The single-model setting, three repetitions and four excluded oracle labels limit generalization. Future paired work can use these 11 unpublished labels as probes, retain cg-07's two distinct causes in one report as a scorer fixture, and separate a source-accurate control observation from a new defect attributable to the change.
