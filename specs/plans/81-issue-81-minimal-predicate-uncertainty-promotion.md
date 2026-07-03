# Issue 81: Minimal Predicate-Only Uncertainty Promotion

Status: PENDING
Planned from: fable review D2/§6.2 (`specs/reviews/1-fable-review.md`); eval evidence `49f4645b/logs/25` (73% of Stage-9 model time spent refuting two template promotions), `49f4645b/logs/24` (finding rescued via promotion with template wording and fabricated anchor), `0c4d5213/logs/42` (erc20 insight leaked into the hint lane with wrong category → partial-match fail), 2026-07-01
Evidence update (2026-07-02, runs 24-30 of `49f4645b`): the promotion lane is **load-bearing for recall on this case, not pure chaff** — when Stage 7 emits no direct candidate (runs 24, 28, 30), promotions rescued the published finding every time (runs 24, 28, 30 all passed via promotion; conversions now ≈4 kept of ~13 promotions, not the earlier 0/5 read). The rescued promotions carry *concrete predicates* and would survive this plan's three-part admission rule; the rejected ones are the "Verify X behavior" template chaff the rule cuts. Two sharpened implications: (a) the admission rule stands, but any lean toward outright deletion is now contra-indicated pending Plan-79 repeat data; (b) the rescue path's *output quality* is the real defect — template titles and fabricated anchors reach published reviews (run 30's final finding is titled "The review raised a concrete unresolved behavior predicate: …" anchored at the promotion's first-changed-line) — so this plan's title/category/anchor fixes matter even for the promotions that stay.
Planned at: commit `73ef963` (branch `next`)
Recommended priority: high, **after Issue 79 lands** (promotion conversion/rescue rates must be measured across repeats before and after — this plan deletes a rescue lane that occasionally saves a run, so the trade must be quantified, not vibed).

## Problem

`uncertainty-promotion.ts` (859 lines) converts Stage-7 hints/uncertainties into synthetic `CandidateFinding`s with template wording, whole-hunk evidence, and a fabricated anchor at the packet's first changed line (`promotedCandidate` + `firstChangedAnchor`, `uncertainty-promotion.ts:257-299,468-480` — verified at current commit). The spec forbids promotion in v1. The subsystem forced ~1,500 lines of downstream compensation: the verifier's `evidence_resolution` lane, the composer's low-confidence publication exemption (`composer.ts:1349-1372`), and most human-attention suppression tiers.

Fresh run evidence quantifies the cost:

- **Run 25 (49f4645b):** Stage 7 produced 1 concrete candidate + 2 promotions ("Verify GetQuote behavior after this change", "Verify TestHyperlane… behavior after this change"). Stage 9 spent 529s of model time; **387s (73%) went to refuting the two template promotions**, 141s to confirming the real finding. Both promotions correctly rejected — pure verifier tax.
- **Run 24 (49f4645b):** 0 direct candidates; the material finding survived only as a promotion kept on a `revise` verdict — published with template boilerplate wording ("The review raised a concrete unresolved behavior predicate: …") and a fabricated anchor. A pass that *looks* like recall but publishes promotion artifacts.
- **Run 42 (0c4d5213):** the erc20 test-coverage insight surfaced as promotion `46897188-u2` with category `correctness` (packet lens was `core/tests`) and template title → scorer `partial-match` fail on both category and title.
- **Runs 43/44 (0c4d5213):** promoted candidates consumed verification slots under budget squeeze while direct candidates went unverified (run 44: `a81d5adf-f1` lost to `budget_limited` behind promotion verifications).

## Goal

Keep the one thing promotion has demonstrably rescued — a hint that names a concrete, changed-line predicate — and delete the template/chaff generator plus the downstream lanes that exist only to compensate for it. Reduce Stage-9 spend on promotions to near zero in the common case, without losing the run-24-style rescue for *concrete* hints.

## Design

Adopt the fable review's minimal rule (§6.2): promote a hint/uncertainty **only if** it carries all of:

1. a concrete file **and** symbol reference that resolves to a changed hunk in the packet,
2. a falsifiable predicate (an assertion about behavior that a verifier can prove or refute — not "verify X behaves correctly"),
3. evidence quoted from changed code (non-empty `changedCode` scoped to the referenced hunk, not the whole packet dump).

