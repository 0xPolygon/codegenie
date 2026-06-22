# Issue 25: Repository Source Recovery and Tool Budget Diagnostics

Status: COMPLETE
Planned from: trails-api eval run 4, 2026-06-15

## Problem

Eval run 4 exposed a source-delivery failure in the repository tools, not a simple tree-sitter parse failure.

The relay fee-price false positive depended on `CalculateAmountUSD` behavior. The verifier asked for that helper and tree-sitter found it in `lib/quotes/fees.go` at lines 96-121, but codegenie returned only a truncated symbol header because the global tool-result character budget had already been mostly consumed by larger reads. The verifier then kept the finding without seeing the decisive branch.

Run 4 telemetry shows:

- 464 repository tool calls total.
- 436 successful tool calls.
- 28 rejected tool calls.
- 53 degraded or truncated tool results.
- Every rejected call was recorded as `budget_or_tool_rejected`, so telemetry does not currently distinguish result-character exhaustion, tool-call exhaustion, investigation-round exhaustion, invalid arguments, lookup miss, or real tool failure.
- For the false positive packet, `read_symbol(CalculateAmountUSD)` was `ok` but truncated, while later reads of `CalculatePriceUSD` and `ResolveTokenPriceUSD` were rejected by budget before source lookup could happen.

This is a general correctness issue. If a model asks for a symbol that exists, codegenie should make a strong best effort to deliver the decisive source, or make the verifier fail closed when the decisive source cannot be delivered.

## Failed Tool Calls Observed

All rejected calls in run 4 were budget/tool rejections, not confirmed tree-sitter lookup failures:

- Stage 7: 9 rejected `find_definition` calls.
- Stage 7: 6 rejected `read_range` calls.
- Stage 7: 4 rejected `read_symbol` calls.
- Stage 7: 2 rejected `find_symbol_mentions` calls.
- Stage 7: 1 rejected `search_files` call.
- Stage 7: 1 rejected `list_files` call.
- Stage 9: 3 rejected `read_symbol` calls.
- Stage 9: 1 rejected `search_files` call.
- Stage 9: 1 rejected `read_range` call.

The most important failure shape is:

1. A large enclosing function read consumes most of the tool-result budget.
2. A small decisive helper is found by tree-sitter.
3. The helper result is truncated before the body is visible.
4. Follow-up reads are rejected because the budget is exhausted.
5. The verifier keeps or revises a candidate with incomplete evidence.

## Plan

1. Add precise tool rejection and truncation diagnostics.
   - Extend tool outcomes with a stable reason code such as `tool_result_budget_exhausted`, `tool_call_budget_exhausted`, `investigation_round_budget_exhausted`, `path_outside_repo`, `invalid_args`, `symbol_not_found`, `file_missing`, `tree_sitter_unavailable`, or `tool_failed`.
   - Persist the reason in `tool-calls.jsonl`, per-call debug artifacts, and stage events.
   - Stop collapsing budget rejections into only `budget_or_tool_rejected`.
   - Include budget state in debug records: used tool calls, max tool calls, used result chars, max result chars, and remaining result chars.

2. Separate source lookup status from source delivery status.
   - For `read_symbol` and `find_definition`, report whether the symbol was found independently from whether the source body was fully delivered.
   - Use fields like `lookupStatus: "found" | "not_found" | "ambiguous" | "file_missing"` and `deliveryStatus: "full" | "truncated" | "budget_rejected"`.
   - In the `CalculateAmountUSD` case, telemetry should say `lookupStatus: found` and `deliveryStatus: truncated`, not imply the symbol was unavailable.

3. Reserve verifier budget for decisive small source reads.
   - Do not allow one large symbol read to starve the verifier of budget for later helper reads.
   - Keep a small reserved source budget for exact `read_symbol` or `read_range` calls on small symbols/ranges after the verifier has already read a large caller.
   - Prefer full delivery for small symbols, for example functions under a modest line/character threshold, even when earlier broad context was expensive.
   - If the reserved budget is used, record that explicitly in telemetry.

4. Add automatic source recovery for truncated symbols.
   - When `read_symbol` finds a symbol but returns truncated text, include a machine-readable recovery hint with the exact path, source, and line range.
   - Allow a follow-up exact `read_range` for that line range to use the reserved source budget.
   - Consider auto-retrying the exact range internally when the symbol is small enough and the first result was truncated by result budget rather than by the symbol-size cap.
   - Keep this generic: it should work for Go, TypeScript, Rust, Solidity, and text fallback files.

5. Improve definition lookup fallback when the model does not know the file path.
   - Keep tree-sitter as the primary backend.
   - Add deterministic text fallback patterns for common declaration forms when tree-sitter discovery misses or when global search has too many matches.
   - Return nearest candidate definitions with paths and line ranges when exact resolution is ambiguous, rather than returning an empty rejected result.
   - Avoid language-specific product assumptions; language adapters may provide declaration regexes, but the tool contract should stay generic.

6. Make verifier source incompleteness fail closed.
   - If a candidate depends on a helper/callee and the decisive helper source is truncated, budget-rejected, or unavailable, the verifier should reject or mark verification incomplete.
   - The verifier may keep the candidate only when it can cite the decisive branch or invariant from complete source.
   - Treat `[tool result truncated by codegenie tool budget]` as insufficient evidence for helper-dependent claims.

7. Add regression tests with fixtures.
   - A large caller read must not prevent a later small helper read from being delivered in full during verification.
   - `read_symbol` should report found-but-truncated distinctly from not found.
   - A truncated symbol should expose a recovery hint and allow exact `read_range` recovery.
   - Tool telemetry should record precise budget exhaustion reason codes.
   - A verifier fixture should reject a removed-guard finding when the replacement helper's complete source shows the guard is still enforced.
   - `find_definition` should locate exported and unexported symbols by name with and without an explicit path in tree-sitter-backed fixtures.

## Likely Files

- `src/llm/pi-runner.ts`
- `src/llm/tool-definitions.ts`
- `src/repo/repository-index.ts`
- `src/repo/source-resolver.ts`
- `src/repo/symbol-extraction.ts`
- `src/pipeline/verifier.ts`
- `src/skills/prompt-builder.ts`
- `src/telemetry/run-artifacts.ts`
- `src/types.ts`
- `tests/repository-intelligence.test.ts`
- `tests/tree-sitter-fixtures.test.ts`
- `tests/verifier.test.ts`
- `tests/telemetry.test.ts`

## Acceptance Criteria

- Existing symbols with known line ranges can be recovered through at least one exact source-read path unless the file is missing or blocked by repository safety checks.
- Tool telemetry distinguishes lookup failures from budget delivery failures.
- Budget exhaustion records include enough context to explain why a tool call was rejected.
- Verifier source reads preserve enough budget for small decisive helpers after large caller reads.
- Helper-dependent findings are rejected or marked incomplete when decisive helper source is truncated or budget-rejected.
- The fix remains language-agnostic and does not add trails-api-specific rules.
