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

The streaming detokenizer promises that concatenating the writes and final flush reproduces whole-sequence `Decode`. For a well-formed multibyte character spread over tokens, it holds the incomplete prefix until it receives the rest. It applies the sequence-level leading-space rule once. Adjudicate reports against these promises and the pinned source.

## Anchor

`tokenizer/stream.go:20-62` at [the introducing commit](https://github.com/townsendmerino/goinfer/commit/f02d0b534efdd9799aca87f72fe5c9fd0ae36b33).

## Severity floor

Medium. The location matcher flags reports for adjudication.

## Control evidence

The introduction includes tests for whole-sequence parity, spaces, byte-level and fallback UTF-8, flush and invalid token IDs. The implementation and tests are byte-identical through goinfer main `36dbfbaf149aabdff43dce5766b49a65183113a7`.

The pinned test helper `byteLevelStreamTokenizer()` provides a valid token ID for the isolated continuation byte `0x9f` in its third return value at index 1. Feed that ID alone to `NewStream().Write` and then flush the same stream. The write returns the raw byte `9f`, flush returns zero bytes, and `Decode` on the same singleton returns `9f`. Go's `utf8.FullRune` treats an invalid encoding as complete and the loop copies the original bytes. A report of invalid UTF-8 in this example is factually correct. For a medium-or-higher defect, establish a broken contract or a concrete downstream consequence. The observed byte parity supports keeping this case as a control.

To reproduce, copy the adjacent `stream_continuation_test.go` into `tokenizer/` in a scratch checkout of the pinned head and run `go test ./tokenizer -run '^TestStandaloneContinuationByteParity$' -count=1`.
