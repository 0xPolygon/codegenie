# Issue 34: Run-Level Tool Result Memoization

Status: PENDING
Planned from: trails-api eval run 6 review and Opus 4.8 notes, 2026-06-16
Planned at: commit `506fa43`

## Problem

Stage 7 and Stage 9 workers repeat deterministic repository reads across packets. Opus 4.8 reported that 142 of 482 tool calls in run 6 were exact repeats by tool name and arguments. Examples included repeated `find_definition` and `read_symbol` calls for the same symbols.

This is duplicated local work. It does not directly reduce LLM tokens, because the model still receives the tool result in its conversation, but it can reduce repository IO, tree-sitter parsing, ripgrep work, debug noise, and wall-clock latency under parallel workers.

## Current State

Relevant files:

- `src/llm/tool-definitions.ts` exposes read-only repository tools to the LLM.
- `src/llm/pi-runner.ts` validates and executes tool calls.
- `src/pipeline/lens-runner.ts` builds repository tool definitions per packet review.
- `src/pipeline/verifier.ts` also uses repository tools.
- `tests/phase4-llm.test.ts` contains most LLM/tool interaction tests.
- `tests/telemetry.test.ts` covers aggregate tool telemetry.

Current execution path:

```ts
// src/pipeline/lens-runner.ts:114-128
const repositoryTools = packet.reviewProfile === "simple" || packet.toolBudget.maxToolCalls <= 0
  ? []
  : buildRepositoryToolDefinitions(tools);
const submitted = await opts.runner.runStructured({
  stage: 7,
  ...
  tools: repositoryTools,
  toolBudget: packet.toolBudget
});
```

```ts
// src/llm/pi-runner.ts:310-315
const outcome =
  localBudgetReason !== undefined && extensionDecision?.status !== "granted"
    ? rejectedToolOutcome(...)
    : tool
      ? await executeToolCall(adapter, repositoryTools, tool, toolCall, taskTimeout.signal, taskTimeout.timedOut)
      : rejectedToolOutcome(...);
```

```ts
// src/llm/pi-runner.ts:858-877
async function executeToolCall(...) {
  const args = adapter.validateToolCall(tools.map(toolSpec), toolCall) as Record<string, unknown>;
  const result = await tool.execute(args, taskSignal);
  return { result, status: ..., args, durationMs: Date.now() - startedAt };
}
```

Because `buildRepositoryToolDefinitions(tools)` is called for each packet, any memoization placed inside that call would likely be packet-local and would not eliminate cross-worker repeats. The cache needs to be run-level and shared across Stage 7/8/9 tool calls.

## Desired Behavior

For deterministic read-only repository tools, codeninja should reuse identical tool results within a single review run:

- same tool name
- same normalized validated arguments
- same repository revision context for the run
- same tool implementation/version

The model should still see the same tool result text. Local tool budgets should still count the model's tool call and result characters, because the conversation still grows. The memoization is for backend work, not for LLM context accounting.

## Plan

1. Add a run-level tool result cache.
   - Create a small in-memory cache type, for example `ToolResultCache`.
   - Store entries by stable key:
     - tool name
     - canonical JSON of validated args, with undefined omitted and object keys sorted
     - a cache schema/version string
     - optional run/repository fingerprint if already available in the runner options
   - Keep the cache per review run only. Do not persist it across runs in the first implementation.
   - Add a bounded size policy:
     - max entries
     - max stored result chars
     - simple LRU eviction is enough

2. Place the cache at the runner/tool execution boundary.
   - Prefer adding an optional `toolResultCache` to `CreateRunnerOptions` and using it inside `executeToolCall` after tool-call validation.
   - This gives the cache access to normalized validated args and avoids caching invalid tool-call arguments.
   - Ensure one shared cache instance is passed to Stage 7, Stage 8, and Stage 9 runner usage for a single pipeline run.
   - Do not put the only cache inside `buildRepositoryToolDefinitions`, because tool definitions are rebuilt per packet and would not share state across workers unless explicitly wired.

