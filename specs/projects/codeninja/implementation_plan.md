---
status: complete
---

# Implementation Plan: codeninja

Build order follows the architecture's tracer-bullet directive: stand up the minimal end-to-end review path before any optional machinery. Phase 5 is the milestone where `codeninja review` produces a real review on stdout. Details live in `architecture.md` and `components/*.md` — this file is the ordered checklist.

## Phases

- [ ] Phase 1: Scaffold and foundation — pnpm/TS/ESM project, `commander` CLI with `review` command flags and mutual-exclusion rules, config loader (TOML, zod, precedence, trust partitioning), typed `CodeninjaError`s, logger + telemetry recorder + run-artifact writers (run dir, `run.log`, `events.jsonl`, `.gitignore` provisioning, `retainRuns` pruning, credential stripping). → `components/skills_llm_telemetry.md` (telemetry half)
- [ ] Phase 2: Git layer and change inventory — `GitClient` subprocess chokepoint, input resolver for branch/commit modes plus bare default (PR mode deferred to Phase 6), diff parser (hunk ids, line mapping, statuses, anchors index), shared detector library + file classifier + Stage 2 filter pass. → `components/repository_and_github.md`
- [ ] Phase 3: Repository intelligence — tree-sitter service (WASM, grammar routing), Go/TS/JS/generic language adapters, Stage 4 changed-symbol extraction, the two v1 static-signal rules, path-containment chokepoint, all nine repository tools with revision reads and the ripgrep fast path, `PacketContext` assembly. → `components/context_and_tools.md`
- [ ] Phase 4: Skills, provider auth, and LLM runner — `codeninja provider` command namespace, `~/.codeninja/` paths, Pi provider/model registry integration, login/logout/auth-status/models/config commands, user-level provider/model/depth/reasoning defaults, skill loader, lens registry, prompt builder with projection maps and untrusted-content fencing, pi-runner (submit-tool structured outputs, TypeBox schemas, tool loop, budgets, abort timeouts, backoff, single provider/model/reasoning resolution), fake `LlmRunner` and fake provider registry for tests, author the four bundled skills. → `components/skills_llm_telemetry.md`
- [ ] Phase 5: Pipeline tracer bullet — orchestrator (`runReview`), planner dossier + planner + validation/fallbacks, packet builder, worker runner, Stage 7 packet review, Stage 9 pre-gates + verification, Stage 10 composer, Markdown/JSON renderers, failure/budget ladder + `RunCoverageStatus` + zero-work short-circuit. Milestone: `codeninja review --branch X` produces a real review end to end. Stage 8 is deferred; packet follow-up hints are recorded and surfaced as needs-human-attention notes. → `components/review_pipeline.md`
- [ ] Phase 6: GitHub integration — `GitHubClient`, `--pr` mode (ref fetching, fork PRs, shallow handling), anchor validation, own-comment listing for duplicate detection, publishing (single `COMMENT` review, 422 recovery, comment sanitization), `--post-github-comments`. → `components/repository_and_github.md`
- [ ] Phase 7: Model-call cache — normalized-request keys, per-call loop caching, integrity checks, eviction, `--cache`/`--no-cache`. → `components/skills_llm_telemetry.md`
- [ ] Phase 8: Evals — `codeninja eval` command, YAML case loading, expectation matching with coarse loss attribution, `--from-artifacts` re-scoring, compare-to-previous, plus a starter fixture-based eval suite that runs in CI. → `components/evals.md`
