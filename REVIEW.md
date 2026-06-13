# codeninja — Source Code Review (Phases 1–8)

Spec-aware deep review of the committed implementation at `d23a62f` (base `7bdea4f`, "spec ready"), against `specs/projects/codeninja/` — `project_overview.md`, `functional_spec.md`, `architecture.md`, and the five `components/*.md`. Scope is the committed phases 1–8 only; the uncommitted Phase 9 (evals) working-tree changes were excluded, and the seven tracked files with uncommitted Phase 9 edits were reviewed at their HEAD versions.

The review ran as 11 focused passes (8 spec-area + security, dependency, test-quality). Per-pass detail lives in `reviews/projects/codeninja/phase_*_feedback.md`; this is the consolidation.

## What This Codebase Is

A TypeScript CLI that reviews pull-request-style diffs through a staged, telemetry-rich AI pipeline: resolve target → parse diff → filter/classify → changed-symbol extraction → planner → packet builder → lens review workers → verifier → composer → optional GitHub publish, with read-only repository tools (tree-sitter + git plumbing) given to the model instead of dumping the repo into context. ~16k lines of source across 64 files, ~12k lines of tests (231 passing).

## Overall Assessment

**This is a high-quality, faithful implementation of an unusually detailed spec.** Across every phase the reviewers independently found that the load-bearing invariants hold: the config precedence chains and trust partition, merge-base semantics, hunk-id hashing and line mapping, deleted-file scope retention, path-containment chokepoint, argv-only subprocess spawning, untrusted-content fencing, packet identity and hunk-loss-safety through compaction/chunking, the Stage 9 gate ladder with critical/high protection, cap enforcement that never displaces verified critical/high findings, and the cache-key normalization all match the spec. The security posture is genuinely enforced in code (no exploitable critical/high findings), and the dependency posture is exemplary (exact pinning, no postinstall downloads, clean adapter boundary).

The issues found are concentrated in **edge-case correctness, failure/degradation paths, and observability** — exactly the areas that are hardest to get right and easiest to defer. None is a security hole. Several are worth fixing before this sees large or unusual real-world diffs, or before the eval system (Phase 9) is trusted, because a few defects quietly undermine the "never lose review work" and "measurable, not vibes" promises that are central to the product thesis.

### Issue Counts

| Phase | Area | Critical | Moderate | Mild |
|---|---|---:|---:|---:|
| 1 | CLI, Config & Provider | 1 | 5 | 11 |
| 2 | Git Layer & Change Inventory (1–3) | 0 | 5 | 12 |
| 3 | Repository Intelligence & Tools (4 + tools) | 1 | 6 | 8 |
| 4 | Skills, Prompts & LLM Runner | 2 | 6 | 9 |
| 5 | Planner & Packet Builder (5–6) | 0 | 3 | 5 |
| 6 | Review Exec, Verify & Compose (7,9,10) | 0 | 3 | 7 |
| 7 | GitHub Integration & Publishing (11) | 0 | 4 | 4 |
| 8 | Telemetry, Redaction & Cache | 1 | 4 | 6 |
| 9 | Security (cross-cutting) | 0 | 1 | 4 |
| 10 | Dependencies | 0 | 0 | 5 |
| 11 | Test Quality | 4 | 11 | 6 |
| **Total** | | **9** | **48** | **77** |

Note: the 5 production-code criticals are in phases 1, 3, 4 (×2), and 8. The 4 criticals in phase 11 are **test-coverage gaps**, not runtime bugs.

## Critical Issues (production code)

These five most directly undermine spec guarantees. All were verified by the reviewers (several with executable repros).

1. **Repo root is resolved from `cwd`, not the git worktree toplevel — repo `codeninja.toml` is silently ignored from any subdirectory.** (`src/cli/review-command.ts:110`, `src/config/config-loader.ts:108`)
   `repoRoot = process.cwd()` and config is loaded only from `<repoRoot>/codeninja.toml`. Running `codeninja review` from a subdirectory (normal git usage; the spec only requires being "inside a worktree") silently skips all repo policy — depth, base branch, lens enable/disable, classification path rules, **and Stage 2 skip rules** — with no warning. Worse, the pipeline is internally inconsistent: the input resolver and repository tools use the real `git rev-parse --show-toplevel`, while run-artifact and PR-lock dirs use the cwd root, so `.codeninja/runs/` and `.codeninja/locks/` scatter into the invocation directory. This is a trust-relevant correctness bug. **Fix:** resolve the git toplevel once, before `loadConfig`, and use that single root everywhere.

