---
created: 2026-11-19T20:36:37Z
author: architect
source: "https://github.com/0xPolygon/codegenie/issues/44 (phase 3 synthesis of workstreams A–D and their challenges)"
status: provisional
---

# Deep review of codegenie 0.8.0: synthesis

This note ranks what the four workstreams found and what the team should do about it. Nothing here has been decided; scope and architecture are @operator's and the owner's to decide.

**Revision 2, approved.** @architect-2 [challenged the first draft](20261119-203942-challenge-deep-review-synthesis.md) and required changes; all are applied here and listed in section 11. They re-checked this revision and approved it, with no further challenge round needed. After approval I added facts from workstream D's final response — the promotion and cap rows in section 2, D's bugs in section 6, one row in section 3 — and changed no recommendation.

**Inputs.** Workstream notes: [A pipeline](20261119-202121-pipeline-architecture.md) and its [addendum](20261119-203132-pipeline-architecture-measurements-and-replies.md), [B models, providers, fast lane](20261119-201523-model-providers-fast-lane.md) with the [live token-count check](20261119-202649-anthropic-token-count-confirmation.md), [C code, tests, evals](20261119-201419-code-level-tests-evals-audit.md) and its [response](20261119-203000-code-audit-challenge-response.md), [D plan history](20261119-202300-plan-history.md) and [D competitive landscape](20261119-202647-competitive-landscape.md), both amended by [D's response](20261119-204403-plan-history-competition-response.md), which wins where they differ and carries an anchor for each of the 125 plans. Challenges: [of A](20261119-202431-challenge-pipeline-architecture.md), [of B](20261119-203826-challenge-model-providers-fast-lane.md) with its [reply](20261119-203840-model-review-challenge-response.md), [of C](20261119-202605-challenge-code-audit-tests-evals.md), [of D](20261119-202949-challenge-plan-history-and-competition.md). Archive census: [by @architect-2](20261119-203450-archive-frequency-and-stage-cost.md).

**Evidence base.** Code at master `f240376`. About 205 stored eval runs from two private cases on one repository, June to September 2026, read with the owner's approval and reported here as counts only. No scored eval run exists on 0.7.0 or 0.8.0; about 25 unscored local reviews on those versions give stage costs and nothing about recall. Three members counted the archive independently and agree on the numbers used below; where a count names a cohort, it holds for that cohort only. Live checks made with the owner's approval: token-count requests that confirmed a request-shape rejection, and reviews that confirmed the fix for it. No eval was run.

## 1. The verdict in six lines

1. **The design is right.** Narrow parallel finders, an evidence-gathering verifier, deterministic accounting and posting: several current products document the same shape, though not all keep verification mandatory. No workstream found a reason to restructure the pipeline.
2. **One release-blocking bug, already fixed on a branch.** The default request to the newest Claude models is rejected by the provider. The fix (#46) is reviewed and passed live reviews; it needs merging and a release. The same question is open for Bedrock (#47).
3. **The harness has outgrown its measurements.** No scored run measures 0.8.0. In the longitudinal eval cohort every run on 0.5.x and 0.6.x used a setting the product ships turned off, and every eval run pins the lens set that the product lets the planner choose. The one case still being run passes every time, so it can no longer show the next loss.
4. **A large part of the pipeline is compensation for earlier compensation** — about a third of `src/pipeline` and `src/llm` by my estimate from line ranges, not by a reproducible count. The history shows each gate between "found" and "published" being patched in turn, about 40 plans reacting to single runs. The stored runs show several of those gates and rescue lanes with no recorded effect.
5. **So the largest safe win is deletion, in two different kinds.** About 950 lines have no production caller or no producer (summed from the ranges in the workstream notes); removing them changes nothing. A further 1,000 or so belong to mechanisms with no recorded yield; removing those changes behaviour and needs the checks named below.
6. **Do not build a fast lane yet.** Measure the cheap variants that already exist. The shipped default is itself one of them.

## 2. What the review established

| Finding | Evidence | Agreement |
|---|---|---|
| Named tool choice is rejected by Opus 5.5 and Fable 5.2, and by vendor documentation also Sonnet 5.5 and Fable/Mythos 5.1; `provider use opus` selects Opus 5.5 | Live HTTP 400 on the first two, 200 with automatic choice; it is a property of the model, not of the thinking setting | B, D challenge, confirmed live; fixed on a branch as #46 |
| Credential preflight refuses a bearer-only setup that the runtime accepts | Reproduced by two members. The bearer token is kept out of the key table on purpose (plan 125); refusing preflight is the side effect | B and D agree on the behaviour; whether it is a defect is a product decision |
| Stage 8 has not run since the first recorded week and never produced a candidate | 10 runs built tasks and 9 made model calls, all on one day; 0 candidates in about 204 runs; its only effect was resolving 17 hints, with no evidence required | A, B, C |
| The post-verification confidence gate suppressed a finding 9 times (8 after its exception existed), none on 0.6.x; the exception published 13 times, twice on 0.6.x | Three matching censuses | A, B, C |
| The evidence lane's cap never bound | 0 overflow of about 220 eligible | A, B, C |
| In the longitudinal cohort every run on 0.5.x and 0.6.x had the adaptive second pass on; the product default is off | 92 of 92 runs in that cohort (a separate set of 12 experimental traces omitted it); on 0.6.x 10 of 80 published findings had no first-pass member | A, B, C, D |
| The promotion limit is the cap that binds most often | It bound in 173 of 257 runs. The adaptive cap bound in 32 of 118 runs with the pass on. Evidence-lane overflow, the verifier budget and the ensemble packet cap never bound | D response |
| Promotion is a saturated, low-yield rescue lane | 484 promoted, 98 kept by the verifier (20%), 18 published on promotion evidence alone, 45 more merged with a packet finding | D response; A's smaller count agrees on the rate |
| The low-confidence exception has not fired in the 55 stored runs on 0.6.1 to 0.8.0 | 13 published and 9 suppressed before that | D response. Check that a 0.6.1 change did not make it unreachable before reading dormancy as safety |
| On small changes the planner and composer are a real share of cost | 7–46% of dollars across 20 unscored 0.8.0 runs; on the stored five-packet case stage 9 is the largest stage | B, D |
| On 0.6.x all 43 scored expectations passed; all six failing runs broke a cost, time or completeness limit | Addendum §3 | A |
| The composer fell back to the deterministic report in 7 of 44 runs on 0.6.x, five on one model family | Addendum §3 | A |
| The scorer can credit a finding assembled from two different candidates, pass a run whose findings file is missing, and pass a failed review | Probes without a provider | C, checked by A |
| Precision is not measured anywhere | No precision metric; unmatched findings are computed and unused | A, C, D |
| Plans patch one gate per run; recall mechanisms accumulate and none retire | 125 plans audited | D |
| Several vendors report that raw model confidence filters poorly, and several studies find verification helps when it brings new evidence | Vendor posts and four papers; denominators differ across sources, and at least one comparable product lets verification be switched off | D, narrowed by B |
| Controlled recall on 0.8.0 at product defaults is unmeasured; uncontrolled 0.8.0 telemetry exists | 20 unscored local runs and one public CI run give cost and time only | B, D |

## 3. Ranked recommendations

Each has its evidence in the linked note. "Kill" is the condition under which the team should drop the recommendation or revert the change.

### Priority 0 — fix what is broken

| # | Recommendation | Impact | Risk | Measure / kill |
|---|---|---|---|---|
| 1 | **Merge and release the fix for named tool choice (#46), and settle Bedrock (#47).** The fix downgrades to automatic choice wherever the catalog says thinking cannot be turned off — the rule @operator chose. It also covers Fable 5, which does accept a named tool; that is an accepted conservative deviation. On Bedrock a named tool is forced whatever `forceSubmitToolChoice` says, and acceptance there is unprobed. (B §1 and its challenge) | Restores the default Claude path, which on master fails at the first planner call | Automatic choice may lower first-submit validity | First-submit validity per model in the baseline; a serialized-request test per affected model, which the suite lacked. Kill: none — this is a defect |
| 2 | **Decide whether bearer-only and federated credentials are supported from the CLI.** If yes, make preflight ask the runtime whether credentials exist and keep the key table only for placing an explicit Action key; never pass a bearer token as an API key. (B §2 and its challenge) | Users with those setups stop being refused | Preflight becomes async | Fixture matrix: bearer, stored key, OAuth, two ambient cloud setups |
| 3 | **Fix the confirmed bugs in section 6**, one issue each, grouped PRs. | Removes four ways a finished review loses or misstates findings | Low; each is small | Each bug's failing case becomes its regression test |

### Priority 1 — make the measurements mean something

| # | Recommendation | Impact | Risk | Measure / kill |
|---|---|---|---|---|
| 4 | **Baseline master in the configuration users get**, on the small and larger stored cases and one new second-language case, two model families. Matrix in section 4; a proposal, not yet approved. | Every later decision depends on it | About $760 for the first round and $1,400 at the proposed maximum, each plus the unpriced new case | Pre-registered rule in section 4 |
| 5 | **End the adaptive-pass split.** My recommendation: measure first and change no default until the matrix is in. Whatever it shows, the eval cases stop overriding the setting. Section 4 gives the rule. (A addendum, D) | The shipped product and the measured product become the same | The status quo continues while the matrix runs | Section 4 |
| 6 | **Fix the scorer before trusting any comparison:** one coherent source per positive expectation; missing or failed runs cannot pass; keep the lenient match for negative sentinels until each lost violation is adjudicated. (C items 2, 3; challenge of C) | Scores stop over-crediting | Historical pass rates move | Re-score the archive; adjudicate each changed result in both directions. Kill: a known genuine merge loses credit |
| 7 | **Give the suite something it can fail:** a case from a second repository and language; a false-positive rate from adjudicated unmatched findings; clean changes as negative controls. An open benchmark's offline set is a cheap outside check. (C, D) | The suite can show the next loss and any precision cost | Adjudication labour | First precision figure with its sample size. Kill: not applicable |

### Priority 2 — delete

| # | Recommendation | Lines | Evidence it is safe | Kill |
|---|---|---|---|---|
| 8 | **Dead-code bundle.** Legacy note suppression and its always-empty artifact fields; the gate-only anchor residue; the budget-extension chain; the compact-finalize residue; planner candidate ranking; zero-caller helpers. | ~950 | Found dead by A, C and D independently; no producer event in 44 recent runs for the anchor path | Any test of *production* behaviour fails |
| 9 | **Do not delete** the Action's preflight-only input, the skill `categories` key in the parser, the readers for old eval cache fields, or the Action's key-placement table. | — | @architect-2's challenge: each has a public contract or a live reader | — |
| 10 | **Stage 8 targeted review.** Delete it, after two checks: adjudicate its 17 historical hint resolutions as correct or unsupported, and run one control case built to trigger it. This is a behaviour change, not dead code: when it ran it changed which questions went downstream. | ~540 + prompt + schema | Zero candidates in about 204 runs; no model call since the first recorded week; it resolves concerns without requiring evidence (challenge of A §2) | The control shows it producing a kept finding that stage 7 and promotion miss, or the adjudication shows its resolutions were correct and useful |
| 11 | **Ensemble K>1.** The owner's sunset count stands at 18 of 20, and its packet cap never bound. Deleting it also removes half of the cache collision in recommendation 16. | ~100–150 | Plan record only. No outside evidence applies: the vendor that dropped an ensemble was voting, and codegenie unions | A single-packet critical miss appears in the baseline that a second draw plausibly catches |
| 12 | **Stage 7 deterministic candidate cleanup.** Replay the invalid-submit shapes it was written for before deleting. | ~300 | Code reading says it cannot recover what shared validation already rejected. In the stored 0.6.x runs it was attempted only twice, with no recovery, among 35 invalid submits that the model repair handled — too few exposures to call it inert on data alone | A replayed failure shape that it recovers and the model repair does not |

### Priority 3 — shorten the path from found to published

| # | Recommendation | Impact | Risk | Measure / kill |
|---|---|---|---|---|
| 13 | **Enforce the verdict contract:** a keep with high false-positive risk is a reject; a synthetic keep from `verify=false` is not "verified". (challenge of A §1) | Closes two precision holes; prerequisite for 14 | One affected verdict in 203 runs | Table test across verify on/off, proof, risk |
| 14 | **Then make the verdict the publication gate** and delete the post-verification confidence check with both exceptions. Keep `minInlineConfidence` as the one rule for inline versus summary. Leave the pre-verification gate alone. | Removes about 120 lines, eight thresholds, and bug A8; ends the gate-by-gate patching D describes | Low-confidence kept findings in categories outside the old exception start to appear, as summary-only | Replay the 8 suppressed and 13 excepted findings and adjudicate each. Kill: any adjudicated material false positive, or a sentinel violation |
| 15 | **Errors in a model call are stage-local unless they are authentication or provider-wide** (plan 80's intent; the code is the reverse), and the review is retained before composition. (D bugs; A2) | A late failure degrades to the deterministic report instead of an empty one | A genuinely fatal error is retried | Injected-error test at each throw site |
| 16 | **Give supplemental draws their own cache identity**, only for whichever of ensemble and adaptive survives. (C item 4) | Cache-on runs stop reporting two passes for one draw | New key material; bump the version | Scripted first-miss, second-hit packet |
| 16a | **Put the promotion lane's cost and yield in front of the owner.** 484 promoted, 98 kept by the verifier, 18 published on promotion evidence alone, with its limit binding in two runs out of three. What the lane costs is not yet known: the stage 9 calls and spend attributable to promoted candidates have to be measured first, since one candidate can take several calls and some are stopped at the gate. the local-delta reserve inside it selects no better than plain ranking. A rescue lane, so rescue counts are fair evidence. (D response; A addendum) | Either a slimmer lane or a recorded decision to keep it | It is the only rescue path in the shipped default | Adjudicate the 18 sole-evidence publications; replay selection without the reserve. Kill: the 18 include material true positives nothing else surfaced, in which case keep the lane and drop only the reserve |
| 17 | **Split the verifier's two jobs — by measurement first.** Its prompt is the largest in the pipeline and most of it concerns the suggested fix and test. (A §4, §6) | Possibly faster and steadier verification | Remedy quality drops | Paired runs with and without the remedy paragraphs. Kill: keep rate on known true positives falls |

### Priority 4 — robustness across model families

| # | Recommendation | Evidence | Measure / kill |
|---|---|---|---|
| 18 | **Define every enum and decision rule the model must choose between, in one sentence each.** The two cross-model defects fixed so far were fixed this way. Start with confidence. (D lesson 5) | Zero code; removes "a per-model lottery" | First-submit validity and verdict mix per family in the baseline |
| 19 | **Test the serialized request for every provider path** on each dependency bump. The forced path rebuilds provider options and differs from the ordinary path on Gemini, Mistral, Radius and Bedrock. (B §3) | Recommendation 1 would have been caught | The test seam exists |
| 20 | **Track fallback and repair rates per model family** as health numbers. (A addendum) | 7 of 44 composer fallbacks, five on one family | Reported per run group |
| 21 | **Per-stage model selection (#29): do not build the public configuration yet.** See section 7. | | |

### Priority 5 — the fast lane

See section 5. Recommendation: no new mode; measure `--depth light` and the shipped default inside the baseline.

### Priority 6 — how the work is run

| # | Recommendation | Evidence |
|---|---|---|
| 22 | **One ledger for plan status.** The plan header is the source; generate or delete the README table; archive the punch list. Close plans 55, 102, 103, 104, 113; decide 105. | Four records disagree (D bottom line 7) |
| 23 | **A measurement rule for every later change:** N per arm stated before the runs, one case outside the single repository, first misses adjudicated by hand, a frozen baseline. | "Single runs decide nothing" was written down six times and not followed (D lessons) |
| 24 | **Refresh the spec where it is wrong, not merely behind:** repair counts, the stage list, the keep criteria, the run-directory layout. | Divergence tables in A §8, B, C |

## 4. The adaptive-pass decision and the paid-run matrix

*A proposal for the owner. No spend has been approved. Models, pinned settings, staging and the decision rule follow [@architect-2's specification](20261119-203840-model-review-challenge-response.md).*

**What is known.** The pass is capped at four per run. In the stored runs with the pass on, it accounted for about 20% of cost on the five-packet case and 3–5% on the 73-packet case; that is attribution inside one arm, not a measured saving from turning it off. In the same arm, ten of 80 published findings on 0.6.x had no first-pass member. That shows where those findings came from; it does not show they would be lost with the pass off, because a first pass can find the same thing on another draw. Nothing measures the off arm, and nothing measures false positives in either.

**Recommendation: measure first.** Defaulting the pass on now would raise cost and wall time for every user on evidence that has no off arm and no precision figure. Leaving the split in place while the matrix runs costs nothing new.

**Before any paid run.** The scorer defects of recommendation 6 are fixed first — a failed or output-less run must not score as a pass. A new case is written: a hard cross-file bug in a second language, with adjudicated safe behaviour as controls, so that no global decision rests on one repository.

| | |
|---|---|
| Build | One pinned master commit |
| Models | `anthropic/claude-opus-5` at high reasoning, the path CI uses today; `openai-codex/gpt-6-astra` at high. Both ids and levels are in the installed catalog. The first accepts a named tool, so the matrix does not wait for #46 |
| Fixed | verify on, K=1, budget boost 1, worker and provider concurrency at the shipped 6, local cache off, lens selection as shipped rather than pinned by the case, the same budget and time limits in every arm |
| Arms | **normal / off** (the shipped default), **normal / on**, **light / off** (the first fast-lane measurement) |
| Cases | Exactly three: the small stored case, the larger stored case, and the new second-language case |
| First round | 3 paired repetitions per case and arm, arms interleaved: 27 runs on one family, 54 on two. Its realised cost and time are recorded before anything further is approved |
| Proposed maximum | Up to 10 repetitions on the small and new cases and 5 on the larger: 150 runs across three arms and two families, under a separately authorised budget, used only to resolve a meaningful ambiguous result |
| Optional fourth case | The stored hard variance case: 9 more runs per family in the first round (72 in all), costed separately |
| Latency | No two paid runs overlap on the same provider while latency is compared |
| Reported | Paired outcomes per expectation with the loss stage; severity of adjudicated misses; new adjudicated false positives; completeness and budget health; cache accounting; median and range of cost and elapsed time, with unknown-cost calls counted. For the light arm also the planner's coverage and skip distribution, packet count, escalated packets and candidate count, so a faster result bought by skipping more hunks is visible |

**Cost and time.** The unit is the stored median for the small case with the pass on: about $9.40 and 9 minutes on the Claude model, about $3.10 and under 3 minutes on the GPT model. The larger case has no stored run on either model; I scale the older Claude model's $23 a run by the 2.3× ratio seen on the small case, giving roughly $54. That scaling is the weakest known number. The new case has no observed price at all. Spend on the subscription-backed GPT path is nominal, API-equivalent accounting.

| First round | Claude model | GPT model |
|---|---|---|
| Small case, 9 runs | ~$80 | ~$28 |
| Larger case, 9 runs | ~$490 | ~$160 |
| New second-language case, 9 runs | unknown | unknown |
| **Known part** | **~$570** | **~$190** |
| Wall time for the two stored cases, runs in series | ~4–9 hours | ~2.5 hours |
| Optional fourth case, 9 runs | ~$45–80 | ~$23 |

First round on both families: about **$760 plus the new case**. The proposed maximum of 150 runs: about **$1,400 plus the new case**. A cheaper start is one family only.

**Decision rule, fixed before the runs.**
- The first round prices the comparison and surfaces discordant pairs. It decides nothing by itself.
- Outcomes compared are verified material findings and adjudicated false positives, not overall pass counts. Two extra passes on one case among many comparisons, or 4 of 5 against 5 of 5, decide nothing.
- **Default the pass on** only if the off arm repeatably loses a material expectation that the on arm keeps, the difference replicates on the second family, and every discordant pair has been adjudicated.
- **If the arms stay tied or the data stays too sparse at the proposed maximum,** the default stays as it is and the decision is recorded as unresolved. A tie at these sample sizes cannot show the pass is unnecessary, so the matrix cannot authorise deleting it; that would be a separate owner decision.
- **Either way the eval cases stop overriding the setting** unless a case says why, so the suite measures what ships.
- **The light arm** becomes the documented fast path only if it lowers both dollars and wall time with no repeatable material loss of recall or precision and no additional incomplete work.

## 5. The fast lane

The owner asked for a brainstorm of a fast lane beside the deep default. The constraints come from the pipeline. Cost is linear in packets. Which stage dominates depends on the size of the change: on two large local runs stage 7 took 83–95% of tokens, while on stored runs of a five-packet change the median shares of elapsed time were 31.5% for stage 7 and 38.5% for stage 9 across 37 complete runs, and of cost 42% and 46% across the 31 of those that were fully priced ([census by @architect-2](20261119-203450-archive-frequency-and-stage-cost.md)). That stored configuration, with the adaptive pass on, spent about 77 model calls and nine minutes on the strongest model; the shipped default has never been timed. `review.depth` scales stage 7 tool budgets, including those of escalated packets, and one nudge threshold. The planner also sees it, so coverage, skips and packet count can shift in a model-dependent way. The verifier's tool budget is fixed, but how many candidates it verifies follows whatever stage 7 produces. No stored run has ever used `light`.

| Option | Saves | Expected signal loss | Verdict |
|---|---|---|---|
| **A. `--depth light`, same model, verification kept** (B) | Stage 7 tool rounds only. Planner, verifier and composer unchanged, so on a small change it touches well under half the cost | Cross-file bugs that need tool evidence; more genuinely incomplete packets | **Measure first.** Exists today, no code |
| **A0. The shipped default** (adaptive pass off) | Hypothesis: up to the 20% of cost the pass accounted for on small changes in the stored on-arm, and one wave of wall time | Unknown. In the on-arm one published finding in eleven had no first-pass member, which bounds nothing causally | **It is already a cheaper variant and it is unmeasured.** Section 4 measures it |
| **B. No model planner, deterministic composition, light review** (B; A §9) | Two serial calls: about 50–80 seconds and $0.20–0.50 in two traces. The pipeline already runs on an empty plan and the fallback report is complete | Planner skips, model-chosen depth, routing to custom lenses, merged prose. Note resolution is a small loss: 4 of 86 concerns resolved | **Second.** Only if the serial stages are still the bottleneck after A |
| **C. One diff-wide pass, no verifier** | Most of the cost | Coverage accounting and the precision gate. Cost-cutting that strips context or checks was reverted every time in the plan history | **Reject** |
| **D. A cheaper or different model for the whole run** | About a third of cost and half the time in one older study | The operating point does not transfer between families | **Available today** with `--model`; measure per model |
| **E. Incremental re-review keyed on hunk content** (D, from a competitor) | Packets, on a re-push | An unchanged hunk can be invalidated by a change elsewhere; needs refusal conditions and fail-open to a full review | **A separate lane for re-pushes.** Design after #30 is measured |
| **F. Publish only high and critical findings** | Comment volume, not cost | Lower-severity true findings | A publication preset, not a fast lane |

**Recommendation.** Add no new mode. A is the third arm of section 4. If it cuts both cost and wall time and loses no repeatable expectation, document `--depth light` as the fast path; the existing model alias is already a per-trigger channel in the Action. Try B only if the planner and composer remain the bottleneck. Design E separately for re-pushes. Keep verification in every variant: it is the part that outside evidence most clearly supports. It is not cheap on small changes, though — it is the largest stage there — so recommendation 17, measuring the verifier without its remedy-assessment work, is also the most direct lever on small-change latency. One naming point from B: "deep review" the product and `depth: deep` the setting mean different things.

## 6. Confirmed code bugs

Each distinct symptom becomes its own issue per the owner's instruction; a row here, or a delivery PR, may group related ones. @pm is merging duplicates across workstreams. Evidence is in the cited note. **Probe** means reproduced offline by the named member; **read** means code reading checked by a second member; **wire** means a difference seen in the serialized request, with the provider's response to it untested.

| Bug | Where | Evidence |
|---|---|---|
| Named tool choice rejected by current Claude models | `src/llm/pi-runner.ts` forced-choice mapping | B, live; fixed on a branch (#46). Bedrock variant open (#47) |
| Forced-submit requests differ from ordinary requests on three other provider paths: Gemini switches from a thinking budget to a thinking level, a non-reasoning Mistral model receives a reasoning effort, and Radius loses the selected effort. Reported reasoning in telemetry disagrees with what is sent | `src/llm/pi-runner.ts:1889-1986` | B, wire only — no provider failure observed |
| Escalated packets keep their old profile: zero tools for `simple`, a smaller budget for `standard` | `src/pipeline/coverage-escalation.ts:39-44` | A read, C read |
| A non-recoverable composer error empties the report; model errors are run-fatal unless marked recoverable | `src/pipeline/composer.ts:128-136`, `review-runner.ts:316-329`, `pipeline-utils.ts:5-7` | A read, D read, C agrees |
| The synthesis-failed banner is dropped from the posted review | `src/pipeline/composer.ts:2119` | A read, C agrees |
| The low-confidence exception bypasses `minInlineConfidence`; the report and GitHub disagree | `src/pipeline/composer.ts:1632-1661` | A, C, D; tests pin both behaviours |
| With `verify=false`, unverified candidates qualify as verified | `src/pipeline/verifier.ts:255-262`, `composer.ts:1696-1704` | C probe |
| A keep with high false-positive risk is accepted | `src/pipeline/verifier.ts:799-801` | A read, C read; once in 203 runs |
| `provenance` is lost on a verifier revise | `src/pipeline/verifier.ts:1284-1301` | A read, C agrees |
| The composer can resolve a note against a finding that caps then suppress, leaving neither | `src/pipeline/composer.ts:112,245` | A read, C probe |
| A planner skip loses its path and reason in the rendered report | `src/pipeline/review-runner.ts:1021-1093` | C probe |
| Supplemental stage 7 passes share a cache key with the first pass | `src/llm/pi-runner.ts:1380-1403` | C probe |
| The scorer credits across candidates; passes a missing findings file; passes a failed review | `src/evals/eval-scoring.ts:69-167` | C probes, A read |
| The model cache crashes when Git is missing and can evict unrelated files | `src/llm/model-call-cache.ts:140-210` | C probe |

From workstream D, confirmed by reading and undisputed in its challenge:

| Bug | Where | Evidence |
|---|---|---|
| A telemetry event for adjudicated-reject suppression is nested in the wrong block and is lost | `src/pipeline/human-attention.ts:283-302` | D read; in code that recommendation 8 deletes |
| Recovery-inventory overflow is run-fatal in the planner and verifier, where stage 7 degrades | `src/llm/pi-runner.ts:312-314,712-714` | D read; not reproduced live |
| A rejected field repair copies the raw rejected arguments into telemetry and the repair prompt | `src/llm/pi-runner.ts:678-684` | D read |
| The verifier repair classifier ignores `findingUpdates` and mislabels a revise as empty | `src/pipeline/verifier.ts:1110-1116` | D read |
| The cache fingerprint includes the absolute repository path and operational settings, so a different checkout or concurrency never replays | `src/pipeline/review-runner.ts:844-869` | D read; part of #30 |
| Planner telemetry reports upgraded hunks as upgraded packets | `src/pipeline/planner.ts:587-588` | D read |
| The README names the wrong model for `provider use opus` | `README.md:28` | B run |

D also lists six unconfirmed items that need a reproduction before an issue (its response, H1–H6).

**Reproduced but disputed as a defect:** preflight refuses a bearer-only setup that the runtime supports (`src/provider/pi-ai-models.ts:111`; B and D probes). Leaving the bearer token out of the key table was deliberate; whether the CLI should support that credential is a product decision (recommendation 2).

Confirmed by @architect-2's second check of A's previously unchallenged list:

| Bug | Where | Evidence |
|---|---|---|
| Stage 8 loads skills for model-suggested lenses with no enabled or language filter | `src/pipeline/system-reviewer.ts:271` | A read, B check |
| A `# ` line inside a skill code fence ends the section; a CRLF skill file fails to load | `src/skills/skill-loader.ts:236,394-421` | A read, B check |
| A planner skip with empty lenses has its reason rewritten (diagnostic scope only) | `src/pipeline/planner.ts:1422-1428` | A read, B check |
| Stage timings vanish from the report when telemetry is off, the default | `src/telemetry/run-artifacts.ts:618-621` | A read, B check |
| `severityBeforeCap` is lost on a verifier revise | `src/llm/verifier-revision.ts:119-124` | sub-review, B check |

## 7. Backlog verdicts

**#29 — per-stage model and reasoning selection: still valid, premise partly stale, keep in Backlog as an experiment.** One model still serves every stage. Reasoning already varies by call: repairs run at the lowest level and the composer steps down one. The issue's cost shares hold for large diffs (stage 7 at 83–95% of tokens) and not for small ones, where verification can be half the calls. The planner and composer are a small share of dollars and a larger share of serial wall time. If built, it must live inside the one runner — one limiter, one budget ledger, one recovery map — and be chosen per request stage. Build it only if it beats two things that need no code: a different global model, and `--depth light`. (B verdict; A addendum §3)

**#30 — the model-call cache barely replays: valid, and it is three separate things.**
1. *Exact replay on the same head works for identical requests* — a probe got a write then a hit. The run fingerprint also covers the absolute repository path and whole configuration subtrees, so replay is easy to lose; a warm hit rate on 0.8.0 has not been measured. Measure it before changing the key.
2. *A real bug:* supplemental passes replay the first pass when the cache is on (section 6).
3. *"Identical input, disjoint findings" is stage 7 variance, not a cache fault.* It is the same variance the history documents.
Reuse across a new head is a different design (option E), with its own safety conditions. The counters the issue asked for exist, as its author later noted. (C; challenge of D)

**#31 — an option to forbid planner skips: valid, accept.** A skip with any non-blank reason removes a source hunk with no deterministic check, and the rendered report then loses its path and reason. Stored frequency is low on our cases — 18 hunks across 48 runs on 0.5.x and 2 across 44 on 0.6.x — but the issue reports 22 in one run on another repository, and for a merge gate the frequency is beside the point. The slim design reuses what exists: with the option off, a skip is converted to the default at plan validation, exactly as an empty-reason skip already is; the report lists planner skips by path with their reasons; and, because the issue asks for it explicitly, a run in that mode fails if any eligible hunk was not dispatched to a packet review that completed. What stays an owner decision is whether incomplete verification or unresolved notes should also fail such a run; plan 06's never-built `--fail-on-partial` is the precedent. Do not use planner skips to make a fast lane look cheaper. (A §2; B verdict; challenge of A §3)

## 8. Security decision for the owner: repository skills are read from the working tree as trusted text

**The fact.** `loadSkills` reads `<repo>/.codegenie/skills` from the working tree on every run (`src/skills/skill-loader.ts:53,68`). Skill text enters the planner, reviewer and verifier prompts unfenced, as instructions. In the default local mode the working tree is the branch under review, so a pull request can add a skill whose False Positives section tells the verifier what to dismiss. Repository `codegenie.toml` can likewise disable lenses. The Action is safe only because the example workflow checks out the base revision; no code enforces it. The spec says skills "always load from the trusted local checkout" and that policy-file changes are "noted in the report"; the code detects such changes and renders nothing.

| Option | What changes | Cost |
|---|---|---|
| **1. Read skills and repository config from the review's base revision, through git** — as every source read already is | A pull request cannot change the rules it is reviewed by, whatever the checkout | Editing a skill in a branch has no effect on that branch's review. Not yet sized: three cases need a design first — the base branch is itself resolved from repository config, a first commit has no base tree, and user-specified `extraSkillPaths` stay outside the rule |
| **2. Keep working-tree loading, but when the diff touches a policy file, use the base version of that file and say so in the report** | Closes the hole only when it is exercised; fixes the missing report line | Two code paths; relies on policy-path detection being complete. Small |
| **3. Leave it, document the checkout requirement, and render the policy-change line** | Nothing structural | The Action stays safe by convention only |

**Recommendation: option 1, as a direction.** It matches how the pipeline already treats source. It is not yet a single small change: the three cases in its row must be resolved before it is sized or called mode-independent. If the owner wants the hole closed sooner, option 2 is the smaller interim step.

## 9. Recommendations that need an owner decision, not a fix

- **Evidence-lane overflow is undisclosed.** It never happened; delete the cap, or count overflow as skipped verification.
- **A completed packet with a kept hint and a tool error fails the run with exit 1.** Possibly intended by plan 123; confirm or soften to incomplete.
- **A hunk over 12,000 characters is windowed and still counted reviewed.** Disclose it in coverage.
- **A new finding within five lines of an older codegenie comment is skipped and not moved to the review body.** Move it to the body.
- **Stage 8 removes hints without evidence.** Moot if recommendation 10 deletes stage 8.
- **Show unverified candidates under the "review incomplete" banner** when verification could not finish. The spec says unverified candidates are not publishable.

## 10. Proposed tickets

For the Backlog after the owner reviews this note. Sizes: S under a day, M a few days, L a week or more.

| # | Ticket | Kind | Size | Depends on |
|---|---|---|---|---|
| 1 | Automatic tool choice for models that reject a named tool — exists as #46, assigned | bug | S–M | — |
| 2 | Preflight asks the runtime for credential availability | bug | M | — |
| 3 | One issue per confirmed bug in section 6 | bug | S each | — |
| 4 | Eval scorer: coherent positives, missing and failed runs | bug | M | — |
| 5 | Baseline matrix on master (section 4) | measurement, paid, needs owner approval | M | 4, and the second-language case from 13 |
| 6 | Decide the adaptive second pass from ticket 5 | decision | S | 5 |
| 7 | Dead-code bundle (recommendation 8, minus 9) | deletion | M | tests pinning production behaviour |
| 8 | Stage 8: delete or keep with a control | decision, deletion | S–M | owner |
| 9 | Ensemble K>1: delete | deletion | S | owner |
| 10 | Stage 7 candidate cleanup: shrink | deletion | S | 5 confirms zero recoveries |
| 11 | Verdict contract, then verdict as the publication gate | simplification | M | 3, replay adjudication |
| 12 | Model-call errors stage-local by default; retain review before composing | bug, hardening | M | — |
| 13 | Precision metric, second-repository case, negative controls | eval | L | 4 |
| 14 | #31: `allowPlannerSkips`, per-path skip disclosure, and failure when an eligible hunk is not dispatched | feature | M | — |
| 15 | Skills and repository config from the base revision | security, design first | M | owner decision, section 8 |
| 16 | #30: measure warm replay; draw identity for surviving supplemental passes | measurement, bug | S–M | 6, 9 |
| 17 | Serialized-request tests per provider path | hardening | M | — |
| 18 | Define confidence and the other model-chosen enums in the prompts | hardening | S | measured in 5 |
| 19 | Verifier remedy-assessment experiment | measurement, paid | M | 5 |
| 20 | Promotion lane: adjudicate its 18 sole-evidence publications; replay without the reserve | measurement | S | — |
| 21 | Plan ledger, spec refresh, close parked plans | docs | M | — |
| 22 | Incremental re-review design (option E) | design | M | 16 |

## 11. Where the workstreams disagree, and what is still open

**Changes made after the challenge of this note.**
1. The paid matrix is a proposal with no spend approved, uses exactly three cases, prices the new case as unknown, and puts the scorer fixes first.
2. Counts are tied to their cohort: 92 of 92 holds for the two longitudinal series; uncontrolled 0.8.0 telemetry exists and is kept apart from controlled recall; findings without a first-pass member are attribution, not causal loss.
3. Deleting stage 8 and the stage 7 cleanup are behaviour changes with their own checks, separate from removing code with no caller; line counts are marked as estimates.
4. The light arm reports planner coverage, skips, packet count, escalations and candidate count.
5. The bug list separates wire-level differences and the disputed bearer-credential classification from confirmed defects.
6. Industry claims are narrowed, and the base-revision skills policy is a direction with three unresolved cases, not a sized change.
7. An inconclusive matrix keeps the adaptive pass opt-in; it cannot authorise deleting it.

- **How much weight outside evidence carries.** D first read a vendor's dropped voting ensemble as support for K=1 and has since retracted that: the vendor voted, codegenie unions. Recommendation 11 rests on the plan's own sunset count alone.
- **Whether "zero rescues" justifies deleting a gate.** @architect-2: a precision gate records zero rescues when it works. Agreed; recommendation 14 is judged by replay and adjudication in both directions, not by counts. For stage 8 and the stage-7 cleanup the argument is different: they are rescue mechanisms, so a record of zero rescues does count against them. It is still not enough alone, which is why recommendations 10 and 12 require the adjudication of the 17 resolutions with a control case, and the replay of the failure shapes behind only two recorded exposures, before either is deleted.
- **Recall priority.** A's first note ranked the confidence gate first; the archive shows it inert on recent runs. A's addendum withdraws that ranking, and this note follows the addendum.
- **Whether stage 8 can be deleted on the archive alone.** @lead-dev-2 calls it a deletion candidate for every lane. @architect-2 asks first for adjudication of its 17 resolutions and a positive control. Recommendation 10 takes the second position: the checks are cheap and need no paid run.
- **Whether the preflight refusal is a bug.** Both reviewers reproduce it; the exclusion behind it was deliberate. Recorded as a product decision (recommendation 2).
- **Workstream B's challenge closed with no unresolved disagreement;** every item was a narrowing or an addition, and all are reflected above.
- **Not yet done.** The larger-case cost in section 4 is an extrapolation. Nothing in this review scored 0.8.0 for recall or precision.
