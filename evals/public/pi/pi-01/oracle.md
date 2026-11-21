---
repo: pi
case: pi-01
role: positive
intro: c4cf7957b4e6698a182925f4393240c1e3b23f41
base: 6085986e4b4a55a36a872df9e438e1a55ffcba35
introDate: 2026-10-16
fix: 790271cd0218b27068211771704f9e2d42500e9a
kind: api-contract
severity: low
contaminationSplit: post-2026-08-01
---

# pi pi-01

Review base `6085986e4b4a55a36a872df9e438e1a55ffcba35` (the parent) against head `c4cf7957b4e6698a182925f4393240c1e3b23f41`.

## Expectation `silent-revert-terminate-type`

### Expected finding

The change narrows `ToolControl.terminate` from `boolean` back to the literal `true`, so a tool that returns `terminate: false` no longer type-checks. It also deletes the regression test "does not terminate on terminate: false" and the matching changelog entries. All of this undoes the parent commit and is unrelated to the commit's stated purpose of per-model compaction settings; the diff contains no compaction code at all.

### Anchor

packages/durable/src/harness/types.ts:139. Also acceptable: the deleted test (packages/durable/test/harness-tools.test.ts, base lines 676-692), or a report that the commit silently reverts the previous fix. Do not credit a remark only about README or changelog wording.

### Severity floor

The matcher floor is low. Expected severity is low; record it as a calibration note, not as a miss.

### Fixing evidence

790271cd0 says the intro "was built from a tree that predates 6085986e4 and reverted its terminate type change, regression test, and changelog entries", and restores them.
