---
status: complete
---

# Phase 1: Scaffold and foundation

## Overview

This phase establishes the TypeScript/ESM CLI foundation for codegenie. It adds the package scaffolding, the `codegenie review` command surface and input validation, home/config path resolution, the merged configuration loader with repo/user trust partitioning, typed errors, credential redaction, and local run telemetry artifacts. Later phases can build the git, skills, LLM, and review pipeline layers on these stable seams.

## Steps

1. Add package scaffolding: `package.json`, `pnpm-lock.yaml`, `tsconfig.json`, `vitest.config.ts`, `src/cli/main.ts`, and executable bin metadata for an ESM TypeScript CLI.
2. Implement shared domain contracts in `src/types.ts` plus `src/util/errors.ts` for `CodegenieError`, stable error codes, and redacted error context.
3. Implement `src/config/paths.ts` and provider settings helpers so `CODEGENIE_HOME` overrides `~/.codegenie`, home directories use secure modes, and `auth.json` / `settings.json` paths are centralized.
4. Implement `src/config/schema.ts` and `src/config/config-loader.ts` with zod validation, TOML parsing, default config, user `config.toml`, user `settings.json`, repo `codegenie.toml`, CLI overrides, the provider/model/reasoning environment layer, cache flag overrides, and warnings for ignored repo-only user-scope keys.
5. Implement `src/cli/review-command.ts` with commander parsing for `review`, target mode normalization, mutual exclusion of `--pr` / `--branch` / positional commits, `--post-github-comments` PR-only validation, repeated `--lens`, `--cache` / `--no-cache`, and resolved config loading.
6. Add `src/telemetry/redaction.ts`, `src/telemetry/telemetry-recorder.ts`, and `src/telemetry/run-artifacts.ts` for run id creation, logger/recorder sinks, `.codegenie/.gitignore` provisioning, run directory attachment, JSONL log/event/model/tool sinks, artifact writing allowlists, debug trace gating, summaries, pruning, and credential stripping.
7. Wire a minimal `codegenie review` placeholder flow that creates telemetry, writes a foundation run artifact, and exits successfully without pretending later review stages are implemented.
8. Add Vitest coverage for CLI validation, config precedence/trust partitioning, secure path/settings behavior, telemetry artifact creation/pruning/redaction, and typed error serialization.

## Tests

- `review_command_rejects_conflicting_targets`: verifies target modes are mutually exclusive and `--post-github-comments` requires `--pr`.
- `config_loader_merges_safe_and_user_scoped_layers`: verifies CLI > repo > user defaults for safe keys, provider env/settings/config precedence, and repo-scoped user keys are ignored with warnings.
- `paths_resolve_codegenie_home`: verifies `CODEGENIE_HOME` and default home path resolution plus secure directory/settings writes.
- `run_telemetry_writes_redacted_artifacts`: verifies run directories, `.gitignore`, log/event/model/tool JSONL files, summaries, and registered-secret stripping.
- `run_telemetry_prunes_old_runs`: verifies run retention deletes only older inactive run directories.
- `codegenie_error_strips_context`: verifies typed errors preserve codes/recoverability and redact credential-bearing context.
