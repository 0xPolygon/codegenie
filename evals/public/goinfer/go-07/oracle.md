---
repo: goinfer
case: go-07
role: positive
intro: db0869e115c5967c2698990433e471c495cc1cc6
base: c49d384f57b211aa6608a5564e32b0c83e8ae040
introDate: 2026-09-10
fix: 85f68e72bd07e9921844841c359a5c8aca54f308
kind: correctness/config-parser-regression
severity: medium
---

## Expected finding

`olmo3Architecture` replaces the parser for nested `rope_parameters` with `parseRopeFlat`. For the nested config shape accepted by the parent, `rope_theta` is under `full_attention` and absent from the outer `rope_parameters` object. The flat reader looks in that outer object and rejects the model load with `rope_theta must be >0` before `validateLlama` runs. Credit descriptions that identify the lost nested-config support and the load rejection. This case does not establish the config shape used by every released checkpoint.

## Anchor

`decoder/registry.go:690-706` at [the introducing commit](https://github.com/townsendmerino/goinfer/commit/db0869e115c5967c2698990433e471c495cc1cc6).

## Severity floor

Medium.

## Fixing evidence

The fix explicitly reverses the switch and preserves the uniform rotary table derived from `full_attention`. The later [committed config fixture](https://github.com/townsendmerino/goinfer/commit/d5bcfbf99) matches that nested layout. At the case revision the parent parser is the repository evidence for the shape. To reproduce, copy `nested_rope_test.go` from this directory into `decoder/` in isolated base and head checkouts and run `go test ./decoder -run '^TestOracleNestedOlmo3RoPE$'`. It succeeds at base and fails at head in the flat parser. [Fixing commit](https://github.com/townsendmerino/goinfer/commit/85f68e72bd07e9921844841c359a5c8aca54f308)
