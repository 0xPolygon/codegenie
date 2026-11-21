---
repo: codegenie
case: cg-04
role: positive
intro: 644608d547ad4d1442b24acd55c11c00b9ba02a8
base: 51e8625293b8792f1ccdd31d82f5d5f3d2af332f
introDate: 2026-11-20
fix: 34e39b7db1dfa427f2824d04d0aafe35fc5716ab
kind: error-handling
severity: low
pr: 108
---

# codegenie cg-04

Review base `51e8625293b8792f1ccdd31d82f5d5f3d2af332f` (the parent) against head `644608d547ad4d1442b24acd55c11c00b9ba02a8`. The head exists only on `refs/pull/108/head` because the PR was squash-merged; fetch it by SHA.

## Expectation `unresolved-reconciliation-required-proof`

### Expected finding

`proofVisibilityDiagnostics` treats every source reference of an unresolved reconciliation as a proof that must be visible, including unknown or non-verification references. It emits a path-bearing `proof_not_visible` diagnostic, so composition chooses attribution repair. That repair cannot edit reconciliations, so it can never clear the diagnostic: repairs are wasted and composition falls back. The invalid model-supplied reference is also echoed into diagnostics.

### Anchor

src/pipeline/composition-content.ts:147 (`required.push(...unresolved reconciliation sourceRefs)` with no inventory or kind filter)

### Severity floor

The matcher floor is low. Expected severity is low; record it as a calibration note, not as a miss.

### Fixing evidence

34e39b7 admits only inventory sources of kind verification. Its regression test expects no diagnostic and no attribution repair for an invalid unresolved reconciliation source, and fails at the intro.

