---
status: draft
---

# Phase 9: Evals

## Overview

Add the `codegenie eval` command and eval subsystem for deterministic suite loading, artifact replay, expectation scoring, run directory management, previous-run comparison, and a fixture-backed starter suite that can run in CI through the fake runner. The implementation reuses `runReview` for live cases and reads the existing telemetry artifact contract for scoring instead of forking review behavior.

## Steps

1. Add eval domain types to `src/types.ts`, matching the `EvalCase`, `EvalFindingExpectation`, scoring, run-info, artifact, and comparison shapes from `architecture.md` and `components/evals.md`.
2. Add a YAML dependency and implement `src/evals/eval-runner.ts` suite discovery/validation with strict zod schemas, literal key mapping, unique case/expectation ids, source exclusivity, regex validation, path resolution, cache override handling, and per-case execution.
3. Implement `src/evals/eval-artifacts.ts` for atomic numeric `logs/<n>` allocation, artifact loading, self-contained replay copies, previous-run lookup, and atomic `info.json` writing.
4. Implement `src/evals/eval-scoring.ts` for deterministic field matching, maximum bipartite assignment, `should_not_find` violations, near violations, coarse loss attribution, metrics, and budget checks.
5. Implement `src/evals/eval-compare.ts` for previous-run regression/fix/violation/budget/finding/metric diffs plus text rendering.
6. Implement `src/evals/eval-command.ts` and wire `codegenie eval` into `src/cli/main.ts`, including `--eval-dir`, `--from-artifacts`, `--cache`, `--no-cache`, stdout summaries, and exit code mapping.
7. Add a starter fixture eval suite under `evals/fixtures/` covering the bundled core, tests, Go, and TypeScript lenses with deterministic fake-runner review cases.
8. Add Vitest coverage for schema validation, matching/scoring/attribution, artifact replay and previous-run comparison, command parsing/errors, and a fixture eval smoke run.

## Tests

- `eval suite validation rejects unknown keys and invalid source/expectation shapes`
- `matchExpectation handles exact/glob paths, line overlap, severity ordering, and regex fields`
- `scoreEvalRun assigns expectations deterministically and reports loss labels, violations, budgets, and metrics`
- `replayFromArtifacts copies telemetry, re-reads editable YAML when present, writes a new run, and compares to previous`
- `runEvalCommand executes the starter fixture suite through the fake runner and returns pass/fail/invalid exit codes`
