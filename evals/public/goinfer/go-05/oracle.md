---
repo: goinfer
case: go-05
role: positive
intro: b6397eee5b7de893078eaba911c15828657491f4
base: abdd312f2e35ba251b81fa816b8c9f122fc8c133
introDate: 2026-10-14
fix: 83e45f9e7000e939957ba6c92b873bfc2be4866d
kind: performance/conversation-slot-identity
severity: low
---

## Expected finding

`PickSlotFor` treats a reuse score of `firsts[i]-1` as proof that a request belongs to the original conversation. The score intentionally leaves the most recent prompt token to recompute, so a second conversation that differs only in the final token of the first prompt gets the same score. It can then take the original slot with the unlimited own-rollback allowance and discard live cached history.

## Anchor

`internal/kvmgr/slots.go:222-230` at [the introducing commit](https://github.com/townsendmerino/goinfer/commit/b6397eee5b7de893078eaba911c15828657491f4).

## Severity floor

Low.

## Fixing evidence

The fix checks that the incoming prompt preserves the complete first prompt before treating it as an own rollback. The resident interleaved-conversation and slot rollback tests distinguish a true rollback from a distinct prompt with the same numerical reuse score. [Fixing commit](https://github.com/townsendmerino/goinfer/commit/83e45f9e7000e939957ba6c92b873bfc2be4866d)
