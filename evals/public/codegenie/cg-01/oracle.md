---
repo: codegenie
case: cg-01
role: positive
intro: 8f322934e8ff5af44d7e193a84ebcfa7e4a30a81
base: 8a4c5bd1574d4c841343fae94c3cabf9cdc31ff4
introDate: 2026-11-20
fix: 7ced84c7522dbbff7020ed38b8714fa6402f686c, dd59976bcc8ccd2b79191bcbc43aa8b95e032ed5
kind: security/redaction, concurrency/timeout
severity: medium, low
pr: 119
---

# codegenie cg-01

Review base `8a4c5bd1574d4c841343fae94c3cabf9cdc31ff4` (the parent) against head `8f322934e8ff5af44d7e193a84ebcfa7e4a30a81`. The head exists only on `refs/pull/119/head` because the PR was squash-merged; fetch it by SHA.

## Expectation `auth-header-redaction`

### Expected finding

`registerModelAuth` now registers only `auth.apiKey` and the secret part of a header named exactly `Authorization` for redaction. Providers whose resolved credential lives in another header are left unregistered. Cloudflare AI Gateway is one: its key is only in `cf-aig-authorization` and `apiKey` is undefined. Before this change the provider's API-key environment variable was registered, so the change opens a credential leak. A key that the pattern-based redaction does not recognise, such as a short key, can then appear unredacted in logs, errors and run artifacts.

### Anchor

src/provider/pi-ai-models.ts:99-106 (`registerModelAuth`, the `name.toLowerCase() === "authorization"` filter)

### Severity floor

The matcher floor is low. Expected severity is medium; record it as a calibration note, not as a miss.

### Fixing evidence

7ced84c registers the secret part of every auth-resolved header value. Its regression test resolves Cloudflare AI Gateway auth with a short key held only in `cf-aig-authorization` and asserts that `stripCredentials` removes it. That test fails at the intro.

## Expectation `judge-resolution-deadline`

### Expected finding

`adapter.resolveModel` is now asynchronous because it runs the Pi auth preflight. The recommendation judge awaits it before the timeout race is created, and passes no abort signal. A hung model or auth resolution, such as a stalled OAuth refresh, therefore leaves the eval judge unbounded even though `timeoutMs` is configured. The deadline only covers the later `complete` call.

### Anchor

src/evals/recommendation-judge.ts:69 (`await adapter.resolveModel(judge)` before the deadline created at lines 76-80); the dropped signal is at src/llm/pi-runner.ts `resolveModel`

### Severity floor

The matcher floor is low. Expected severity is low; record it as a calibration note, not as a miss.

### Fixing evidence

dd59976 creates one deadline before resolution, races both `resolveModel` and `complete` against it, and threads the abort signal into model resolution. Its regression test uses a `resolveModel` that never settles and expects a timeout with an aborted signal; that test hangs at the intro.
