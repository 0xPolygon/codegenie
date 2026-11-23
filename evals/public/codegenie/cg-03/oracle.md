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

Composition validation echoes unknown model-supplied references in an error message. The runner caps that reason before handing it to the telemetry interface as the raw model-call `errorMessage`, so that raw record can include sensitive text. The standard on-disk `model-calls.jsonl` writer applies `stripCredentials` during serialization (`src/telemetry/run-artifacts.ts:828-833,2256-2258`). It can scrub a complete recognized credential, but the earlier cap can cut the credential into a fragment the serializer no longer recognizes. Credit a report identifying the unsafe raw diagnostic or partial material surviving this redaction order. The default disk stream does not persist a complete recognized credential merely because it was present in the raw record.

### Anchor

src/llm/pi-runner.ts:3439 (`truncateDiagnostic(withoutRejectedArguments(...))` without `stripCredentials`); recorded as `errorMessage` around line 1679

### Severity floor

The matcher floor is low. Expected severity is medium; record it as a calibration note, not as a miss.

### Fixing evidence

3d66957 redacts the recorded reason before capping it and stops composition diagnostics echoing unknown references. Two regression tests (redaction and cap, no echo of unknown references) fail at the intro.
