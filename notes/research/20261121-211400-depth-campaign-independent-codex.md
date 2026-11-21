---
created: "2026-11-21T21:14:00Z"
author: "architect-2"
source: "Operator-requested independent analysis of plan 128 on codegenie 54db64b, using frozen source, per-review adjudications and local telemetry."
status: verified
---

# Depth comparison on Luna and Opus at high reasoning

Reconciled with [the other independent analysis](20261121-211530-depth-campaign-independent-analysis.md). Both analyses agree on a single mode with today's normal behavior. This note recommends keeping that mode under the name deep; the other recommends removing the depth setting. The operator decided to remove the setting (2026-11-21), superseding plan 128's rename fallback. On the evidence: deep had one paired Luna gain and one loss on the harder required finding (4/5 in each arm), while light cleared the registered elapsed-time bar (41% faster overall, 19% among reviews without oversized calls) but lost two paired required detections and had an extra partial. This note counts five of nine Opus TypeScript reviews with a promoted claim identifying the required cause, against seven with a related question by topic in the other note, and the varying planner assignments leave the effect of the depth label unresolved.

**Ship one mode named deep, using today’s normal packet budget, close nudge and planner input.** The larger deep budget reproduced the normal arm’s two Luna required-detection counts, with one paired gain and one paired loss on the harder behavior. Promotion required gains in at least three of five Luna pairs on the same required behavior. On Opus, normal published one required behavior on each case that deep missed in all three repetitions. The light arm cleared the speed bar but failed the quality and completion criteria. Keep adaptive second pass off. These are the migration choices specified by the [pre-registered decision rule](../../specs/plans/128-issue-124-stage9-and-depth-campaign.md).

On the larger Luna case, light cut median elapsed time **41.2%**, from 14.03 to 8.25 minutes. Median cost fell only **0.7%**, from $0.3202 to $0.3181. Light lost the harder required behavior in two paired reviews, had two partial reviews to normal’s one, and lost both single normal-arm required detections in the Opus cross-check. Deep also happened to finish faster than normal on larger Luna, at a median of 8.96 minutes and 8.9% higher median cost. The timing split below shows why scope and provider stalls matter when interpreting those medians.

## Runs and adjudication

The small Luna pilot and all 48 frozen comparison slots returned results. There were 45 complete reviews, four partials, no execution errors, no 402s and no review over 30 minutes. Review durations summed to **308.47 minutes**, excluding the credit hold and time between reviews. The priced total was **$138.359 plus 14 unpriced calls**, against the $150 stop. The pilot took 10.47 minutes, cost $0.0711 plus one unpriced call, covered 10/10 eligible hunks and found its one required behavior. It contributes no vote. The 30 comparison reviews on OpenRouter GPT-6 Luna cost $5.550 plus 13 unpriced calls and took 220.42 minutes. The 18 on Anthropic Opus 5.5 cost $132.738 and took 77.58 minutes. Both used configured high reasoning, normal stage-specific routing, six workers, budget boost one, verification on and local model caching off. All slots ran serially on the same build.

I adjudicated candidate claims, revisions and final publications against the frozen base and head. Each behavior counts once per review. A question qualified after promotion only when it identified the causal condition. I locked the worksheets before seeing the other analyst’s results. Arm and model were hidden from the extracted claim records where possible, although dispatch timing made complete blinding impractical. The 177 final entries, including summary-only entries, comprised 168 source-supported and nine policy-dependent claims. I found zero wholly false published claims and zero negative-sentinel publications. Multiple entries can describe one defect. Automated matching gave six unsupported required-behavior credits on the public TypeScript case. Across the two comparison cases it missed one first-required detection, one second-required detection, three optional detections and seven candidate-only detections. All decisions below use adjudication.

## Where each stage affected the outcome

**Stage 5 — planning.** Six Luna larger-case plans recorded degraded planning, three normal, two deep and one light. No Opus plan degraded. Across all 49 reviews, 12 of 61 planner calls were schema-invalid. The saved larger Luna plans under normal contained 128 deep and 32 normal entries. Under deep they contained 78 deep and 153 normal entries. These counts include any deterministic plan produced on degradation. The dossier setting and the generated plans varied, so combining the deep dossier label with normal budgets and nudges would be a new configuration. Preserve the measured normal dossier semantics under the new public name.

