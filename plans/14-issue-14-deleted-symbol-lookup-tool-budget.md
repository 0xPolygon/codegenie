# Issue 14: Deleted Symbol Lookup and Targeted Tool Budget

Status: COMPLETE

Implementation note: this plan was narrowed during implementation. The shipped change makes deleted or renamed symbols inspectable through source-aware `read_symbol` and `find_definition` lookups, adds explicit source-fallback metadata, and updates reviewer guidance. Existing packet static signals already carry cheap deleted-symbol hints into packets. The proposed evidence-reserve/tool-budget extension was not implemented here because it is a broader LLM-runner budget policy and should be handled as a separate follow-up if future evals still show useful source reads being cut off too early.

## Problem

Reviewers often need to compare changed code against symbols or guards that existed only in the base revision. If the tool lookup defaults to head-only behavior, deleted helpers show up as `symbol not found`, which can block evidence gathering for behavior-preserving refactors.

Separately, some review threads need one final source read to confirm or reject a concrete candidate. Hard tool-budget cutoff is useful, but any reserve policy must stay small and predictable.

The fix should stay simple: make base/head symbol lookup explicit and expose deleted symbols through existing packet signals without introducing open-ended investigation loops.

## Plan

1. Add base-side fallback for symbol tools:
   - For `read_symbol` and `find_definition`, support `source: "auto"`.
   - `source: "auto"` should search head first, then base.
   - Return metadata:
     - requested source
     - source used
     - whether fallback occurred
     - whether the symbol exists only in base.
   - Keep explicit `source: "head"` and `source: "base"` behavior available for callers that require one side.

2. Add deleted-symbol hints from the diff:
   - During syntax/change extraction, identify deleted function/method/type names where supported.
   - Attach deleted symbol names to hunk facts and review packets.
   - Include a compact base-side signature/source snippet only when it fits existing packet budget.
   - Do not add language-specific special cases beyond the normal language adapter hooks.

3. Improve model-facing tool guidance:
   - Tell reviewers that removed symbols or deleted guards should be inspected from base when assessing behavior-preserving refactors.
   - Prefer `read_symbol(..., source: "auto")` for renamed/deleted symbols unless the exact side matters.
   - Make tool responses explicit when a lookup succeeded only in base.

4. Defer bounded evidence-reserve budget:
   - Do not change packet tool budgets in this plan.
   - If future evals show strong candidate-worthy threads being cut off by one final source read, implement a separate LLM-runner budget policy with explicit tests.
   - Do not publish findings based only on rejected reads.

## Likely Files

- `src/repo/repository-index.ts`
- `src/repo/tools.ts`
- `src/repo/tree-sitter-index.ts`
- `src/pipeline/packet-builder.ts`
- `src/skills/prompt-builder.ts`
- `src/types.ts`
- `tests/repository-intelligence.test.ts`
- `tests/phase4-llm.test.ts`

## Tests

- `read_symbol` with auto source finds a symbol that exists only in base.
- Explicit head lookup still reports `symbol not found` for deleted symbols.
- `find_definition` with auto source finds a definition that exists only in base.
- Model-facing tool output includes source fallback metadata.

## Acceptance Criteria

- Deleted or renamed symbols are inspectable without manual source-side guessing.
- Tool budget remains bounded and predictable.
- The change improves generic refactor review quality, not one specific bug pattern.
