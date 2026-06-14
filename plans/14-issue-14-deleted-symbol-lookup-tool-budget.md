# Issue 14: Deleted Symbol Lookup and Targeted Tool Budget

Status: PENDING

## Problem

Reviewers often need to compare changed code against symbols or guards that existed only in the base revision. If the tool lookup defaults to head-only behavior, deleted helpers show up as `symbol not found`, which can block evidence gathering for behavior-preserving refactors.

Separately, some review threads need one final source read to confirm or reject a concrete candidate. Hard tool-budget cutoff is useful, but it should preserve a small, predictable evidence reserve for candidate-quality threads.

The fix should stay simple: make base/head symbol lookup explicit, expose deleted symbols in packets when cheap, and add a bounded evidence reserve without introducing open-ended investigation loops.

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

4. Add a bounded evidence-reserve budget:
   - Keep normal packet tool budgets unchanged for most work.
   - Reserve a tiny extra budget, such as 1-2 source reads, for packets that have:
     - a medium/high candidate in progress
     - a static signal such as narrowing cast, deleted guard, changed fallback behavior, or deleted test coverage.
   - Allow only a small number of extra reads, focused on source/evidence calls, not broad searches.
   - Emit `tool_budget_evidence_extension` when used.
   - Do not grant extra budget for broad search, speculative follow-ups, or low-confidence questions.

5. Make rejected reads actionable:
   - When a read is rejected due to budget and the reviewer produces a follow-up hint, include the rejected tool call in the hint metadata.
   - The verifier/composer should know whether the uncertainty is due to missing evidence, tool budget, or true ambiguity.
   - Do not publish findings based only on rejected reads.

## Likely Files

- `src/repo/repository-index.ts`
- `src/repo/tools.ts`
- `src/repo/tree-sitter-index.ts`
- `src/pipeline/packet-builder.ts`
- `src/pipeline/lens-runner.ts`
- `src/skills/prompt-builder.ts`
- `src/types.ts`
- `tests/repository-intelligence.test.ts`
- `tests/tree-sitter-tools.test.ts`
- `tests/pipeline-phase6.test.ts`
- `tests/pipeline-phase7.test.ts`

## Tests

- `read_symbol` with auto source finds a symbol that exists only in base.
- Explicit head lookup still reports `symbol not found` for deleted symbols.
- Packet facts include deleted symbol hints for a removed function where the language adapter supports it.
- A packet with a narrowing-cast static signal receives a bounded evidence extension when the reviewer requests one more base-side read.
- Budget extension is not granted for low-confidence speculative threads.
- Follow-up hints caused by rejected reads include enough metadata to debug the missing evidence.

## Acceptance Criteria

- Deleted or renamed symbols are inspectable without manual source-side guessing.
- Strong candidate-worthy threads get a small evidence budget before becoming follow-up noise.
- Tool budget remains bounded and predictable.
- The change improves generic refactor review quality, not one specific bug pattern.
