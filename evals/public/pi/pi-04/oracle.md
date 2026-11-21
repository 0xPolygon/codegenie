---
repo: pi
case: pi-04
role: spare
intro: 80c918c2478c0e48a6f1773668f3bef82518ff0f
base: 0b54c87e24ba94b0a2ac43501959fd35c48deb1b
introDate: 2026-05-15
fix: 1dac099022e764c0d400495597f688f7224ac2ee
kind: logic
severity: medium
contaminationSplit: pre-2026-08-01
---

# pi pi-04

Review base `0b54c87e24ba94b0a2ac43501959fd35c48deb1b` (the parent) against head `80c918c2478c0e48a6f1773668f3bef82518ff0f`.

## Expectation `short-ids-from-uuidv7-timestamp`

### Expected finding

Short entry IDs are the first 8 characters of a UUIDv7. Those characters are the timestamp and are nearly constant between calls, so the 100 attempts collide and the function falls back to a full UUID, defeating short IDs.

### Anchor

packages/agent/src/harness/session/jsonl-storage.ts:36 and memory-storage.ts:24

### Severity floor

The matcher floor is low. Expected severity is medium; record it as a calibration note, not as a miss.

### Fixing evidence

1dac09902 says "Regression from 80c918c2 which replaced randomUUID with uuidv7". It adds no test.

