---
created: 2026-11-21T12:50:51Z
author: "@architect-2"
source: "Requested by @operator for #124. Aggregate verifier-boundary checks, model-call ledgers and source adjudications from plan 128."
status: verified
---

# Stage 9 paired verifier results

**Rule 1 triggered the pre-registered stop condition.** On identical inputs, baseline A published the larger case’s first required finding (R1) and treatment B lost it. A and B both published the second required finding (R2), a latent regression. The operator stopped the experiment after two of ten planned draws and directed the team to restore baseline prompt behavior. One larger-case draw establishes the paired loss. It leaves the frequency of either outcome unknown. [Campaign protocol](../../specs/plans/128-issue-124-stage9-and-depth-campaign.md) · [Offline reject replay](20261121-115639-stage9-reject-replay.md)

## What ran

Both arms used GPT-6 Luna on OpenRouter with configured high reasoning, normal depth, adaptive off and verification on. A was `0850ed6` with verifier template `p9.28`. B was `16a4ad4` with `p9.30`. Plan 128 originally named `p9.29`. The follow-up clarified which contract establishes input validity before dispatch. Both builds used the same verdict schema, proof gate, composer and renderer. Rule 2 had already failed offline replay with three wholly false flips and a negative-sentinel flip. Only Rule 1 entered the live comparison. [Template clarification](https://github.com/0xPolygon/codegenie/pull/136)

**Retired cache pair.** In the first TypeScript attempt, the cold baseline produced a schema-invalid Stage 7 response. The cache stored the repair and omitted the invalid response. The warm treatment regenerated the original response and missed again on its next call. The planner replayed, and 12 of 14 Stage 7 calls hit the cache. All three candidate IDs matched, but the candidate content differed. Both reviews were partial. The pair counts toward spend and safety reporting only.

The lexical scorer gave the retired baseline credit for the required finding and flagged the treatment’s negative sentinel. Source adjudication found that both arms published the same distinct real issue. Neither found the required behavior or made the claim the sentinel forbids. The operator cleared the lexical false alarm for the revised experiment. [Scoring follow-up #127](https://github.com/0xPolygon/codegenie/issues/127)

**Verifier-boundary replay.** For each fresh draw, A ran discovery once and saved the full planner and packet-review results before verification. The private launcher restored those results on each build, rebuilt packets, promotions and repository tools on the frozen target, and checked the canonical verifier input against the captured bytes. Both builds matched on both draws. Separate checks also matched the diff, candidate and promotion artifacts. Each arm then made fresh verifier calls and ran its ordinary composition, rendering and scoring path. Local model caching was off. The time and token budgets restarted at the boundary for both arms. Discovery usage is counted once per draw.

Judge verifier edits by comparing paired verdicts on identical input and following those verdicts through publication. A change in a candidate verdict can disappear in the final report when two candidates cover the same behavior.

## Paired outcomes

One TypeScript draw and one larger-case draw produced **four complete downstream reviews**. The larger draw supplied 18 candidate inputs and the TypeScript draw supplied two. Counts below are source-adjudicated. Required and optional columns count final-publication detections. The candidate-only column counts presence at verifier intake.

| Case and arm | Required | Optional | Candidate-only | Published entries | Adjudicated sentinel hits |
| --- | --- | --- | ---: | ---: | ---: |
| Larger A | R1 and R2 | O2 | 1 | 7 | 0 |
| Larger B | R2 | O2 | 1 | 6 | 0 |
| TypeScript A | 0 | — | — | 1 | 0 |
| TypeScript B | 0 | — | — | 1 | 0 |

On the larger draw, A revised both candidates for R1 and published one finding. B rejected both despite recognizing the source-proven change. Its rejection of the candidate published by A explicitly applied the treatment’s instruction about a preservation commitment outside the affected behavior. Both rejections completed. This evidence met the protocol’s attribution rule for a paired required loss. A published latent R2 at medium severity and B at low. The target of B publishing R2 in at least three of five reviews remained untested. O1 was descriptive only and appeared in neither final report. The strict scorer missed candidate-only presence on both arms.

On that draw, two of A’s five rejected candidates became revisions in B. One concerned R2, which A had already published through another candidate. Neither verdict identified a qualifying preservation commitment as its positive justification. The TypeScript case was a guard because its intent did not activate Rule 1. Its two reports agreed after source adjudication. Across the four valid reviews there were zero strict sentinel hits, zero wholly false publications and zero policy-dependent publications. B’s seven published entries therefore produced no new false publication. The paired R1 loss determined the decision.

## Observed cost and time

| Attempt or draw | Capture USD / min | A USD / min | B USD / min |
| --- | ---: | ---: | ---: |
| Retired TypeScript pair, full reviews | — | 0.03236 / 2.29 | 0.02408 / 8.79 |
| Valid TypeScript draw | 0.01846 / 0.73 | 0.01244 / 1.31 | 0.00909 / 1.52 |
| Valid larger draw | 0.23353 / 3.90 | 0.13463 / 6.10 | 0.11604 / 10.60 |

**Known provider usage totaled $0.58063.** Of 421 provider calls, 419 had a recorded price. Two Stage 9 timeouts had unknown cost, one in the retired treatment and one in the valid larger treatment. The 13 local cache hits in the retired pair carried $0.01444 of historical usage, excluded from provider spend. Valid-draw A/B times in the table cover the downstream invocation. The shared discovery time is listed separately. From Stage 9 start to completion, the valid larger A/B reviews took 6.01/10.50 minutes and the TypeScript reviews took 1.30/1.51 minutes. The larger treatment used 17.3 seconds of its 120-second finalization grace and returned complete verifier verdicts. [Finalization follow-up #101](https://github.com/0xPolygon/codegenie/issues/101)
