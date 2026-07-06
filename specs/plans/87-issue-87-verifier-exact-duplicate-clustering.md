# Issue 87: Verifier Pre-Clustering Restricted to Exact Duplicates

Status: COMPLETE
Completed: 2026-07-02. Implementation notes: `duplicateCandidate` is now the exact rule (same path + same category + same trusted anchored hunk, or both-anchorless with identical normalized `changedCode` + equal normalized title AND failureMode via `exactTextKey`). Plan-76 interplay: hunk equality reads `locationTrustedAnchor`, so gate-only representative anchors never create identity. Fingerprint-first was REJECTED during implementation: plan-83 fingerprints are deliberately wording-free (path+location+category+lens), so two different findings on one hunk would collide — the exact failure mode this plan removes; the textual rule already covers the fingerprint's structural components. Deleted ~180 lines of fuzzy machinery (`strongTextMatch`/Jaccard, `candidateScopesOverlap`, `locationClusterKey`, symbol/evidence-path overlap, cross-category bridging, `highImpactAmbiguous`). Fan-out kept; per-cluster event now carries `rule: "exact_text"`; reject propagation across exact copies covered by a per-candidate-trail test; the fable-bug-2 fixture (same file, same failureMode, different titles/hunks) verifies independently and a reject cannot kill the sibling. Repeat A/B measurement against the Wave-2 baseline still owed (owner-run).
Planned from: fable review D3/bug 2 (`specs/reviews/1-fable-review.md`), verified against `src/pipeline/verifier.ts` at commit `00617d79`, 2026-07-02
Planned at: commit `00617d79` (branch `next`)
Recommended priority: high, Wave 3 of `PUNCHLIST.md` (behavior change to verification admission — measured against the Issue-79 baseline). Sequenced after Issue 83 so exact identity can lean on stable fingerprints.

## Problem

The spec (functional_spec:563) allows verifier pre-clustering only as a scheduling optimization for identical/near-identical copies and states it "must not perform semantic grouping". The implementation is a fuzzy semantic clusterer:

- `clusterCandidates` (`verifier.ts:1272`) groups across candidates using `duplicateCandidate` (`verifier.ts:1348`): failure-mode `strongTextMatch` (substring/Jaccard text similarity) that can even bridge **different categories**, plus `candidateScopesOverlap` (shared evidence paths / path-root + symbol overlap) and `locationClusterKey` (`verifier.ts:1433`).
- Only the representative is verified. The verdict fan-out (`verifier.ts:353-363`, verified) returns `[]` for rejects **before duplicates are consulted** — a rejected representative silently kills every clustered sibling, including non-identical findings that were never individually verified. There is no per-finding artifact recording that a candidate died as an unverified cluster member.

Failure scenario (fable bug 2): Stage 7 emits a strong candidate A and a weaker look-alike B; fuzzy matching clusters them; B is chosen representative; the verifier correctly refutes B; A — a true positive — is dropped with no verdict and no trail. This is a recall risk with zero observability, sitting directly on the "generate liberally, verify strictly" load-bearing path: liberal generation *increases* look-alike volume, which this clusterer then converts into correlated kills.

## Goal

Pre-clustering only ever merges candidates that are safe to share a verdict: exact duplicates. Every non-identical candidate gets its own verification (subject to existing lane caps). ~20 lines of matching logic replace ~260, per the fable estimate.

## Design

1. **Exact-duplicate rule.** Two candidates cluster iff all of: same `path`, same `category`, same anchored hunk (`anchor.hunkId` equal, or both anchorless with identical `evidence.changedCode` after whitespace normalization), and near-identical normalized title+failureMode (equality after lowercase/whitespace/punctuation normalization — no Jaccard, no substring). Once Issue 83 lands, prefer: equal stable fingerprint ⇒ duplicate; the textual rule remains only as the pre-83 fallback.
2. **Delete** `duplicateCandidate`'s fuzzy branches, `candidateScopesOverlap`-based grouping, cross-category bridging, and `locationClusterKey` fuzzy keys. Keep the `duplicatesByRepresentative` fan-out mechanism itself — it is correct for true duplicates (both keep and reject may propagate across *exact* copies).
3. **Scheduling impact is the cost, not a blocker.** Former fuzzy clusters now verify individually; `verificationScheduled` rises. Existing ordering (`orderVerifierRepresentatives`: severity → changedLine → confidence) and lane caps already bound the work. Do not pre-emptively raise caps; if the Issue-79 A/B shows material candidates crowded out by the higher volume, that surfaces in `evidenceResolutionLaneLimitedCandidateIds` / budget telemetry first (same telemetry-first stance as plan 76 §2c).
4. **Observability.** Per-cluster telemetry event `verifier_cluster { representativeId, memberIds, rule: "fingerprint" | "exact_text" }`; pipeline metrics keep `clusteredDuplicates`. Any candidate that shares a verdict it did not individually earn is traceable.

## Non-Goals

- Post-verification dedup/merging at Stage 10 (unchanged — that is where semantic grouping legitimately lives).
- Raising `EVIDENCE_RESOLUTION_LANE_MAX` or verification budgets.
- Changing verdict semantics or the reject path for genuinely exact duplicates.

## In-Scope Files

- `src/pipeline/verifier.ts` — `clusterCandidates`, `duplicateCandidate`, `locationClusterKey`, cluster telemetry.
- Tests: verifier clustering unit tests; a regression fixture of the fable-bug-2 shape.

## Implementation Steps

1. Implement the exact-duplicate predicate (fingerprint-first, normalized-text fallback); delete the fuzzy machinery.
2. Telemetry event + keep existing counters coherent.
3. Fixtures: (a) exact copies (same hunk, same normalized text) → one verification, verdict propagates to both, including reject; (b) fable-bug-2 shape (same file, similar wording, different hunks/claims) → two independent verifications, refuting one does not touch the other; (c) cross-category look-alikes → never clustered.
4. Measure: repeat-10 A/B against the Wave-2 baseline — expect `verificationScheduled` up modestly, `finalRecallRate` up or flat, `should_not_find` unchanged (verifier itself is the false-positive backstop and is now consulted *more*, not less).

## Validation

- Unit suite green; the three fixtures pass.
- Baseline A/B: no case exceeds `maxModelCalls`/`maxCostUSD`; verification-stage cost increase quantified in the findings note.
- Spot-check one run's `verifier_cluster` events: every cluster is exact under the new rule.

## Done Criteria

- No candidate can be rejected without either its own verification or an exact-duplicate relationship to the verified representative.
- Fuzzy clustering code deleted; cluster decisions observable in telemetry.
- Measured recall flat-or-better with bounded verification cost increase.

## Stop Conditions

- If the A/B shows verification cost blowing case budgets on candidate-heavy diffs, first tighten Stage-7 duplicate emission telemetry to understand the volume — do not reintroduce fuzzy clustering; consider batching exact-duplicate detection with Issue 83 fingerprints instead.
