---
repo: codegenie
case: cg-13
role: positive
intro: 54ff89ac7ae6f45db2c3b3b0f876f9f884122b96
base: fc29575c3857ae8ea1ce4314c88d8d62c3fd348d
introDate: 2026-11-21
fix: e5a3bfab427c1de8c3277c88340b2847fba297ca
kind: failure-path/data-integrity
severity: low
pr: 214
---

# codegenie cg-13

Review [fc29575c3857](https://github.com/0xPolygon/codegenie/commit/fc29575c3857ae8ea1ce4314c88d8d62c3fd348d) against its child [54ff89ac7ae6](https://github.com/0xPolygon/codegenie/commit/54ff89ac7ae6f45db2c3b3b0f876f9f884122b96).

## Expected finding for unborn-snapshot-records-unresolved-head

A staged or uncommitted review on an unborn repository can compare against the empty tree yet record HEAD as the base in run.json. The label is fixed before the snapshot resolves, so readers of resolved-input.json and run.json see different descriptions of the same comparison.

## Why the diff introduces it

The parent has no staged or uncommitted snapshots. This change adds the empty-tree fallback in local-review.ts and writes a fixed HEAD label at telemetry initialization. An ordinary committed HEAD is accurate. The inconsistency occurs only when snapshot capture chooses the empty tree.

## Anchors

[src/pipeline/review-runner.ts:473–479](https://github.com/0xPolygon/codegenie/blob/54ff89ac7ae6f45db2c3b3b0f876f9f884122b96/src/pipeline/review-runner.ts#L473-L479).

## Severity floor

The prefilter uses low. Expected severity is low. Adjudicate severity independently of detection.

## Fixing evidence

The review fix updates the run record from the resolved snapshot labels. Its two unborn-HEAD test cases compare run.json with resolved-input.json for both local modes. The reviewed fix is included in the public squash merge of PR #214. [Fixing commit](https://github.com/0xPolygon/codegenie/commit/e5a3bfab427c1de8c3277c88340b2847fba297ca)
