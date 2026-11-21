---
repo: goinfer
case: go-06
role: positive
intro: d94356157b694ec9f0ceb7d76843704f78d3fee3
base: 22f3631d6e0d1ee52616b97aec9780e1164e0c4b
introDate: 2026-10-21
fix: 89e1777bf5822a4d013876e50a7b50f26e2688c8
kind: correctness/host-memory-accounting
severity: medium
---

## Expected finding

`fromVMStats64` adds speculative read-ahead pages as a separate term even though macOS already includes those pages in both the free and external file-backed counters. The estimate counts each speculative page three times, overstating memory available for model placement by twice the speculative-page count.

## Anchor

`internal/hostmem/vmstats64.go:34-37` at [the introducing commit](https://github.com/townsendmerino/goinfer/commit/d94356157b694ec9f0ceb7d76843704f78d3fee3).

## Severity floor

Medium.

## Fixing evidence

The fix subtracts speculative pages from free and includes them once through external. `TestFromVMStats64_addsUpReclaimable` moves free pages to the speculative class in a fixed sample and checks that available bytes remain unchanged. [Fixing commit](https://github.com/townsendmerino/goinfer/commit/89e1777bf5822a4d013876e50a7b50f26e2688c8)