**Stage 6 — packing and dispatch.** Every one of the 3,298 eligible hunk instances was dispatched. There were zero config exclusions, 2,244 eligible hunk instances without an explicit planner entry, 1,853 packets dispatched and 31 escalations. Larger-case packet counts were identical across depths within each family. Affected-file coverage stayed fixed while the amount of work each packet could request changed. The normal default for unlisted hunks and the planner’s inability to skip both matter here. The six-worker limit means individual call durations cannot be added to recover stage wall time.

**Stage 7 — discovery and repairs.** Packet review emitted 345 candidates. On the larger Luna case deep produced 72 direct candidates versus normal’s 68 and light’s 74. All five normal and five deep reviews discovered both required behaviors directly. Light discovered the harder behavior directly in three of five and reached four of five after promotion. Deep did recover the *candidate-only* behavior five times versus normal’s once. That improves secondary signal without meeting the required-behavior promotion bar. On public cg-10, zero of 24 reviews emitted a direct candidate for the frozen artifact-write defect. Luna repeatedly found a different genuine primitive-rejection defect. Only Opus supplied a causal hint for the required defect, in five of nine reviews. More Stage 7 budget did not resolve this discovery gap. [Public case oracle](../../evals/public/codegenie/cg-10/oracle.md)

**A narrow change could remove most Stage 7 schema repairs.** Of 122 invalid packet submits, 119 reported that the optional `noFindingReason` was too short. Individual response bodies were available for 109 of those 119. All 109 had `reviewStatus="findings"`, a nonempty findings array and `noFindingReason=""`. In an offline replay, omitting just that empty optional field made **109/109 pass the pinned submit schema**, preserving all 109 submitted finding objects. Ten earlier calls lacked the response body required to test the same change. The live harness spent 122 model repair attempts and recovered 121 chains, including one second invalid attempt. Test the narrow normalization before model repair, preserving validation for empty results and malformed findings. This is schema replay evidence. Publication parity and saved wall time would require measurement on the changed build.

**Stage 9 — verification.** Stage 9 received 437 candidates including 92 promotions. It retained 312 with established proof (112 keep, 200 revise), rejected 121 (64 refuted, 57 unresolved), suppressed three and left one incomplete. It reduced severity on 52 retained candidates (40 medium to low, seven high to medium, five high to low). The larger required behavior with the most variation reached the post-promotion pool in 19 of 24 reviews and survived verification in 11. All 11 then reached the report. On cg-10, one of the five Opus promoted causal candidates survived verification and was published. No Luna verifier saw the required cause on these inputs. These are distinct opportunities for improvement. A verifier change should be tested on fixed inputs that actually contain the behavior. [Independent baseline-variance study](20261121-154810-verifier-baseline-variance.md)

**Stage 10 — composition.** In all 49 reviews, 32 schema-invalid composer calls led to 29 repair attempts and three deterministic fallbacks after repair exhaustion. All three fallbacks were larger Luna reviews (two normal and one deep). Stage 10 retained every verified required behavior in the source worksheet. Within the comparison, Luna spent 23.8 aggregate minutes in composition across 30 reviews and Opus spent 22.5 across 18. Composition can change grouping and advice even where behavior-level detection stays constant. Use the existing paired-composition experiments to measure those effects on fixed verified groups.

**Partial reviews.** All four partials occurred on larger Luna. Three reviewed all 131 eligible hunks and recorded a Stage 7 tool-result budget error. One of those three also left a candidate verification incomplete. The fourth dispatched all 131 but reviewed only 130. Seven comparisons exceeded the historical 300-call advisory threshold and none exceeded 600. No partial resulted from the 30-minute limit. Report dispatch, completed hunk review and unresolved evidence separately. The earlier medium-reasoning study also observed two larger light-arm partials with complete hunk coverage. That study used another primary model and build. [First-round results](20261121-043636-first-round-baseline-results.md)

## Time with and without oversized argument streams

