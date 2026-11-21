---
repo: goinfer
case: go-11
role: negative-control
intro: 9383547fcbbb5c37dee7c7177babe2e751948449
base: a9297c9b571a368c1aa2b1e19731d04c2dc8314f
introDate: 2026-10-12
kind: control/in-process-http-streaming
severity: low
---

## Expected result

No defect is expected in the in-process HTTP transport. Response bytes stream through a pipe and closing the body cancels the handler context and unblocks writes. A panic before headers returns a transport error, while a panic after headers surfaces on the response body. Adjudicate any reported issue against the transport contract and the pinned source.

## Anchor

`internal/inproc/transport.go:22-139` at [the introducing commit](https://github.com/townsendmerino/goinfer/commit/9383547fcbbb5c37dee7c7177babe2e751948449).

## Severity floor

Low. The location matcher flags reports for adjudication.

## Control evidence

The introduction tests ordinary requests, streaming, cancellation and panics before and after headers. The implementation and tests were moved byte-for-byte to `internal/app/inproc` and stayed unchanged through goinfer main `36dbfbaf149aabdff43dce5766b49a65183113a7`.