3. Cache only safe deterministic outcomes first.
   - Cache successful read-only tool results for:
     - `read_range`
     - `read_file_outline`
     - `read_symbol`
     - `find_definition`
     - `read_diff_blocks`
     - `search_files`
     - `find_symbol_mentions`
     - `find_likely_tests`
     - `list_files`
   - Do not cache:
     - rejected calls from local budget checks
     - path containment/security rejections
     - calls aborted by timeout or cancellation
     - unknown tool calls
   - Start by caching only `status: "ok"` outcomes. If caching deterministic not-found errors is later useful, add it deliberately with tests.

4. Handle concurrent identical requests.
   - Use an in-flight map so two workers requesting the same key concurrently share one backend execution.
   - The first worker executes the tool.
   - Later workers await the same promise.
   - If the backend execution fails or is aborted, do not poison the cache.

5. Preserve telemetry semantics.
   - Still call `recordToolCall` for every model-requested tool call, because from the LLM conversation perspective the tool call happened.
   - Add fields to tool call records or debug artifacts:
     - `cacheStatus: "hit" | "miss" | "write" | "disabled"`
     - `backendExecuted: boolean`
   - Add aggregate run metrics:
     - `toolResultCache.hits`
     - `toolResultCache.misses`
     - `toolResultCache.writes`
     - `toolResultCache.inflightHits`
     - `toolResultCache.evictions`
     - `toolResultCache.savedBackendCalls`
   - Keep context-pressure and local tool-budget accounting based on the delivered result text, not on whether the backend was cached.

6. Add tests.
   - In `tests/phase4-llm.test.ts`, create two structured requests that call the same repository tool with identical args using the same runner.
   - Assert the underlying `tool.execute` function runs once while telemetry records two model tool calls.
   - Add a concurrent/in-flight test where two requests overlap and share one execution promise.
   - Add a non-cacheable rejection/error test.
   - Add a test that different source selectors or different line ranges produce different cache keys.
   - Add telemetry tests for hit/miss/write counters and saved backend calls.

7. Evaluate run-level impact.
   - After implementation, compare a large eval run against run 6:
     - total tool calls may stay similar.
     - backend executions should drop.
     - repeated `find_definition` and `read_symbol` backend work should drop.
     - wall-clock time should improve, especially under higher concurrency.

## Opus 4.8 Comparison

This plan directly addresses Opus's duplicated-effort finding:

- repeated exact tool calls across workers are real.
- `find_definition` and `read_symbol` are high-value targets.
- memoization should be run-level and shared across workers.

The plan is careful not to overclaim cost savings. It should reduce local backend work and latency, but it will not reduce LLM input tokens unless paired with prompt/tool-result summarization work.

## Likely Files

- `src/llm/pi-runner.ts`
- `src/llm/llm-runner.ts`
- `src/llm/tool-definitions.ts`
- `src/pipeline/pipeline.ts` or wherever the single runner/cache instance is created
- `src/telemetry/run-artifacts.ts`
- `src/types.ts`
- `tests/phase4-llm.test.ts`
- `tests/telemetry.test.ts`

## Verification Commands

- `pnpm test -- tests/phase4-llm.test.ts`
- `pnpm test -- tests/telemetry.test.ts`
- `pnpm run build`

Expected result: all commands exit 0.

## Acceptance Criteria

- Identical deterministic tool calls within one run reuse one backend result.
- Concurrent identical tool calls coalesce in flight.
- Every model-requested tool call is still recorded in telemetry.
- Tool-budget and result-character accounting remain unchanged from the model's perspective.
- Security rejections, budget rejections, unknown tools, and aborted calls are not cached.
- Run artifacts expose tool-result cache hit/write/saved-call metrics.

## Stop Conditions

- Stop if the only feasible implementation would persist tool results across runs.
- Stop if caching would bypass path containment validation.
- Stop if memoization changes delivered tool text or local tool-budget behavior.
- Stop if adding the cache requires broad changes to repository tool APIs instead of a small runner-level wrapper.