Everything else stays a hint/uncertainty and flows to human-attention as today.

Deletions that follow:

- **No fabricated anchors.** Promoted candidates carry `anchor: undefined`; anchor recovery is Issue 76's job (Tier 1 reconstruction from the quoted evidence), and its `anchorSource` enum gets a `promotion`-aware value if needed. A promoted candidate must never claim first-changed-line placement it did not establish.
- **No template titles.** The candidate title is the hint's own predicate text (bounded), so scorer category/title matching sees the model's actual claim (fixes the run-42 shape).
- **Category from packet lens context** when the hint does not state one (a `core/tests` packet's coverage hint is `testing`, not `correctness`).
- **Delete the regex risk classifier, locality scoring, and reserve-slot machinery**; with concrete-predicate admission the ranking problem largely disappears.
- **Retire downstream compensation where it becomes dead:** the verifier `evidence_resolution` lane and composer low-confidence exemption shrink or delete once promotions are rare and evidence-backed by construction — do this as a follow-up step in the same plan, gated on the new promotion volume actually being near-zero in eval runs.

## Non-Goals

- Deleting promotion outright (measure first; if Issue-79 repeats show concrete-predicate promotions also never convert, deletion is a one-line follow-up).
- Changing Stage-7 prompts to force the candidate lane (tracked as part of the Issue-84 ensemble/lane work; fable §5.2).
- Human-attention note redesign (plan 75 / fable §6.4).

## In-Scope Files

- `src/pipeline/uncertainty-promotion.ts` — admission rule, title/category/evidence construction, delete classifier/locality/reserve machinery, delete `firstChangedAnchor` fabrication.
- `src/pipeline/review-runner.ts:254-259` — injection point unchanged in shape, fewer candidates.
- `src/pipeline/verifier.ts` — evidence-resolution lane shrink (step 2, gated).
- `src/pipeline/composer.ts:1349-1372` — low-confidence exemption removal (step 2, gated).
- `src/telemetry/*` — promotion admission telemetry: `promotionAdmitted`, `promotionRejectedReason` (no_symbol, no_predicate, no_changed_evidence).
- Tests: promotion unit tests + pipeline fixtures.

## Implementation Steps

1. Implement the three-part admission predicate with per-rejection telemetry; keep rejected hints flowing to human-attention unchanged.
2. Replace template title/category/evidence construction with hint-derived values; drop anchor fabrication.
3. Fixtures: run-25's two "Verify X" promotions → not admitted; run-24's kept promotion → admitted only if it names symbol+predicate (check the actual artifact; if it fails admission, that is the measured trade Issue 79 adjudicates); run-42's erc20 hint → admitted with `testing` category or cleanly left as a note.
4. After Issue 79 lands: `repeat: 10` on 49f4645b and 0c4d5213 before/after — compare `candidateRecallRate`, `finalRecallRate`, promotion admission/conversion counts, Stage-9 token spend.
5. Gated step: if admitted-promotion volume across the repeat runs is ≤1 per run, shrink/delete the evidence-resolution lane and composer exemption; delete human-attention suppression tiers that keyed on promotion provenance.

## Validation

- Stage-9 spend on promotions drops to near zero on runs shaped like 25 (measure via per-candidate call attribution in `model-calls.jsonl`).
- No regression in `finalRecallRate` on the 49f4645b repeat set versus baseline (the run-24 rescue path is the risk; the harness decides).
- `should_not_find` cases unaffected.

## Done Criteria

- Promotions are rare, concrete, correctly categorized, and never carry fabricated anchors.
- Verifier chaff spend measurably reduced; net recall unchanged or better across N≥10 repeats.
- ≥500 lines net deletion across promotion + compensation lanes (fable estimate) or an explicit note of what remains and why.

## Stop Conditions

- If the Issue-79 repeat study shows concrete-predicate promotions still convert to kept findings at a meaningful rate but the stricter rule loses them, loosen only the predicate-wording requirement (keep symbol + changed-evidence requirements) and re-measure.
- If recall drops on either case, halt deletions and keep the admission rule alone.
