# Issue 57: Resolve Call-Site Context Hints To Callers

Status: COMPLETE
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
2. If `hint.symbol` is present and `hint.kind === "call_site"`, call `findSymbolMentions` with bounded result count and symbol enrichment. Prefer adding optional `contextMode?: "none" | "lines" | "symbols"` and `maxResults?: number` support to `RepositoryTools.findSymbolMentions()` and the `find_symbol_mentions` tool definition, matching the existing `search_files` option shape where practical. Keep the default behavior unchanged so ordinary model tool calls do not become more expensive unless they request symbol context. The Stage 6 call-site resolver should request `contextMode: "symbols"` and a bounded `maxResults`.
3. For each useful mention, prefer rendering the **enclosing caller's body** over a few raw grep lines. With symbol enrichment enabled, `findSymbolMentions` results should carry a tree-sitter-derived `enclosingSymbol` (see below), so when a mention's `enclosingSymbol` differs from the hinted callee, read that enclosing symbol with `readSymbol(enclosingSymbol.path, { line: enclosingSymbol.lineRange[0] })` and render it. The line selector avoids ambiguity when duplicate method/helper names exist. Keep this bounded to the selected distinct caller symbols only. Fall back to a worker tool-lookup hint when no distinct enclosing caller symbol is available.
4. Filter out self-only results: drop mentions whose `enclosingSymbol` is the hinted symbol itself (the callee's own definition is already attached to the packet as the primary symbol).
5. If no useful mentions are found, fall back to a worker tool lookup hint rather than expanding the callee body as if it were a caller.

The resolver should prefer precise, bounded context:

- cap distinct caller symbols, for example 3-5;
- cap the raw mention lookup as well, for example 25-50 results before selecting callers;
- prefer mentions whose `enclosingSymbol` differs from the callee;
- prefer mentions in changed files or same package when result count is high;
- try the hinted file first and only fall back to repo-wide mention search when same-file results do not produce a distinct caller;
- dedupe by enclosing symbol so one caller is not read repeatedly;
- truncate the rendered block through the existing hint context cap.

Rendering the caller's *body* (not ±N grep lines) matters for the motivating case: the one eval run that found the issue succeeded specifically because the `scaleAmount` packet received the whole `GetQuote` caller body (the `EXACT_OUTPUT` branch). A few surrounding lines around the call site would likely not have been enough.

### Why tree-sitter makes this cheap and precise

This is not a new intelligence system; the pieces already exist:

- `SearchResult` (`src/types.ts:1301`) already includes `contextBefore`, `contextAfter`, and `enclosingSymbol`.
- `search.ts` `enrichSymbols()` can populate `enclosingSymbol` per mention via the language adapter's tree-sitter `getEnclosingSymbol(parsed, line)` (Go and TypeScript adapters exist under `src/repo/tree-sitter/`). This currently happens only for searches using `contextMode: "symbols"`, so the implementation must enable symbol enrichment for call-site hint resolution before relying on `enclosingSymbol`.
- `search.ts` `verifyIdentifierMention()` already uses tree-sitter to confirm a hit is a real identifier rather than a comment/string, which mitigates the reads-vs-calls concern below.

Caveats to keep in scope:

- `enrichSymbols()` only enriches roughly the first 25 mentions; for very common helper names, cap/prioritize (changed files, same package) before relying on enclosing symbols, and emit the degraded telemetry below.
- tree-sitter `enclosingSymbol` identifies the *caller function*, not strictly a *call expression*. That is sufficient here — the caller body is exactly the context Stage 7 needs. A precise call-expression filter (a tree-sitter query over `call_expression` nodes whose callee identifier matches) is a possible future tightening but is out of scope per the non-goals.

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
- Call-site hint lookup enables symbol enrichment, and tests fail if mention results lack `enclosingSymbol` when the language adapter can provide it.
- Definition-style hints with symbols still use `readSymbol()`.
- A call-site hint does not render the hinted symbol's own body as the only context when useful mention results are unavailable.
- Rendered call-site context is bounded and readable.
- Telemetry records whether the call-site hint resolved, was empty, or degraded.
- No target repo names or domain-specific symbol names are hard-coded.

## Validation

Add focused tests with a small fixture:

- `scaleAmount()` helper is called by `quoteMinimum()` and `buildTransfer()`.
- A `call_site` hint for `scaleAmount` renders the **caller bodies** (`quoteMinimum`, `buildTransfer`), keyed off each mention's tree-sitter `enclosingSymbol`, not just the matched lines.
- A `call_site` hint for `scaleAmount` does **not** render `scaleAmount`'s own body, even if a mention lands inside the definition (self-filter via `enclosingSymbol === hinted symbol`).
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
