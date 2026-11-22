---
repo: pi
case: pi-16
role: positive
intro: e5f3b41506570eca81eaf75ae114ee4c8b9ef075
base: d7a988d18d2a27f78f1cdcc0597154e916d95ed9
introDate: 2026-11-05
contaminationSplit: post-2026-08-01
fix: 434dc5e4d496b62f1b1296ec8847ee04a2fefe84
kind: failure-path/resource-ownership
severity: medium
pr: 11696
---

# pi pi-16

Review [d7a988d18d2a](https://github.com/earendil-works/pi/commit/d7a988d18d2a27f78f1cdcc0597154e916d95ed9) against its child [e5f3b4150657](https://github.com/earendil-works/pi/commit/e5f3b41506570eca81eaf75ae114ee4c8b9ef075).

## Expected finding for archive-rejection-leaks-sync-reader

A pull into a non-empty copy can open a filesystem-backed archive body and then reject it before iteration. The file was already opened by the body producer. Its sole close lives inside an async generator's finally block, which will not run for an iterator that never starts. The rejected pull leaves the file open.

## Why the diff introduces it

The parent has no replication pull or filesystem-backed sync body. This change adds the pull's read-before-archive-validation ordering and the generator whose file is opened before its first next call.

## Anchors

[packages/chord/src/sync/client.ts:355–363](https://github.com/earendil-works/pi/blob/e5f3b41506570eca81eaf75ae114ee4c8b9ef075/packages/chord/src/sync/client.ts#L355-L363), [packages/chord/src/sync/filesystem.ts:182–200](https://github.com/earendil-works/pi/blob/e5f3b41506570eca81eaf75ae114ee4c8b9ef075/packages/chord/src/sync/filesystem.ts#L182-L200).

The optional anchor is a second location for the same cause. Count it once.

## Severity floor

The prefilter uses low. Expected severity is medium. Adjudicate severity independently of detection.

## Fixing evidence

The fix ensures pull releases each acquired body on every path and supplies an iterator that closes even on return before its first read. The upstream tests count open and closed readers when a pull reads an archive and then refuses it. [Fixing commit](https://github.com/earendil-works/pi/commit/434dc5e4d496b62f1b1296ec8847ee04a2fefe84)
