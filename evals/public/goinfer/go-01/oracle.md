---
repo: goinfer
case: go-01
role: positive
intro: 37e4ad2fa6c99a26179bb4d6fd23ab15dd8da5a6
base: 34bfca8d3010b8b30be1bdd561a70ec0a9619170
introDate: 2026-06-07
fix: cd0fa3ab996719a23e989daa453fcc8bd24f2e71
kind: concurrency/resource-lifetime
severity: medium
---

## Expected finding

Two admin requests to load a model under the same name can both pass the initial registry check and finish `loadDecoder` outside the lock. The losing request takes the second duplicate-name branch and returns HTTP 409 without closing the freshly opened, unregistered model. Its mapped weights and resident allocations therefore remain allocated.

## Anchor

`cmd/serve/admin.go:76-81` at [the introducing commit](https://github.com/townsendmerino/goinfer/commit/37e4ad2fa6c99a26179bb4d6fd23ab15dd8da5a6).

## Severity floor

Medium.

## Fixing evidence

The fix closes the model only on the post-load conflict path, where this request still owns it. `TestAdminLoad_racedDuplicateIsClosed` checks that this branch closes the model and distinguishes it from the conflict before loading. [Fixing commit](https://github.com/townsendmerino/goinfer/commit/cd0fa3ab996719a23e989daa453fcc8bd24f2e71)
