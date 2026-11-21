---
repo: pi
case: pi-07
role: positive
intro: 4d9aa837c2ec6e0ebc7599f7e724c7c19c06441e
base: 47b5119d09f00cb785409d53d74c4950acc7d803
introDate: 2026-08-12
fix: 541045ae0e30ac0375fde429f8a8baa057c009db
kind: logic
severity: medium
contaminationSplit: post-2026-08-01
---

# pi pi-07

Review base `47b5119d09f00cb785409d53d74c4950acc7d803` (the parent) against head `4d9aa837c2ec6e0ebc7599f7e724c7c19c06441e`.

## Expectation `default-tools-disables-extension-tools`

### Expected finding

When the `defaultTools` setting is configured and the caller passes neither `tools` nor `noTools`, `allowedToolNames` becomes the configured list. `allowedToolNames` is the allowlist for every tool, so extension and custom tools not in the list are disabled; on base the allowlist was undefined in that situation and they stayed enabled. The setting should only choose the initial built-in tools.

### Anchor

packages/coding-agent/src/core/sdk.ts:248-250. Do not credit findings only about initialActiveToolNames (lines 253-255), which is the intended use of the setting.

### Severity floor

The matcher floor is low. Expected severity is medium; record it as a calibration note, not as a miss.

### Fixing evidence

541045ae0 removes the setting from `allowedToolNames`, rewrites the doc comment to say "initial built-in selection", and adds extension-tool tests.
