---
repo: goinfer
case: go-14
role: positive
intro: b7e873b8e2a21f5d42f37ad4c9032e5b6d09729c
base: 177b9816e13fad9fc69a84e3bdb06e508ccc47c3
introDate: 2026-06-20
fix: c6eb3c0db75ae7899e221a5e945b07e0914fbd86
kind: failure-path/resource-ownership
severity: medium
---

# goinfer go-14

Review [177b9816e13f](https://github.com/townsendmerino/goinfer/commit/177b9816e13fad9fc69a84e3bdb06e508ccc47c3) against its child [b7e873b8e2a2](https://github.com/townsendmerino/goinfer/commit/b7e873b8e2a21f5d42f37ad4c9032e5b6d09729c).

## Expected finding for metal-batched-forward-blocks-before-submit

The experimental batched WebGPU forward records a compute pass for repeated per-row and per-layer operations and defers its only queue submit to the end of the batch. On Metal, ending each pass allocates a native command buffer. A sufficiently large batch fills the uncommitted-buffer cap while still encoding, so another pass waits for capacity and execution never reaches the submit that could free it.

## Why the diff introduces it

The parent does not contain DecodeTokenFusedBatched. This diff introduces the one-encoder batched path, the repeated pass endings and its sole submit after all layers and rows. The affected entry point is the new batched forward, including its GPU parity and measurement calls.

## Anchors

[gpu/decodetoken_batched.go:77–84](https://github.com/townsendmerino/goinfer/blob/b7e873b8e2a21f5d42f37ad4c9032e5b6d09729c/gpu/decodetoken_batched.go#L77-L84), [gpu/decodetoken_batched.go:215–221](https://github.com/townsendmerino/goinfer/blob/b7e873b8e2a21f5d42f37ad4c9032e5b6d09729c/gpu/decodetoken_batched.go#L215-L221).

The optional anchor is a second location for the same cause. Count it once.

## Severity floor

The prefilter uses low. Expected severity is medium. Adjudicate severity independently of detection.

## Fixing evidence

The follow-up documents the Metal queue stall observed in the upstream microbench and submits bounded groups of passes without waiting between submissions. It keeps ordering on the same queue. Source evidence applies to the Metal backend and the new batched path. [Fixing commit](https://github.com/townsendmerino/goinfer/commit/c6eb3c0db75ae7899e221a5e945b07e0914fbd86)
