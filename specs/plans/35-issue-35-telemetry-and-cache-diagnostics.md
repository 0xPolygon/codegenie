# Issue 35: Telemetry and Cache Diagnostics

Status: COMPLETE
Planned from: trails-api eval run 6 review and Opus 4.8 notes, 2026-06-16
Planned at: commit `506fa43`

## Problem

Several eval/debug signals are currently too easy to misread. This plan bundles the observability fixes because they share the same purpose: make review runs explain what happened without inflating the core review workflow.

The confirmed issues are:

- Local model-call cache writes are double-counted in run summaries.
- Miss-then-write cache calls are hard to interpret because `miss` and `write` are treated like mutually exclusive statuses.
- Some early/skipped stages do not emit consistent lifecycle events.
- Repeated eval runs can show zero local model-call cache hits, but the current artifacts do not make it easy to tell whether that is expected semantic cache invalidation or accidental key volatility.

This plan is diagnostic and accounting work. It should not change review quality policy, packet construction, verifier behavior, or cache key semantics unless a volatility bug is proven.

## Current State

Relevant files:

- `src/telemetry/run-artifacts.ts` builds run summaries, stage summaries, and cache counters.
- `src/llm/pi-runner.ts` emits model-call records and builds canonical local model-call cache keys.
- `src/llm/model-call-cache.ts` emits local model-call cache hit/miss/write events.
- `src/pipeline/review-runner.ts` orchestrates stages 1-10.
- `src/evals/eval-scoring.ts`, `src/evals/eval-command.ts`, and `src/evals/eval-compare.ts` read cache metrics for eval output.
- `tests/telemetry.test.ts`, `tests/phase4-llm.test.ts`, and `tests/evals.test.ts` cover the relevant telemetry surfaces.

Current double-count source:

```ts
// src/telemetry/run-artifacts.ts:659-673
private updateModelSummary(record: LlmCallRecord): void {
  const providerCallCount = record.cacheStatus === "hit" ? 0 : 1;
  ...
  this.modelSummary.cache[record.cacheStatus] += 1;
}
```

```ts
// src/telemetry/run-artifacts.ts:799-808
private updateModelSummaryFromCacheEvent(event: TelemetryEvent): void {
  if (event.cacheStatus !== "write" || event.message !== "model_call_cache_write") {
    return;
  }
  this.modelSummary.cache.write += 1;
  ...
  bucket.cache.write += 1;
}
```

Stage lifecycle gap:

```ts
// src/pipeline/review-runner.ts:107-139
const resolved = await resolveInput(input, config, run.telemetry, repoRoot, overrides);
const diff = parseDiff(resolved.rawDiff);
...
const fileFacts = await classifyChangedFiles(resolved, kept, decisions, config, run.telemetry);
```

Stages 1, 2, and 3 currently do important work in `review-runner.ts` without the same `stage_started` / `stage_completed` pair used by later stages. Stage 8 emits lifecycle events when targeted system review runs, but the no-task path returns a direct empty result and should emit an explicit skipped/completed lifecycle.

Local model-call cache keying includes the run fingerprint:

```ts
// src/llm/pi-runner.ts:420-444
const canonicalRequest = canonicalModelRequest({
  cacheSchemaVersion: MODEL_CALL_CACHE_SCHEMA_VERSION,
  runFingerprint: opts.cache?.runFingerprint ?? null,
  ...
  messages,
  tools
});
const cacheKey = buildModelCallCacheKey(canonicalRequest);
```

The fingerprint is useful only if it is stable for identical eval inputs and changes for semantic inputs. If it includes volatile data like run id, timestamps, debug directories, or unstable ordering, cross-run hit rate will be poor.

## Plan

1. Fix local model-call cache counter semantics.
   - Define counters as:
     - `hit`: cached model response replayed; provider call was not made.
     - `miss`: local cache lookup did not replay a response.
     - `write`: provider response was persisted after a miss.
     - `disabled`: local model-call cache was disabled.
   - Make it explicit that one call can be both a miss and a write.
   - Pick one authoritative source for cache counts.
   - Do not leave both model-call records and `model_call_cache_write` events incrementing the same write bucket.
   - Keep provider prompt-cache read/write tokens and costs separate from local model-call cache counters.

