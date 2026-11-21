---
repo: goinfer
case: go-02
role: positive
intro: 8c3083bd675c8ebe860807db7595c5e8704e7e66
base: 30af454d60b1aeb8ca4b25f0638f2e1ec8318252
introDate: 2026-09-02
fix: d766fcebd359aefa7900a07798cb469f2f2825cb
kind: api-contract/offline-resolution
severity: medium
---

## Expected finding

`Resolve` promises to return a verified cached model without network access. For a pinned `demo:` ref with the expected filename, size and digest already available from its manifest, the new resolver still calls `CheckAccess` and `List` before reaching cache verification in `Download`. An offline startup fails even when the exact pinned file is already cached.

## Anchor

`pull/resolve.go:36-45` at [the introducing commit](https://github.com/townsendmerino/goinfer/commit/8c3083bd675c8ebe860807db7595c5e8704e7e66).

## Severity floor

Medium.

## Fixing evidence

The fix verifies the pinned local file before either network call. `TestResolveOffline_verifiedCacheHitNeedsNoNetwork` and `TestResolve_callsResolveOfflineBeforeCheckAccess` cover the local hit and ordering, while mismatch and unpinned cases still take the ordinary route. [Fixing commit](https://github.com/townsendmerino/goinfer/commit/d766fcebd359aefa7900a07798cb469f2f2825cb)
