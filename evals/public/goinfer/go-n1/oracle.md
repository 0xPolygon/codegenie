---
repo: goinfer
case: go-n1
role: negative-control
intro: b3a1d9140fa4eb82f3284898026a451ba42c6fc9
base: 2439737dbb0dc3ce33dcaf0af02d2673c6592747
introDate: 2026-11-20
kind: control/behavior-preserving-refactor
severity: medium
---

# goinfer go-n1

Review [2439737dbb0d](https://github.com/townsendmerino/goinfer/commit/2439737dbb0dc3ce33dcaf0af02d2673c6592747) against its child [b3a1d9140fa4](https://github.com/townsendmerino/goinfer/commit/b3a1d9140fa4eb82f3284898026a451ba42c6fc9).

## Control rationale

The named weightLoadOpts fields carry the former positional arguments in the same order. Load transfers quantization, embedInt4, needCanonical, skipRow4, LoRA and the same abort channel. The options are unpacked into the original parameters in the loader and forwarded to the safetensors builder. For readers using defaults, quantNone is zero and the omitted bools, pointer and channel are the same false and nil defaults. The guard ordering, success mapping ownership and failure cleanup stay the same. The callers, including the tests, are converted in the same commit.

## Anchors

[decoder/model.go:658–659](https://github.com/townsendmerino/goinfer/blob/b3a1d9140fa4eb82f3284898026a451ba42c6fc9/decoder/model.go#L658-L659), [decoder/weights.go:561–572](https://github.com/townsendmerino/goinfer/blob/b3a1d9140fa4eb82f3284898026a451ba42c6fc9/decoder/weights.go#L561-L572).

Medium-or-higher reports in these spans are leads for source adjudication.
