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

`olmo3Architecture` replaces the parser for nested `rope_parameters` with `parseRopeFlat`. In a valid Olmo 3 config with `rope_theta` under `full_attention` and no top-level frequency, the flat parser misses the field. The model then fails validation because its base frequency remains unset.

## Anchor

`decoder/registry.go:690-706` at [the introducing commit](https://github.com/townsendmerino/goinfer/commit/db0869e115c5967c2698990433e471c495cc1cc6).

## Severity floor

Medium.

## Fixing evidence

The fix explicitly reverses the switch and preserves the uniform rotary table derived from `full_attention`. The later [committed config fixture](https://github.com/townsendmerino/goinfer/commit/d5bcfbf99) matches that nested layout. At the case revision the parent parser is the repository evidence for the shape. [Fixing commit](https://github.com/townsendmerino/goinfer/commit/85f68e72bd07e9921844841c359a5c8aca54f308)