2. **The ripgrep "fast path" spawns one `git ls-tree` subprocess (plus 2 `realpath`s) per tracked file on every search call — and a spawn failure rejects instead of falling back.** (`src/repo/search.ts:164-199, 428-442`)
   `tryRipgrep` enumerates all tracked files and validates each with its own `git ls-tree` subprocess — up to 5,000 sequential spawns (~10–30s) per `searchFiles`/`findSymbolMentions`, none of them behind the mandated `p-limit(8)` semaphore, repeated across concurrent workers. The "fast path" is orders of magnitude slower than the `git grep` it's meant to beat. Separately, passing 5,000 paths as argv can exceed `ARG_MAX`; `spawn` then errors and `runRipgrepCapped` **rejects the whole tool call** instead of degrading to git grep, violating the never-block contract. **Fix:** compute the safe path set once per snapshot from a single `ls-tree -r`, cache it, treat spawn errors as fall-back-to-git-grep, and route spawns through the semaphore (or return to the spec's `--glob`-translation design that needs no path list).

3. **Post-backoff transient provider failures (429/5xx/network) are marked `recoverable: false`, so a sustained rate-limit burst kills the entire run and discards all completed review work.** (`src/llm/pi-runner.ts:926-932`)
   The spec is explicit: transient failures surviving the 3-retry backoff reject `recoverable: true`; only auth/provider-wide failures are run-fatal. Here `recoverable: false` propagates through `lens-runner`/`planner` as fatal, so a 429 burst — entirely plausible with parallel workers on one provider — aborts at Stage 7 rather than marking the affected hunks `review_failed` and degrading per the budget ladder. A test (`phase4-llm.test.ts:1006`) deliberately encodes this deviation. **Fix:** make post-backoff 429/5xx/network `recoverable: true` (auth stays fatal), or consciously amend the spec.

4. **Budget-checkpoint exhaustion throws instead of entering forced finalization, throwing away a worker's gathered evidence mid-task.** (`src/llm/pi-runner.ts:329-341`)
   On `checkpoint → "exhausted"` the runner throws `llm_call_failed`/`budget_exhausted`. The spec's agent loop requires entering finalization (one forced submit call over the evidence already in the conversation) instead. A packet worker that spent several tool rounds gathering evidence discards it all — exactly the "completed review work must never be lost" failure the spec calls out. Code, component spec, and the spec's own test plan disagree. **Fix:** implement finalize-on-exhaustion with the finalize call exempted from the checkpoint, or amend the spec.

5. **The entire pipeline-metrics half of `telemetry.json`/`run.json` is hardcoded zeros — the folding layer was never built.** (`src/telemetry/run-artifacts.ts:255, 663-683`)
   `pipelineSummary` (workers, packets, lenses, coverage, candidates, verdicts, dedup, final-selection, posting) and `runTotals()` pipeline counts are initialized empty and **never updated** anywhere in the repo. Per-worker runtime has no structure at all. The pipeline emits events, but nothing folds worker/packet/candidate/verdict/dedup/posting events into the summary — so every eval or human reading telemetry concludes the run produced nothing. Writing confident zeros is worse than omitting the fields, and a test (`telemetry.test.ts:265-283`) pins the all-zero output. This directly undercuts the product's "review quality is measurable, not vibes" thesis and the Phase 9 eval system that depends on these artifacts. **Fix:** define the well-known event names and fold them into `pipelineSummary` in `recordEvent` (mirroring the existing `model_call_cache_write` folding); or, if deferred, omit/mark the fields rather than reporting zeros, and write the deferral down.

## Cross-Cutting Themes

Three patterns recur across phases and are worth addressing as themes, not just point fixes:

