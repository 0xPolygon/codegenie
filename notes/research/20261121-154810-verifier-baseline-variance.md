---
created: 2026-11-21T15:48:10Z
author: "@architect-2"
source: "Operator-requested follow-up to #124 using fixed verifier inputs, paid-call ledgers and independent source adjudication."
status: verified
---

# Baseline verifier variance on identical input

The unchanged verifier published the larger case's first required behavior (R1) in **10/10** repeats and its second (R2, a latent regression) in **8/10**. Earlier end-to-end detection rates used different candidates. These repeats estimate publication conditional on one fixed input. In the prior paired experiment the changed verifier lost R1 on that same input and cited the new instruction. The pre-registered stop still stands. [Paired result](20261121-125051-stage9-paired-verifier-results.md)

## From candidates to publication

We ran ten larger-case and five TypeScript repeats on `0850ed6` with verifier template `p9.28`, OpenRouter GPT-6 Luna at high configured reasoning, verification on and local caching off. Each repeat restored an identical, hash-checked input and made fresh calls through normal composition. The original paired reviews are outside these denominators. All 15 repeats completed.

| Larger-case behavior | Candidates accepted out of 10 | Reviews publishing behavior | Published entries and severity |
| --- | --- | ---: | --- |
| R1 | 8 and 9 | 10/10 | 11 medium |
| R2 | 4 and 7 | 8/10 | 8 medium, 2 low |

In three of ten reviews, composition published two entries for the same expected behavior. Count each behavior once per review. The second optional behavior was published in 10/10, and the candidate-only behavior was present in 10/10. The native lexical scorer credited R1 in 8/10 and R2 in 9/10. Source inspection of all 72 larger-case and five TypeScript publications found zero wholly false claims, policy-dependent publications or negative-sentinel claims.

The TypeScript required behavior was absent from its one fixed discovery result and published in **0/5** repeats. One different real candidate was verified and published at medium in all five. A deterministic gate suppressed the other, related question in all five before a verifier call. Independent analysts initially disagreed on whether this was loss of the required behavior at that gate. Rechecking the question against the oracle showed that it did not identify the required cause. The five replays are **one discovery observation**. Gate suppression alone does not establish that dispatching the question would recover the defect. Earlier Stage 9 losses on other candidate sets remain separate evidence.

## Verdict and severity variance

Of 18 larger-case candidates, eight crossed the keep-or-revise versus reject boundary, eight were always accepted and two were always rejected. Across 180 decisions there were 42 keeps, 87 revisions and 51 rejections (28 refuted, 23 unresolved). Each repeat rejected between three and seven candidates. Six candidates varied between low and medium severity when accepted. The table uses capture order; severity counts are for accepted verifier decisions before composition merges sources.

| Candidate | Keep | Revise | Reject | Accepted low / medium |
| --- | ---: | ---: | ---: | ---: |
| 1 | 7 | 3 | 0 | 10 / 0 |
| 2 | 5 | 5 | 0 | 10 / 0 |
| 3 | 2 | 8 | 0 | 7 / 3 |
| 4 | 3 | 7 | 0 | 10 / 0 |
| 5 | 5 | 5 | 0 | 3 / 7 |
| 6 (R2) | 0 | 4 | 6 | 2 / 2 |
| 7 | 0 | 3 | 7 | 3 / 0 |
| 8 (R2) | 3 | 4 | 3 | 0 / 7 |
| 9 (R1) | 0 | 8 | 2 | 0 / 8 |
| 10 (R1) | 1 | 8 | 1 | 0 / 9 |
| 11 | 2 | 5 | 3 | 7 / 0 |
| 12 | 0 | 0 | 10 | 0 / 0 |
| 13 | 0 | 3 | 7 | 3 / 0 |
| 14 | 3 | 5 | 2 | 2 / 6 |
| 15 | 4 | 6 | 0 | 0 / 10 |
| 16 | 4 | 6 | 0 | 1 / 9 |
| 17 | 0 | 0 | 10 | 0 / 0 |
| 18 | 3 | 7 | 0 | 2 / 8 |

## Stage timing and spend

Discovery, packet construction and promotions were restored or rebuilt without model calls. Stage 9 had 30 schema-invalid calls and 11 timeouts across the 15 repeats; all scheduled candidates ultimately received verdicts. Stage 10 had 12 schema-invalid calls and completed model composition in all 15. Seven repeats retained full debug traces after the owner enabled them; all 15 retained the model, tool and event ledgers and final artifacts.

| Case | Stage | Calls | Recorded tokens | Stage minutes, sum | Known USD | Unpriced calls |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Larger | 9 · verifier | 686 | 11,502,845 | 79.52 | 1.04094 | 11 |
| Larger | 10 · composer | 22 | 1,384,711 | 12.41 | 0.17240 | 0 |
| TypeScript | 9 · verifier | 24 | 413,054 | 5.98 | 0.04115 | 0 |
| TypeScript | 10 · composer | 5 | 57,134 | 0.97 | 0.00978 | 0 |

Total recorded spend was **$1.26427**, with prices for 726 of 737 calls, against a $1.50 estimate. The 15 reviews used 99.99 minutes in total. Median review time was 10.79 minutes on the larger case (3.26–12.75) and 1.40 minutes on TypeScript (1.22–1.54).

Judge verifier edits on paired verdicts from identical inputs, then follow each behavior through composition. Here, eight candidates changed acceptance on the baseline alone, while composition sometimes published two entries for one behavior. A final-finding count cannot distinguish those effects.
