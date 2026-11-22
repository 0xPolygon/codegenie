---
created: 2026-11-22T16:58:31Z
author: "architect"
source: "Requested by the operator for plan 131 (#146). Read-only scripts and blind sub-agent reads over the telemetry of the 140 completed Luna slots at pins a3437f2 (A) and 1607a8b (B, draft PR #150), the frozen public case oracles and the reviewed source. Written before reading the other analyst's note; the reconciliation section was added afterwards."
status: verified
---

# Verifier advice labels: independent analysis

**Keep the advice labels. Without them the verifier is cleaner, faster and cheaper, but in this sample the arm without labels published one wholly false finding that the labelled arm rejected on the same input in every draw, and it published a wrong fix in all three repeats of another case where the labelled arm withheld it.** The campaign stopped on its registered rule for a false publication. The labels are not selective: the labelled arm withheld eight suggestions and only two were wrong.

Reconciled with [the other independent analysis](20261122-164132-verifier-advice-codex.md). Both reach the same decision from the same go-06 evidence, and agree on the sample, the spend, the Stage 9 and Stage 10 health and time figures, the published-advice counts and the larger-case counts. They differ on one group of advice: the other analysis counts three go-06 cleanup fixes in B as wrong, giving B 7 wrong of 54 published fixes, where my readers call them valid close calls, giving 4. Both set aside the six go-05 selection fixes. I adopted its reading of one go-05 fix in A after comparison, and it adopted mine of the go-06 path claim; neither of those two agreements is independent.

## What ran

Arm A is build `a3437f2`, which asks the verifier to assess each suggested fix and test and withholds advice it does not mark supported. Arm B is `1607a8b`, draft PR #150, which removes those assessments from the verdict. Both ran GPT-6 Luna at high reasoning through OpenRouter. Stages 5 to 7 were frozen per input, so each pair of reviews verified and composed the same candidates.

| Stratum | Inputs | Reviews per arm |
| --- | ---: | ---: |
| Public cases | 20 | 60 |
| Larger private case | 1 | 5 |
| Existing TypeScript case | 1 | 5 |

That is 140 of the 248 scheduled Luna reviews; the rest did not run because of the stop. Recorded spend is $1.23 for A with three unpriced calls and $0.91 for B with one. Seven Opus reviews exist; that cross-check is incomplete and is not analysed here.

