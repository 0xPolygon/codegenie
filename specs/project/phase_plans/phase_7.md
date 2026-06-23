---
status: draft
---

# Phase 7: GitHub Integration

## Overview

This phase completes GitHub PR mode and optional PR review publishing. It replaces the Phase 2 `--pr` placeholder with a `GitHubClient` backed by `gh`, fetches PR base/head revisions into local git without checking anything out, runs the existing review pipeline against the GitHub-matched diff, deduplicates prior codegenie comments, and posts a single `COMMENT` review only when `--post-github-comments` is passed.

## Steps

1. Extend `src/types.ts` with Phase 7 publishing contracts:
   - `InlineCommentInput`
   - `GitHubReviewInput`
   - `GitHubClient`
   - `FindingDuplicateDecision`
   - `RunPostingRecord`
   - optional `posting?: RunPostingRecord` on `ReviewResult` so renderers can emit the Stage 11 summary after publishing.
2. Extend `src/git/subprocess.ts` with `runGh(repoRoot, args, opts)` using the existing subprocess hygiene, `GH_PROMPT_DISABLED`, network timeouts, non-shell invocation, input support, and credential-scrubbed errors.
3. Add `src/github/github-client.ts`:
   - `createGitHubClient(repoRoot)`
   - `viewPr(number): Promise<PullRequestMetadata>` using `gh repo view`, `gh pr view`, and REST fallback for missing `baseRefOid`/`headRefOid`
   - `listOwnComments(number): Promise<ExistingReviewThread[]>` with viewer-login filtering, pagination, marker parsing, and `original_line` fallback
   - `createReview(number, review)` posting `event: "COMMENT"`, cached PR `commit_id`, and stdin JSON.
4. Wire `resolveReviewInput({ mode: "github_pr" })` in `src/git/review-input-resolver.ts`:
   - accept an injectable `github?: GitHubClient` for tests
   - fetch stale PR refs cleanup, missing base/head commit fetches, fork head via `refs/pull/<n>/head`, direct base-SHA fetch with branch fallback, remote selection by owner/repo URL, one head-moved metadata retry, merge-base diff, commit log, and PR metadata on `ResolvedReviewInput`.
5. Add `src/github/duplicate-detector.ts`:
   - shared marker regex
   - `fingerprintFindingForGitHub` / marker formatting helpers
   - exact fingerprint skip and ±5-line fuzzy skip over viewer-authored codegenie comments.
6. Add `src/github/publisher.ts`:
   - `maybePublishToGitHub(finalReview, resolved, config, telemetry, opts?)`
   - no-op without `postingPlan`, `invalid_args` for posting plans outside PR mode
   - pre-posting anchor validation against `parseDiff(resolved.rawDiff)` / `buildDiffAnchorIndex`
   - confidence-floor demotion, duplicate skip, body demotion for invalid anchors, body-only/no-finding behavior, sanitization, marker appending, 422 recovery, `github-posting.json`, and `RunPostingRecord`.
7. Update `src/pipeline/review-runner.ts` to call `maybePublishToGitHub` after Stage 10 and before rendering output; pass the posting record into renderers without changing non-posting behavior.
8. Update `src/output/stdout-renderer.ts` and JSON/Markdown renderers as needed so posting mode prints a concise Stage 11 posting summary instead of the full review while non-posting output stays unchanged.
9. Add focused tests:
   - PR resolver unit tests with fake Git/GitHub clients for metadata mapping, fetch refspecs, remote selection, head-moved retry, and merge-base diff/log.
   - GitHub client tests by mocking the subprocess seam to assert exact `gh` argv/stdin and pagination mapping.
   - duplicate-detector tests for fingerprint stability, exact skip, fuzzy boundary, and foreign markers.
   - publisher tests for no-op/invalid mode, sanitization, marker placement, confidence/anchor demotion, duplicate skipping, no-findings config, 422 recovery, and posting record persistence.
   - pipeline integration with fake LLM runner and fake GitHub publisher seam proving `--pr --post-github-comments` produces a posting record and concise stdout.
10. Run automated checks:
    - `pnpm test`
    - `pnpm run typecheck`
    - `pnpm run build`

## Tests

- `resolver.pr-mode-fetches-and-diffs-github-matched-revisions`: PR mode uses metadata OIDs, fetches missing commits into `refs/codegenie/pr/<n>/*`, computes `mergeBase..head`, and returns PR metadata.
- `github-client.view-pr-rest-fallback`: missing GraphQL/OID fields use the REST pull endpoint for `base.sha` and `head.sha`.
- `github-client.comments-pagination-and-marker-authorship`: only viewer-authored comments suppress reruns, and outdated line fallback is honored.
- `duplicate-detector-exact-and-fuzzy`: fingerprint and ±5-line duplicate rules skip only codegenie-authored comments.
- `publisher.sanitizes-and-posts-single-comment-review`: posted bodies are stripped, mention-neutralized, secret-scrubbed, marker-appended, and sent as one `COMMENT` review.
- `publisher.demotes-invalid-or-low-confidence-inline-findings`: defense-in-depth checks move unpostable findings into the review body without dropping them.
- `publisher.recovers-from-422`: identified or locally suspect comments are demoted before retry, with summary-only fallback as the last attempt.
- `pipeline.pr-posting-renders-posting-summary`: Stage 11 runs after composition, persists `github-posting.json`, and stdout renders the posting summary for posting mode.
