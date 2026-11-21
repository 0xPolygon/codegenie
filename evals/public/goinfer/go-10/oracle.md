---
repo: goinfer
case: go-10
role: negative-control
intro: f02d0b534efdd9799aca87f72fe5c9fd0ae36b33
base: 3d50ec1f8f4b9489e189748189c160fa6073a834
introDate: 2026-10-11
kind: control/streaming-detokenization
severity: medium
---

## Expected result

No defect is expected in the new streaming detokenizer. It only emits complete characters during writes, flushes any remaining bytes at end of stream and applies the sequence-level leading-space rule once. Adjudicate any reported issue against the tokenizer contract and the pinned source.

## Anchor

`tokenizer/stream.go:20-62` at [the introducing commit](https://github.com/townsendmerino/goinfer/commit/f02d0b534efdd9799aca87f72fe5c9fd0ae36b33).

## Severity floor

Medium. The location matcher flags reports for adjudication.

## Control evidence

The introduction includes tests for whole-sequence parity, spaces, byte-level and fallback UTF-8, flush and invalid token IDs. The implementation and tests are byte-identical through goinfer main `36dbfbaf149aabdff43dce5766b49a65183113a7`.
