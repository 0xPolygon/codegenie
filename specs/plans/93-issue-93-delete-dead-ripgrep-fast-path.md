# Issue 93: Delete the Dead Ripgrep Fast Path (and its Per-Run Enumeration Tax)

Status: COMPLETE — implemented 2026-07-04.
Implementation notes: `src/repo/search.ts` now uses `git grep` unconditionally and reports `engine: "git-grep"` for search-backed tool telemetry; the ripgrep spawn/filter/parser path is deleted. `SourceResolver` no longer snapshots worktree cleanliness or enumerates untracked/ignored files. `@vscode/ripgrep` is removed from `package.json`/`pnpm-lock.yaml`. Current project specs and rendered HTML now describe the single git-grep search engine. Historical plan text below is retained for provenance.
Planned from: fable review D9 + §3 bug 10 + §6 item 7 (`specs/reviews/1-fable-review.md`), 2026-07-04
Planned at: commit `762339d` (branch `next`)
Recommended priority: first of the simplification series — zero model-behavior surface, pure deletion of dead machinery plus a real per-run cost.

## Problem

The ripgrep "fast path" never executes: eligibility requires zero untracked files *including ignored ones* (`search.ts:295-300`), and `source-resolver.ts:181-192` enumerates `git ls-files --others --ignored` into a Set to check that — so any repo with `node_modules/`, `.codegenie/runs/`, or build output (i.e., every real repo) fails eligibility and falls back to git-grep. The result: we carry the ripgrep integration's complexity (engine selection, `--no-ignore --hidden` flags that also contradict the spec's default-ignore pin), pay a full ignored-file enumeration on **every run**, and get none of the speed. `ToolCallRecord.engine` is also never recorded for model-initiated calls, so the dead path is invisible in telemetry — which is how it stayed dead.

## Decision: delete, not fix

The fable review allows either. Delete wins on evidence:
- The fallback (git-grep) has been the *only* engine in every recorded run; all recall/latency data of the entire wave era was produced on it. There is no measured deficit to fix.
- Tool-call latency is not a loss source anywhere in the loss ledger (runs 24-54); the enumeration tax, by contrast, is a measured per-run cost with zero payoff.
- Fixing (allow untracked, post-filter) adds a second live engine whose results must be proven identical — a validation burden with no demonstrated benefit. If grep latency ever becomes a measured problem, reintroduce it *then*, against the harness.

## In-Scope

- `src/repo/search.ts` — remove ripgrep engine selection/spawn path; git-grep becomes the only engine, unconditionally.
- `src/repo/source-resolver.ts:181-192` — delete the `--others --ignored` enumeration and the untracked/ignored Set.
- `@vscode/ripgrep` dependency removal from `package.json` if nothing else imports it.
- `ToolCallRecord.engine` — either delete the field (single engine) or record `"git-grep"` unconditionally; pick whichever keeps artifact consumers stable (grep eval-scoring first).
- Spec: repository_and_github search section — remove the fast-path paragraphs; note the deletion rationale (D9).

## Validation (harness)

- Unit: search fixture tests unchanged (results identical — they already run on git-grep in practice).
- One owner eval run: `tool-calls-summary.json` latency distribution comparable to the runs 51-54 baseline; no new tool errors; run wall-clock unchanged or slightly better (enumeration removed).

## Done Criteria

- No ripgrep code, dependency, or spec text remains; ignored-file enumeration gone.
- Search behavior byte-identical on the fixture suite.

## Stop Conditions

- If anything else consumes the untracked/ignored Set (grep before deleting), disposition that consumer first rather than keeping the enumeration alive for it silently.
