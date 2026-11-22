# Plan 132 · Review local snapshots

- Issue #211
- Integration after 0.9.0 has shipped

## Behavior

`--staged` reviews HEAD versus the index. `--uncommitted` reviews HEAD versus the tracked working tree, including staged changes. Both accept an unborn branch and use an empty base. These flags are mutually exclusive with other targets and `--base`; posting also fails validation. There is no index-to-worktree mode.

The uncommitted target counts nonignored untracked files and reports the count with the `git add -N <path>` remedy. Git can include intent-to-add files because the original index already contains them. An unmerged index fails in Stage 1 with a concise error.

## Implementation

1. Resolve the index and object store using Git plumbing. Copy the index to a private scratch directory outside the checkout and run-artifact root. Run tree creation there and update tracked entries for the uncommitted target. Disable index hooks and fsmonitor. Preserve Git's configured clean filters.
2. Store new trees and blobs in a temporary object directory and read the real objects through an alternate. Pass one scoped Git client to the file classifier, repository index and composition path. Bind base/head reads to the same tree IDs as the diff. Clean up the scratch files at run finalization.
3. Use mode and tree IDs in the existing cache fingerprint. Keep the repository's config and skills sourcing as it is. Display the two target sides and record tree IDs in the resolved-input artifact. The report has no head commit or GitHub links, and the planner receives an empty commit list.
4. Reject GitHub posting at CLI validation and Stage 1. Keep the target examples in the usage-error renderer in sync.

## Verification

Exercise both modes with the fake provider and a Git client that rejects commit-only operations. Check separate staged/worktree bytes and anchors, read/list/search stability after an edit, status and index preservation, alternate and split indexes, zero-work and unborn trees, detached HEAD, unmerged input, cleanup, cache stability, untracked disclosure, and the no-post contract.
