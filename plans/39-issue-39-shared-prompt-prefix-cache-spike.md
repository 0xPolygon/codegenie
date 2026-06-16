# Issue 39: Shared Prompt-Prefix Cache Spike

Status: PENDING
Planned from: trails-api eval run 6 review and Opus 4.8 notes, 2026-06-16
Planned at: commit `506fa43`

## Problem

Opus 4.8 observed that provider prompt-cache write cost was a large part of run 6 cost and that many Stage 7 calls share a large identical prefix: reviewer frame, tool/schema instructions, and skill projection text. If that prefix could be expressed as provider-cacheable shared context, prompt-cache read/write efficiency might improve.

This is promising but provider/Pi-dependent. Codeninja currently builds each prompt as one large string and sends it as a single user message, so it is not obvious that we can mark a shared prefix as a separate cacheable block without changing the Pi adapter interface or provider-specific options.

Treat this as an investigation/spike first, not an assumed easy win.

## Current State

Relevant files:

- `src/skills/prompt-builder.ts` builds full prompt strings.
- `src/llm/llm-runner.ts` defines the generic `PiAiAdapter.complete` interface.
- `src/llm/pi-runner.ts` sends messages to Pi.
- `src/llm/pi-runner.ts` records provider prompt-cache read/write tokens and costs.
- `tests/phase4-llm.test.ts` covers prompt hashing, local model-call cache behavior, and provider call metadata.

Current message construction:

```ts
// src/llm/pi-runner.ts:151-158
runStructured: async <T>(request: LlmStructuredRequest<T>): Promise<T> => {
  const submitTool = buildSubmitTool(request);
  ...
  const messages: ConversationMessage[] = [
    { role: "user", content: request.prompt, timestamp: 0 }
  ];
```

Current Stage 7 prompt construction includes repeated shared prefix plus per-packet blocks:

```ts
// src/skills/prompt-builder.ts:103-128
buildPacketReviewPrompt: ({ packet, skills }) => {
  const projection = projectSkills(skills, 7, options);
  const blocks = [
    fenceUntrusted(packet.prSummary, "pr-summary"),
    packet.intentText ? fenceUntrusted(packet.intentText, "declared-intent") : "",
    fenceUntrusted(renderPacket(packet), "review-packet")
  ].filter(Boolean);
  return buildPrompt(7, [
    reviewerFrame("packet review"),
    injectionInstruction(),
    "...",
    "Skill guidance:\n" + projection.text,
    ...blocks,
    "Finish by calling submit_review..."
  ], projection, blocks.length);
}
```

## Investigation Questions

Before implementing, answer these with code or provider documentation:

1. Does `@earendil-works/pi-ai` expose provider-specific prompt cache controls, cache-control blocks, or message-part metadata?
2. Can Pi accept a structured message list with a stable system/developer prefix and a per-call user payload?
3. Do the target providers bill lower write tokens when a stable prefix is isolated into a cacheable block?
4. Would changing prompt shape affect local model-call cache keys, schema validation, or tool-call behavior?
5. Can this be implemented generically without provider-specific branches leaking through the whole prompt builder?

## Plan

1. Inspect Pi capabilities.
   - Read the installed `@earendil-works/pi-ai` types and adapter APIs.
   - Look for support for:
     - system/developer/user roles
     - multipart message content
     - provider cache-control metadata
     - Anthropic/OpenAI prompt-cache hints
   - Write down what is supported in this plan file or a follow-up note before changing source.

2. Split prompt representation internally without changing behavior.
   - If Pi can support it, evolve `BuiltPrompt` from only `{ prompt: string }` toward:
     - `sharedPrefix?: string`
     - `dynamicBody: string`
     - `prompt: string` compatibility string
   - Keep the existing joined `prompt` for debug artifacts and local model-call cache hashing until tests are updated.
   - Do not change model-visible text order or wording in the first step.

3. Add adapter support only behind capability detection.
   - If the adapter/provider can accept cacheable prefix blocks, use them only when capability is present.
   - If not available, keep the current single-message behavior.
   - Do not add hard-coded provider assumptions without tests.

4. Preserve cache keys and debug visibility.
   - Update canonical model-call request hashing to include the structured prompt representation.
   - Ensure two semantically identical requests produce the same local model-call cache key.
   - Ensure prompt debug artifacts still show exactly what the model saw.
   - Record provider prompt-cache read/write tokens before and after so eval comparison can measure effect.

5. Build a small benchmark before broad rollout.
   - Use a synthetic Stage 7 workload with many packets sharing the same skills and static instructions.
   - Compare:
     - provider prompt-cache read tokens
     - provider prompt-cache write tokens
     - provider prompt-cache read/write cost
     - model-call latency
     - schema/tool behavior
   - Do not rely only on trails-api. Use at least one small deterministic fixture too.

6. Decide after the spike.
   - If Pi/provider mechanics support shared prefix caching cleanly and measurements improve cost, write a follow-up implementation plan.
   - If not, mark this plan as rejected or blocked with the reason.
   - Do not force a complex provider abstraction for a small or unproven gain.

## Opus 4.8 Comparison

This plan takes Opus's finding seriously but does not assume the implementation is simple. The shared prefix is real, and provider prompt-cache write cost was high in run 6. The uncertain part is whether Pi exposes the provider-specific primitives needed to make the shared prefix cheaper.

## Likely Files

Investigation:

- `node_modules/@earendil-works/pi-ai` type declarations
- `src/llm/llm-runner.ts`
- `src/llm/pi-runner.ts`
- `src/skills/prompt-builder.ts`

Possible follow-up implementation:

- `src/llm/pi-runner.ts`
- `src/llm/llm-runner.ts`
- `src/skills/prompt-builder.ts`
- `tests/phase4-llm.test.ts`
- `tests/phase4-skills-provider.test.ts`

## Verification Commands

For spike-only work:

- `pnpm run build`
- `pnpm test -- tests/phase4-llm.test.ts`

If implementation proceeds:

- `pnpm test`
- run one small fixture/eval with debug telemetry and compare provider prompt-cache read/write tokens.

Expected result: all commands exit 0, and measurements are recorded before deciding to ship.

## Acceptance Criteria

- The plan has a clear yes/no answer on whether Pi/provider mechanics can support shared prompt-prefix caching.
- Any implementation keeps model-visible instructions equivalent unless intentionally changed and reviewed.
- Local model-call cache keys remain deterministic.
- Debug artifacts still show the effective prompt/messages.
- Provider prompt-cache metrics prove whether the change helps.

## Stop Conditions

- Stop if Pi does not expose a safe way to express cacheable shared prompt blocks.
- Stop if the implementation requires provider-specific prompt logic scattered through the pipeline.
- Stop if cache-key determinism or debug prompt visibility gets weaker.
- Stop if measurements show no material provider prompt-cache benefit.