This build predates the bounded-stream change. I used recorded argument volume as a reproducible **padding proxy**: more than 64,000 cumulative tool-argument characters in a call (128,000 for Stage 10). Timeout records usually lack a completed argument body, so they cannot establish whether every excess character was padding. Fourteen calls qualified, all on Luna: one planner, two packet-review and 11 verifier calls. Thirteen timed out. These calls totaled 101.64 **worker-minutes**, of which 83.28 were in Stage 9. The 11 Stage 9 records crossed the later verifier length threshold. The other stages and the cumulative counter have different semantics from the later live detector.

| Larger Luna depth | Reviews with / without flagged calls | Median review minutes with / without | Median Stage 9 minutes in those reviews |
| --- | ---: | ---: | ---: |
| Normal | 3 / 2 | 14.10 / 8.57 | 9.11 / 2.38 |
| Deep | 2 / 3 | 15.96 / 8.45 | 6.18 / 2.49 |
| Light | 2 / 3 | 13.63 / 6.94 | 8.94 / 2.75 |

Across all cases the 10 affected reviews took a median 13.63 minutes and the 39 unaffected ones 2.97 minutes. Their case and model mixes differ. Within larger Luna, light’s unaffected median was 19.0% below normal’s (6.94 versus 8.57 minutes), based on only three and two reviews respectively. The registered speed decision uses all five per arm. Across the 49 reviews, 65.53 elapsed minutes had at least one flagged model call and zero other active model calls. Subtracting only that interval gives **242.94 of 308.47 observed minutes** as an explicitly hypothetical accounting view. An early abort still needs time to trip, retry or finish the work. The actual speed benefit of a bounded stream must be measured on the newer build.

The following tables exclude the one small pilot. Counts refer to reviews within each row unless the column names packets, candidates, calls, hunks or entries. R1 and R2 are the first and second required behaviors within each case. O1 and O2 are separate optional counts. Stage 5 entries are per hunk named by the saved plan, while Stage 6 packets can contain multiple hunks. Native completeness and the campaign’s 30-minute rule agreed for all 49 slots. Price ranges use priced ledger entries. Model-level stage times are cumulative stage wall minutes over each family’s comparison reviews.

## Review outcomes

| Case | Model | Depth | Runs | Complete | Median USD (range) | Median min (range) | Priced USD | Unpriced calls | Real / policy / false entries |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Larger | Luna | normal | 5 | 4 | 0.320 (0.312–0.372) | 14.0 (8.5–14.8) | 1.682 | 5 | 39/1/0 |
| Larger | Luna | deep | 5 | 4 | 0.349 (0.340–0.356) | 9.0 (8.4–18.7) | 1.744 | 4 | 38/3/0 |
| Larger | Luna | light | 5 | 3 | 0.318 (0.298–0.327) | 8.2 (6.9–13.8) | 1.579 | 2 | 27/4/0 |
| Larger | Opus | normal | 3 | 3 | 14.056 (12.847–14.251) | 7.3 (7.0–8.5) | 41.154 | 0 | 18/0/0 |
| Larger | Opus | deep | 3 | 3 | 13.861 (13.680–14.022) | 7.4 (7.2–8.1) | 41.562 | 0 | 14/0/0 |
| Larger | Opus | light | 3 | 3 | 13.682 (13.480–14.011) | 6.9 (6.5–7.4) | 41.174 | 0 | 15/1/0 |
| TypeScript | Luna | normal | 5 | 5 | 0.035 (0.032–0.044) | 2.5 (2.3–10.0) | 0.184 | 1 | 5/0/0 |
| TypeScript | Luna | deep | 5 | 5 | 0.037 (0.029–0.054) | 2.8 (2.0–3.0) | 0.198 | 0 | 5/0/0 |
| TypeScript | Luna | light | 5 | 5 | 0.030 (0.027–0.039) | 2.8 (1.9–10.0) | 0.164 | 1 | 5/0/0 |
| TypeScript | Opus | normal | 3 | 3 | 0.995 (0.815–1.194) | 1.2 (1.0–2.0) | 3.004 | 0 | 1/0/0 |
| TypeScript | Opus | deep | 3 | 3 | 1.145 (0.824–1.233) | 1.3 (1.2–1.5) | 3.203 | 0 | 0/0/0 |
| TypeScript | Opus | light | 3 | 3 | 0.940 (0.727–0.975) | 1.0 (1.0–1.1) | 2.641 | 0 | 0/0/0 |

