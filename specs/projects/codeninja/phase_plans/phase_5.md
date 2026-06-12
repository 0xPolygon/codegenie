---
status: draft
---

# Phase 5: Pipeline Spine On Fake Runner

## Overview

This phase turns the Phase 1-4 inventory, repository intelligence, prompt, telemetry, and fake LLM seams into a complete deterministic review run. It adds the public `runReview` orchestration entrypoint, stage artifacts, planner validation/fallbacks, packet building, worker execution, verification, composition, Markdown/JSON output, and CLI wiring. The goal is a full fake-runner review printed to stdout with every stage artifact written and no provider API spend.

## Steps

1. Extend `src/types.ts` with the Phase 5 output contracts: `ReviewResult`, `PostingPlan`, `NeedsHumanAttentionNote`, and the planner dossier record types consumed by `PromptBuilder.renderDossier`.
2. Add `src/pipeline/review-runner.ts` with `runReview(input, config, overrides?)`, run setup, budget/coverage helpers, zero-work short-circuit, telemetry/artifact flushing, and stage sequencing through parse, filter, classify, repository indexing, planning, packets, Stage 7, Stage 9, Stage 10, rendering, and return.
3. Add `src/pipeline/planner.ts` for deterministic dossier construction, enabled-lens summaries, planner LLM invocation through `LlmRunner`, semantic validation, `review-plan.json`, and deterministic default plans on recoverable planner failure.
4. Add `src/pipeline/packet-builder.ts` for hunk/file packet construction, stable packet ids, line rendering, default lens fallbacks, tool-budget scaling, `packets/<packet-id>.json`, and packet coverage records.
5. Add `src/pipeline/worker-runner.ts` for bounded priority scheduling with stable worker ids, timeout handling, cancellation surfaces, and non-throwing per-task outcomes.
6. Add `src/pipeline/lens-runner.ts` for one composite Stage 7 structured call per packet using projected skills, repository tool definitions, output stamping/validation, candidate ids/producers, follow-up hint events, and `PacketReviewResult` records.
7. Add `src/pipeline/verifier.ts` for deterministic pre-gates, optional verifier calls, verdict handling, incomplete verification records, and `verification.json`.
8. Add `src/pipeline/composer.ts` for deterministic grouping/ranking/caps, optional composer LLM call, fallback composition, needs-human-attention notes, fingerprints, `final-selection.json`, and `final-findings.json`.
9. Add `src/output/markdown-renderer.ts`, `json-renderer.ts`, and `stdout-renderer.ts` to render full reviews or posting summaries; wire `src/cli/review-command.ts` to call `runReview` instead of stopping at Phase 2 inventory.
10. Add focused Vitest coverage for fake end-to-end review artifacts, zero-work short-circuit, planner fallback validation, packet construction, worker behavior, verification/composition, and CLI stdout wiring.

## Tests

- `runReview_stage_order_and_artifacts`: verifies a fake LLM end-to-end run writes dossier, plan, packets, candidate findings, verification, coverage, final selection, final findings, and final Markdown.
- `runReview_zero_work_empty_diff`: verifies empty diffs short-circuit before LLM work with `noFindings: true` and complete coverage.
- `planner_terminal_failure_default_plan`: verifies recoverable planner failure produces deterministic normal coverage with default lenses.
- `packets_default_one_per_hunk`: verifies stable packet ids, line-number rendering, changed-line arrays, coverage, and tool budgets.
- `workers_respect_concurrency_and_priority`: verifies bounded scheduling order and non-throwing worker outcomes.
- `verify_disabled_by_config`: verifies Stage 9 gates still run and gate survivors pass through without verifier LLM calls.
- `compose_terminal_failure_fallback`: verifies fallback composition preserves verified findings and emits final artifacts.
- `review_command_prints_fake_markdown`: verifies `codeninja review` reaches the pipeline and prints a deterministic fake review through stdout.
