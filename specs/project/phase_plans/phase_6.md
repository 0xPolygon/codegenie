---
status: complete
---

# Phase 6: Live Review

## Overview

This phase proves the non-fake review path end to end. The implementation should use the real `PiRunner` for planner, packet-review, verifier, and composer calls, exercise schema repair and provider backoff in that path, and keep Stage 8 deferred by surfacing follow-up hints as needs-human-attention notes.

## Steps

1. Add a Phase 6 regression test that invokes `runReview({ mode: "branch", branchName: "feature" }, config, { piAdapter })` with a scripted `PiAiAdapter`, not an injected `LlmRunner`, so the pipeline constructs and uses `createPiRunner`.
2. Script Stage 5 planner output from the real prompt's `planner-dossier` block, Stage 7 packet review output with one schema-invalid submit followed by a repaired submit, Stage 9 verifier output after a transient 429 retry, and Stage 10 composer output.
3. Assert the final review includes the composed finding and a medium/high-confidence follow-up hint as a needs-human-attention note, with no Stage 8 artifacts or events.
4. Assert telemetry artifacts prove the live runner path: model calls for stages 5, 7, 9, and 10, schema-invalid/repair telemetry, transient retry telemetry, and final review output on stdout.
5. Fix any orchestration, prompt, validation, or telemetry gaps exposed by the new live-run coverage while preserving fake-runner behavior for Phase 5 tests.

## Tests

- `phase_6_live_review_uses_pi_runner_end_to_end`: verifies `runReview --branch` reaches real planner, packet-review, verifier, and composer calls through `PiRunner`, repairs schema-invalid output, backs off after a transient provider error, and surfaces follow-up hints as needs-human-attention notes.
- Full project checks: `pnpm test`, `pnpm run typecheck`, and `pnpm run build`.
