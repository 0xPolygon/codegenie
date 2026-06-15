# Issue 16: Eval Matching for Merged Findings

Status: PENDING
Planned at: a47a23b, 2026-06-14

## Problem

The latest trails-api eval reported the routing explicit-preference expectation as failed even though the final review published the same root issue. The published final finding was anchored to `lib/intentmachine/routingsolver/fallbacks.go`, while the eval expectation was written against caller-side routing files. The scorer currently matches mostly against the final finding anchor path, so it can miss issues that were correctly found, verified, merged, and published under a shared helper or root-cause location.

This makes eval results look worse than the actual review quality and mislabels the loss as composition failure.

## Plan

1. Extend eval matching to consider a scorable finding's full evidence footprint:
   - final anchor path
   - related evidence paths
   - source candidate paths merged into the final finding
   - verified candidate paths when the final finding records source candidate ids
2. Add an internal helper such as `getFindingMatchPaths(...)` so path matching is centralized and testable.
3. Keep matching conservative:
   - path expansion should only help when the expectation also matches the issue text/category/severity constraints
   - do not let an unrelated related file satisfy a weak expectation by path alone
4. Update loss attribution so a matched final finding through a merged/source candidate is treated as found, not `lost-at-composition`.
5. Add regression tests using a final finding anchored to a helper file with merged candidates in caller files.

## Likely Files

- `src/evals/eval-scoring.ts`
- `src/evals/eval-artifacts.ts`
- `src/evals/eval-compare.ts`
- `tests/evals.test.ts`
- private eval fixture expectations, if needed

## Tests

- Add an eval scoring test where an expectation path does not equal the final anchor path but does match a merged source candidate path.
- Add a test where a related path alone is insufficient because the text/category constraints do not match.
- Run `pnpm test`.

## Acceptance Criteria

- The trails-api routing expectation passes when the published final finding contains the merged/source evidence for that issue.
- Existing negative eval expectations do not become overly broad.
- Loss reporting distinguishes true composition losses from successful merged-publication cases.