## Source-adjudicated behavior

| Case | Model | Depth | R1, direct → promoted pool → verified → published | R2 through those stages | Optional published (O1/O2) | Candidate-only in pool |
| --- | --- | --- | --- | --- | --- | --- |
| Larger | Luna | normal | 5 → 5 → 5 → 5 | 5 → 5 → 4 → 4 | 0/5 | 1 |
| Larger | Luna | deep | 5 → 5 → 5 → 5 | 5 → 5 → 4 → 4 | 0/5 | 5 |
| Larger | Luna | light | 5 → 5 → 5 → 5 | 3 → 4 → 2 → 2 | 0/5 | 5 |
| Larger | Opus | normal | 3 → 3 → 3 → 3 | 2 → 2 → 1 → 1 | 1/3 | 3 |
| Larger | Opus | deep | 3 → 3 → 3 → 3 | 1 → 1 → 0 → 0 | 0/3 | 3 |
| Larger | Opus | light | 3 → 3 → 3 → 3 | 2 → 2 → 0 → 0 | 0/3 | 3 |
| TypeScript | Luna | normal | 0 → 0 → 0 → 0 | — | — | — |
| TypeScript | Luna | deep | 0 → 0 → 0 → 0 | — | — | — |
| TypeScript | Luna | light | 0 → 0 → 0 → 0 | — | — | — |
| TypeScript | Opus | normal | 0 → 2 → 1 → 1 | — | — | — |
| TypeScript | Opus | deep | 0 → 2 → 0 → 0 | — | — | — |
| TypeScript | Opus | light | 0 → 1 → 0 → 0 | — | — | — |

## Planning and coverage

| Case | Model | Depth | Planner deep/normal/light/skip | Eligible without entry | Eligible/dispatched/reviewed | Packets built/dispatched | Escalated | Soft target packets | Stage 7 candidates / promoted / verifier intake |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Larger | Luna | normal | 128/32/0/0 | 495 | 655/655/654 | 365/365 | 9 | 231 | 68/15/83 |
| Larger | Luna | deep | 78/153/0/0 | 424 | 655/655/655 | 365/365 | 10 | 211 | 72/15/87 |
| Larger | Luna | light | 92/28/0/0 | 535 | 655/655/655 | 365/365 | 10 | 292 | 74/15/89 |
| Larger | Opus | normal | 57/59/24/0 | 253 | 393/393/393 | 219/219 | 0 | 97 | 32/9/41 |
| Larger | Opus | deep | 73/51/18/0 | 251 | 393/393/393 | 219/219 | 1 | 62 | 32/9/41 |
| Larger | Opus | light | 51/44/17/0 | 281 | 393/393/393 | 219/219 | 1 | 150 | 33/9/42 |
| TypeScript | Luna | normal | 20/9/0/0 | 1 | 30/30/30 | 20/20 | 0 | 13 | 10/3/13 |
| TypeScript | Luna | deep | 23/6/0/0 | 1 | 30/30/30 | 20/20 | 0 | 5 | 11/2/13 |
| TypeScript | Luna | light | 20/8/0/0 | 2 | 30/30/30 | 20/20 | 0 | 14 | 9/5/14 |
| TypeScript | Opus | normal | 9/3/6/0 | 0 | 18/18/18 | 12/12 | 0 | 1 | 0/2/2 |
| TypeScript | Opus | deep | 9/3/6/0 | 0 | 18/18/18 | 12/12 | 0 | 1 | 0/5/5 |
| TypeScript | Opus | light | 9/3/6/0 | 0 | 18/18/18 | 12/12 | 0 | 4 | 0/3/3 |

## Cost and time by stage

