# Issue 78: Stage-Grouped Telemetry Artifacts

Status: PENDING
Planned from: local telemetry review/debugging workflow discussion after comparing trails-api Opus runs, 2026-06-23
Planned at: commit `7ffa1e8` (branch `next`)
Recommended priority: medium. This is a developer-experience and eval-debuggability improvement: new run directories become stage-by-stage browsable with exactly one canonical home per artifact — no duplicate writes and no fallback reads.

> Executor instructions: each artifact has exactly ONE canonical location. Stage-owned artifacts are written only under `stages/<NN>-<slug>/`; run-level summaries under `stages/00-run/`; discovery files, append-stream files, and the human-readable final report stay at the run root. Do NOT duplicate any artifact to two locations, and do NOT add legacy/fallback read paths. This is a clean layout change: new runs use the new layout; old root-only runs are not migrated and are not read by updated readers.
>
> Drift check: `git diff --stat 7ffa1e8..HEAD -- src/telemetry/run-artifacts.ts src/evals/eval-artifacts.ts src/cli/review-progress.ts tests/telemetry.test.ts tests`
> If in-scope files changed since this plan was written, compare the "Current State" excerpts below against live code before editing.

## Problem

Codegenie run directories currently write most run artifacts at the telemetry root:

```text
resolved-input.json
diff.json
file-facts.json
planner-dossier.json
review-plan.json
hunk-relationships.json
candidate-findings.json
verification.json
final-selection.json
final-findings.json
telemetry.json
run.json
...
```

This is stable and script-friendly, but it is not ideal when manually reviewing a run stage by stage. During recent comparisons of Opus/GPT/2x-budget runs, the workflow repeatedly required mentally grouping root files into Stage 1 input resolution, Stage 5 planning, Stage 6 packet/context construction, Stage 7 packet review, Stage 9 verification, and Stage 10 composition.

The data already has clear stage ownership. The filesystem layout should make that visible for new runs.

## Current State

`src/telemetry/run-artifacts.ts` owns telemetry output. It has:

- `KNOWN_ARTIFACTS` (around line 51), a flat root-path allowlist of 29 artifact names;
- `writeArtifact(relPath, data)`, used by pipeline stages;
- `writeJson()` / `writeText()`, which already create parent directories;
- an allowlist guard:

```ts
function assertAllowedArtifactPath(relPath: string): void {
  const normalized = relPath.split(path.sep).join("/");
  if (KNOWN_ARTIFACTS.has(normalized) || /^packets\/[^/]+\.json$/.test(normalized)) {
    return;
  }
  throw new Error(`unknown run artifact path: ${relPath}`);
}
```

`src/evals/eval-artifacts.ts` loads eval telemetry from the flat root layout:

```ts
readRequiredJson(dir, "candidate-findings.json")
readOptionalJson(dir, "verification.json")
readOptionalJson(dir, "review-plan.json")
readOptionalJsonl(path.join(dir, "events.jsonl"))
loadPackets(path.join(dir, "packets"))
```

`src/cli/review-progress.ts` (around line 18) already has a canonical stage-name map `STAGE_LABELS: Record<ReviewStage | 0, string>` (`5: "planning review"`, `8: "checking follow-ups"`, …); `ReviewStage` is `1..11` (`src/types.ts:1`). There is no stage→directory-slug mapping today; add one once and share it (Design §1).

Note: `review-questions.json` is in `KNOWN_ARTIFACTS` but is no longer written by any pipeline stage (planner review questions were removed in Issue 66). It is vestigial; drop it rather than carry it into the new layout.

## Goal

A single, canonical, stage-grouped layout for new runs. Each artifact lives in exactly one place:

```text
<run>/
  run.json  telemetry.json  artifact-manifest.json
  run.log  events.jsonl  model-calls.jsonl  tool-calls.jsonl
  debug/            # only when debugTrace is enabled; raw diagnostics, not stage-owned artifacts
  final-review.md   # human-readable top-level review report
  stages/
    00-run/          error.json  cost-profile.json  model-calls-summary.json  tool-calls-summary.json
    01-input/        resolved-input.json
    02-diff/         diff.json  file-filter-decisions.json
    03-classify/     file-facts.json
    05-planner/      intent-signals.json  planner-dossier.json  planner-dossier-chunks.json  review-plan.json
    06-packets/      hunk-relationships.json  packets/<id>.json
    07-review/       # no durable JSON artifact today; data is in root streams/debug and later candidate materialization
    08-followups/    system-review-raw-tasks.json  system-review-tasks.json  system-review-results.json
    09-verification/ candidate-findings.json  uncertainty-promotion.json  verification.json
    10-composition/  coverage.json  budget-summary.json  final-selection.json  human-attention-notes.json  final-findings.json
    11-github-posting/
                     github-posting.json
```

