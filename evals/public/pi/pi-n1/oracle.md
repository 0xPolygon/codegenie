---
repo: pi
case: pi-n1
role: negative-control
intro: 4523528b21c66084fdece7ed3ffa10888bc5ac60
base: 66cd061ab468aeae9fd2e38715d3931f7f77f569
introDate: 2026-07-31
contaminationSplit: pre-2026-08-01
---

# pi pi-n1

Review base `66cd061ab468aeae9fd2e38715d3931f7f77f569` (the parent) against head `4523528b21c66084fdece7ed3ffa10888bc5ac60`.

## Control rationale

"fix(ai): treat only plain objects as provider error bodies (#7205)". At least three months old; every source line it added is unchanged at pi d4d188646; no later fix blames it, and no later commit mentions its hash or PR. This is weaker evidence than a positive label.

A published finding of medium severity or higher on the changed source is a candidate false positive. Adjudicate it against the source before counting it.
