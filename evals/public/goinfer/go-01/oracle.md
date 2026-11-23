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

Two admin requests to load a model under the same name can both pass the initial registry check and finish `loadDecoder` outside the lock. The losing request takes the second duplicate-name branch and returns HTTP 409 without explicitly releasing the loaded, unregistered model. On the directory-backed CPU safetensors path, its mapping can remain live until garbage collection runs the pinned aikit finalizer. This delays reclamation and can increase peak mapped-weight and memory pressure under overlapping loads. The GGUF loader already defers closing its mapping. Credit the losing load's lack of prompt reclamation, including descriptions that say the mapping stays live until GC. Permanent retention and a leak across all model formats are outside the evidence.

## Anchor

`cmd/serve/admin.go:76-81` at [the introducing commit](https://github.com/townsendmerino/goinfer/commit/37e4ad2fa6c99a26179bb4d6fd23ab15dd8da5a6).

## Severity floor

Medium for a race that can delay release of an entire safetensors mapping. A plain duplicate response without a resource consequence does not meet the expectation.

## Fixing evidence

A later revision closes the model on the post-load conflict path, where this request still owns it. Its `TestAdminLoad_racedDuplicateIsClosed` exercises that branch using the later release API. At the case revision the model has no public `Close` method and aikit v1.0.0 owns safetensors unmapping through a finalizer. [Fixing commit](https://github.com/townsendmerino/goinfer/commit/cd0fa3ab996719a23e989daa453fcc8bd24f2e71)
