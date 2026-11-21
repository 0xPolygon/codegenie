---
repo: codegenie
case: cg-08
role: positive
intro: 57755e3a6472f170e3a8308ebab6a29c32628446
base: 1533cc22070da080fc3c6d564d8cd68ed46e322f
introDate: 2026-11-19
fix: bdaebe14cb8ec4d0de2b63b4efec02eed413412d
kind: logic
severity: low
pr: 89
---

# codegenie cg-08

Review base `1533cc22070da080fc3c6d564d8cd68ed46e322f` (the parent) against head `57755e3a6472f170e3a8308ebab6a29c32628446`. The head exists only on `refs/pull/89/head` because the PR was squash-merged; fetch it by SHA.

## Expectation `skip-disclosure-truncated-before-dedupe`

### Expected finding

Planner skips are recorded per hunk, so a file whose hunks share a skip reason adds the same `path: reason` entry several times. The list is cut to ten before deduplication. Repeats can therefore use the whole ten-entry disclosure and hide other skipped paths and reasons from the coverage report.

### Anchor

src/pipeline/review-runner.ts:1045-1051 (`skipped.slice(0, 10)` before deduplication)

### Severity floor

The matcher floor is low. Expected severity is low; record it as a calibration note, not as a miss.

### Fixing evidence

bdaebe1 deduplicates the strings before the limit. Its regression test, ten identical skips plus one other file, expects the other file to be disclosed, and fails at the intro.

