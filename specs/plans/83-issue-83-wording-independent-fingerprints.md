# Issue 83: Wording-Independent Finding Fingerprints and Compare Integrity

Status: COMPLETE
Completed: 2026-07-02. Implementation notes: the defect was broader than drafted — `mergeRootCauseGroups` applied the wording-derived fingerprint to **every** group including singletons, so all published findings carried wording-derived identity (this alone explains the runs-24/25 divergence). New identity: singletons keep their member's structural `fingerprintFinding` exactly; multi-member groups hash the sorted member fingerprints. Design-2 decisions: `producedBy.lensId` KEPT in per-finding identity (verified lane-stable — both direct candidates and promotions use `packet.lenses[0]`); location identity left as-is (anchor→symbol with evidence inference fallback; residual anchored-vs-unanchored variance on multi-symbol packets is measured by Plan 79's cross-run assertion, not guessed at). Old-layout reads FIXED (root-path fallback in the eval artifact loader) rather than only disclosed; compare additionally discloses `previousFindingsUnreadable` when the previous run's findings genuinely cannot be read. `legacyFingerprint` transition field dropped: the first post-change compare against a pre-change run shows one-time +N/-N churn, then identity is stable — cheaper than carrying a field for a release. Handoff to Plan 79: add the cross-run fingerprint-equality assertion (same expectation matched in two runs ⇒ equal fingerprints).
Planned from: fable review D7/bug 3 (`specs/reviews/1-fable-review.md`); eval evidence `49f4645b/logs/25` `compare-to-previous` reporting `+1 added, -0 removed` for the identical EXACT_OUTPUT bug found in run 24 (same defect, different lane/wording → different fingerprint; and the vanished run-24 fingerprint not counted as removed), 2026-07-01
Planned at: commit `73ef963` (branch `next`)
Recommended priority: medium-high. Two independent defects compound: fingerprints derived from model wording defeat cross-run identity (spec: architecture.md pins wording-independence so rerun duplicate suppression works), and the eval compare silently mis-balances across artifact layouts. The first also re-posts duplicate GitHub comments on PR re-review.

## Problem

**A. Wording-derived fingerprints.** `rootCauseGroupFingerprint` (`src/pipeline/composer.ts:1256-1268`, verified) hashes normalized top-24 title/failure-mode/fix/evidence *terms* plus symbols for merged root-cause groups, replacing the deterministic per-finding fingerprints. Model wording varies per run — runs 24/25 published the same hyperlane under-delivery bug with fingerprints that share nothing, so:

- rerun duplicate suppression on the same PR can re-post previously posted merged-group comments (spec violation, architecture.md:1449-1455);
- `compare-to-previous` findingDiff reads every rewording as `+1 added`, making cross-run comparison — the eval harness's core instrument — noise for merged/promoted findings.

**B. Compare imbalance across layouts.** `buildFindingDiff` (`src/evals/eval-compare.ts:104-130`) is symmetric on fingerprints, yet run 25's report shows `+1/-0` with one finding in each run — run 24's finding was neither matched nor counted removed. Run 24 predates the layout-v2 artifacts; the previous-run findings were most likely read as empty (fable: "old-layout artifact replay broken", `eval-artifacts.ts:36-93`). A compare that can't read the previous run must say so, not report a clean-looking half-diff.

## Goal

Same defect → same fingerprint across runs regardless of wording, lane (direct vs promoted), or merge grouping; eval compare either reads both runs' findings or explicitly discloses that it could not.

## Design

1. **Merged-group fingerprints from structural identity.** Replace wording-term hashing with deterministic components already present on member findings: sorted member per-finding fingerprints (which are anchored on path/category/hunk identity), or where members lack stable fingerprints, `path + hunkId set + category`. Two-step: `groupFingerprint = sha256(sorted(memberFingerprints))`. Wording contributes nothing.
2. **Lane-independent per-finding identity.** Verified at current commit: `fingerprintFinding` (`composer.ts:1625-1632`) is already wording-free — it hashes path + location identity + category + `producedBy.lensId`. The remaining per-finding instability sources are therefore narrower than the fable review implied: (a) `producedBy.lensId` in the hash — a promoted candidate and its direct-candidate twin can carry different lens/provenance, so the same defect fingerprints differently across lanes; (b) `fingerprintLocationIdentity` (`:1634`) resolves symbol/hunk from `anchor.hunkId` with evidence-based inference as fallback — anchor-presence variance (see runs 24/25, Issue 76) changes the resolved identity. Decide whether identity should be provenance-independent (drop `lensId`; measure the collision rate on the eval corpus — two lenses reporting genuinely different issues on the same hunk+category is the collision risk) and make location identity robust to missing anchors (symbol-first, aligned with Issue 76's reconstruction).
3. **Cross-run identity check in the harness (measurement).** Issue 79's repeat runs assert: same expectation matched in runs A and B → fingerprints equal. This becomes the regression test that keeps fingerprints stable.
4. **Compare integrity.** `compare-to-previous` loads previous findings through the same artifact loader as replay; if the previous run's findings cannot be read (old layout, missing artifact), the report prints `previous findings unreadable (<reason>) — diff partial` instead of implying `-0`. Fix or explicitly deprecate old-layout reads (`eval-artifacts.ts:36-93`).
5. **Duplicate-suppression test for publishing:** two composed reviews of the same diff with different model wordings → identical fingerprint set → second posting suppresses all comments.

## Non-Goals

- Semantic cross-run matching of *different* defects (out of scope; fingerprints are identity, not similarity).
- Changing group *membership* logic (which findings merge) — only how the merged identity is derived.
- The scorer leniency stack (fable D8) — separate decision.

## In-Scope Files

- `src/pipeline/composer.ts` — `rootCauseGroupFingerprint` replacement.
- Per-finding fingerprint construction (locate via `stableFingerprint`/fingerprint assignment in `composer.ts`/`pipeline-utils.ts`) — input audit.
- `src/evals/eval-compare.ts` — unreadable-previous disclosure.
- `src/evals/eval-artifacts.ts` — old-layout read fix or explicit deprecation error.
- Tests: fingerprint stability fixtures (same members, reworded text → equal; different hunks → different), compare disclosure test, publishing duplicate-suppression test.

## Implementation Steps

1. Audit every fingerprint input; write the collision/stability report against existing eval artifacts (runs 10-25 of 49f4645b give real reworded twins — e.g. runs 24/25's finding must land equal under the new scheme).
2. Implement structural group fingerprint; keep the old value in telemetry as `legacyFingerprint` for one transition release so cross-version compares stay interpretable.
3. Compare loader disclosure + old-layout handling.
4. Tests per Design 5 and the runs-24/25 fixture.
5. Hand Issue 79 the cross-run fingerprint-equality assertion.

## Validation

- Runs 24/25 artifacts replayed through the new scheme yield equal fingerprints for the hyperlane finding.
- Reworded-composition fixture: zero re-posted comments on second publish.
- `compare-to-previous` against an old-layout previous run states the read gap explicitly.

## Done Criteria

- Fingerprints for the same defect are run-stable across wording, lane, and merge grouping on the existing eval corpus.
- No compare report can show an unbalanced diff without a disclosure line.
- GitHub rerun duplicate suppression covered by test.

## Stop Conditions

- If dropping wording terms from per-finding fingerprints causes real collisions (distinct defects, same path/hunk/category) at a measurable rate on the corpus, reintroduce the minimal disambiguator (symbol set, then predicate terms) in that order — never title text.
