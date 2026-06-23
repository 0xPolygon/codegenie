---
status: complete
---

# Phase 8: Model-Call Cache

## Overview

This phase completes the optional local model-call cache for review runs. The cache is keyed by a deterministic normalized request, stores individual provider-call responses, validates entries before replay, refuses repo-tracked cache directories, prunes old/oversized entries, and is toggled by config plus `--cache` / `--no-cache`.

## Steps

1. Update `src/llm/model-call-cache.ts` to use the spec layout `<dir>/v<schema>/<key[0..2]>/<key>.json`, include the run fingerprint in the normalized key, create parent directories before writes, validate stored entries on read, emit stage-0 eviction telemetry, and keep write failures best-effort.
2. Update `src/llm/pi-runner.ts` so `canonicalModelRequest` includes `cacheSchemaVersion`, schema name/version, runner message version, resolved model settings, full conversation prefix, tool schemas/descriptions, tool budget, and request kind/tool choice. Cache hits must produce model-call records without budget usage; misses/writes must emit telemetry and only schema-valid provider responses are written.
3. Update `src/pipeline/review-runner.ts` to compute the run fingerprint from canonical run data: repo root, mode, base/head revisions, diff hash, behavior-affecting config (`lenses`, `review`, `git`, `classification`, `llm`), effective lens state, and skill content hashes.
4. Verify `src/cli/review-command.ts` and `src/config/config-loader.ts` wire `--cache` / `--no-cache` through the existing config override path.
5. Add/adjust tests in `tests/phase4-llm.test.ts`, `tests/config-loader.test.ts`, and `tests/review-command.test.ts` to pin cache layout, redaction, schema mismatch misses, eviction telemetry, cache-key sensitivity, hit budget behavior, and CLI overrides.

## Tests

- `model_call_cache_layout_redaction_and_validation`: writes cache entries under the versioned shard layout, redacts secrets, returns hits, misses malformed/schema-mismatched entries, and deletes invalid files.
- `model_call_cache_eviction_records_telemetry`: prunes stale entries at construction and emits a stage-0 cache eviction telemetry event.
- `pi_runner_cache_hits_do_not_consume_provider_budget`: a cache hit records a hit and avoids provider usage / checkpoint calls.
- `review_command_cache_flags_override_config`: `--cache` and `--no-cache` override the configured cache default per run.
- Existing Phase 4/5/6/7 tests continue to pass with the completed cache path.
