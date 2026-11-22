---
repo: codegenie
case: cg-11
role: positive
intro: 83e9770f92eb663a4d79cf1e9be59648d33b8d59
base: 7bdea4f70a38c567ed9a7a109100357cca78bc58
introDate: 2026-06-11
fix: 9be30afc5a16b8bc8b6351c2b664fcc6f50121e4
kind: resource-ownership
severity: high
---

# codegenie cg-11

Review [7bdea4f70a38](https://github.com/0xPolygon/codegenie/commit/7bdea4f70a38c567ed9a7a109100357cca78bc58) against its child [83e9770f92eb](https://github.com/0xPolygon/codegenie/commit/83e9770f92eb663a4d79cf1e9be59648d33b8d59).

## Expected finding for run-retention-removes-unowned-directories

Run retention can recursively remove directories it did not create. The selection accepts any directory under the configured runs root, then uses age and the keep count to decide what to remove. This lets routine retention remove unrelated data when the configured root is shared.

## Why the diff introduces it

The parent has no run retention implementation. This diff introduces recursive pruning. Directory type and timestamps serve as eligibility and the active directory is the only identity excluded from deletion.

## Anchors

[src/telemetry/run-artifacts.ts:921–939](https://github.com/0xPolygon/codegenie/blob/83e9770f92eb663a4d79cf1e9be59648d33b8d59/src/telemetry/run-artifacts.ts#L921-L939).

## Severity floor

The prefilter uses low. Expected severity is high. Adjudicate severity independently of detection.

## Fixing evidence

The fix restricts deletion to authenticated, expired runs in a recorder-managed root. The retention tests cover foreign directories, forged lookalikes and concurrent active runs. The expected finding here is the lack of ownership proof in candidate selection. [Fixing commit](https://github.com/0xPolygon/codegenie/commit/9be30afc5a16b8bc8b6351c2b664fcc6f50121e4)