Properties:

- **Exactly one home per artifact.** No artifact is written to both root and a stage dir.
- **No legacy/fallback reads.** Readers use the canonical location directly.
- Packet JSON moves with its stage: `stages/06-packets/packets/<id>.json`.
- Stage directory order matches pipeline order (numeric prefix → terminal sort).

Root holds only run discovery, append streams, the human-readable final report, and opt-in debug traces: `run.json`, `telemetry.json`, `artifact-manifest.json`, `final-review.md`, `run.log`, `events.jsonl`, `model-calls.jsonl`, `tool-calls.jsonl`, and `debug/` when `debugTrace` is enabled. `run.json` and `telemetry.json` stay at root because run retention, directory discovery, and ad hoc inspection use them as top-level entry points — they are run-level, not stage-owned, so this is not duplication. `final-review.md` stays at root because it is the primary human-readable review output, not a telemetry debugging artifact. `debug/` stays root because it is raw per-call diagnostics, not stage-owned review output. Notes:

- `coverage.json` → `stages/10-composition/`. In the normal path it is written once after Stage 10 composition has produced `finalReview.coverage` and any budget-stop marker has been applied. The zero-work path writes the same final artifact shape early, but keep one canonical path.
- `budget-summary.json` → `stages/10-composition/`. It is currently written by the pipeline after Stage 10 composition, not by telemetry finalization.
- `candidate-findings.json` → `stages/09-verification/`. It is materialized after Stage 8 and after Stage 9 uncertainty promotion has prepared verifier-bound candidates, so it is the candidate set entering verification, not a pure Stage 7 artifact.
- `uncertainty-promotion.json` → `stages/09-verification/`. It emits Stage 9 telemetry and mutates the verifier-bound candidate set.
- `final-review.md` → root. Although it is derived from the composed `ReviewResult`, it is the top-level human report users open first, so keep it outside `stages/` as an explicit exception. It still has exactly one canonical location.
- Stage 4 (`indexing symbols`) has no stable artifact today; reserve `stages/04-index/` for a future Stage 4 summary, do not invent one here.
- Stage 7 (`reviewing hunks`) has no stable JSON artifact today. Packet review results are consumed in memory, and the durable candidate set is written later after Stage 8/9 additions.
- Stage directory names are numeric + semantic so terminal sort matches pipeline order.

## Non-Goals

- No duplicate writes; an artifact is never written to two locations.
- No legacy/fallback read paths; do not keep root copies of stage-owned artifacts for old tooling.
- Do not migrate or rewrite historical run directories.
- Do not change pipeline stage numbering or `ReviewStage`.
- Do not split `events.jsonl` / `model-calls.jsonl` / `tool-calls.jsonl` by stage (they stay root append streams; a stage-filtered *view* is a separate follow-up — see Future Work).
- Do not change final review output semantics.

## Design

### 1. One canonical stage table (no third naming of stages)

Add a single shared table so the stage **slug** is derived once and cannot drift from the existing progress labels. Put this in a lightweight shared module such as `src/review-stages.ts` (or similar), not inside telemetry-specific code, so both `review-progress.ts` and `run-artifacts.ts` can depend on it without coupling progress UI to telemetry internals:

```ts
export const STAGES = [
  { stage: 0,  slug: "00-run",          label: "setup" },
  { stage: 1,  slug: "01-input",        label: "resolving input" },
  { stage: 2,  slug: "02-diff",         label: "parsing diff" },
  { stage: 3,  slug: "03-classify",     label: "classifying files" },
  { stage: 4,  slug: "04-index",        label: "indexing symbols" },
  { stage: 5,  slug: "05-planner",      label: "planning review" },
  { stage: 6,  slug: "06-packets",      label: "building review packets" },
  { stage: 7,  slug: "07-review",       label: "reviewing hunks" },
  { stage: 8,  slug: "08-followups",    label: "checking follow-ups" },
  { stage: 9,  slug: "09-verification", label: "verifying findings" },
  { stage: 10, slug: "10-composition",  label: "composing review" },
  { stage: 11, slug: "11-github-posting", label: "github posting" }
] as const;
```

Refactor `STAGE_LABELS` in `review-progress.ts` to derive from this table, so progress output, directory slugs, and the manifest `stageName` share one definition.

### 2. Canonical artifact map + single write

Replace the flat `KNOWN_ARTIFACTS` set with a map from logical artifact name to its one canonical relative path:

