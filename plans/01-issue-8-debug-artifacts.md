# Issue 8: Debug Artifacts

## Problem

Real-run debugging needs more than model-call summaries. The current `debug/llm-calls/*.json` artifacts preserve provider responses and usage, but they do not reliably preserve the full redacted request context needed to reconstruct what the model saw: messages, system prompt, tool schemas, tool-choice mode, prior tool calls, and tool results.

This makes eval failure analysis harder because we cannot answer whether a missed finding came from prompt content, packet construction, tool output, provider behavior, or schema validation.

## Plan

1. Add a redacted request artifact format for every provider call:
   - `debug/llm-calls/<call-id>.request.json`
   - `debug/llm-calls/<call-id>.response.json` or keep response in the existing file with a clear schema version.
   - Include `stage`, `role`, `kind`, `packetId`, `candidateId`, `promptTemplateVersion`, `skill/lens ids`, `provider`, `model`, `reasoning`, `toolChoice`, and `toolBudget`.

2. Persist the full message list after redaction:
   - System/developer/user/assistant/tool-result messages.
   - Tool call ids and names.
   - Tool result status, metadata, truncation/degradation flags, and result text when debug trace is enabled.
   - Preserve message order exactly as sent to Pi.

3. Persist provider-facing tool definitions:
   - Tool names, descriptions, and normalized provider schemas.
   - Store a `schemaHash` and optionally full schemas when `debugTrace` is enabled.
   - Include both the local TypeBox schema hash and provider-normalized schema hash so provider/schema issues are debuggable.

4. Redaction rules:
   - Reuse the existing redaction utility path.
   - Redact common secret patterns in prompt text, tool outputs, paths where needed, env vars, URLs with credentials, tokens, private keys, and auth headers.
   - Add a `redaction.applied` summary with counts by rule, not the removed values.

5. Add artifact limits:
   - Default on only when `debugTrace` is true.
   - Cap per-call debug artifact size and emit `debug_artifact_truncated` telemetry if exceeded.
   - Never block the review on debug artifact write failure; emit a warn event.

## Tests

- Unit test that `recordModelCall` writes request and response artifacts with schema version and stable ids.
- Redaction test with fake secrets in prompts and tool results.
- Tool transcript test showing model -> tool -> model call reconstruction across multiple calls.
- Size-limit test that truncates debug artifacts and emits telemetry.

## Acceptance Criteria

- Given a run directory, an evaluator can reconstruct the exact redacted model conversation for any call.
- Provider schema failures include the provider-facing schema and request shape needed to debug them.
- Debug artifacts are safe by default and only verbose when debug tracing is enabled.
