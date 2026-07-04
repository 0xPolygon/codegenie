# Issue 96: Fixed Stage-6 Symbol-Context Budget (Delete the Adaptive Tree)

Status: PENDING (simplification backlog; last — a real behavior change to packet inputs, needs the strongest measurement)
Planned from: fable review §2.2 + §6 item 6 (`specs/reviews/1-fable-review.md`); plan 42's finding that context volume was not the recall constraint; PLAN12/seed-context direction (memory: `context.ts` seed-context is the real token target), 2026-07-04
Planned at: commit `762339d` (branch `next`)
Recommended priority: last of the simplification series, and only in a quiet measurement window — this changes what Stage 7 reads.

## Problem

Adaptive symbol-context budgeting is ~600 unspec'd lines (`packet-builder.ts:1554-2150`): a 5-mode decision tree with risk matchers and sliced excerpts, grown one eval-regression at a time (plans 29/32/42 lineage). Plan 42's own conclusion was that context under-delivery wasn't the recall constraint — variance was — and the entire wave era has since confirmed it: every loss in the modern ledger (runs 46-54) was generation/verification judgment variance, **never** a context-starvation loss. The subsystem is complexity purchased against a threat the measurement says isn't the binding one. It's also in the blast path of the PLAN12 tree-sitter/seed-context direction — simplifying it first shrinks that migration.

## What the telemetry says (and what to check before cutting)

- Context-pressure telemetry exists per run (`toolBudgetRejections`, source-budget extensions/denials, degraded hunks) — recent runs show low single-digit rejections and zero context-attributed losses.
- Stage-7 packets can *pull* context on demand (repository tools + plan-69 recovery): the adaptive pre-computation competes with a tool loop that already self-serves. That is the structural argument: fixed seed + on-demand pull beats a 600-line guess about what to pre-push.
- **Step 0 census (no code):** from runs 46-54 artifacts, distribution of adaptive modes actually chosen, sliced-excerpt frequency, and whether packets in the highest-adaptive modes produced findings at different rates (join with attention records). If one mode dominates ~all packets, the tree is already effectively fixed and deletion is near-free; if modes genuinely spread, size the fixed budget at the level that covers the productive modes.

## Design

1. Replace the 5-mode tree with **one fixed symbol-context budget** (sized from the census; likely "current normal-mode allotment") + deterministic tail truncation + one telemetry event (`symbol_context_truncated { packetId, dropped }`) so starvation is observable rather than pre-compensated.
2. Keep the *inputs* (symbol facts, relevance ordering) — deletion targets the mode tree, risk matchers, and slicing machinery, not the symbol extraction.
3. Coordinate with PLAN12: land this before (or as part of) the seed-context work so the tree isn't ported.

## Validation (harness — the strongest of the series)

- Owner A/B, both cases, ≥2 runs each vs the 51-54 baseline: `candidateRecallRate`/final recall flat; attention-efficiency per coverage bucket flat; tool-call volume may rise slightly (packets pulling what was pre-pushed) — bounded by existing tool budgets; context-pressure metrics and `symbol_context_truncated` counts reviewed.
- Watch specifically for T2 adaptive-trigger changes (silent-with-signal keys partly on static/coverage signals, not symbol context — should be unaffected; verify).

## Done Criteria

- Adaptive tree deleted (~600 lines → ~50); fixed budget + truncation event; census + budget-sizing rationale recorded here; recall flat on the A/B.

## Stop Conditions

- If the A/B shows recall movement on any expectation, revert and record which packets starved (the truncation event names them) — that evidence would justify a *small* targeted budget bump, not resurrecting the tree.
- If the census shows a genuinely productive high-context mode, size the fixed budget to include it rather than fighting about it.
