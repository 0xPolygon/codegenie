# Issue 57: Resolve Call-Site Context Hints To Callers

Status: PENDING
Planned from: trails-api `49f4645b` eval review, 2026-06-17
Recommended priority: high, before Issue 56, because it is deterministic context retrieval that review-question answers will depend on

## Problem

Planner context hints can ask for `kind: "call_site"`, but Stage 6 currently resolves any symbol hint by reading that symbol's own body.

Current behavior in `src/pipeline/packet-builder.ts`:

- line-range hints call `readRange`,
- symbol hints call `readSymbol(path, { symbolName })`,
- `hint.kind` is only shown in the rendered label.

That means a `call_site` hint naming a helper can expand the helper itself instead of the caller sites that use it. In review runs, this can starve Stage 7 of the downstream/caller context needed to answer whether a changed helper still preserves the public contract.

The repository tool already has `findSymbolMentions()`, so this is not a new intelligence system. It is a small Stage 6 resolver bug.

## Goal

Make `SurroundingContextHint.kind === "call_site"` resolve to caller/mention context, not the callee's own definition.

This should improve packet context for generic cross-symbol questions without adding domain-specific rules or a new risk taxonomy.

## Non-Goals

- Do not add language-specific semantic call graph resolution in this issue.
- Do not infer business risk from symbol names.
- Do not attach every mention result to the packet.
- Do not replace `readSymbol` for ordinary `enclosing_symbol`, `sibling_pattern`, or other definition-style hints.
- Do not make Stage 6 expensive; mention context must be bounded.

## Design

Update `resolvePacketContextHint()`:

1. If `hint.lineRange` is present, keep the existing `readRange` behavior.
2. If `hint.symbol` is present and `hint.kind === "call_site"`, call `findSymbolMentions(hint.symbol, { pathGlob, source: { kind: "head" } })`.
3. Render a compact mention/caller block instead of the symbol definition.
4. Filter out self-only results when they point to the same primary symbol definition already attached to the packet.
5. If no useful mentions are found, fall back to a worker tool lookup hint rather than expanding the callee body as if it were a caller.

The resolver should prefer precise, bounded context:

- cap mention count, for example 3-5 results;
- include file path, line, and short surrounding text;
- prefer mentions outside the hinted symbol's own definition when detectable;
- prefer mentions in changed files or same package when result count is high;
- truncate the rendered block through the existing hint context cap.

If `findSymbolMentions()` cannot distinguish reads/references/calls, that is acceptable. The fix is still useful because callers/mentions are closer to call-site context than always reading the callee body.

## Telemetry

Emit Stage 6 debug telemetry for call-site hint resolution:

- `packet_context_call_site_hint_resolved`
- `packet_context_call_site_hint_empty`
- `packet_context_call_site_hint_degraded` when results were truncated or only low-quality mentions were available

Include:

- `path`,
- `symbol`,
- `resultCount`,
- `includedCount`,
- `reason`.

## Likely Files

- `src/pipeline/packet-builder.ts`
- `tests/pipeline-phase5.test.ts` or packet-builder focused tests
- Possibly `src/types.ts` only if a helper type improves clarity

## Acceptance Criteria

- A `call_site` hint with a symbol uses `findSymbolMentions()` instead of `readSymbol()`.
- Definition-style hints with symbols still use `readSymbol()`.
- A call-site hint does not render the hinted symbol's own body as the only context when useful mention results are unavailable.
- Rendered call-site context is bounded and readable.
- Telemetry records whether the call-site hint resolved, was empty, or degraded.
- No target repo names or domain-specific symbol names are hard-coded.

## Validation

Add focused tests with a small fixture:

- `scaleAmount()` helper is called by `quoteMinimum()` and `buildTransfer()`.
- A `call_site` hint for `scaleAmount` renders caller/mention context.
- A non-`call_site` symbol hint for `scaleAmount` still renders `scaleAmount()` itself.
- A `call_site` hint with no mentions leaves a worker lookup hint or records an empty/degraded event instead of rendering unrelated callee source.

Run:

```text
pnpm exec vitest run tests/pipeline-phase5.test.ts
pnpm test
pnpm run build
```

Then rerun the `49f4645b` eval and compare Stage 6 packet context:

```text
pnpm run dev eval --eval-dir /home/peter/Dev/0xPolygon/codegenie-private-evals/trails-api/49f4645b --no-cache
```

Expected trend:

- packets with planner `call_site` hints include caller/consumer context,
- Stage 7 has less need to rediscover downstream call sites through tools,
- candidate generation is less dependent on luck for helper-to-caller contract issues.

## Stop Conditions

Stop and reassess if:

- call-site hint resolution adds broad search cost to most packets,
- mention results are too noisy to be useful,
- packets become overloaded with mention snippets,
- the implementation starts approximating a full call graph with ad hoc language-specific rules.