Both builds predate the Stage 10 change that canonicalizes attention decisions (#165), so the Stage 10 figures below describe an older composer than current master.

## The stop: a false finding published only without labels

On one public input (go-06) the same frozen candidate reached both verifiers three times. It claims a documentation entry points to a source path that does not exist.

| Draw | A | B |
| --- | --- | --- |
| 1 | rejected, refuted | kept and published, low severity, with a fix |
| 2 | rejected, unresolved | rejected, refuted |
| 3 | rejected, unresolved | rejected, refuted |

The claim is false. The file lists every source under a module prefix, 27 entries use the same prefix, and the census test scans the repository root under it. The suggested fix would make that one entry inconsistent with the rest. The plan's stop rule is a wholly false finding published by B and never by A on that input, and this meets it.

One publication in three draws does not show how often removal would cause this. Verdicts on a frozen candidate vary between draws in both arms, as the larger case shows below.

## Advice quality on the public cases

Published advice was classified blind. Each file of advice text was read by a sub-agent that saw only the text, the reviewed checkout and the case oracle, and the arm was joined by script after the classes were written. A second pass then had one reader per case judge every item of that case under a single standard. The two passes agree on valid against wrong for 181 of 182 items.

| | A | B |
| --- | ---: | ---: |
| Fixes published | 46 | 57 |
| Tests published | 34 | 37 |
| Fixes withheld | 6 | 0 |
| Tests withheld | 2 | 0 |
| Wrong fixes published, undisputed | 0 | 4 |
| Wrong tests published | 0 | 0 |

B's four undisputed wrong fixes are two findings:

- One finding in cg-01, in all three repeats. It describes a credential check at runner construction, which is real but intended: tests pin it and the GitHub Action reads its marker. The fix says to drop the check. A raised the same finding in two repeats and withheld the fix both times.
- The false go-06 finding above, once.

Three groups of items are close calls, and I report them apart from the counts above:

- **go-05, a fix that inherits a boundary one token early (A, one item).** My first reader and my per-case reader called it valid; a reader given the five related fixes together called it wrong and reproduced the harm in an offline copy, where a different conversation inherited the boundary and a later request then discarded 576 cached rows. The other analyst had locked it as wrong. I accept wrong. A labelled this fix supported and published it.
- **go-05, six fixes for a slot-selection finding (three per arm).** Readers split on which of two doc comments governs. Published equally in both arms, so it does not separate them.
- **go-06, three fixes that check whether a process is still running before signalling its group (B).** My readers call them valid on the ground that the server keeps no child processes; a reader who treats group signalling as contract would call them wrong.

With the go-05 selection group set aside, wrong published fixes are 1 of 43 for A and between 4 and 7 of 54 for B.

### What the labels did

In A every published suggestion carried the supported label and every withheld one the unverified label, so the label is the withholding rule and nothing more. Of the eight withheld, two were wrong (the cg-01 fix, twice) and six were valid, including one fix that matches the real cg-01 fix. Of the 80 published, one was wrong. The label caught the one repeated wrong fix in this sample and passed the other.

A's composed findings more often lacked a fix: 12 of its 58 composed finding groups against 6 of 63 for B. Findings without a test were level, 24 and 26. Five further A groups came from one review composed by the fallback.

## Verdicts

| Stratum | | A | B |
| --- | --- | ---: | ---: |
| Public | keep | 21 | 41 |
| | revise | 58 | 40 |
| | reject | 23 | 21 |
| | candidates published | 79 | 81 |
| Larger private case | keep or revise, of 90 | 62 | 59 |

Without the assessment fields B keeps where A revises; rejections are level. The case scorer passes 27 of 60 public reviews in each arm. I did not adjudicate required findings on the public cases from source, so this note gives no recall figure.

### Larger private case

The ten reviews replay one frozen set of 18 candidates. The majority verdict differs between the arms on three of them. Six candidates differ by at least one vote, and I had each adjudicated against the source by a reader who saw only the claim and the repository:

- One is a real defect introduced by the change. A sibling candidate covers the same defect, and every review in both arms publishes it.
- Five should not be published by my reading. A kept them 14 of 25 times and B 13 of 25.

Two of those five carry a required expectation in the case oracle. The other analyst keeps the oracle's line for them, at 4 of 5 reviews for A against 3 of 5 for B. We agree that no request that succeeded before the change is shown to fail after it, and differ on whether that latent difference warrants a finding.

Verdict variance matters for any rule that redraws after a rejection. On these stored verdicts, redrawing once after an unresolved rejection and letting an accept win would raise the one real defect from 0.90 to 0.99 expected publications per review, and the five others from 2.70 to 3.33.

## Verifier health, time and cost

Stage 9, all 197 verifier requests per arm:

| | A | B |
| --- | ---: | ---: |
| Model calls | 732 | 686 |
| Calls not completing normally | 11 | 0 |
| Stopped for runaway padding | 3 | 0 |
| Field repairs scheduled | 7 | 0 |
| Schema repairs scheduled | 8 | 0 |
| Submissions canonicalized | 135 | 0 |
| Suggestion support downgraded by the harness | 5 | 0 |
| Recorded Stage 9 spend, USD | 0.99 | 0.74 |

Stage 9 wall time, mean per input:

| Stratum | A | B |
| --- | ---: | ---: |
| Public, 20 inputs | 34.0 s | 20.9 s |
| Larger private case | 166.9 s | 122.4 s |
| TypeScript case | 69.5 s | 29.9 s |

B is lower on every stratum. These gains are real and are the reason the removal was proposed.

Stage 10, on the older composer:

| | A | B |
| --- | ---: | ---: |
| Model calls | 87 | 76 |
| First submission invalid, public (of 60) | 5 | 1 |
| First submission invalid, larger case (of 5) | 4 | 2 |
| Reviews composed by the deterministic fallback | 1 | 1 |

Every invalid first submission on the larger case named the attention decisions, not the advice fields. B's one fallback, on the larger case, made six kept findings summary-only and published its findings without advice, which is how #150 is designed to behave in fallback.

## What this supports

- Removing the assessments fixes the verifier's repairs and padding and saves about a quarter of Stage 9 cost and between a quarter and over half of its time, depending on the input.
- It also removes the only thing that stopped a wrong fix from reaching the reader, and in one draw it coincided with a false finding being kept. Wrong advice on a finding both arms publish is the smaller harm; a false finding is the larger one.
- The labels as built are a blunt filter. They withhold three valid suggestions for each wrong one, and they pass wrong fixes they mark supported. Keeping them is the safer choice on this evidence, not a sign that they work well.

## Limits

- The sample is 20 public inputs with three draws each, one larger case and one TypeScript case. Half the schedule did not run.
- All of my readers are one model family. Single readers were not stable on close calls: one item was classed three ways across three readings. The undisputed counts are the ones every reading and the other analyst agree on.
- I changed my class for the go-05 boundary fix after seeing the other analyst's, so that agreement is not independent.
- Process slips, disclosed when they happened: early in the campaign a script of mine printed the arm of one advice file before I had classed it, and I had that file classed by a fresh blind reader; I opened a file in the campaign directory that held four of the other analyst's judgements after my own were locked; and one blind reader ran a public test that sent a few requests with placeholder names to a public model host, after which the readers were barred from network use.
- The private case appears here as counts only.
