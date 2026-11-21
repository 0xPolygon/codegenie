---
repo: codegenie
case: cg-09
role: positive
intro: c9df07f17b21e4a9514b2912f4cc702936a1e364
base: 052096f9262a00a9666b5c23d8afb2b59b0b0e73
introDate: 2026-11-19
fix: 6f43d71a21e7aa1a093a6283d0fb0f295e88bec5
kind: logic
severity: low
pr: 86
---

# codegenie cg-09

Review base `052096f9262a00a9666b5c23d8afb2b59b0b0e73` (the parent) against head `c9df07f17b21e4a9514b2912f4cc702936a1e364`. The head exists only on `refs/pull/86/head` because the PR was squash-merged; fetch it by SHA.

## Expectation `empty-finding-updates-counted-as-revision`

### Expected finding

The verifier's schema-invalid classifier now treats any non-null `findingUpdates`, including `{}` or `[]`, as a revision payload. A revise whose `findingUpdates` is empty is schema-invalid, because the schema requires at least one property, but it is no longer classified as `revise_without_revision_payload`. It therefore gets the wrong repair instruction and diagnostic subreason.

### Anchor

src/pipeline/verifier.ts:1114 (`findingUpdates == null` check)

### Severity floor

The matcher floor is low. Expected severity is low; record it as a calibration note, not as a miss.

### Fixing evidence

6f43d71 requires a non-empty plain object. Its regression tests for `{}` and `[]` fail at the intro.
