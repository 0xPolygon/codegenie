# Issue 7: Token Telemetry

Status: COMPLETE

## Problem

The trails-api run reported `inputTokens: 496` for 248 Anthropic calls while `totalTokens` was about 4.85M. This is technically explainable by Anthropic prompt caching, but misleading: `input` counted only uncached input tokens, while `cacheRead` and `cacheWrite` carried most prompt volume and cost.

The telemetry should make provider usage understandable without knowing provider-specific accounting details.

## Plan

1. Extend `LlmCallRecord` token fields:
   - `inputTokens`
   - `outputTokens`
   - `totalTokens`
   - `cacheReadTokens`
   - `cacheWriteTokens`
   - `uncachedInputTokens`
   - `billableInputTokens` if available from Pi/provider usage.
   - `usageProvider` / `usageRaw` in debug artifacts.

2. Normalize provider usage in `pi-runner`:
   - Map Anthropic `usage.input`, `usage.output`, `usage.cacheRead`, `usage.cacheWrite`, and `usage.totalTokens`.
   - Keep `inputTokens` as "effective prompt tokens" only if we define it that way consistently, or rename the current provider field to `uncachedInputTokens`.
   - Prefer explicit names over derived ambiguity.

3. Update aggregate telemetry:
   - `model-calls-summary.json`
   - `cost-profile.json`
   - `telemetry.json`
   - `run.json.totals`
   - Include cache token totals by stage and overall.

4. Update reporting:
   - If prompt caching is present, show cost and token summaries as:
     - uncached input
     - cache read
     - cache write
     - output
     - total provider tokens
   - Do not present tiny uncached input counts as total prompt volume.

5. Update eval budget metrics:
   - Preserve existing `totalTokens` budget behavior.
   - Add optional eval budget checks for `cacheReadTokens`, `cacheWriteTokens`, and `outputTokens` only if useful.

## Tests

- Anthropic fake usage maps cache tokens into the new fields.
- Summary aggregation includes cache read/write by stage.
- Backward-compatible handling when a provider has no cache fields.
- Cost profile snapshot/golden test for a mixed cached/uncached run.

## Acceptance Criteria

- A run with Anthropic prompt caching no longer appears to have near-zero input usage.
- Total cost, total tokens, cache tokens, and output tokens reconcile across per-call and summary artifacts.
- Existing tests and eval scoring remain compatible.
