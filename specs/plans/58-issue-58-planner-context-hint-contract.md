# Issue 58: Planner Context Hint Contract

Status: COMPLETE
Planned from: trails-api `49f4645b` eval runs 1, 3, 4, and 5, 2026-06-17
Recommended priority: medium-high, before or alongside Issue 56 implementation

## Problem

Issue 57 changed `call_site` context hints so they resolve to caller bodies instead of the hinted symbol's own definition. That is the right behavior, but the eval runs show the planner's hint semantics are still loose.

Runs 1 and 3 emitted `kind: "call_site"` with `symbol: "(*Hyperlane).GetQuote"` even though the desired context was the `GetQuote` body itself. That only worked because the old resolver ignored `kind` and read the symbol body. With Issue 57, `call_site` now means "find callers/mentions of this symbol," so the same planner output could become less useful.

Run 5 emitted the better shape: `kind: "call_site"` with `symbol: "scaleAmount"`, and Stage 6 resolved it to the caller body `GetQuote`. That produced stronger context and a stronger exact-output finding. The goal is to make this reliable without adding a domain taxonomy.

## Goal

Make context hint semantics explicit, validated, and visible in telemetry:

- `enclosing_symbol` means "read this symbol body."
- `call_site` means "find caller/usage bodies of this callee/helper symbol."
- `test` means "read or prefer relevant test symbols."
- `line_range` means "read this explicit line range."
- `other` is reserved for rare mechanical retrieval needs that do not fit the supported modes.

The planner should choose the right retrieval mode, put semantic intent in `reason`, and Stage 6 should expose when a hint is semantically weak or unresolved.

## Non-Goals

- Do not build a full semantic call graph.
- Do not add language-specific business rules.
- Do not add semantic/risk categories to `SurroundingContextHint.kind`.
- Do not hard-code any target repo, symbol, route, quote, or decimal names.
- Do not roll back Issue 57.
- Do not attach broad mention results to every packet.

## Design

### 1. Document The Hint Contract In Types And Planner Prompt

Add short descriptions where `SurroundingContextHint.kind` is defined and in the planner prompt/schema guidance.

Rules:

- Use `enclosing_symbol` when the planner wants the body of a known function, method, class, type, or test.
- Use `call_site` when the planner wants to inspect callers/usages of a helper, changed symbol, API, or interface.
- Use `test` for relevant test symbols or test ranges.
- Use `line_range` for explicit lines when a symbol is not the right unit.
- For `call_site`, `symbol` should name the callee/used symbol, not the desired caller.
- If the planner knows the desired caller body, it should emit `enclosing_symbol` for that caller.
- Put concerns such as authorization, lifecycle, configuration, resources, or architecture in `reason`, not in `kind`.

Good:

```json
{ "kind": "call_site", "symbol": "scaleAmount", "reason": "Verify caller decimal ordering." }
```

Good:

```json
{ "kind": "enclosing_symbol", "symbol": "(*Store).SaveUser", "reason": "Need transaction and validation flow." }
```

Bad:

```json
{ "kind": "call_site", "symbol": "(*Store).SaveUser", "reason": "Need SaveUser body." }
```

### 2. Keep Stage 6 Defensive

The Issue 57 resolver should remain bounded:

- try same-file mentions first,
- fall back repo-wide only when same-file produces no distinct caller,
- dedupe by enclosing symbol,
- never render the hinted symbol's own body as a successful call-site result,
- leave a worker lookup hint or telemetry event when no distinct caller is available.

If the resolver sees no distinct caller bodies, it should emit `packet_context_call_site_hint_empty` or `packet_context_call_site_hint_degraded`; it should not silently pretend the hint was satisfied.

### 3. Add Semantic-Warning Telemetry

Add or preserve telemetry that makes hint quality visible:

- `packet_context_call_site_hint_resolved`
- `packet_context_call_site_hint_empty`
- `packet_context_call_site_hint_degraded`
- optionally `planner_context_hint_warning` when validation can identify a likely contract mismatch.

Useful warning conditions:

- `call_site` hint resolved zero caller bodies,
- `call_site` hint only found self references,
- `call_site` symbol looks identical to the packet's primary enclosing symbol and no caller body was found.

Do not reject the plan because of these warnings. They are diagnostics, not hard failures.

### 4. Tests

Add focused tests for planner prompt/schema behavior where practical and packet-builder behavior where deterministic:

- `call_site` for a helper renders caller bodies.
- `call_site` for a symbol with no distinct callers records degraded/empty telemetry and does not render unrelated source.
- `enclosing_symbol` still renders the requested body.
- A planner-output fixture using `call_site` for a known body is either documented as invalid or produces warning telemetry.

## Likely Files

- `src/types.ts`
- `src/pipeline/planner.ts`
- `src/pipeline/packet-builder.ts`
- `tests/*planner*.test.ts`
- `tests/*packet*.test.ts`
- `plans/57-issue-57-call-site-context-hint-resolution.md`

## Validation

Run:

```text
pnpm exec vitest run tests/*planner*.test.ts tests/*packet*.test.ts
pnpm test
pnpm run build
```

Then rerun the `49f4645b` eval:

```text
pnpm run dev eval --eval-dir /home/peter/Dev/0xPolygon/codegenie-private-evals/trails-api/49f4645b --no-cache
```

Expected trend:

- planner uses `call_site` for callee/helper symbols more consistently,
- Stage 6 call-site telemetry appears only when real call-site context was requested,
- packet context contains caller bodies when available,
- no final finding depends on a silent context-hint mismatch.

## Stop Conditions

Stop and reassess if:

- planner guidance becomes long or brittle,
- hint validation starts rejecting otherwise useful plans,
- Stage 6 begins doing broad mention searches for most packets,
- packet context becomes noisier or less bounded.
