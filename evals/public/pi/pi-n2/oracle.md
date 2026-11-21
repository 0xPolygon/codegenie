---
repo: pi
case: pi-n2
role: negative-control
intro: 1c799cecd02c6d8245afa39b1684f07d3b96bd3e
base: c6d8371521fc8357958bb21fd43552c15f46c7f4
introDate: 2026-07-16
contaminationSplit: pre-2026-08-01
---

# pi pi-n2

Review base `c6d8371521fc8357958bb21fd43552c15f46c7f4` (the parent) against head `1c799cecd02c6d8245afa39b1684f07d3b96bd3e`.

## Control rationale

"fix(tui): normalize tabs for terminal output (#6697)". At least three months old; every source line it added is unchanged at pi d4d188646; no later fix blames it, and no later commit mentions its hash or PR. This is weaker evidence than a positive label.

A published finding of medium severity or higher on the changed source is a candidate false positive. Adjudicate it against the source before counting it.
