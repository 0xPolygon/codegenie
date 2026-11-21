---
repo: codegenie
case: cg-n4
role: negative-control
intro: 850f1fc1c5a1e6808eb4a275ac57591342a674a9
base: 10251bd2af254169d388b003066044a942fb33a6
introDate: 2026-11-19
pr: 90
---

# codegenie cg-n4

Review base `10251bd2af254169d388b003066044a942fb33a6` (the parent) against head `850f1fc1c5a1e6808eb4a275ac57591342a674a9`. The head exists only on `refs/pull/90/head`; fetch it by SHA.

## Control rationale

Removes checkout paths and runtime-only settings from the model-call cache fingerprint so replay stays stable across worktrees. The fingerprint function was never changed afterwards. The removal of `repoRoot` is intended; the commit message records remaining eval-fixture SHA variance as separate work.

A published finding of medium severity or higher on the changed source is a candidate false positive. Adjudicate it against the source before counting it.