- **Secret redaction is incomplete at several sinks.** Phases 1, 6, 8, and 11 each found a gap: the final CLI stderr error path writes the raw message unscrubbed (`main.ts:29-33`); the review report printed to **stdout** bypasses the `scrubGitHubSecrets` applied to the on-disk copy (`review-runner.ts:842-845`) — a real token-to-CI-log leak; cache-put strips credentials but the live conversation prefix doesn't, diverging replay bytes and corrupting cached content (`model-call-cache.ts:96`); and the git subprocess path doesn't scrub private keys the way the gh path does (locked in by `git-client.test.ts:50`). The redaction primitive is sound; it just isn't uniformly applied. Recommend a single scrub-at-the-sink chokepoint covering all of stdout, stderr, artifacts, and cache.

- **Several tests certify spec deviations rather than catch them.** Phase 4's two criticals, Phase 6's duplicate-record shape, Phase 7's premature 422 collapse, and Phase 8's all-zero telemetry are each pinned by a passing test. The suite is strong (see below), but in these spots it has frozen "what the code does" in place of "what the spec requires." Each needs either a code fix or a deliberate, written spec amendment — not silent divergence.

- **Dead/duplicated code that is a divergence trap.** The symlink-escape guard `assertWorktreeContained` is dead (phases 3, 9) while the synchronous tool chokepoint does no symlink resolution — safe today only because all reads go through git plumbing, but a regression hazard the moment a worktree `fs.readFile` is added. Two divergent fingerprint implementations exist, the "canonical" one dead (phase 7). A second independent `config.toml` parser lives in provider-services (phase 1). `cliLenses`/`cacheOverride` are dead duplicate state (phase 1). `deterministicDeclaredIntent` is duplicated across planner and packet-builder (phase 5). Each is self-consistent now and a latent bug the first time a second consumer or maintainer touches it.

## Moderate Issues by Area (selected)