```ts
// run-artifacts.ts
const ARTIFACT_LOCATION: Record<string, string> = {
  "resolved-input.json":     "stages/01-input/resolved-input.json",
  "diff.json":               "stages/02-diff/diff.json",
  "review-plan.json":        "stages/05-planner/review-plan.json",
  "candidate-findings.json": "stages/09-verification/candidate-findings.json",
  "verification.json":       "stages/09-verification/verification.json",
  "final-findings.json":     "stages/10-composition/final-findings.json",
  "budget-summary.json":     "stages/10-composition/budget-summary.json",
  // run-level discovery stays at root:
  "run.json":                "run.json",
  "telemetry.json":          "telemetry.json",
  "artifact-manifest.json":  "artifact-manifest.json",
  "final-review.md":         "final-review.md",
  // ... full partition over every artifact ...
};
```

`writeArtifact(name, data)` accepts the current logical artifact names only, resolves `name` → canonical path via the map, and writes it **once** there (`writeText` for `.md`, `writeJson` for JSON). Pipeline call sites should keep passing logical names like `review-plan.json`; they should not pass physical paths like `stages/05-planner/review-plan.json`. Packets resolve `packets/<id>.json` → `stages/06-packets/packets/<id>.json`. Only the central map knows directories. `finalize()` summary writes route through the same map: `run.json` / `telemetry.json` stay at root, while `cost-profile.json`, `model-calls-summary.json`, and `tool-calls-summary.json` go to `stages/00-run/`. `artifact-manifest.json` is a root finalize artifact. `budget-summary.json` is not a telemetry-finalize summary today; it is a pipeline artifact written after Stage 10 composition, so it belongs in `stages/10-composition/`.

### 3. Artifact manifest

Emit a root `artifact-manifest.json` at finalize, indexing the canonical layout:

```json
{
  "schemaVersion": 1,
  "layoutVersion": 2,
  "artifacts": [
    { "id": "review-plan", "stage": 5, "stageName": "planning review", "kind": "json", "path": "stages/05-planner/review-plan.json" }
  ]
}
```

Each entry carries the one canonical `path` (no legacy/root alias). Include root streams and the root final report too, with their root paths:

```text
final-review.md  run.log  events.jsonl  model-calls.jsonl  tool-calls.jsonl
```

The manifest is a self-describing index for external tooling; readers do not depend on it (paths are canonical and known). If a run fails before finalize, the manifest may be absent — do not risk masking the original pipeline error to write it.

### 4. Readers use canonical paths (no fallback)

Update `src/evals/eval-artifacts.ts` to read the canonical stage paths directly:

```text
stages/09-verification/candidate-findings.json
stages/10-composition/final-findings.json
stages/10-composition/final-selection.json
stages/09-verification/verification.json
stages/05-planner/review-plan.json
stages/10-composition/coverage.json
stages/06-packets/packets/
stages/00-run/cost-profile.json
stages/00-run/model-calls-summary.json
stages/00-run/tool-calls-summary.json
stages/10-composition/budget-summary.json
run.json                # root discovery, unchanged
telemetry.json          # root discovery, unchanged
events.jsonl            # root stream, unchanged
model-calls.jsonl       # root stream, unchanged
tool-calls.jsonl        # root stream, unchanged
```

No stage-then-root probing, no try-both logic. `--from-artifacts` replay therefore requires a new-layout run directory. Keep `copyReviewOutput()` pointed at root `final-review.md`.

### 5. Allowlist enforces the partition

Rework artifact validation in two layers:

- Public `writeArtifact()` input validation accepts logical artifact names only (`review-plan.json`, `coverage.json`, `packets/<id>.json`) and rejects physical stage paths from call sites.
- Internal physical-path validation accepts exactly the resolved canonical paths (each mapped stage/root path, plus `stages/06-packets/packets/<id>.json`) and rejects (a) a stage-owned artifact written to root, and (b) a root-only artifact written under `stages/`.

The guard's job is to catch a miswired stage path, not just unknown names. Do not loosen it to arbitrary `stages/**`.

## In-Scope Files

- `src/review-stages.ts` or similar — shared `STAGES` table.
- `src/telemetry/run-artifacts.ts` — `ARTIFACT_LOCATION` map, single-write resolution, partition-enforcing allowlist, manifest; drop vestigial `review-questions.json`.
- `src/cli/review-progress.ts` — derive `STAGE_LABELS` from the shared `STAGES` table.
- `src/evals/eval-artifacts.ts` — read canonical stage/root paths (no fallback).
- `tests/telemetry.test.ts` — single-location writes; allowlist accepts canonical, rejects mislocated; partition exhaustiveness.
- Eval artifact-loader tests if present, or a focused new test for the staged layout.
- `specs/plans/README.md` — index/queue entry.

## Out of Scope

