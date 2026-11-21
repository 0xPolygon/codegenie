---
repo: codegenie
case: cg-02
role: positive
intro: 91c96b94f6797a03a048e91609e9dbd7c9ee59fe
base: 6e1318f5397c925c54d29c07677be47cf48c6b2e
introDate: 2026-07-03
fix: 98633d8e813194f6bc8dd800670b459dd9b8069c
kind: data-integrity
severity: medium
pr: 5
---

# codegenie cg-02

Review base `6e1318f5397c925c54d29c07677be47cf48c6b2e` (the parent) against head `91c96b94f6797a03a048e91609e9dbd7c9ee59fe`. The head exists only on `refs/pull/5/head` because the PR was squash-merged; fetch it by SHA.

## Expectation `ensemble-pass-pooling`

### Expected finding

`runLensPackets` pairs the outcomes from `workerRunner.schedule()` with `passPlan` entries by array index. `schedule()` returns outcomes in dispatch order, sorted by priority and coverage, not input order. With `deepEnsemblePasses` above 1, pass results are therefore pooled into the wrong packets: candidates, statuses, hints and ensemble attribution are attached to packets that did not produce them.

### Anchor

src/pipeline/lens-runner.ts:123-131 (`passPlan.forEach((entry, index) => passResults[index] ...)`)

### Severity floor

The matcher floor is low. Expected severity is medium; record it as a calibration note, not as a miss.

### Fixing evidence

98633d8 tags each task with its packet and ensemble pass and groups outcomes by `outcome.task` instead of position. Its regression test reorders dispatch on purpose and fails with positional grouping. The defect was also observed in a live eval run.
