# TODO

Confirmed critical findings from `reviews/**` have been addressed in the current working tree.

Final follow-up fixes applied after `reviews/projects/codeninja/post_review_verification.md`:
- `readRange` no longer returns the last file line for ranges that start past EOF.
- `findDefinition` now routes discovery and candidate reads/parses through the shared repository-tool limiter, and same-file definition caps report omitted definitions.
- The ripgrep fast path is disabled when untracked or ignored worktree paths are present, avoiding large ignored-tree walks while preserving tracked-tree semantics through `git grep`.

Remaining deferred follow-ups:
- Add per-worker runtime telemetry.
- Reduce Stage 2 symlink `ls-tree` backfill fanout.
- Split provider login hints between unknown provider/model and missing auth.
- Expand test breadth for anchor validation, skill-loader validation, cache-key sensitivity, client pagination, and fingerprint golden vectors.

Verification completed:
- `pnpm test`
- `make build`
