---
status: complete
---

# Phase 2: Git Layer And Change Inventory

## Overview

This phase implements the deterministic local git/change-inventory layer used by the review pipeline. It adds the `GitClient` subprocess chokepoint, branch/commit/default target resolution, unified-diff parsing with stable hunk ids and anchor validation, Stage 2 filter decisions, and Stage 3 file classification facts. PR mode and GitHub posting remain deferred to Phase 7; the Phase 2 CLI path resolves local inputs, parses the diff, writes inventory artifacts, and stops before later LLM stages.

## Steps

1. Extend `src/types.ts` with Phase 2 contracts: `ReviewInput`, `ResolvedReviewInput`, `CommitInfo`, `UnifiedDiff`, `DiffFile`, `DiffHunk`, `DiffLine`, `FactProvenance`, `FileFacts`, `FileFilterDecision`, `DiffAnchor`, `DiffAnchorIndex`, and `DiffAnchorValidation`.
2. Add `src/util/hashing.ts` for `sha256Hex` so hunk ids and later fingerprints share one utility.
3. Add `src/git/subprocess.ts` as the private subprocess chokepoint for git commands: argv-only execution through `execa`, environment hygiene, no shell, timeout/output-buffer controls, safe ref/path/glob/refspec validators, typed error mapping, and credential-scrubbed error context.
4. Add `src/git/git-client.ts` with `createGitClient(repoRoot, opts?)`, the public `GitClient` methods, and internal helper methods needed by the resolver/classifier (`currentBranch`, `isInsideWorktree`, `repoRoot`, `resolveBranch`, `emptyTreeSha`, `checkIgnored`, `lsTreeEntry`, etc.).
5. Add `src/git/review-input-resolver.ts` to normalize `default_branch`, `branch`, and `commit_range` review targets into pinned SHAs, merge base, commit metadata, and raw diff. PR mode returns a typed deferred error for Phase 7.
6. Add `src/git/diff-parser.ts` with strict git-header unified-diff parsing, status/binary/mode-only/symlink/submodule detection, C-quoted path unescaping, hunk line-number mapping, stable hunk-id hashing, `buildDiffAnchorIndex`, and `validateDiffAnchor`.
7. Add `src/git/detectors.ts` with deterministic shared detectors for generated/vendor/lock/binary/ignored/submodule/symlink/language/test/package-root facts, including bounded revision content reads through `GitClient.catFile`.
8. Add `src/git/file-classifier.ts` with `filterDiffFiles` and `classifyChangedFiles`, memoized detector reuse, configured path-rule matching via `picomatch`, policy-change labels, small-added-file `whole-file` handling, and degraded facts for deleted files whose base content cannot be read.
9. Wire `executeReviewCommand` so local review modes run Phase 2 inventory, write `resolved-input.json`, `diff.json`, `file-filter-decisions.json`, `file-facts.json`, and `coverage.json`, then return successfully with a clear "later stages not implemented" status.
10. Add Vitest coverage for subprocess safety/GitClient basics, resolver local modes, diff parsing/anchor validation, and filtering/classification behavior.

## Tests

- `git-client.rejects-option-like-ref-and_paths`: verifies unsafe refs and paths fail with `invalid_args` before spawning risky git commands.
- `git-client.diff-and-log-integration`: verifies pinned diff output and NUL-delimited commit log parsing in a temporary repo.
- `resolver.default_branch_and_branch_modes`: verifies bare current-branch review matches explicit branch mode and resolves the base branch with merge-base semantics.
- `resolver.commit_modes`: verifies single commits diff against first parent/root empty tree and two-commit ranges use endpoint diffs.
- `diff-parser.status_lines_and_hunk_ids`: verifies status detection, absolute line mapping, no-newline markers, and stable hunk ids.
- `anchor.validation`: verifies RIGHT/LEFT changed-line validation, rename old-path semantics, unknown hunks, and context-line rejection.
- `filter-and-classify.detectors_and_path_rules`: verifies generated/vendor/lock/binary skip decisions, configured skip/labels/priority/mode precedence, language/test/package-root facts, policy-change labeling, and small added files.
- `review-command.phase2_inventory_artifacts`: verifies `codegenie review --branch` writes Phase 2 inventory artifacts and leaves later stages marked not implemented.
