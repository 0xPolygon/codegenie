# Issue 15: Telemetry Cache Terminology

Status: COMPLETE

## Problem

Telemetry currently uses the word `cache` for more than one concept. For example, a run can show local response-cache counters next to provider prompt-cache token accounting:

```json
"cache": {
  "disabled": 231,
  "hit": 0,
  "miss": 0,
  "write": 0
},
"cacheReadTokens": 1730539,
"cacheWriteTokens": 2060697
```

The `cache.disabled` count refers to Codeninja's local response cache, while `cacheReadTokens` and `cacheWriteTokens` refer to provider prompt-cache accounting. Seeing local cache disabled next to provider cache usage makes it look contradictory.

This is not a review-quality bug, but it makes cost telemetry harder to reason about during evals and production tuning. The fix should be naming/schema cleanup only; it must not change cost calculations.

## Plan

Implementation note: codeninja uses `localModelCallCache` as the canonical field name instead of the earlier `localResponseCache` wording. This matches the actual cache contract: complete model-call responses keyed by normalized model request. The legacy `cache` field remains as a deprecated alias for compatibility.

1. Split cache concepts in telemetry:
   - Add `localModelCallCache` for Codeninja's own cached model-call responses.
   - Add `providerPromptCache` for provider-reported prompt-cache read/write tokens and costs.
   - Keep both in `run.json`, `telemetry.json`, `model-calls-summary.json`, and `cost-profile.json`.

2. Preserve compatibility carefully:
   - Keep the old `cache` field as a deprecated alias for local model-call cache for now.
   - Add clearer fields first; remove ambiguous aliases only in a later schema version.
   - Document which fields should be used by eval tooling.

3. Make cost profile self-explanatory:
   - Group cost into:
     - uncached input
     - provider cache read
     - provider cache write
     - output
     - total.
   - Include token counts beside each cost group.
   - Ensure `totalCostUSD` is reproducible from grouped components.

4. Improve run summaries:
   - In human-readable debug summaries, say `local cache disabled` and `provider prompt cache read/write`.
   - Avoid generic "cache disabled" wording without naming the cache layer.

5. Add regression coverage:
   - Snapshot telemetry for a model call with provider cache read/write usage and local cache disabled.
   - Assert the resulting artifact cannot be misread as contradictory.
   - Assert total cost and token totals are unchanged by the schema/naming change.

## Likely Files

- `src/telemetry/telemetry.ts`
- `src/llm/model-call-recorder.ts`
- `src/cache/*`
- `src/pipeline/run-artifacts.ts`
- `src/output/markdown-renderer.ts` if summaries mention cache
- `tests/telemetry.test.ts`
- `tests/pipeline-phase7.test.ts`

## Tests

- Model-call summary separates local model-call cache counters from provider prompt-cache tokens/cost.
- Cost profile groups provider cache read/write cost separately from uncached input and output.
- Existing artifact readers continue to work or are updated with a schema-version test.
- Human-readable debug output does not use ambiguous cache wording.
- Total cost remains bit-for-bit unchanged for the same model-call records.

## Acceptance Criteria

- A run can show local model-call cache disabled and provider prompt-cache usage without looking contradictory.
- Eval tooling can reliably compare token/cost behavior across runs.
- `totalCostUSD` remains unchanged by the naming cleanup.
- Old artifacts remain readable through the deprecated alias.
