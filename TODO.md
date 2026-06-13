# TODO

Confirmed from `reviews/**` against current HEAD. This only lists critical or moderate review findings that still look real and worth fixing.

## Phase 1: CLI, Config & Provider Layer

- [critical] Resolve the git worktree top-level before loading repo config, creating run artifacts, or taking PR locks. `parseReviewCommand` still uses `process.cwd()` as `repoRoot`, so running from a subdirectory can silently ignore root `codeninja.toml` and scatter `.codeninja/` state.
- [moderate] Add an actionable provider-login hint when no usable LLM model can be resolved, and distinguish unknown model/provider from missing authentication where possible.
- [moderate] Make `--lens` restriction semantics part of resolved config instead of relying on the separate `cliLenses` side channel while mutating `lenses.enabled` misleadingly.
- [moderate] Validate `~/.codeninja/auth.json` shape and JSON parse failures with `config_error` context instead of bare `JSON.parse` and unchecked casts.
- [moderate] Remove the second `~/.codeninja/config.toml` parser in provider services, or reuse the config loader so `codeninja provider config` reports the same effective values as `review`, including environment overrides.
- [moderate] Scrub the final CLI stderr error path in `src/cli/main.ts` before writing messages for both `CodeninjaError` and generic `Error`.

## Phase 2: Git Layer & Change Inventory

- [moderate] Fix `modeOnly` detection so only `old mode` / `new mode` headers mark mode-only changes. `new file mode` and `deleted file mode` currently set `modeOnly` on hunkless added/deleted files.
- [moderate] Make `parseDiffGitPaths` handle independently C-quoted old/new paths, such as a plain old path and quoted new path.
- [moderate] Parse commit parents only from the commit header section in `parentShas`; commit-message lines beginning with `parent ` can currently break root-commit review.
- [moderate] Reduce Stage 2 per-file subprocess fanout by batching ignored checks, avoiding unnecessary symlink backfill when mode data is known, and skipping content reads after decisive cheap filters.
- [moderate] Scrub `runGitCapped` error contexts the same way `runCommand` does before attaching args/stderr to `CodeninjaError`.

## Phase 3: Repository Intelligence & Tools

- [critical] Rework the ripgrep fast path. It currently lists tracked paths and runs `git ls-tree` per path on every search, can exceed argv limits, and rejects on spawn errors instead of falling back to git grep.
- [moderate] Fix tree-sitter parse-cache lifetime. LRU eviction deletes `Tree` objects that may still be held by callers walking the parsed result.
- [moderate] Preserve full hunk changed-line lists in `HunkSymbolFacts.changedLines`; the tree-sitter path currently narrows to only the primary symbol's changed lines.
- [moderate] Treat git-grep fallback as an engine choice, not model-visible degraded quality, unless actual result quality is reduced.
- [moderate] Normalize `omittedCount` units in repository tool metadata. Current counts mix omitted lines, omitted results, and truncated characters.
- [moderate] Simplify `core/exported-api-change` static-signal extraction into one gated pass and close the deletion-only multi-symbol gap.
- [moderate] Route all repository-intelligence subprocess work through the shared bounded semaphore and memoize full-tree/file-line reads where the spec expects it.

## Phase 4: Skills, Prompts & LLM Runner

- [critical] Mark post-backoff transient provider failures as recoverable so sustained 429/5xx/network errors degrade affected tasks instead of aborting the whole run as fatal provider failures.
- [critical] Implement forced finalization on budget-checkpoint exhaustion instead of throwing immediately and losing gathered investigation work.
- [moderate] Preserve and disclose lenses whose declaring skills were found but failed to load, so "lens disabled because all skills failed" is visible in telemetry and run output.
- [moderate] Restore the two-step plain-text recovery ladder: first nudge with repository tools still allowed, then force finalization if the model answers in plain text again.
- [moderate] Record `cacheStatus: "write"` on model-call records whose responses are cached, not only as a separate telemetry event.
- [moderate] Sanitize model-supplied tool names before using them in untrusted fence labels such as `tool-result-${name}`.
- [moderate] Add provenance/containment checks for repo-sourced extra skill paths so out-of-repo markdown cannot become trusted prompt content through a config-loader regression.
- [moderate] Truncate schema-repair validation errors before adding them to the next prompt.

## Phase 5: Planner & Packet Builder

- [moderate] Attach static signals to planned hunks by hunk line range, not by whole file.
- [moderate] Preserve language-lens defaults when an invalid skip decision references a compacted-away hunk from a dossier rollup.
- [moderate] Fix proximity grouping for deletion-only hunks so it does not compare old-side and new-side coordinates.

## Phase 6: Review Execution, Verification & Composition

