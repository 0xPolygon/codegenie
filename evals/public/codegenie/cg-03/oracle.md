---
repo: codegenie
case: cg-03
role: positive
intro: 285c014b6f6f7ab52eab656712af9d64ffde4d48
base: 644608d547ad4d1442b24acd55c11c00b9ba02a8
introDate: 2026-11-20
fix: 3d669571d7ac53137922c61f1940837fcc4497f8
kind: security/redaction
severity: medium
pr: 108
---

# codegenie cg-03

Review base `644608d547ad4d1442b24acd55c11c00b9ba02a8` (the parent) against head `285c014b6f6f7ab52eab656712af9d64ffde4d48`. The head exists only on `refs/pull/108/head` because the PR was squash-merged; fetch it by SHA.

## Expectation `schema-invalid-reason-redaction`

### Expected finding

The new schema-invalid reason recorded on model calls is the validator or semantic-validation message, truncated but not passed through credential redaction. Composition validation details echo model-supplied unknown references, so a credential the model writes into a submission can be persisted in model-call records. Truncating before redaction can also leave a partial key that the redaction patterns no longer match.

### Anchor

src/llm/pi-runner.ts:3439 (`truncateDiagnostic(withoutRejectedArguments(...))` without `stripCredentials`); recorded as `errorMessage` around line 1679

### Severity floor

The matcher floor is low. Expected severity is medium; record it as a calibration note, not as a miss.

### Fixing evidence

3d66957 redacts the recorded reason before capping it and stops composition diagnostics echoing unknown references. Two regression tests (redaction and cap, no echo of unknown references) fail at the intro.

