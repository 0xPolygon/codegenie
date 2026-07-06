# Issue 88: Publisher Summary-Only Fallback Reachability and Posting Disclosure

Status: COMPLETE
Completed: 2026-07-04
Planned from: fable review D6/bug 1 (`specs/reviews/1-fable-review.md`), verified against `src/github/publisher.ts` at commit `00617d79`, 2026-07-02
Planned at: commit `00617d79` (branch `next`)
Recommended priority: medium — production GitHub-posting path only; evals never exercise it, so it is independent of the measurement campaign and can land whenever a slot opens (Wave 4 in `PUNCHLIST.md`). It is, however, the difference between "review posted without inline comments" and "review lost" for any PR that hits three 422s.

## Problem

The spec (repository_and_github.md:650-657) prescribes: after the 3-attempt inline-comment ladder fails, post a **summary-only review**; only if that final post also fails does publishing fail.

Verified current behavior in `src/github/publisher.ts`:

1. **The guaranteed fallback is dead code on every path** (verified against the full loop at `publisher.ts:176-229`): each of the three iterations either returns (success), throws (non-422), or — on attempt 3 — rethrows the 422, so control can never reach the post-loop summary-only `createReview`. Three 422s with comments remaining ⇒ `github_post_failed`, despite a perfectly postable summary body existing (the loop even demotes comments into `currentBody` along the way, then throws the body away).
2. **Suspect-class drop order diverges from spec.** `nextLocal422SuspectClass` drops `deletedFileAnchor` comments first, then LEFT-side, then the remainder; the spec pins a different order. Triage per the code-is-source-of-truth rule: decide whether the implemented order is the better product decision (→ spec-stale note) or a transcription error (→ fix); do not silently keep the divergence.
3. **Partial-coverage disclosure is not rendered into the posting body.** `buildPostingBody` *gates inclusion* on `finalReview.coverage.partial` but never renders the coverage/partial-reasons disclosure into the posted review, so a GitHub reader of a budget-stopped review sees findings with no signal that 55 hunks went unreviewed. The markdown/stdout renderer got this treatment (coverage section + the 2026-07-01 budget-stop banner); the posting body did not.

## Goal

A review that survives composition is always deliverable to GitHub in at least summary-only form unless GitHub rejects even that; posted reviews disclose partial coverage the same way stdout output does.

## Design

1. **Reachable fallback.** On the final attempt's failure (or any 422-ladder exhaustion), do not throw: demote all remaining comments into the body (`demoteCommentsIntoBody`), post summary-only, record `attempts` outcome `fallback_summary_only`. Throw `github_post_failed` only when the summary-only post itself fails. Non-422 terminal errors (auth, permissions) keep failing fast — the ladder is for anchor-shaped rejections, not credential problems.
2. **Drop-order decision.** Compare implemented order (deleted-file → LEFT → rest) against the spec'd order with the original plan rationale; pick one, document it in `repository_and_github.md`, and pin it with a unit test so future drift is loud. (Default expectation: the implemented order is plausibly deliberate — deleted-file anchors are the most 422-prone class — in which case this is a spec-stale note, not a code change.)
3. **Posting disclosure.** Reuse the renderer's coverage-summary lines (`renderCoverageSummaryLines`) and the budget-stop notice in the posting body when `coverage.partial` — one shared helper, not a re-implementation, so stdout and GitHub cannot drift apart again.

## Non-Goals

- Changing inline-comment anchor preparation, sanitization, or the duplicate detector.
- Retrying beyond the existing 3-attempt ladder.
- Eval harness changes (evals do not post).

## In-Scope Files

- `src/github/publisher.ts` — fallback reachability, attempts recording, disclosure rendering.
- `src/output/markdown-renderer.ts` or a shared module — export the coverage/budget-notice helper for reuse.
- `specs/project/components/repository_and_github.md` — drop-order documentation (whichever way the decision goes).
- Tests: publisher unit tests with a mock GitHub client.

## Implementation Steps

1. Restructure the retry loop so final-attempt failure falls through to the summary-only post; record `fallback_summary_only`; only summary-post failure throws.
2. Extract and reuse the coverage-disclosure helper in `buildPostingBody`; include the budget-stop notice for budget-stopped runs.
3. Drop-order decision + doc note + pinning test.
4. Tests: (a) three 422s with comments remaining → summary-only review posted, `inlinePosted: 0, summaryOnly: true`, no throw; (b) summary-only post also fails → `github_post_failed`; (c) auth error on attempt 1 → fail fast, no ladder; (d) partial-coverage review → posted body contains the disclosure lines; (e) drop-order pinning.

## Validation

- Unit suite green with the five scenarios above.
- One manual dry-run against a scratch PR (or recorded-fixture client) confirming the posted body renders disclosure correctly.

## Done Criteria

- No 422 path can lose a postable review; fallback outcome is recorded and observable.
- Posted reviews disclose partial coverage identically to stdout output (shared helper).
- Drop order is documented and test-pinned, whichever direction the decision went.

## Stop Conditions

- If GitHub rejects even summary-only posts in practice for reasons other than auth (body-size limits), add body truncation with disclosure rather than growing the retry ladder.