- [moderate] Scrub stdout review output, JSON output, and posting-summary output before writing to the terminal or CI logs. The artifact path is scrubbed; the primary output path is not.
- [moderate] Tighten `isNoFindingsSummary` so a valid summary that says, for example, "No security issues, but one correctness bug remains" is not replaced by the fallback summary.

## Phase 7: GitHub Integration & Publishing

- [moderate] Fix 422 recovery so the third attempt can still preserve valid inline comments after dropping the next suspect class, instead of collapsing all remaining comments to summary-only on attempt 2.
- [moderate] Add an explicit deleted-file anchor signal or document/code the current LEFT-side-subsumes-deleted-file behavior so the 422 suspect-class ladder is unambiguous.
- [moderate] Have `GitHubClient.createReview` surface structured HTTP status and response body for 422 handling; avoid regex matching `422` across arbitrary error text.
- [moderate] Remove the divergent dead GitHub fingerprint helper or make it the single canonical fingerprint implementation used by the composer and duplicate detector.

## Phase 8: Telemetry, Redaction & Model-Call Cache

- [critical] Fold pipeline telemetry into `telemetry.json` and `run.json`. Current pipeline aggregate fields are initialized to zero and never updated, so artifacts can report packets/candidates/verdicts/final findings as zero.
- [moderate] Redact provider responses before recording, caching, and appending to the live conversation so cache replay keys and replayed content match live execution.
- [moderate] Fix `stripCredentials` cycle handling so shared non-cyclic object references are not replaced with `[redacted:circular]`.
- [moderate] Provision `.codeninja/.gitignore` from every code path that creates `.codeninja/`, including cache and PR-lock creation when telemetry is disabled or redirected.
- [moderate] Make run pruning skip active concurrent runs, for example by pruning only finalized run directories or using a heartbeat/lock.

## Phase 9: Security Review

- [moderate] Either wire `assertWorktreeContained` into every worktree filesystem read path or document and enforce that repository reads must use git plumbing. The current symlink-escape guard is dead code.

## Phase 10: Dependency Review

- No confirmed critical or moderate follow-up from the dependency review.

## Phase 11: Test Coverage & Regression Safety

- [critical] Add a hunk-id golden-vector test and a shift-sensitivity test. The current tests only check 64-hex format and same-process stability, but hunk ids are the base identity for anchors, packet ids, fingerprints, and cache keys.
- [critical] Add parser coverage for copied files, symlink diffs (`120000`), submodule diffs (`160000` / `Subproject commit`), and C-quoted path unquoting with octal/control escapes.
- [critical] Add subprocess-boundary tests for no-shell invocation, `--` separators before untrusted pathspecs where supported, hygiene env vars, and credential scrubbing through surfaced `CodeninjaError.context`.
- [critical] Add a real PiRunner agent-loop test for `path_outside_repo` tool rejection that asserts model-visible `isError`, warn telemetry, rejected `ToolCallRecord`, and successful task completion.
- [moderate] Expand diff-anchor validation tests to cover all reason codes, multi-line anchor rules, header line-count mismatch errors, empty diffs, zero-length sides, and omitted-count defaults.
- [moderate] Add isolated config precedence tests for adjacent layers, especially `settings.json` over `config.toml`, repo `codeninja.toml` review-depth over user defaults, and `--reasoning auto` fall-through.
- [moderate] Extend repo-config trust-partition tests for `telemetry.runDir`, `cache.dir`, relative path containment, and warning counts so safe keys are not over-warned.
- [moderate] Add real repository-tool tests for `list_files` and `read_range`, and assert `meta.backend` / `meta.precision` provenance across tool results.
- [moderate] Add file-classifier tests for first-match skip precedence and deleted-file branches, including deleted reviewable source, deleted generated/lock files, and deleted-file degradation when base content is unavailable.
- [moderate] Expand GitHub publisher tests for body caps, low-confidence inline demotion, partial-coverage disclosure, `summaryWhenNoFindings`, deleted-file suspect-class handling, and end-to-end real-client 422 error shape.
- [moderate] Add GitHub client / duplicate-detector tests for comment pagination, fuzzy duplicate author verification on a nearby foreign comment, fingerprint normalization, symbol-preferred identity, and a fingerprint golden vector.
- [moderate] Add skill-loader validation tests for malformed frontmatter fields, oversized skill files, purpose-only skills, empty guidance, duplicate/case-insensitive headings, and missing `Checks` warnings.
- [moderate] Strengthen cache-key sensitivity tests for template version, reasoning, schema version, model id, and changed prior tool results.
- [moderate] Add lens-registry and prompt-projection tests for all-skills-failed lens disclosure, `enabledByDefault` conflict resolution, default-off lens enablement, `registryHash()` stability/sensitivity, stage-specific skill projection maps, and planner-dossier prompt determinism.
