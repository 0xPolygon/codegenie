---
repo: pi
case: pi-07
role: compatibility-question
intro: 4d9aa837c2ec6e0ebc7599f7e724c7c19c06441e
base: 47b5119d09f00cb785409d53d74c4950acc7d803
introDate: 2026-08-12
fix: 541045ae0e30ac0375fde429f8a8baa057c009db
kind: compatibility/tool-allowlist
contaminationSplit: post-2026-08-01
---

# pi pi-07

Review base `47b5119d09f00cb785409d53d74c4950acc7d803` (the parent) against head `4d9aa837c2ec6e0ebc7599f7e724c7c19c06441e`.

## Compatibility question `default-tools-disables-extension-tools`

When `defaultTools` is set and the caller passes neither `tools` nor `noTools`, should that setting exclude registered extension and custom tools absent from the list, or only select the initial built-ins? At head it feeds `allowedToolNames`, so registered tools absent from the list are disabled. At base that allowlist was undefined for the comparable session without an explicit tools override.

### Source and credit

Use `packages/coding-agent/src/core/sdk.ts:248-250` and the filtering of registered tools in `agent-session.ts`. Credit a source-adjudicated question only if it names this configuration and the effect on registered extension or custom tools, and asks whether the broader allowlist is intended. A question about initial built-in selection alone lacks the compatibility consequence.

The same-change `packages/coding-agent/docs/settings.md` explicitly describes the setting as an allowlist that applies to built-in, extension, and custom tools. Its test calls it the initial tool allowlist. Separate question credit from confirmed defects and clean controls.

### Later contract

541045ae0 removes the setting from `allowedToolNames`, describes it as initial built-in selection, and adds extension-tool tests. That later change establishes the later contract. The introducing commit documents and implements the broader behavior.
