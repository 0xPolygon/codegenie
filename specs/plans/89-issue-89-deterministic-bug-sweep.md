# Issue 89: Deterministic Bug Sweep (Phases A/B)

Status: PENDING
Planned from: fable review §3 bugs 5, 9, 11-20 and §2.4 drift items (`specs/reviews/1-fable-review.md`); spot-verified against commit `00617d79` (file-classifier first-match, `a...b` validation, tree-sitter eviction), 2026-07-02
Planned at: commit `00617d79` (branch `next`)
Recommended priority: split. **Phase A (Wave 1 in `PUNCHLIST.md`)**: items that distort the eval/measurement signal — these must precede the Issue-79 baseline campaign. **Phase B (Wave 4)**: hygiene with no measurement impact. Every item is deterministic, small, and independently landable; each gets its own commit + test so a regression bisects to one item.

## Phase A — eval-signal integrity (before the baseline campaign)

**A1. Eval scorer must not crash on missing artifacts** (fable bug 13; evidence: run `0c4d5213/24` died with `invalid_args: unknown run artifact path: system-review-tasks.json`). A review failure or absent optional artifact scores as unmatched-with-disclosure (`artifact unreadable: <path>`), never as a scorer crash that destroys the run's data point. Files: `src/evals/eval-scoring.ts`, `eval-artifacts.ts`. Test: score a run dir with a missing artifact → status computed, disclosure recorded.

**A2. Reject `a...b` eval targets explicitly** (bug 14; verified: `"a...b".split("..")` → `["a", ".b"]` passes the current check at `eval-runner.ts:215-219`). Validate with a strict pattern (`/^[^.]+(\.\.)[^.]+$/`-shaped, or reject any `...` substring) and a message naming the three-dot mistake. Test: `a...b` → clear validation error; `a..b` → accepted.

**A3. Coverage aggregation corrections** (bug 19). `aggregateRunCoverage` (`review-runner.ts:928-946`) under-counts `coverageByLevel` for packet-less hunks; safety-coverage decisions are mislabeled `source: "planner"` (`:1193-1198`) — both pollute exactly the coverage fields the eval scorer and the Issue-79 harness read. Tests: fixture with packet-less hunks → levels sum to `totalHunks`; recovery-upgraded coverage carries its true source.

**A4. Static-signal binding hygiene** (bug 17). Side-less signals can bind to the wrong hunk (`planner.ts:1478-1518`); line-less signals attach to every hunk of the file (`packet-builder.ts:1215-1226`), inflating packet context and planner risk weighting. Bind side-less signals only when unambiguous (single candidate hunk), else attach at file level with an `ambiguous_binding` marker; line-less signals attach once per file, not per hunk. Tests per shape.

**A5. Configured skip rules: last-match wins** (bug 5; verified `effectiveConfiguredSkip` in `file-classifier.ts` returns on first `processingMode`-bearing match). The classification layer and spec expect last-match precedence, so `[{pattern:"**", processingMode:"per-hunk"}, {pattern:"src/legacy/**", processingMode:"skip"}]` currently reviews `src/legacy/**`. Align to last-match; changes review *scope* determinism, so it belongs before baselining. Test: the two-rule example skips `src/legacy/**`.

## Phase B — hygiene (Wave 4, no measurement impact)

**B1. Tree-sitter parse-tree disposal** (bug 9). Evicted `CachedParse` entries never call `tree.delete()` (`tree-sitter-service.ts` `remember()`, verified) — WASM heap growth on large reviews; also replace the raw-content-string cache-key fallback (retains large strings) with a content hash. Test: eviction calls `delete()` exactly once per evicted tree.

**B2. Per-stage runtime double-counting** (bug 11) in `telemetry.json` on repeated stage lifecycle events (`run-artifacts.ts:1060-1068`). Idempotent per stage; test with a duplicated `stage_started`/`stage_completed` sequence.

**B3. Crashed-run pruning** (bug 12). `pruneRuns` requires `run.json` (`run-artifacts.ts:1953`), so crashed run dirs accumulate forever. Prune by directory mtime when `run.json` is absent (age threshold, e.g. retain-count-equivalent); test with a fabricated crashed dir.

**B4. Stop mutating existing `.codegenie/.gitignore`** (§2.4 drift; `run-artifacts.ts:1910-1929`). Create-if-absent only; architecture law says never modify an existing `.codegenie/`.

**B5. Go value-receiver rendering** (bug 15). `func (s Store) Clone()` renders as `(*Store).Clone` in prompts/facts (`go-adapter.ts:92-99`). Render `(Store).Clone` for value receivers; snapshot test.

**B6. HTTP-status regex mining false positives** (bug 16). `pi-runner.ts:3011-3018` classifies "context of 500 tokens" as a retryable 500. Anchor the pattern to status-code contexts (e.g. `\b(?:status|code|HTTP)\D{0,4}(5\d\d)\b`-shaped); table-driven tests including the "500 tokens" false-positive string.

**B7. Extra submit calls: telemetry instead of silent drop** (bug 18). Second `submit_review` call in one response is dropped without a trace (`pi-runner.ts:277,307`) — findings split across two submits vanish. Emit `extra_submit_dropped { callId, droppedToolCallCount }`; no behavior change (merging payloads is submit-ladder territory, deliberately out of scope per fable §2.3).

**B8. Small-races-and-clamps cluster** (bug 20): stale-lock takeover race in the PR-ref lock (`review-runner.ts:593-613`; re-stat before takeover); `packet-context.ts:210-221` `endsWith` symbol matching picking a wrong enclosing symbol (require segment boundary); `relatedContextOmitted.hunkId` carrying a CSV of ids (`packet-builder.ts:868-895` — emit an array); `readRange` past-EOF returning degraded-empty instead of the spec'd clamp.

**B9. Identity/paths leftovers** (§2.4): eval engine runId is the constant `"telemetry"` (`review-runner.ts:395`) — mint a real run id and thread it through eval `info.json` joins; README spec-path typo (`specs/projects/codegenie/` → `specs/project/`); `--from-artifacts` old-layout replay either fixed or explicitly erroring with "old layout unsupported" (the compare-side handling belongs to Issue 83 — coordinate, don't duplicate).

## Non-Goals

- Anything requiring measurement or posture judgment (those live in Waves 2-3 plans).
- The submit/salvage-ladder consolidation, similarity-module dedup, adaptive-context deletion, ripgrep decision — simplification backlog items with their own future plans.
- Fixing the eval scorer leniency stack (D8 — a decision, not a bug).

## Sequencing & Validation

- Phase A lands as five independent commits before the Issue-79 baseline campaign; Phase B fills slack any time after, one commit per item.
- Each item ships with its named test; `pnpm run typecheck && pnpm test && pnpm run build` green per commit.
- Phase A explicitly documents expected metric shifts (A3 changes coverage numbers; A5 can change reviewed-hunk counts on repos using skip rules) so the first post-sweep eval runs are not misread as regressions.
- Phase B7/B9 telemetry additions verified by grepping one live run's artifacts.

## Done Criteria

- All Phase-A items landed and test-pinned before the first baseline campaign run; no scorer crash, mis-scoped skip rule, or coverage miscount can contaminate baseline data.
- Phase B items each independently landed with tests; none changes review findings on the fixture suite.

## Stop Conditions

- If any "small" item turns out to require design judgment mid-implementation (e.g. A4's ambiguity rules growing branches), stop and split it into its own plan rather than growing this sweep.
