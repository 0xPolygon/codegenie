# TODO

Confirmed critical findings from `reviews/**` have been addressed in the current working tree.

Final follow-up fixes applied after `reviews/projects/codeninja/post_review_verification.md`:
- `readRange` no longer returns the last file line for ranges that start past EOF.
- `findDefinition` now routes discovery and candidate reads/parses through the shared repository-tool limiter, and same-file definition caps report omitted definitions.
- The ripgrep fast path is disabled when untracked or ignored worktree paths are present, avoiding large ignored-tree walks while preserving tracked-tree semantics through `git grep`.

Remaining deferred follow-ups:
- Add per-worker runtime telemetry.
- Simplify concurrency config to a single primary setting. `review.concurrency` and `llm.maxConcurrentCalls` now both default to 4, but the split should become an advanced provider-throttle override rather than two first-class knobs.
- Reduce Stage 2 symlink `ls-tree` backfill fanout.
- Split provider login hints between unknown provider/model and missing auth.
- Expand test breadth for anchor validation, skill-loader validation, cache-key sensitivity, client pagination, and fingerprint golden vectors.

Run-quality follow-ups from the trails-api real run, in intended fix order:
- [x] Issue 8: Persist reconstructable, redacted LLM request/debug artifacts so eval/debug runs can inspect prompts, tools, tool results, and provider payload shape. Plan: `plans/01-issue-8-debug-artifacts.md`.
- [ ] Issue 7: Fix token/cost telemetry so prompt cache read/write tokens are explicit and Anthropic usage is not misread as near-zero input tokens. Plan: `plans/02-issue-7-token-telemetry.md`.
- [ ] Issue 2: Reduce Stage 6 packet context degradation, especially `symbol not found` and oversized-symbol truncation on important packets. Plan: `plans/03-issue-2-packet-context-degradation.md`.
- [ ] Issue 3: Treat planner hunk coverage as targeted overrides, not mandatory exhaustive output, and remove noisy `planner_missing_coverage` reporting. Plan: `plans/04-issue-3-planner-coverage-semantics.md`.
- [ ] Issue 4: Reduce Stage 7 cost and repeated investigation by tightening lens routing, tool budgets, and one-call fast paths. Plan: `plans/05-issue-4-stage-7-cost.md`.
- [ ] Issue 1: Improve budget exhaustion behavior and partial-run semantics so quality-impacting budget stops are planned, visible, and not mistaken for full reviews. Plan: `plans/06-issue-1-budget-partial-runs.md`.
- [ ] Issue 5: Strengthen Stage 9 verification reservation and recovery so generated candidates are not silently lost to budget/schema failures. Plan: `plans/07-issue-5-verification-degradation.md`.
- [ ] Issue 6: Improve fallback composition, dedupe, and developer-facing final Markdown quality. Plan: `plans/08-issue-6-final-composition.md`.

Verification completed:
- `pnpm test`
- `make build`
