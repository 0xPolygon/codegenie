---
created: 2026-11-19T20:26:05Z
author: architect
source: "https://github.com/0xPolygon/codegenie/issues/44 (phase 2 challenge of notes/research/20261119-201419-code-level-tests-evals-audit.md by lead-dev)"
status: provisional
---

# Challenge: code audit, tests and evals note (workstream C)

I re-read the code behind the three claims @lead-dev asked me to attack and behind items 5 and 8. Nothing was run. Outcome: no claim is wrong; one deletion needs an extra test because it removes a guarantee that is already silently off, one scorer fix has an asymmetric side effect, and two items are ranked above their evidence.

## Item 1 — delete the legacy note suppression: agree, with one finding

**Reachability holds.** The only caller of `selectHumanAttentionForOutput` passes empty findings and resolutions (`src/pipeline/composer.ts:267-273`). `buildVerificationResolutionIndex` and `suppressAttentionGroupsResolvedByVerification` have no other caller in `src` (grep: definitions at `src/pipeline/human-attention.ts:350,388` and the one internal call at `:267`).

**The artifact shape does not need preserving.** The eval reader takes only `outputNotes` from `human-attention-notes.json` (`src/evals/eval-artifacts.ts:218-221`). `publicationFallbacks`, `fallbackGroup*`, `suppressedByFindings`, `suppressedByVerification` and `keptForOutputGroupIds` have no reader in `src`. Drop them with the code rather than writing constants.

**What the deletion also removes.** The same function holds plan 110's publication fallback: a note whose candidate the verifier kept but which was not published outranks ordinary notes inside the five-note cap (`human-attention.ts:263-279`). Because the resolutions argument is empty, that guarantee is already off at master. So the deletion is behaviour-neutral, but "zero live runs needed" hides that the failure plan 110 fixed may be reachable again through plan 121's reconciliation:

1. Reconciliation evidence is built from the verifier-kept findings before caps (`composer.ts:112` passes `pretrim.kept`).
2. The composer model may resolve a packet note against that evidence. The self-support check only blocks evidence from the concern's own candidate (`src/pipeline/attention-reconciliation.ts:332`), and a packet note's candidate id is `packet:<id>` (`:107`), so the finding promoted from that very note is admissible evidence.
3. Caps run after the composer returns (`composer.ts:245`) and can suppress that finding for `low` confidence (`:1632-1660`).
4. Resolved notes are removed (`:262-266`). With no finding and no note, health is `completed` and the summary is "No credible findings" (`:314-318`).

This is a code-path reading, not an observed run. Please add it to the deletion's test list: *a kept finding suppressed at caps whose source note was resolved against it*, asserting that the finding or the note is visible. The fix belongs in publication policy (your item 8, my B1), not in keeping the legacy code.

## Item 2 — coherent evidence per expectation: agree, with an asymmetry

Verified: `matchExpectation` returns `fields.every(matched)` and each field is matched on its own against the merged source views (`src/evals/eval-scoring.ts:164-166`). Location is internally coherent — the line range is checked only on path-matched variants (`:1573-1579`) — so the false credit is between location and category, severity or title, as you describe.

**Side effect to design for.** `should_not_find` uses the same matcher (`:72`). A stricter matcher gives fewer positive credits, which is the intent, and also fewer sentinel violations, which weakens the only false-positive guard the suite has. Require the coherent view for positives; for negatives either keep the lenient match or adjudicate every violation that disappears. Your adoption rule ("re-score stored cases and adjudicate each changed result") should count the two directions separately.

## Item 3 — missing evidence passes: agree

Verified: missing artifacts are recorded (`src/evals/eval-artifacts.ts:44-46,89-93`), `scoreEvalRun` never reads them (`eval-scoring.ts:69-93`), and they surface only as a metric (`:995-996`). A negative-only case therefore passes on an absent `final-findings.json`. No change to your proposal.

## Item 4 — Stage 7 replay identity: mechanism agreed, rank and order challenged

Verified: the cache key has no pass or worker component (`src/llm/pi-runner.ts:1380-1403`), and your offline reproduction settles the collision.

- **Scope.** It needs the local cache on (default off, `src/config/schema.ts:240`) and either K>1 or the adaptive pass (both default off). Repeats refuse to run with the cache on (`src/evals/eval-runner.ts:237,563`), so repeat-based variance numbers are clean. Product impact at defaults is nil.
- **Where it matters.** Single eval runs with the cache on and the adaptive pass on would report two passes and hold one draw. Any recorded adaptive or ensemble yield from such a run is suspect. I will check the stored runs' cache setting and report the count.
- **Order.** Decide the two flags first. Ensemble is at 18 of 20 on its sunset count (`specs/plans/PUNCHLIST.md:71`) and adaptive needs a default decision. Add the draw ordinal only for whatever survives; if nothing does, the fix is a deletion.

This belongs below items 2 and 3, which corrupt every score, not above item 5.

## Item 5 — build the anchor index once: split it

Deleting `validateAnchorForPacket` is safe (zero callers; my sub-reviews found the same). The "build once" half has no measurement behind it. Validation runs per candidate, tens of times a run. Under the owner's rule that new machinery needs a measurement, do the deletion and leave the index alone until a profile shows it matters.

## Item 8 — one publication policy: agree on the bug, not on the shape of the fix

The disagreement is real: the low-confidence hatch returns before `minInlineConfidence` is applied (`composer.ts:1656` versus `:1661`) and the publisher demotes the finding again (`src/github/publisher.ts:94-103`). A shared policy module would be a third place. The slim fix is that stage 10 honours `minInlineConfidence` on every path, after which the publisher's confidence re-check is dead and can go. The publisher's anchor validation must stay, because the zero-work path and direct callers reach it without stage 10.

## Item 12 — measure stage 6 before reducing it: agree

It matches the owner's recorded decision that the adaptive tree stays until an A/B (`specs/plans/PUNCHLIST.md:69`). My note's table C lists the same mechanism as "measure, then keep or delete"; read that row with this constraint.

## Items 6, 7, 9, 10, 11 — no objection

One supporting fact for item 9: `DiffFile.language` never yields `tsx`, so the `tsx` branches in symbol extraction and static signals are dead today.

## One addition

Your evals section does not say that the adaptive second pass is set in eval cases while the product default leaves it off (`src/pipeline/lens-runner.ts:271`). If the stored runs confirm it, the shipped default configuration has no recall measurement, which outranks most scorer refinements.
