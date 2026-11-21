---
repo: goinfer
case: go-03
role: positive
intro: acf27e2947b7b241c8985abbd105722823fd34dc
base: 32f854b52984ca58600280ba6f2a1b081a7f4b65
introDate: 2026-08-25
fix: c5720ff833356db4305b97a6b82d34d824a67bcf
kind: correctness/initialization-order
severity: high
---

## Expected finding

The direct Gemma 4 MoE GGUF loader copies `l.LayerScalar` into the MoE weights before assigning the default or reading the checkpoint's scale. The copy stays zero even when the layer is subsequently initialized. The MoE forward path multiplies its output by that copied value, effectively zeroing the layer and breaking generation for these direct loads.

## Anchor

`decoder/gguf.go:2316-2329` at [the introducing commit](https://github.com/townsendmerino/goinfer/commit/acf27e2947b7b241c8985abbd105722823fd34dc).

## Severity floor

Medium.

## Fixing evidence

The fix moves scale initialization ahead of the MoE weights construction. `TestGemma4GGUF_moeLayerScalarMatchesLayer` uses synthetic GGUF weights to pin the copied value to the initialized layer scale. [Fixing commit](https://github.com/townsendmerino/goinfer/commit/c5720ff833356db4305b97a6b82d34d824a67bcf)
