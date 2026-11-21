---
created: 2026-11-21T04:36:36Z
author: "@architect-2"
source: "Requested by @operator for #112. First-round model-call ledgers, coverage records, final reports and source adjudications on codegenie 0.8.0 at 8a4c5bd."
status: verified
---

# First-round review baseline results

**Keep normal depth with the adaptive second pass off as the default. Keep light depth experimental.** On the small case every arm found the required issue. On the larger case adaptive review found the harder required issue twice more on Sol and once less on Opus than the shipped configuration. On the public TypeScript case light depth missed the seeded issue in all six reviews, and two larger-case Sol light reviews were partial. The arms were tied or the evidence was too sparse to establish a replicated gain. The first round also falls short of the criterion for promoting light to the documented fast path. [Pre-registered plan](../../specs/plans/127-issue-112-baseline-matrix.md)

## What ran

The 54 reviews ran serially on 21 November 2026 UTC, with three interleaved repetitions per case, model and arm. Opus denotes Anthropic Claude Opus 5.5 and Sol denotes GPT-6.2 Sol via Codex. Both used medium configured reasoning, shipped stage-specific reasoning, verification, shipped lens selection and the same work and time budgets. The arms were normal depth with adaptive off (reference), normal with adaptive on, and light with adaptive off.

| Case | Recorded USD | Serial wall minutes | Complete / partial | Adjudicated required detections / opportunities |
| --- | ---: | ---: | ---: | ---: |
| Small | 21.88 | 40.0 | 18 / 0 | 18 / 18 |
| Larger | 164.37 | 157.0 | 16 / 2 | 22 / 36 |
| TypeScript · public codegenie #60 | 12.34 | 31.4 | 18 / 0 | 5 / 18 |
| **First round** | **198.59** | **228.4** | **52 / 2** | **45 / 72** |

Wall time totals the three phase windows and excludes the pause for approval between phases. All 6,570 provider calls had recorded prices. Sol dollars value subscription usage at catalog rates. The small-case estimate was $69 and the larger-case historical-volume estimate was $549. The first Sol process spent five minutes closing its transport after writing results. The launcher then released the transport after each review, including on error. There were zero execution errors, review-budget overruns or local model-cache hits.

## Outcomes by case and arm

Each row contains three reviews. USD and minutes are totals across those reviews, with minutes measured from review start to result. Detection columns count reviews whose final report identified the expected behavior, as checked against the frozen source. For the larger case, paired numbers give the first and second expectations within each tier, in their original order. The candidate column counts presence in the saved candidates. A dash means the case had no such expectation.

| Case | Model | Depth / adaptive | USD | Minutes | Complete | Required | Optional | Candidate |
| --- | --- | --- | ---: | ---: | ---: | --- | --- | --- |
| Small | Opus | normal / off | 4.96 | 4.10 | 3 | 3 | — | — |
| Small | Opus | normal / on | 5.78 | 5.01 | 3 | 3 | — | — |
| Small | Opus | light / off | 4.45 | 4.45 | 3 | 3 | — | — |
| Small | Sol | normal / off | 2.25 | 7.12 | 3 | 3 | — | — |
| Small | Sol | normal / on | 2.34 | 7.47 | 3 | 3 | — | — |
| Small | Sol | light / off | 2.10 | 6.45 | 3 | 3 | — | — |
| Larger | Opus | normal / off | 37.23 | 15.20 | 3 | 3, 1 | 1, 3 | 3 |
| Larger | Opus | normal / on | 34.70 | 17.11 | 3 | 3, 0 | 2, 3 | 3 |
| Larger | Opus | light / off | 35.22 | 14.60 | 3 | 3, 1 | 0, 3 | 3 |
| Larger | Sol | normal / off | 19.74 | 38.48 | 3 | 3, 0 | 0, 3 | 3 |
| Larger | Sol | normal / on | 20.33 | 41.00 | 3 | 3, 2 | 0, 3 | 3 |
| Larger | Sol | light / off | 17.15 | 30.25 | 1 | 3, 0 | 0, 3 | 3 |
| TypeScript | Opus | normal / off | 2.605 | 3.67 | 3 | 2 | — | — |
| TypeScript | Opus | normal / on | 3.073 | 4.46 | 3 | 2 | — | — |
| TypeScript | Opus | light / off | 1.687 | 2.02 | 3 | 0 | — | — |
| TypeScript | Sol | normal / off | 1.585 | 6.59 | 3 | 0 | — | — |
| TypeScript | Sol | normal / on | 2.026 | 8.09 | 3 | 1 | — | — |
| TypeScript | Sol | light / off | 1.365 | 6.19 | 3 | 0 | — | — |

| Case | Model | Median USD/run (range) | Median minutes/run (range) | Reviewed / total hunk instances |
| --- | --- | ---: | ---: | ---: |
| Small | Opus | 1.65 (1.27–2.44) | 1.41 (1.31–1.87) | 90 / 90 |
| Small | Sol | 0.75 (0.64–0.93) | 2.26 (2.01–2.87) | 90 / 90 |
| Larger | Opus | 12.10 (8.94–12.96) | 5.19 (4.63–5.92) | 1,175 / 1,179 |
| Larger | Sol | 6.45 (5.57–6.99) | 12.19 (9.34–14.96) | 1,179 / 1,179 |
| TypeScript | Opus | 0.807 (0.426–1.340) | 1.18 (0.41–1.96) | 54 / 54 |
| TypeScript | Sol | 0.486 (0.422–0.861) | 2.16 (1.68–3.11) | 54 / 54 |

