---
repo: codegenie
case: cg-05
role: positive
intro: 3e7a960cda68366c66dd1ec469063d309f7b9cb7
base: 51e8625293b8792f1ccdd31d82f5d5f3d2af332f
introDate: 2026-11-20
fix: 67079caf62802c37d1afa8f3eb793e4f7eb54e09
kind: security/redaction
severity: medium
pr: 109
---

# codegenie cg-05

Review base `51e8625293b8792f1ccdd31d82f5d5f3d2af332f` (the parent) against head `3e7a960cda68366c66dd1ec469063d309f7b9cb7`. The head exists only on `refs/pull/109/head` because the PR was squash-merged; fetch it by SHA.

## Expectation `replay-signature-cache-credentials`

### Expected finding

The model-call cache now writes `redactStoredResponseForReplay(entry)` instead of a credential-stripped entry. That deliberately leaves bare signatures and envelope opaque fields unredacted. The only guard is `hasRedactedReplaySignature`, which looks for `[redacted]` markers, not credentials. A thinking, text or tool-call signature containing a registered secret or credential-shaped token is therefore written to the on-disk cache in plain text and accepted again on read. This breaks the cache's redaction invariant.

### Anchor

src/llm/model-call-cache.ts:101-102 (`put` gates only on `hasRedactedReplaySignature`); src/llm/assistant-replay.ts:22 and :47

### Severity floor

The matcher floor is low. Expected severity is medium; record it as a calibration note, not as a miss.

### Fixing evidence

67079ca rejects, on both put and get, any replay signature that credential stripping would change, including inside decoded envelopes. Its regression test expects a put miss with no credential on disk and eviction of a legacy entry, and fails at the intro.