2. Update eval readers and compatibility aliases.
   - Update `src/evals/eval-scoring.ts`, `src/evals/eval-command.ts`, and `src/evals/eval-compare.ts` to read corrected local model-call cache fields.
   - Keep fallbacks for older artifacts.
   - Keep output labels explicit: `local model-call cache`, not generic `cache`.

3. Add complete stage lifecycle events.
   - Add lifecycle events for Stage 1 input resolution:
     - start before `resolveInput(...)`
     - complete after `resolved-input.json` is written
   - Add lifecycle events for Stage 2 diff parsing/filtering:
     - start before `parseDiff(...)`
     - complete after file filter decisions are written
   - Add lifecycle events for Stage 3 file classification:
     - start before `classifyChangedFiles(...)`
     - complete after `file-facts.json` is written
   - Add explicit Stage 8 skipped/completed events when there are no targeted system review tasks.
   - Do not log raw PR bodies, prompts, tool output, credentials, or secrets.

4. Add cache hit-rate diagnostics without changing key behavior first.
   - For local cache misses, emit debug metadata that explains key components without exposing prompts:
     - stage
     - model-call kind
     - template version
     - prompt hash/chars
     - tool budget hash
     - tool spec hash
     - run fingerprint hash
     - cache key prefix
     - miss reason when known
   - In debug mode, write a small cache-key component artifact so two eval runs can be compared.
   - Do not log raw prompts, tool results, PR text, credentials, or API keys.

5. Audit run fingerprint stability.
   - Inspect `reviewCacheFingerprint(...)` in `src/pipeline/review-runner.ts`.
   - Keep semantic inputs in the fingerprint:
     - diff/target
     - model/provider/reasoning
     - skills/lenses
     - relevant review config
   - Remove or normalize volatile non-semantic inputs if found:
     - run id
     - timestamp
     - telemetry/debug/eval log directory
     - object ordering that can vary
   - Do not remove model-visible prompt/tool/schema inputs from cache keys.

6. Add tests.
   - Cache miss-then-write reports one miss and one write, not a doubled write.
   - Cache hit reports no provider call.
   - Cache disabled reports disabled without miss/write confusion.
   - Eval output reads corrected local cache fields.
   - Stage lifecycle summary includes stages 1, 2, 3, and skipped Stage 8.
   - Identical eval inputs produce stable cache-key component hashes.
   - Changing semantic inputs changes cache keys.
   - Changing telemetry/debug output directories does not change cache keys.

## Opus 4.8 Comparison

This bundle covers the overlapping observability findings from the combined reviews:

- Opus's exact cache double-count root cause.
- ChatGPT's lifecycle tracing gap.
- Opus's local model-call cache hit-rate concern.

They are bundled because the implementation surfaces are the same telemetry/eval layers, and because fixing counters before investigating hit rate avoids chasing bad data.

## Likely Files

- `src/telemetry/run-artifacts.ts`
- `src/llm/pi-runner.ts`
- `src/llm/model-call-cache.ts`
- `src/pipeline/review-runner.ts`
- `src/evals/eval-scoring.ts`
- `src/evals/eval-command.ts`
- `src/evals/eval-compare.ts`
- `tests/telemetry.test.ts`
- `tests/phase4-llm.test.ts`
- `tests/evals.test.ts`
- `README.md` only if public terminology changes

## Verification Commands

- `pnpm test -- tests/telemetry.test.ts`
- `pnpm test -- tests/phase4-llm.test.ts`
- `pnpm test -- tests/evals.test.ts`
- `pnpm run build`

Expected result: all commands exit 0.

## Acceptance Criteria

- Cache write counts are not doubled.
- Miss-then-write behavior is represented clearly.
- Provider prompt-cache metrics remain separate from local model-call cache metrics.
- Stages 1, 2, 3, and skipped Stage 8 produce lifecycle telemetry.
- Cache miss diagnostics explain which key component changed without exposing sensitive content.
- Historical eval artifacts remain readable through compatibility fallbacks.

## Stop Conditions

- Stop if fixing counters requires changing model-call cache key generation.
- Stop if hit-rate improvements would require ignoring model-visible prompt/tool/schema changes.
- Stop if diagnostics would log raw prompts, tool outputs, PR body, credentials, or secrets.
- Stop if lifecycle events require reordering pipeline stages.