- **Diff parser (Phase 2):** `new file mode`/`deleted file mode` wrongly trigger `modeOnly` (empty added/deleted files and rename+chmod misreported); a `diff --git` header mixing one C-quoted and one plain path **fatally fails the whole parse** despite the spec promising C-quoted support; `parentShas` scans the commit message body, breaking root-commit review when a message line starts with "parent ". All three reproduced.
- **Stage 2 scaling (Phase 2):** ~3 sequential git subprocesses per changed file (unbatched `check-ignore`, per-file content reads, a symlink-backfill `ls-tree` for every non-symlink file) — ~900 serial spawns on a 300-file PR before any review starts.
- **Tree-sitter lifetime (Phase 3):** LRU eviction calls `tree.delete()` on trees still shared with in-flight workers — use-after-free on the WASM heap under concurrency once >128 files churn the cache.
- **Model-facing metadata (Phase 3):** git-grep fallback wrongly sets `degraded: true` (one out-of-repo symlink degrades *every* search for the run), and `omittedCount` mixes lines/chars/match-units across tools, making the counts the model weighs evidence by meaningless.
- **Stage 4 fidelity (Phase 3):** `HunkSymbolFacts.changedLines` drops changed lines outside the primary enclosing symbol, under-counting what changed.
- **Disclosure gaps (Phase 4):** "lens whose only skills failed → disabled with disclosure" is unimplemented; `cacheStatus: "write"` is never recorded (breaks the `model-calls-summary.json` eval contract); the untrusted-fence label is derived from the model-supplied tool name (narrow injection vector); no containment re-check for repo-sourced `extraSkillPaths`.
- **Composer/verifier (Phase 6):** `isNoFindingsSummary` can discard a valid model summary that merely mentions an absence; verified clusters re-materialize duplicate members as independent findings (double-report risk if category/lens differ).
- **GitHub 422 recovery (Phase 7):** collapses to summary-only one attempt too early (losing otherwise-valid inline comments, pinned by a test); missing the spec's "deleted-file" suspect class; 422 detection is a regex over the whole error blob rather than the structured `{httpStatus, responseBody}` the spec mandates, so the identified-drop path is effectively dead against real GitHub payloads.
- **Telemetry/cache (Phase 8):** redaction-at-cache-put diverges replay bytes (false positives on ordinary code like `token = getAuthToken()`); shared (non-cyclic) object refs are falsely replaced with `[redacted:circular]`, silently corrupting artifacts; `.codeninja/.gitignore` isn't provisioned when the cache or lock dir creates `.codeninja/` first; run pruning can delete a concurrent active run's directory (jsonl appends don't bump dir mtime).
- **Planner (Phase 5):** per-file (not per-hunk) static-signal attachment in planned-hunk records; deletion-hunk proximity coalescing mixes old/new-side coordinates; invalid-skip on a compacted-away hunk yields core lenses but no language lens.
- **Security (Phase 9):** the one moderate is the dead `assertWorktreeContained` regression hazard above; all six mandated security properties otherwise hold.

The mild items (77) are documented per-phase and are mostly polish: wording mismatches, dead ternaries, minor metadata nits, micro-optimizations, and small spec-conformance gaps.

## Test Quality (Phase 11)

The suite is genuinely above-average: real git repos via a helper harness, real tree-sitter parses against committed fixtures, the **real** `PiRunner` agent loop driven through injected fake adapters (not module-mocking), and an exemplary end-to-end `runReview` test in phase 6. The production fake `LlmRunner` is correctly confined to artifact-plumbing tests.

Its weaknesses are spec-mandated edge/degradation/security paths with no or weak coverage — the 4 "critical" test gaps:
- **Hunk-id canonical serialization has no golden vector and no shift-sensitivity test** — the single most load-bearing parser invariant (GitHub anchoring, packet ids, fingerprints, and the cache key all build on it) is unprotected; a wrong separator or field order would pass every test.
- **`copied`/symlink/submodule statuses and C-quoted/octal path unquoting are entirely untested** (the riskiest string code in the parser).
- **Subprocess hygiene** (no-shell, `--`-before-pathspecs, credential-scrubbing at the error boundary) has no test — this is the fork-PR injection defense.
- **The `path_outside_repo` agent-loop telemetry warn** (a review-manipulation signal) appears unimplemented and is masked by a factory-level-only test.

High-value moderate gaps: config precedence chains are tested with all layers set at once, so individual rungs (settings.json > config.toml, the full depth chain, `--reasoning auto`) would pass even if inverted; two of nine repository tools (`list_files`, `read_range`) have no real coverage and `meta.precision`/`meta.backend` provenance is asserted nowhere; Stage 2 first-match precedence and deleted-file degradation are untested; several publisher branches are uncovered.

## Dependencies (Phase 10)

Clean. Every runtime dep is exact-pinned, lockfile specifiers match the manifest 1:1, all declared deps are actually imported, `@earendil-works/pi-ai` is imported only behind its adapter (`src/llm`, `src/provider`), and the two security-critical commitments hold: **no postinstall binary downloads** (`@vscode/ripgrep@1.18.0` ships per-platform binaries via optional deps; tree-sitter `.wasm` ships in-tarball) and `pnpm audit --prod` is clean with no production copyleft. Mild notes only: unused native-addon transitives ride along behind the WASM grammars, a benign duplicate `tree-sitter-javascript`, and the TS grammar lags a minor behind the Go/JS grammars versus the "pinned together" intent.

## Recommended Priority

1. **Fix the five production criticals** — repo-root resolution (#1), ripgrep fast path (#2), the two runner failure-semantics deviations (#3, #4), and telemetry folding (#5). #3/#4/#5 each undercut a core product promise.
2. **Close the redaction sinks** as one unified scrub-at-output pass (stdout, stderr, artifacts, cache) — currently four separate gaps.
3. **Fix the reproduced diff-parser bugs** (mode-only, mixed-quoted rename header, `parentShas`) and the Stage 2 / repository-tool subprocess scaling before large or fork-PR real-world diffs.
4. **Reconcile the tests that pin spec deviations** — for each, decide fix-vs-amend and write it down, so the suite stops certifying divergence.
5. **Add the missing high-value tests** — hunk-id golden vector + sensitivity, subprocess hygiene, rare diff statuses, tool provenance, and isolated precedence-chain rungs.
6. **Remove the dead/duplicated traps** (second config.toml parser, dead fingerprint, dead worktree guard, dead `cliLenses`/`cacheOverride`).

Full per-issue detail with file:line references and reproduction notes is in `reviews/projects/codeninja/phase_1_feedback.md` … `phase_11_feedback.md`.
