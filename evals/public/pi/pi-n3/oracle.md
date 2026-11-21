---
repo: pi
case: pi-n3
role: negative-control
intro: 9022a5b5eaa8bb0938e9b8b28f98b4d76a0519e9
base: cbe1a8b732e45359f20be58b367ea48af9c93acf
introDate: 2026-03-30
contaminationSplit: pre-2026-08-01
---

# pi pi-n3

Review base `cbe1a8b732e45359f20be58b367ea48af9c93acf` (the parent) against head `9022a5b5eaa8bb0938e9b8b28f98b4d76a0519e9`.

## Control rationale

"fix(agent): await subscribed event handlers". At least three months old; every source line it added is unchanged at pi d4d188646; no later fix blames it, and no later commit mentions its hash or PR. This is weaker evidence than a positive label.

A published finding of medium severity or higher on the changed source is a candidate false positive. Adjudicate it against the source before counting it.
