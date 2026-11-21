---
repo: pi
case: pi-05
role: positive
intro: 871a99047944f060b85a30c7d5b6add89685c9a8
base: bd2cfabc5f886447eb7ae9193cc9f87e85a52390
introDate: 2026-07-30
fix: 9cde1725d7ca51d0fe06e03f89a87000a18abf36
kind: concurrency
severity: medium
contaminationSplit: pre-2026-08-01
---

# pi pi-05

Review base `bd2cfabc5f886447eb7ae9193cc9f87e85a52390` (the parent) against head `871a99047944f060b85a30c7d5b6add89685c9a8`.

## Expectation `waitforidle-waits-for-mutations`

### Expected finding

The refactor puts the active operation and the session mutations (`appendMessage`, `setModel`, `setThinkingLevel`, `setTools`, `setActiveTools`) into one `activeTasks` set, and `waitForIdle` now awaits all of them; on base it awaited only the active operation. `waitForIdle` therefore no longer resolves while a mutation is still pending. That changes its public meaning and can stall a caller that waits for idle while a write is in flight.

### Anchor

packages/agent/src/harness/agent-harness.ts:1139-1141. Related lines: the shared set at 181 and the track helper at 354-368 (optional expectation). Do not credit a remark only that shutdown now relies on waitForIdle (line 1105); that is equivalent to base.

### Severity floor

The matcher floor is low. Expected severity is medium; record it as a calibration note, not as a miss.

### Fixing evidence

9cde1725d gives tasks a kind and adds the test "does not treat concurrent mutations as active operations", written for this behaviour (not run by us).

## Expectation `waitforidle-shared-task-set` (optional)

### Expected finding

The same defect as the required expectation, anchored at the shared task-tracking helper. Count a hit here as the same detection after adjudication.

### Anchor

packages/agent/src/harness/agent-harness.ts:354-368 (track helper); the set is declared at 181.

### Severity floor

The matcher floor is low. Expected severity is medium; record it as a calibration note, not as a miss.

### Fixing evidence

Same fix as the required expectation.

