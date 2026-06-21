---
status: draft
---

# Phase 4: Skills, Provider Auth, And LLM Runner

## Overview

Phase 4 adds the model-facing startup layer required before the review pipeline can call an LLM: bundled Markdown skills, repo/extra skill loading, lens resolution, deterministic prompt assembly, Pi-backed provider settings and CLI commands, structured LLM schemas, a Pi adapter/runner with tool-loop budget enforcement, repository tool definitions, model-call cache scaffolding, and fake seams for tests.

The phase-start Pi verification found `@earendil-works/pi-ai@0.74.2` as the Node-20-compatible dist tag. Its public API exposes `complete`, `getModel`, `getProviders`, `getModels`, `getEnvApiKey`, `validateToolCall`, TypeBox exports, cost data on `usage.cost`, and OAuth login helpers through `@earendil-works/pi-ai/oauth`. It does not export literal `PiAuthStorage` or `PiModelRegistry` classes, so codegenie wraps the real exports in internal `PiAuthStorage` and `PiModelRegistry` interfaces with injectable fake implementations for tests.

## Steps

1. Add `@earendil-works/pi-ai@0.74.2` to dependencies so TypeBox, `complete`, model registry helpers, env auth helpers, validation, and OAuth functions are available on the supported Node >=20 engine.
2. Add bundled skill Markdown files under `bundled-skills/core/` and `bundled-skills/lang/` for `core/code-review`, `core/tests`, `lang/go`, and `lang/typescript` with the required frontmatter and checklist content.
3. Implement `src/skills/skill-loader.ts` with frontmatter parsing, section extraction, bundled/repo/extra discovery, SHA hashing, validation failures, recoverable `skill_invalid` warnings, and trusted-checkout-only filesystem reads.
4. Implement `src/skills/lens-registry.ts` with lens registration, config/CLI enablement resolution, strict CLI validation, config conflict handling, disclosure telemetry, and stable `registryHash()`.
5. Implement `src/skills/prompt-builder.ts` with deterministic stage templates for stages 5/7/9/10, projection maps and caps, untrusted-content fencing, and prompt template version exports.
6. Extend provider support in `src/provider/provider-services.ts` with codegenie auth storage, Pi model registry wrappers, provider command handlers, settings commands, credential redaction registration, and fake registry injection for tests.
7. Wire `codegenie provider ...` into `src/cli/main.ts` while preserving existing `review` behavior and help semantics.
8. Add `src/llm/llm-runner.ts`, `src/llm/schemas.ts`, `src/llm/tool-definitions.ts`, `src/llm/pi-runner.ts`, and `src/llm/model-call-cache.ts` for TypeBox submit schemas, tool definitions, structured request types, fakeable Pi adapter loop, budgets, timeout/abort handling, model resolution, retry classification, model-call telemetry, and cache scaffolding.
9. Update shared types and telemetry artifact allow-lists as needed for new Phase 4 contracts.
10. Add focused Vitest coverage for bundled skill loading, lens resolution, prompt fencing/projection, provider command/settings behavior, submit schemas, repository tool definitions, and the Pi runner tool loop/fake adapter path.

## Tests

- `skills_load_bundled_inventory`: verifies the four bundled skills load with deterministic ids, source, lenses, and non-empty checks.
- `skills_frontmatter_validation_and_duplicate_id`: verifies malformed and duplicate skill files warn, emit `skill_invalid`, and do not block valid siblings.
- `lens_cli_and_config_resolution`: verifies default, config, CLI replacement, unknown CLI, and enabled/disabled conflicts.
- `prompt_projection_and_fencing`: verifies stage projection maps, truncation metadata, prompt determinism, and backtick-collision-safe untrusted fences.
- `provider_commands_smoke_and_settings`: verifies `provider list`, `auth-status`, `models --all`, `config`, and `config set-*` against a fake registry without printing credentials.
- `schemas_reject_extra_fields`: verifies TypeBox submit schemas reject hallucinated fields and expose the expected submit tool names.
- `tooldefs_cover_all_nine`: verifies repository tool definitions and rendered result metadata for all nine tool names.
- `pi_runner_tool_round_then_submit`: verifies fake adapter completion, tool execution, fenced tool result injection, submit validation, model/tool telemetry, and budget counters.
- `model_call_cache_basic`: verifies cache key sensitivity, hit/miss behavior, schema-version mismatch miss, and atomic writes.
