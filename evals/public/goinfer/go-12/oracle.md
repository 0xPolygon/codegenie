---
repo: goinfer
case: go-12
role: positive
intro: 76cab582735ad426ea696fa8ca1369040f84d892
base: bb5d55b84c195d05540904129a5ff2c4439d0690
introDate: 2026-10-22
fix: 3dff704a318daef3eadf9fc73321dfc1fcadb254
kind: resource-ownership
severity: high
---

# goinfer go-12

Review [bb5d55b84c19](https://github.com/townsendmerino/goinfer/commit/bb5d55b84c195d05540904129a5ff2c4439d0690) against its child [76cab582735a](https://github.com/townsendmerino/goinfer/commit/76cab582735ad426ea696fa8ca1369040f84d892).

## Expected finding for bf16-convolution-aliases-released-mapping

The LFM2 short-convolution projections can now alias BF16 checkpoint storage. On a direct safetensors load whose tensor types pass the existing alias check, loadWeights closes the source mapping after building the weights. With an all-BF16 checkpoint, the retained projections point into that closed mapping and a subsequent decode can fault.

## Why the diff introduces it

At the parent, loadLFM2Conv widens the BF16 input and output projections through TensorF32 before creating the retained matrix. Those BF16 projections have owned storage. The changed stIsland calls can retain the original BF16 bits instead. The end-of-load release predicate in decoder/weights.go still treats BF16 as safe to unmap.

## Anchors

[decoder/lfm2.go:49–59](https://github.com/townsendmerino/goinfer/blob/76cab582735ad426ea696fa8ca1369040f84d892/decoder/lfm2.go#L49-L59).

## Severity floor

The prefilter uses low. Expected severity is high. Adjudicate severity independently of detection.

## Fixing evidence

The fix checks for retained BF16 short-convolution islands before dropping the checkpoint mapping. TestMEM11_lfm2BF16CheckpointKeepsItsMapping uses a small all-BF16 checkpoint and asserts the source mapping stays live. [Fixing commit](https://github.com/townsendmerino/goinfer/commit/3dff704a318daef3eadf9fc73321dfc1fcadb254)
