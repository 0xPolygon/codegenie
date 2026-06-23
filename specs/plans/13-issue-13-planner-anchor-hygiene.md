# Issue 13: Planner and Anchor Hygiene

Status: COMPLETE

Implementation note: the audit found that planner hunk-id normalization, Stage 7 anchor stripping, verifier anchor stripping, composer validation, and GitHub publisher validation were already largely present. This pass completed the remaining gaps by adding explicit Stage 7 `candidate_anchor_summary_only` telemetry and regression tests proving unknown planner hunk ids do not reduce deterministic review coverage.

## Problem

Planner output and model candidate anchors are useful hints, but they are not trusted sources of truth. The pipeline should validate both before they affect scheduling, final output, or GitHub posting.

Two invariants should hold:

- Planner hunk ids may influence priority and coverage, but invalid ids must not reduce deterministic review coverage.
- Candidate anchors must either point to a valid changed diff line or be marked summary-only before any inline publication path sees them.

## Plan

1. Normalize planner hunk references:
   - Add a small ReviewPlan normalization step after Stage 5.
   - Accept exact known hunk ids only.
   - Invalid ids are ignored and logged as `planner_unknown_hunk`.
   - Do not guess by prefix/suffix or fuzzy matching.
   - Never let planner hunk-id mistakes affect deterministic default coverage.

2. Make planner override semantics explicit:
   - Planner coverage is an override for coverage/lens priority, not the source of truth for whether a hunk is reviewed.
   - Unknown planner hunk ids should not be treated as coverage failures.
   - The final coverage report should remain based on actual diff hunk review records.

3. Validate candidate anchors immediately after Stage 7 output:
   - Check that candidate `path`, `hunkId`, `side`, and `line` map to a changed line in the packet hunk.
   - For right-side findings, require a changed head line.
   - For left-side deletion findings, require a changed/deleted base line.
   - If the line is not valid, mark the candidate `publication: "summary"` and `changedLine: false`.
   - Do not automatically recenter to a nearby line; guessed anchors are worse than summary-only findings.

4. Keep unsafe anchors out of inline publication:
   - Verification can still evaluate summary-only candidates.
   - GitHub posting must never attempt to post an out-of-hunk inline comment.
   - Final composer should prefer inline candidates when action is clear, but summary-only findings can still appear in the review body.

5. Improve telemetry:
   - Emit `candidate_anchor_summary_only` when a candidate is preserved but cannot be inline.
   - Emit `candidate_anchor_rejected` only when the anchor problem makes the finding unusable.
   - Keep `out_of_hunk_anchor` as a warning for unexpected cases.

## Likely Files

- `src/pipeline/planner.ts`
- `src/pipeline/review-plan.ts` or equivalent plan normalization code
- `src/pipeline/lens-runner.ts`
- `src/pipeline/verifier.ts`
- `src/github/anchors.ts` or equivalent anchor utilities
- `src/types.ts`
- `tests/pipeline-phase5.test.ts`
- `tests/pipeline-phase7.test.ts`
- `tests/github-anchor.test.ts`

## Tests

- Planner hunk id with a suffix/prefix mismatch is ignored, not guessed.
- Planner hunk id with no safe match is ignored without reducing coverage.
- Candidate on a valid changed line remains inline.
- Candidate with an invalid inline anchor becomes summary-only.
- GitHub posting skips summary-only findings and never receives an out-of-hunk inline anchor.

## Acceptance Criteria

- Stage 5 planner hunk-id mistakes cannot degrade review coverage.
- Stage 7 candidate outputs are normalized into inline-safe or summary-only findings before verification.
- No final or GitHub inline finding can carry an out-of-hunk anchor.
- Invalid planner hunk references and invalid candidate anchors are visible in telemetry but do not create noisy or unsafe output.
