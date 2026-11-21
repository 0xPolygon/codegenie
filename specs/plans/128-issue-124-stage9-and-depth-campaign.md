# Stage 9 verification and the fast/deep decision

**Status — protocol approved, execution pending.** The first experiment asks whether the Stage 9 prompt recovers a real bug from identical candidates. The second asks whether spending more or less at Stage 7 improves the final review. The operator must confirm that this plan is merged and identify the pinned runner build(s) before any paid calls. Record the exact revisions and resolved model routes in the private dispatch manifest. The depth rename follows the results. [Stage 9 issue #124](https://github.com/0xPolygon/codegenie/issues/124) · [First-round protocol](127-issue-112-baseline-matrix.md) · [First-round results](../../notes/research/20261121-043636-first-round-baseline-results.md)

| Order | Comparison | Cases and size |
| --- | --- | --- |
| 1 | Offline replay of historical Stage 9 rejects | All 81 from #112. Zero model calls. |
| 2 | Old vs new verifier prompt, Luna high | Larger and TypeScript, 5 pairs each. 20 reviews. |
| 3 | Small price and time pilot, Luna high | One full review at normal depth, adaptive off. |
| 4 | Normal vs deep vs light, adaptive off throughout | Larger and TypeScript. Per case and arm, 5 Luna reviews and 3 Opus reviews. 48 reviews (32 normal/deep plus 16 light). |

There are **69 paid review slots** if every gate passes. The small case was detected in 18/18 reviews in #112. Its pilot calibrates cost and time and contributes no votes to either comparison.

## Freeze before dispatch

Use private working copies of the three plan 127 cases. Pin the same source revisions, diff modes, oracle definitions, required and optional expectations, candidate-only expectation and negative sentinels. Store target SHAs, oracle and manifest hashes, per-slot order, lockfile, binary commit and effective configuration outside the public repository. For the public TypeScript case the base is `a8b1d998cb10b65de26e05dbc001b7079df5ff42` and the head is `80df9e6c6869035cb0cf1c6b2dfba75debf3edd6`. Keep the oracle out of the checkout being reviewed.

Use `openrouter/openai/gpt-6-luna` and `anthropic/claude-opus-5-5`, both with **configured reasoning high**. Preserve the runner's shipped stage-specific reasoning policy and record the effective level per stage. In all full reviews use shipped lenses, verification on, budget boost 1, six workers, six concurrent model calls, 8,000,000 tokens, the 30-minute review limit and the eight-minute per-pass limit. Remove inherited lens/model overrides and the obsolete ensemble setting from the private copies. Keep any historical advisory call-count threshold separately labeled. It is not an execution cutoff.

Use the pinned build's `executeEvalCommand` through the same serial launcher pattern as plan 127, with one invocation of `eval --eval-dir <slot>` per review. Give each slot its own output and a clean configuration home. Lock the schedule, reconcile any previous start, and close provider transports in a `finally` block. Before a paid dispatch, load all manifests offline, verify each resolved target, arm, route, limit and cache setting, and compare the exact scheduled counts with the table above. Preserve every attempt and its ledger. An error, timeout, missing artifact or unpaired result stays in the attempted denominator. Replacements and additional repetitions require an operator decision.

## 1. Verify the verifier change

**Offline prerequisite.** The Stage 9 implementer adjudicates all 46 unresolved and 35 refuted rejects against their frozen sources. Record each original verdict, which proposed rule would change it, and whether the resulting claim is real, policy-dependent or wholly false. Report aggregate flips and negative-control results to the operator before changing code. Any wholly false flip or negative-sentinel flip stops the proposal. After a passing replay and the operator’s checkpoint, the implementer adds the prompt rules and deterministic tests.

Rule 1 applies only with explicit behavior-preserving intent. Inspected source must establish an observable base/head difference at a changed line for an input admitted by the interface and unexcluded by inspected guards. If the only remaining essential assumption concerns whether production supplies that input, revise the finding, retain reachability as a secondary assumption and cap severity at low until reachability is proven. A product-policy question does not meet this test. Rule 2 lets the verifier revise an overbroad correctness or security claim when an independently proven residual input class survives refutation. TypeScript tests the second rule and guards against unintended changes outside the first rule's intent condition.

**Paired builds.** A uses the parent on master immediately before the Stage 9 prompt change. B uses its merged revision. Verify the diff that reaches the verifier, the template bump from `p9.28` to `p9.29`, unchanged `submit_verdict` v11 and unchanged proof gate. Resolve any unrelated runtime difference before dispatch. Pin both lockfiles and builds. Use normal depth and adaptive off in both arms. Alternate AB/BA by repetition and alternate which case starts each repetition. Run the first arm of each pair cold with `review.cache = true` and a fresh private `review.cacheDir`. Run the second with the same target, config and cache directory. Either arm may warm the cache. Each pair generates a new candidate set independently of the other nine pairs.

**Prove the inputs match.** Hash canonical JSON for the ordered Stage 9 `candidate-findings.json`, `uncertainty-promotion.json` and corresponding Stage 6 packet inputs in each arm. Compare hashes privately. Check the model-call ledger and per-stage cache accounting. The replaying arm must have zero upstream model-call misses through Stage 7, and Stage 9 must draw fresh verdicts without cross-arm model-cache hits. The template version participates in the call key. A deterministic repository-tool cache hit on the frozen revision is admissible. Missing or unequal payloads, upstream misses or a cross-arm verifier hit make the pair unpaired. Record the spend and examine safety outcomes even for unpaired reviews. If pairing fails, stop dispatch and diagnose before committing more slots. A decision requires five valid pairs on each case. [Cache replay issue #30](https://github.com/0xPolygon/codegenie/issues/30)

**Stage 9 decision.** Adjudicate by the behavior proved in the source. In the larger case R1 and R2 mean the first and second required expectations, and O1 and O2 the two optional expectations in manifest order.

| Outcome | Decision |
| --- | --- |
| Success, all conditions | B publishes R2 in at least 3/5 larger-case reviews. In each pair B retains every A detection of R1, O1 and O2 and preserves the candidate-only expectation at its declared checkpoint. TypeScript has at least as many paired required detections in B as A. |
| Kill, any condition | B introduces a wholly false published finding, fires a negative sentinel on either case, or loses a paired required detection that source adjudication attributes to the change. Stop and report. |
| Owner decision | If B's policy-dependent publication count exceeds twice A's, report the counts before continuing (including A = 0 and B > 0). Missing success, too few valid pairs or a safety stop leaves the depth campaign pending the operator's decision. |

Report reject-to-revise flips per rule on shared candidates, verdict mix, policy-dependent findings and partial reviews. Show original strict scores alongside source adjudications. Compare cost and elapsed time for Stages 9 through final output separately from whole-review spend. The cold arm pays to generate candidates. Report Stage 9 finalizations past the grace period, timeouts and missing verdicts separately from source-based rejection. [Finalization issue #101](https://github.com/0xPolygon/codegenie/issues/101)

## 2. Compare depth before renaming it

On one operator-confirmed post-Stage-9 build, freeze identical coverage policy in all arms. The planner ranks attention and every eligible hunk is dispatched. Preserve deterministic config exclusions. Verify the planner change on the common build before the pilot. Keep the three existing depth values so normal remains a measurable control. [Eligible-hunk coverage #130](https://github.com/0xPolygon/codegenie/issues/130) · [Depth migration #129](https://github.com/0xPolygon/codegenie/issues/129) Use local model caching **off** (`--no-cache`) throughout this phase, including the pilot. Perform a small-case checkpoint with recorded cost, wall time, route, effective reasoning, completeness and unknown-cost calls, then reforecast the remaining slots. Escalate material drift to the operator before continuing.

| Arm | Depth | Adaptive second pass | Role |
| --- | --- | --- | --- |
| A | normal | off | Shipped budget and close-nudge reference |
| B | deep | off | Candidate default with today's larger packet budgets |
| L | light | off | Candidate opt-in fast mode |

Run independent full reviews within blocks keyed by case, model and repetition. Rotate A–B–L, B–L–A and L–A–B across repetitions. Offset the rotation by one position for the second case and reverse it for Opus. Interleave cases and models while both families have repetitions remaining. Store the resulting slot order before running. The 5 Luna blocks per case are the primary evidence. The 3 Opus blocks per case test whether another model supports or contradicts Luna's direction. Opus alone cannot establish a switch. The adaptive configuration key stays available with its default off.

**Score each stage separately.** For every required behavior, establish presence in Stage 7 candidates, after uncertainty promotion, after Stage 9 verification and in the final report. Retain required, optional, candidate-only and negative results separately. Read every discordant result and every potential new false positive against the frozen source, blinded to arm where possible. Confirm apparent matches even when the scorer agrees across arms. Count each behavior once per review and distinguish real detections, policy-dependent findings and wholly false publications. Count severity or repair errors separately from whether the behavior was detected. The TypeScript oracle distinguishes two causally different failures that shared lexical matches in #112.

For every cell report starts, completions, partials, errors, adjudicated detections, wholly false findings, provider prices and unpriced calls, cache usage, median and range for cost and elapsed time. Record both runner completeness and a campaign partial when a review exceeds 30 minutes. Keep actual wall time, including grace. Record eligible, excluded, dispatched and reviewed hunk counts, planner entries by coverage level, packets built, escalation, Stage 7 soft-target or result-size exhaustion, candidates and verification intake. Report the Stage 5 deep / normal / light / skip hunk-entry distribution for every case, model and arm. Compare A with B because the planner dossier receives the depth label. These pre-rename runs retain the old depth labels in run.json.

**Deep.** Compare B with A within each block. B must hold required detections for each expectation, case and family, show a material source-adjudicated gain on at least one case in a majority of Luna pairs (at least 3/5 for the same required behavior), and add no confirmed false-positive regression or partial review. Opus can confirm that direction or be neutral. A reversal on Opus blocks promotion. If the arms tie, results remain sparse, or B fails the criteria, use today's normal budget under the deep name and drop the 1.5× scale. On that outcome, use A’s close-nudge behavior as well. If A and B differ in planner assignments, flag that a literal deep dossier label with A’s budgets and nudge was never measured. The migration owner can preserve the measured A behavior internally or request separate validation. Similar distributions in this sample do not establish label equivalence.

**Fast.** Compare L with the selected default on the common build and report L versus A as a fixed reference. Require at least **30% lower median cost or median elapsed time on the larger case** on primary Luna, with required detections and completeness held on both cases, no confirmed false-positive regression, and no contrary quality result in the Opus cross-check. Report both cost and time, including any trade-off. An Opus-only win cannot qualify fast. If the bar is missed, ship one mode. The separate migration design handles legacy inputs and warnings after this decision.

## Cost and time

The table holds #112 medium-reasoning token volumes fixed. Luna uses medians of Sol per-review volumes repriced per call at the locally pinned Pi 1.6.0 OpenRouter Luna rates ($0.10 uncached input, $0.50 output, $0.01 cache read and $0.125 write per million tokens). All sampled calls fit the first price tier. Opus uses mean recorded dollars per corresponding Opus arm. Deep's row uses normal volume as its reference because #112 did not run deep. High reasoning, new verdicts, provider cache behavior and the full-coverage planner can change both volume and elapsed time.

| Phase | Pricing basis | Illustrative USD |
| --- | --- | ---: |
| Offline reject replay | 81 source adjudications | 0 |
| Stage 9, 10 Luna pairs | 5 × (one cold larger $0.3520 + replay stages 9 onward $0.1264 + one cold TypeScript $0.0245 + replay $0.0124) | 2.58 |
| Luna small pilot | One normal/off review | 0.04 |
| Luna A and B | 5 × 2 arms × ($0.3520 larger + $0.0245 TypeScript) | 3.77 |
| Opus A and B | 3 × 2 arms × ($12.4089 larger + $0.8685 TypeScript) | 79.66 |
| Luna L | 5 × ($0.2969 larger + $0.0238 TypeScript) | 1.60 |
| Opus L | 3 × ($11.7391 larger + $0.5624 TypeScript) | 36.90 |
| **Total** | **48 depth reviews about $121.94, plus verifier comparison and pilot. Total from unrounded inputs.** | **124.55** |

Price actual usage from the provider ledgers at each checkpoint. In #112 Stage 7 represented 70% of normal/off cost on Opus and 60% on Sol. A 50% increase in that stage alone would add about $14.5 across the deep slots, before any effect on downstream verification. Use the ledger's recorded prices for the actual route and show unknown usage separately. Historical Luna at **max**, normal depth, adaptive on and four workers took a median 10.0 minutes (7.8–16.1) on the small case and 48.1 (37.7–53.6) on the larger case at budget boost 4. Luna-high latency on these cases and high/deep Opus spend remain unmeasured.

Publish aggregate comparisons and the resulting decisions only. Keep the private per-pair evidence, candidate IDs, prompts, paths, source content and hashes of private inputs in the private worksheet.
