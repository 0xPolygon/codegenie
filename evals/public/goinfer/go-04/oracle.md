---
repo: goinfer
case: go-04
role: positive
intro: 164d6379af6fff2da31787ec6efa12c84eff7d94
base: 88aeb1a30e85456ed615cfdfec1bc20a80903040
introDate: 2026-09-10
fix: 0e5794009822cfa4d02e0a7dfd3e0a29e2e3b88a
kind: correctness/kv-cache-bookkeeping
severity: high
---

## Expected finding

The successful BlockSpec exit publishes all output token IDs as resident cache contents. The trailing token has been emitted, but the decoder has yet to forward it as the next round's anchor. A later generation reusing that recorded prefix can read stale or unwritten KV state for the claimed last position.

## Anchor

`decoder/blockspec.go:434-436` at [the introducing commit](https://github.com/townsendmerino/goinfer/commit/164d6379af6fff2da31787ec6efa12c84eff7d94).

## Severity floor

Medium.

## Fixing evidence

The fix forwards the final token when it can and otherwise records only the written prefix. `TestBlockSpecGenerate_commitsOnlyWrittenPositions` pins this behavior. The same fixing commit also repairs a separate grammar-path issue, which is outside this expectation. [Fixing commit](https://github.com/townsendmerino/goinfer/commit/0e5794009822cfa4d02e0a7dfd3e0a29e2e3b88a)