| Model | Stage | Calls | USD | Unpriced | Stage minutes | Tokens (M) | Cache read/write (M) | Schema-invalid calls | Repair calls | Timeouts | Tool calls/degraded |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Luna | 5 | 40 | 0.136 | 1 | 19.2 | 0.77 | 0.01/0.64 | 10 | 10 | 1 | 0/0 |
| Luna | 6 | 0 | 0.000 | 0 | 1.1 | 0.00 | 0.00/0.00 | 0 | 0 | 0 | 4298/62 |
| Luna | 7 | 3584 | 3.642 | 2 | 72.9 | 54.05 | 31.96/20.53 | 118 | 118 | 2 | 5690/408 |
| Luna | 9 | 1097 | 1.485 | 10 | 102.6 | 18.04 | 10.68/6.13 | 26 | 26 | 10 | 1755/320 |
| Luna | 10 | 57 | 0.287 | 0 | 23.8 | 2.23 | 0.52/1.53 | 30 | 27 | 0 | 0/0 |
| Opus | 5 | 20 | 3.965 | 0 | 9.1 | 0.60 | 0.01/0.51 | 2 | 2 | 0 | 0/0 |
| Opus | 6 | 0 | 0.000 | 0 | 0.7 | 0.00 | 0.00/0.00 | 0 | 0 | 0 | 2616/36 |
| Opus | 7 | 1861 | 93.932 | 0 | 29.6 | 44.74 | 29.76/14.11 | 0 | 0 | 0 | 1641/72 |
| Opus | 9 | 450 | 27.801 | 0 | 15.2 | 12.92 | 8.87/3.67 | 1 | 1 | 0 | 507/50 |
| Opus | 10 | 20 | 7.040 | 0 | 22.5 | 0.91 | 0.00/0.74 | 2 | 2 | 0 | 0/0 |

## Stage costs by arm

| Case | Model | Depth | Calls (5/6/7/9/10) | Cost in USD (5/6/7/9/10) | Stage minutes (5/6/7/9/10) |
| --- | --- | --- | --- | --- | --- |
| Larger | Luna | normal | 8/0/1149/275/17 | 0.04/0.00/1.16/0.38/0.10 | 3.8/0.3/17.4/31.7/6.7 |
| Larger | Luna | deep | 8/0/1256/312/12 | 0.04/0.00/1.22/0.42/0.07 | 7.4/0.3/24.5/19.4/5.9 |
| Larger | Luna | light | 6/0/921/316/12 | 0.03/0.00/1.02/0.45/0.07 | 3.5/0.3/13.5/25.8/5.9 |
| Larger | Opus | normal | 3/0/602/139/4 | 1.08/0.00/28.97/8.73/2.37 | 2.5/0.2/8.5/3.8/7.6 |
| Larger | Opus | deep | 3/0/667/136/3 | 1.08/0.00/30.08/8.53/1.88 | 2.5/0.2/9.6/4.0/6.2 |
| Larger | Opus | light | 3/0/491/137/3 | 1.03/0.00/29.63/8.63/1.89 | 2.1/0.2/7.6/3.9/6.9 |
| TypeScript | Luna | normal | 6/0/91/63/6 | 0.01/0.00/0.09/0.07/0.01 | 1.5/0.0/3.4/13.4/1.7 |
| TypeScript | Luna | deep | 5/0/103/66/5 | 0.01/0.00/0.09/0.08/0.01 | 1.5/0.0/3.5/6.2/2.0 |
| TypeScript | Luna | light | 7/0/64/65/5 | 0.01/0.00/0.07/0.08/0.01 | 1.4/0.0/10.7/6.1/1.7 |
| TypeScript | Opus | normal | 4/0/35/8/3 | 0.30/0.00/1.92/0.45/0.34 | 0.7/0.0/1.5/1.2/0.8 |
| TypeScript | Opus | deep | 3/0/38/18/3 | 0.19/0.00/1.80/0.92/0.30 | 0.7/0.0/1.3/1.2/0.7 |
| TypeScript | Opus | light | 4/0/28/12/4 | 0.29/0.00/1.54/0.54/0.27 | 0.6/0.0/1.0/1.1/0.3 |

## Telemetry limits

The pilot and the first three comparison slots preceded the full-debug directive. All 45 later slots had individual request and response files for all 6,615 model calls and per-call tool traces for all 8,935 model-initiated tool calls. The four earlier runs retained call ledgers, stage artifacts, coverage and final reports. Across all 49 runs the ledgers recorded 7,178 calls, 82.34 million provider-cache-read tokens and 48.18 million provider-cache-write tokens. Provider cache usage contributes to token volumes even with the local model cache disabled. Strict price totals exclude the 14 calls without a recorded price. The two cases and limited repetitions establish this pre-registered decision on this build. The public version comparison provides the separate test across repositories.
