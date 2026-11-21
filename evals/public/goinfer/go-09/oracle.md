---
repo: goinfer
case: go-09
role: positive
intro: 6e9fcb99ba1d235dfa5a9e83fd10b21f41d8ab64
base: 1e2ca04f68e20e8f869f901e4433a79d480726b4
introDate: 2026-09-29
fix: 2f685d7e7cd67849c2e685ddc290f0d611b0906a
kind: concurrency/device-slot-ownership
severity: high
---

## Expected finding

An adaptive speculative verify round holds `resBusy` but calls the resident verifier without the batcher's separate `busy` exclusion. Another generation's slot bind and prefill use `busy` without checking `resBusy`; those operations can interleave with the round's bind and forward. The round can therefore write KV to the wrong active slot under concurrent generation.

## Anchor

`decoder/spec_ngram.go:716-730` at [the introducing commit](https://github.com/townsendmerino/goinfer/commit/6e9fcb99ba1d235dfa5a9e83fd10b21f41d8ab64). `decoder/spec_ngram.go:636-638` establishes the separate resident claim and is also valid when the report traces the unprotected verify path.

## Severity floor

Medium.

## Fixing evidence

The fix wraps both verify variants in the batcher's exclusive section, matching the bind, prefill and commit protection. `TestSpecAdaptiveConcurrentCUDA` checks concurrent parity. The two distinct locks and the omitted acquisition are visible in the Go source. [Fixing commit](https://github.com/townsendmerino/goinfer/commit/2f685d7e7cd67849c2e685ddc290f0d611b0906a)
