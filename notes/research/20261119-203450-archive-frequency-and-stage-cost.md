---
created: 2026-11-19T20:34:50Z
author: architect-2
source: "0xPolygon/codegenie#44, owner-authorized aggregate analysis"
status: provisional
---

# Historical stage frequency, cost and the missing product baseline

The retained evaluations answer how often several branches actually ran. The latest recorded version is 0.6.3. The archive does not establish the recall or cost of the 0.8.0 product defaults.

## Population

I counted 219 event streams from June 14 through September 25, 2026. Three copies contained byte-identical events, leaving 217 distinct traces. Distinct start timestamps give the same count. Each denominator below requires evidence that a run reached the relevant stage. The census covers two longitudinal case series and a 12-trace experiment. It includes partial runs. Early builds used a flat artifact layout. Later builds used stage directories. Scanning only the later layout would omit 58 matched final selections and change the estimated escape-route pass rate. A separate archive contained 143 earlier-format ledgers with different task and verdict schemas. I excluded those ledgers from stage-specific denominators.

| Question | Historical observation | Interpretation |
| --- | --- | --- |
| How often did Stage 8 fire? | Of 204 starts, 194 explicitly skipped, 10 built a total of 20 tasks (4.9%), and 9 made at least one model call (4.4%). One run stopped after task construction. The nine completed active runs all occurred June 18. They recorded zero new candidates and 17 resolved hints. | The stage had a real effect on questions passed downstream. Inspect whether the resolutions were justified before proposing its removal. [Task construction and skipped branch](../../src/pipeline/system-reviewer.ts#L87) |
| How often did a below-threshold finding escape suppression? | Among 205 completed compositions with final selections, 13 publications joined to escape-route events and 9 findings had the confidence-threshold suppression reason. All 13 published inline. One suppression occurred before the first committed implementation on June 16 and lacks a build identifier. For the 197 matched compositions starting after that commit, 13 of the 21 observed threshold outcomes passed (61.9%) and 8 were suppressed. On 0.6.x there were just 2 such outcomes and both passed. | The denominator is **findings that reached this decision**, not all candidates or all verifier keeps. These disposition counts cannot establish whether the underlying reports were correct. [Threshold branch](../../src/pipeline/composer.ts#L1633) · [First committed hatch](https://github.com/0xPolygon/codegenie/commit/007548a) |
| Was the Stage 9 evidence lane full? | 205 distinct traces reported the overflow counter. It was 0 in all 205. The same summaries recorded 223 eligible and 219 scheduled candidates, with 53 keeps, 154 rejections and 12 incomplete outcomes. | The four eligible-to-scheduled differences were **not recorded as cap overflows**. The runtime tracks eligibility, scheduling and overflow separately. A zero occurrence does not test whether the report correctly discloses an overflow when one happens. [Gate counters](../../src/pipeline/verifier.ts#L416) |
| Has the shipped default been measured? | No archive trace identified itself as 0.8.0. Of 213 distinct traces with case snapshots, 120 explicitly set the adaptive second pass on. The other 93 omitted the setting. All 44 versioned 0.6.x snapshots set it on. Two of three maintained case configurations turn it on. | The runner applies case overrides. Omission in an older snapshot gives no evidence of matched model, version, budgets, lenses or thresholds for today's default. The older corpus cannot serve as the reference arm of a current recall comparison. [Eval overrides](../../src/evals/eval-runner.ts#L862) · [Product routing](../../src/pipeline/lens-runner.ts#L230) |

## Where time and money went

Among the 44 traces on 0.6.x, 37 reported full completion and zero local model-call cache hits. The time column divides recorded stage runtime by the end-to-end duration of the same run. The cost column includes only the 31 eligible runs with a positive known total and no calls of unknown cost. Each cell gives a per-run median and range. Medians across stages need not add to a whole review. Model families, budgets and provider prompt caching varied within this observational sample.

| Stage | Calls | Share of priced cost | Share of elapsed time |
| --- | ---: | ---: | ---: |
| 5, planning | 1 (1–2) | 2.6% (1.1–7.9%) | 10.3% (2.7–23.4%) |
| 7, packet review | 45 (15–60) | 42.0% (29.6–58.1%) | 31.5% (16.1–60.4%) |
| 8, targeted review | 0 | 0% | 0.0% rounded |
| 9, verification | 39 (15–57) | 46.2% (37.4–64.7%) | 38.5% (25.8–56.4%) |
| 10, composition | 1 (1–4) | 5.5% (2.7–11.6%) | 14.1% (4.5–39.2%) |

Stage 9 can cost as much as packet review on a small change with adaptive packet passes enabled. The two local examples in the [original provider workstream](./20261119-201523-model-providers-fast-lane.md) had substantially higher Stage 7 cost shares. Both observations support reporting stage-specific cost distributions separately by workload and arm. Neither estimates a percentage saving for `--depth light`.

The next comparison needs a frozen current build, explicit product defaults, at least one independently adjudicated case in another language, and an uncached repeated pair for each case. Use the old series as historical context. A public 0.8.0 CI review recorded 27 calls, 525,761 tokens and a completed run in 3m51s for $1.9775. Its report establishes an operational result, but supplies neither a controlled recall denominator nor stage-cost attribution. [Public CI result](https://github.com/0xPolygon/codegenie/pull/43#issuecomment-7020657663)
