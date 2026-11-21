---
repo: codegenie
case: cg-06
role: positive
intro: f6a37ee054afdfbd1b84183162e6050bbffaa870
base: 86f90c90d443d4f8f628b1ce375a7d9fde954c37
introDate: 2026-11-21
fix: 805d3b87191468880d44cfb034d142168c5d80ef
kind: data-integrity
severity: low
pr: 132
---

# codegenie cg-06

Review base `86f90c90d443d4f8f628b1ce375a7d9fde954c37` (the parent) against head `f6a37ee054afdfbd1b84183162e6050bbffaa870`. The head exists only on `refs/pull/132/head` because the PR was squash-merged; fetch it by SHA.

## Expectation `published-caveats-dropped`

### Expected finding

Removing the original-assessments block from published findings also drops caveats that were only published there: secondary proof assumptions, legacy verification text with no structured proof, and unresolved-reconciliation sources. When the model-written verification section omits them, a published finding can read as unconditionally proven. With telemetry off, the originals are not retained anywhere.

### Anchor

src/pipeline/composition-content.ts:230-238 (Open conditions lists only unresolved proof evidence and essential assumptions; the body no longer carries provenance)

### Severity floor

The matcher floor is low. Expected severity is low; record it as a calibration note, not as a miss.

### Fixing evidence

805d3b8 renders secondary assumptions under Open conditions and adds a recorded-verification block for legacy and unresolved verification text. Its regression test, which checks that proof and caveats survive composed text that erases them, fails at the intro.