- Reorganizing, migrating, or reading historical root-only runs.
- Duplicate writes or fallback reads.
- Splitting root JSONL streams by stage.
- Changing telemetry event schemas or eval scoring logic.

## Implementation Steps

1. Add the shared `STAGES` table in a lightweight shared module; refactor `STAGE_LABELS` to derive from it.
2. Add `ARTIFACT_LOCATION` (the full partition) in `run-artifacts.ts`; remove the flat `KNOWN_ARTIFACTS` set and the vestigial `review-questions.json`.
3. Update `writeArtifact()` and packet writes to resolve name → canonical path and write once; route `finalize()` summaries through the same map (`run.json`/`telemetry.json` at root; `cost-profile.json`, `model-calls-summary.json`, and `tool-calls-summary.json` under `stages/00-run/`).
4. Rework artifact validation so public `writeArtifact()` accepts only logical names and internal resolved-path validation permits only canonical physical paths.
5. Emit `artifact-manifest.json` at finalize (canonical paths only).
6. Update `eval-artifacts.ts` readers to the canonical paths (no fallback); update packet loading to `stages/06-packets/packets/`.
7. Update tests; update `specs/plans/README.md`.

## Tests

- `writeArtifact("review-plan.json", …)` writes `stages/05-planner/review-plan.json` and creates **no** root `review-plan.json`.
- Packets are written only under `stages/06-packets/packets/<id>.json`.
- `finalize()` keeps root `run.json`, root `telemetry.json`, root JSONL streams, and root `debug/` when enabled; it writes telemetry-owned summaries (`cost-profile.json`, `model-calls-summary.json`, `tool-calls-summary.json`) under `stages/00-run/` with no root copies.
- `final-review.md` is written only at root, with no staged copy.
- `coverage.json` and `budget-summary.json` are written only under `stages/10-composition/`.
- `candidate-findings.json`, `uncertainty-promotion.json`, and `verification.json` are written only under `stages/09-verification/`.
- Root `packets/` is not pre-created for new runs.
- Public `writeArtifact()` accepts logical names and rejects physical stage paths from call sites; internal physical-path validation accepts every canonical path and rejects: a stage-owned artifact at root (e.g. `candidate-findings.json`), a root-only artifact under `stages/`, and unknown paths.
- **Partition exhaustiveness:** a test asserts every artifact the pipeline can emit is classified in `ARTIFACT_LOCATION` exactly once (stage or root) — so a future new artifact cannot silently skip the layout.
- `artifact-manifest.json` exists after finalize, lists canonical paths, and includes root streams.
- `loadEvalArtifacts()` loads a new-layout fixture run for candidates, final findings, final selection, verification, review plan, coverage, packets, cost profile, model/tool summaries, budget summary, root run metadata, root telemetry summary, and root model/tool/event streams.

## Validation

```bash
pnpm typecheck
pnpm test -- tests/telemetry.test.ts
pnpm test -- tests/evals.test.ts
```

Manual spot check on a small review run:

```text
.codegenie/runs/<run-id>/
  run.json
  telemetry.json
  artifact-manifest.json
  final-review.md
  stages/05-planner/review-plan.json
  stages/09-verification/candidate-findings.json
  stages/10-composition/coverage.json
  stages/10-composition/final-findings.json
  (no root review-plan.json / candidate-findings.json / final-findings.json)
```

## Risks and Mitigations

- **Clean break for historical runs.** Updated eval/replay readers will not read old root-only runs; external scripts referencing root artifact paths break. Mitigation: intended — old runs are throwaway; update any kept scripts to canonical paths. No fallback is added by design.
- **A reader is missed during the move.** Mitigation: update the official eval reader in the same change; the partition-exhaustiveness and load tests cover the canonical paths.
- **Stage-name drift.** Mitigation: one shared `STAGES` table feeds labels, slugs, and manifest; covered by tests.
- **A new artifact is added without a location.** Mitigation: the partition-exhaustiveness test fails until it is classified.

## Success Criteria

- New run directories are browsable by stage under `stages/`, with run-level discovery + streams at root, telemetry-owned summaries under `stages/00-run/`, and composition-produced summaries under `stages/10-composition/`.
- Stage 11 artifacts use `stages/11-github-posting/`.
- Every artifact has exactly one canonical location; no duplicates, no fallback reads.
- Eval artifact loading works on the staged layout.
- Stage slugs derive from a single shared table; the partition is exhaustively tested.
- No pipeline call site needs to know stage directory names.

## Future Work

- A read-side stage inspector (e.g. `codegenie inspect <run> --stage 7`) that lists a stage's artifacts and filters the root append streams (`events`/`model-calls`/`tool-calls`, which already carry a `stage` field) — this is where most stage-by-stage *tracing* value lives, beyond grouping the structured JSON files.
