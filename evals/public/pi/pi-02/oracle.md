---
repo: pi
case: pi-02
role: positive
intro: d850edee9ccc5d3b6cec79553d4839a1cbab47ed
base: 7a11fe1c723b942fa093edb8b00f051ddb9b6627
introDate: 2026-09-30
fix: c5f5b3282d5e4203c085e59837ba17aeaf2829b5
kind: security
severity: high
contaminationSplit: post-2026-08-01
---

# pi pi-02

Review base `7a11fe1c723b942fa093edb8b00f051ddb9b6627` (the parent) against head `d850edee9ccc5d3b6cec79553d4839a1cbab47ed`.

## Expectation `issuer-check-skipped-without-metadata`

### Expected finding

The new RFC 9207 issuer check is wrapped in `if (metadata && ...)`. When no authorization-server metadata was discovered there is no issuer to compare with, so the check is skipped and an authorization response carrying any `iss` is accepted. The code is then exchanged at `discovered.authorizationServerUrl`, so a code issued by another authorization server can be sent to this one (a mix-up attack). The check should reject a response that carries `iss` when there is no metadata.

### Anchor

packages/mcp/src/oauth/flow.ts:326-328. Do not credit findings about trusting the configured metadata URL or about discovery caching.

### Severity floor

The matcher floor is low. Expected severity is high; record it as a calibration note, not as a miss.

### Fixing evidence

c5f5b3282 removes the `metadata &&` guard, rejects in that case and changes the tests. Its message describes the attack and credits an external reporter.

