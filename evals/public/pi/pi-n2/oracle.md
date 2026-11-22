---
repo: pi
case: pi-n2
role: contaminated-control
intro: 1c799cecd02c6d8245afa39b1684f07d3b96bd3e
base: c6d8371521fc8357958bb21fd43552c15f46c7f4
introDate: 2026-07-16
contaminationSplit: pre-2026-08-01
---

# pi pi-n2

Review base `c6d8371521fc8357958bb21fd43552c15f46c7f4` (the parent) against head `1c799cecd02c6d8245afa39b1684f07d3b96bd3e`.

## Exclusion rationale

The base normalizer preserves tabs. The head expands tabs outside recognized escape sequences, with an explicit promise to preserve tabs inside terminal strings. The escape reader recognizes OSC and APC as its two terminal string variants. A tab inside DCS is therefore rewritten by the new normalizer. The audit found no repository producer for tab-bearing DCS output. Keep this as an exploratory input and exclude it from the clean-control and required-detection denominators. [Pinned change](https://github.com/earendil-works/pi/commit/1c799cecd02c6d8245afa39b1684f07d3b96bd3e)

The normalization loop is in `packages/tui/src/utils.ts:284-305`, and the escape reader is at lines 311-349.
