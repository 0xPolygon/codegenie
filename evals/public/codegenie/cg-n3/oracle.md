---
repo: codegenie
case: cg-n3
role: negative-control
intro: 8a748215a904c1b07e27e84835f9a1e8e6518247
base: 22ebccdcfb11c6f4d64cac8a3e8989244b75a8ad
introDate: 2026-11-19
pr: 87
weak: true
---

# codegenie cg-n3

Review base `22ebccdcfb11c6f4d64cac8a3e8989244b75a8ad` (the parent) against head `8a748215a904c1b07e27e84835f9a1e8e6518247`. The head exists only on `refs/pull/87/head`; fetch it by SHA.

## Control rationale

Keeps a missing-git failure typed during cache preflight: optional stderr, with the error attached as cause. The function was never changed afterwards. This is a weak control because only three source lines change. **Weak control.**

A published finding of medium severity or higher on the changed source is a candidate false positive. Adjudicate it against the source before counting it.