## Scoring and adjudication

**Small case.** The scorer and source checks agreed on all 18 required detections. Sol also reported one additional confirmed issue in five reviews (one normal/off, two normal/on and two light/off). Opus reported it in zero. No published finding was adjudicated wholly false.

**Larger case.** The table gives strict scorer counts followed by adjudicated counts. Each expectation had nine opportunities per model. All 18 reviews passed the negative control.

| Model | Required 1 | Required 2 | Optional 1 | Optional 2 | Candidate only |
| --- | ---: | ---: | ---: | ---: | ---: |
| Opus | 9 → 9 | 1 → 2 | 0 → 3 | 7 → 9 | 6 → 9 |
| Sol | 9 → 9 | 2 → 2 | 0 → 0 | 9 → 9 | 2 → 9 |

Wording, anchor and severity requirements affected which detections received credit. All three adjudicated detections of optional expectation 1 were rated low, below its medium threshold. For required expectation 2, the scorer recorded five partial matches and three verifier rejections on Opus, and seven verifier rejections on Sol. Of the four adjudicated detections, three were rated low and one medium. The candidate-only behavior appeared in every run's candidates and final report.

Across 53 Opus and 125 Sol published entries, source checks found zero wholly false findings. Three Opus entries and 16 Sol entries described verified behavior changes whose desirability depends on product policy. Two of those Opus entries overstated an input subcase. These are counts of entries across repeated reviews. All nine Sol reviews exceeded the case's historical advisory finding-count and model-call thresholds.

**Public TypeScript case.** The codegenie #60 regression requires two failures. A fatal composer rejection is followed by an artifact-write failure, and the failure report loses the verified findings. The strict scorer credited Opus in 2/9 reviews and Sol in 5/9. Reading the final reports reversed that ranking to **4/9 Opus and 1/9 Sol**. Two genuine Opus detections missed the case's wording pattern. Four Sol reviews received credit for a distinct failure caused by a primitive rejection. All 18 passed the negative control. The scorer also classified two Opus misses as occurring before candidate generation and five as partial matches. Sol had four partial matches. These labels inherit the limitations of the case's matcher. [Case revision](https://github.com/0xPolygon/codegenie/commit/80df9e6c6869035cb0cf1c6b2dfba75debf3edd6)

Sol identified the primitive-rejection defect in all nine reviews. Five also identified a distinct risk when concurrent reviews share the same error object. None of the 20 published entries was adjudicated wholly false. **All five genuine detections proposed a fix or test that propagated the wrong error.** Each rated the seeded defect low and would have propagated the composer error. The regression test requires the caller to receive the write error while retaining the findings. Two Opus reports also overstated the scope of lost diagnostics or understated the effect on the report. [Fix and regression test](https://github.com/0xPolygon/codegenie/commit/edd3ec2734e6fa093eb480a9a0d4f0c41aad7855)

## Coverage and the decision rule

The pipeline labeled a larger-case Opus normal/off review complete after the planner skipped four eligible hunks. Conversely, both partial Sol light reviews covered every hunk and exhausted a Stage 7 tool-result limit. Coverage and completeness therefore answer different questions.

Each row sums three reviews. Stage 5 counts one entry per hunk listed in the saved plan, grouped by its assigned coverage level. Stage 6 gives eligible hunks omitted from the plan normal coverage and groups hunks into review packets. For example, on the larger case Opus listed 72 hunk instances in its plans. The packet builder included those 72 and the 321 omitted instances in 219 packets.

| Light arm, three reviews | Stage 5 hunk entries in plan (deep / normal / light / skip) | Hunks reviewed | Stage 6 packets built | Escalated | Stage 7 candidates |
| --- | --- | ---: | ---: | ---: | ---: |
| Small · Opus | 15 / 8 / 3 / 0 | 30/30 | 15 | 0 | 9 |
| Small · Sol | 21 / 3 / 2 / 0 | 30/30 | 15 | 0 | 14 |
| Larger · Opus | 58 / 14 / 0 / 0 | 393/393 | 219 | 4 | 32 |
| Larger · Sol | 52 / 6 / 0 / 0 | 393/393 | 219 | 0 | 80 |
| TypeScript · Opus | 9 / 3 / 0 / 0 | 18/18 | 12 | 0 | 0 |
| TypeScript · Sol | 9 / 3 / 0 / 0 | 18/18 | 12 | 0 | 9 |

Promotion of unresolved questions brought TypeScript light-arm verification intake to two entries on Opus and ten on Sol. In the normal/on arm, completed adaptive passes on the small, larger and TypeScript cases were respectively 2, 12 and 5 on Opus, and 0, 12 and 1 on Sol.

The pre-registered rule requires a repeatable material loss with adaptive off that also occurs on the second model family. For the larger case's harder required expectation, two paired Sol repetitions favored adaptive on and one paired Opus repetition favored off. On TypeScript the two normal arms had identical Opus outcomes and a single Sol pair favored on. Light depth requires lower cost and latency while preserving material recall, precision and completeness. On TypeScript, two paired Opus detections from normal/off disappeared at light depth. On the larger case, two Sol light reviews were partial while all normal/off reviews were complete. With three repetitions per cell, neither change meets the rule. The shipped configuration remains normal depth with adaptive off, and light depth is not promoted.
