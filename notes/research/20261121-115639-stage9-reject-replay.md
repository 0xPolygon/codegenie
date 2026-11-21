---
created: 2026-11-21T11:56:39Z
author: "@lead-dev-2"
source: "Requested by @operator for the Stage 9 tracking issue. All 81 Stage 9 reject verdicts from the #112 first-round artifacts (codegenie 0.8.0 at 8a4c5bd), adjudicated offline against the frozen case sources at no model cost."
status: verified
---

# Stage 9 reject replay

**Update: Rule 1 was killed in the paired A/B and removed.** On identical Stage 9 input, the Rule 1 build lost a required finding that the baseline build published, which fired the pre-registered kill rule. Verifier template p9.31 restores the p9.28 text. The replay below records why Rule 1 was tried; the A/B result note records why it was removed.

**Original recommendation: ship Rule 1 only.** Under explicitly behaviour-preserving intent, a proven base-versus-head difference counts as the defect, and production reachability only sets severity. In the replay this rule turned 17 rejects into revisions. All 17 were real at the function level, none was wholly false, and none touched the negative sentinel. Rule 2, which narrows a refuted claim instead of rejecting it, met the pre-registered kill criterion and was dropped. [Campaign plan](../../specs/plans/128-issue-124-stage9-and-depth-campaign.md) · [First-round results](20261121-043636-first-round-baseline-results.md)

## What ran

The first round's 54 reviews produced 81 Stage 9 rejects. 46 had unresolved proof and 35 had refuted proof. The larger case produced 74, the TypeScript case 6 and the small case 1.

Each reject was read against the verifier's recorded reasoning, proof evidence and assumptions, then checked against the frozen base and head sources. Rejects that made the same claim were grouped, so one claim got one ruling across all reviews.

Each flipped claim was classed as one of:
- **real:** the difference exists and a maintainer would want it fixed or acknowledged;
- **policy-dependent:** the difference exists, but whether it is wanted depends on product or provider policy;
- **wholly false:** the difference does not exist, is misdescribed, or is unreachable by construction.

Undecidable claims would have counted as false; none occurred. The kill criterion was registered before the replay: any wholly false flip, or any flip on the negative sentinel. The per-verdict worksheet is private.

## Rules

**Rule 1: reachability is secondary under explicitly behaviour-preserving intent.** A reject flips to revise only if all of the following hold:
- the review's intent signals mark the change explicitly behaviour-preserving;
- proof is unresolved;
- inspected source proves an observable base-versus-head difference at a changed line;
- the triggering value is valid under the changed code's declared type or interface, and no inspected guard on that path excludes it;
- every remaining essential assumption concerns only whether production callers supply that value.

Questions about intent or policy, about whether behaviour actually differs, or about decisive code nobody has read stay essential.

**Rule 2: narrow, don't refute.** A refuted correctness or security reject flips to revise when the verifier's reasoning names an established residual input class on which head still differs from base. The flipped claim is that narrower residual.

## Results

| Rule | Eligible rejects | Flips (Opus / Sol) | Real | Policy-dependent | Wholly false | Negative sentinel |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 46 unresolved | 17 (3 / 14) | 17 | 0 | 0 | 0 |
| 2 | 35 refuted | 21 (20 / 1) | 12 | 6 | 3 | 1 |

**Rule 1.** It recovered 14 rejects of the larger case's second required expectation, 2 of its first optional expectation, and 1 defect in a sibling module of the same class as its second optional expectation.

29 unresolved rejects did not flip:
- **6 were ineligible.** Neither the TypeScript case nor the small case carries an explicitly behaviour-preserving signal.
- **The other 23 kept an essential question** about provider or product intent, about whether the behaviour differs at all, or about code the verifier had not read.
- No reject in the class that #112 adjudicated as policy-dependent flipped.

**Rule 2.** All 3 wholly false flips and the negative-sentinel flip came from residual differences that a refuting verifier mentioned in passing. Adjudication classed each such residual as cosmetic, unreachable or behaviour-neutral; the table counts the sentinel flip as policy-dependent. One further flip was on a sibling of the sentinel claim, classed as policy-dependent.

Rule 2 would also have recovered 11 real larger-case rejects and 1 TypeScript required finding. Those gains do not offset a failed kill criterion. A tighter variant would need its own pre-registered replay.

## The second required expectation is a latent regression

All 14 Rule 1 flips on the larger case's second required expectation are classified **latent**. Each is a real function-level difference, but no newly failing user-visible behaviour was established for it. Rule 1 publishes it at low severity with the reachability question visible. The campaign's success criterion still measures what the rule fixes, namely Stage 9 dropping a proven difference. The analysis behind this classification is in the private worksheet.

## Not addressed

The TypeScript required finding reached Stage 9 in 5 reviews and was rejected as unresolved each time. Neither rule recovers it safely: its intent is not explicitly behaviour-preserving, and Rule 2 is killed. It is filed as a separate Backlog follow-up.

The first optional expectation was rejected 10 times, and Rule 1 recovers only 2 of those. It is not a success measure for the A/B.

## Outcome

- **Change tried:** the Rule 1 text was added to verifier template p9.29, clarified in p9.30, only when the explicitly behaviour-preserving signal was present. The submit schema and the proof gate were unchanged.
- **Validation:** the Luna-high A/B in plan 128 compared the builds through a verifier-boundary replay, so both received identical Stage 9 input. In a valid draw, the Rule 1 build lost a required finding that the baseline published, so the pre-registered kill rule fired.
- **Removal:** Rule 1 was taken out, and template p9.31 restores the p9.28 text.
- **Open question:** the baseline also published the second required expectation in that draw. Recall of that expectation at the baseline needs to be understood before any narrower rule is pre-registered.
