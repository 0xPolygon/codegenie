# Issue 78: Stage-Grouped Telemetry Artifacts

Status: PENDING
Planned from: local telemetry review/debugging workflow discussion after comparing trails-api Opus runs, 2026-06-23
Planned at: commit `7ffa1e8` (branch `next`)
Recommended priority: medium. This is a developer-experience and eval-debuggability improvement: future run directories should be easier to inspect stage by stage, with a clean staged layout for newly-created runs while keeping historical root-layout telemetry readable.

> Executor instructions: do not migrate or rewrite old telemetry runs. For new runs, make `stages/<stage>/` the canonical artifact location. Keep only root-level discovery/stream files needed to identify and summarize a run. Teach artifact readers to understand both historical root-only runs and new staged runs.
>
> Drift check: `git diff --stat 7ffa1e8..HEAD -- src/telemetry/run-artifacts.ts src/evals/eval-artifacts.ts tests/telemetry.test.ts tests`
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

- `KNOWN_ARTIFACTS`, a root-path allowlist;
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

`src/evals/eval-artifacts.ts` loads eval telemetry from the root-level layout:

```ts
readRequiredJson(dir, "candidate-findings.json")
readOptionalJson(dir, "verification.json")
readOptionalJson(dir, "review-plan.json")
readOptionalJsonl(path.join(dir, "events.jsonl"))
loadPackets(path.join(dir, "packets"))
```

Eval runs copy the full telemetry directory recursively, so adding directories is mechanically safe, but readers and tests should understand the new layout deliberately.

## Goal

Make future telemetry runs easier to inspect by adding a stage-grouped artifact layout:

```text
stages/
  01-input/
  02-diff/
  03-classification/
  04-index/
  05-planner/
  06-packets/
  07-review/
  08-system-review/
  09-verification/
  10-composition/
  11-posting/
```

while preserving:

- historical run compatibility;
- root-level run discovery and stream files;
- historical packet JSON compatibility through reader fallback from `packets/`;
- existing `run.log`, `events.jsonl`, `model-calls.jsonl`, and `tool-calls.jsonl` root streams.

## Non-Goals

- Do not move or rewrite old telemetry runs.
- Do not keep ordinary stage-owned artifacts duplicated at the root in new runs.
- Do not change pipeline stage numbering.
- Do not change final review output semantics.
- Do not split model/tool/event JSONL streams by stage in this plan. That can be a later plan if the root streams remain too large to inspect.

## Design

### 1. Add a canonical stage artifact map

Define a single mapping from current logical artifact names to stage-grouped paths in `src/telemetry/run-artifacts.ts`.

For new runs, the following staged paths are canonical:

```text
stages/00-run/error.json
stages/00-run/budget-summary.json
stages/00-run/cost-profile.json
stages/00-run/model-calls-summary.json
stages/00-run/tool-calls-summary.json

stages/01-input/resolved-input.json

stages/02-diff/diff.json
stages/02-diff/file-filter-decisions.json

stages/03-classification/file-facts.json

stages/05-planner/intent-signals.json
stages/05-planner/planner-dossier.json
stages/05-planner/planner-dossier-chunks.json
stages/05-planner/review-plan.json
stages/05-planner/review-questions.json

stages/06-packets/hunk-relationships.json
stages/06-packets/packets/<id>.json
stages/06-packets/coverage.json

stages/07-review/candidate-findings.json
stages/07-review/uncertainty-promotion.json

stages/08-system-review/system-review-raw-tasks.json
stages/08-system-review/system-review-tasks.json
stages/08-system-review/system-review-results.json

stages/09-verification/verification.json

stages/10-composition/final-selection.json
stages/10-composition/human-attention-notes.json
stages/10-composition/final-findings.json
stages/10-composition/final-review.md

stages/11-posting/github-posting.json
```

Notes:

- `coverage.json` is produced after verification today, but it represents run coverage over planned/built/reviewed packets. Put it in `06-packets` for human inspection unless implementation strongly prefers `10-composition` or `00-run`.
- Stage 4 currently has no stable root artifact. Do not invent a large repo-index dump in this plan. If a later Stage 4 summary artifact is added, place it under `stages/04-index/`.
- Keep stage directory names numeric and semantic so terminal sort order matches pipeline order.

### 2. Keep only root discovery and stream files

For new runs, root should contain only:

```text
run.json
telemetry.json
artifact-manifest.json
run.log
events.jsonl
model-calls.jsonl
tool-calls.jsonl
```

`run.json` and `telemetry.json` stay at root because run retention, directory discovery, summaries, and ad hoc inspection use them as top-level entry points. They may also be mirrored to `stages/00-run/` if implementation wants complete staged browsing, but they must remain root-level.

All ordinary stage-owned artifacts should be written only to staged paths in new runs:

```text
stages/05-planner/review-plan.json
stages/06-packets/packets/<id>.json
stages/07-review/candidate-findings.json
stages/09-verification/verification.json
```

Do not make pipeline call sites aware of stage paths. Keep the mapping centralized in telemetry.

### 3. Add an artifact manifest

Add a root artifact:

```text
artifact-manifest.json
```

with entries like:

```json
{
  "schemaVersion": 1,
  "layoutVersion": 2,
  "artifacts": [
    {
      "id": "review-plan",
      "stage": 5,
      "stageName": "planner",
      "kind": "json",
      "legacyRootPath": "review-plan.json",
      "stagePath": "stages/05-planner/review-plan.json"
    }
  ]
}
```

The manifest gives debugging tools and eval tooling a stable index without forcing readers to hard-code every path. For stage-owned artifacts, `stagePath` is the canonical path. `legacyRootPath` documents where the same artifact lived in historical runs; it is not written for new runs.

It should include root streams too, with no `stagePath` when they are intentionally root-only:

```text
run.log
events.jsonl
model-calls.jsonl
tool-calls.jsonl
```

### 4. Teach eval artifact loading to support both layouts

Update `src/evals/eval-artifacts.ts` so artifact readers try stage paths first, then historical root paths:

```text
stages/07-review/candidate-findings.json
candidate-findings.json
```

Stage-first makes the new layout canonical. Root fallback preserves old telemetry and copied eval run compatibility.

For packets, support both:

```text
stages/06-packets/packets/
packets/
```

For JSONL streams, keep root-only in this plan.

### 5. Update the artifact allowlist

Extend `KNOWN_ARTIFACTS` / `assertAllowedArtifactPath()` to allow:

- `artifact-manifest.json`;
- every mapped `stages/<stage-dir>/<artifact>` path;
- `stages/06-packets/packets/<id>.json`.

Root-level stage-owned artifact paths should no longer be allowed for new write call sites, except where the compatibility reader deliberately supports them for old runs. Do not loosen the allowlist to arbitrary `stages/**` writes. The guard exists to catch accidental artifact churn.

## In-Scope Files

- `src/telemetry/run-artifacts.ts` — central stage path mapping, canonical staged writes, manifest generation, allowlist.
- `src/evals/eval-artifacts.ts` — stage-first/root-fallback artifact loading.
- `tests/telemetry.test.ts` — artifact allowlist and write behavior tests.
- Eval artifact-loader tests if present, or a focused new test for stage fallback.
- `specs/plans/README.md` — index entry.

## Out of Scope

- Reorganizing existing run directories.
- Removing root discovery/stream artifacts.
- Splitting root JSONL streams by stage.
- Changing telemetry event schemas.
- Changing eval scoring logic.

## Implementation Steps

1. Add `STAGE_ARTIFACT_PATHS` or equivalent mapping in `run-artifacts.ts`. This mapping should take the current logical artifact name used by pipeline call sites and return the canonical staged path for new writes.

2. Add helpers:

   ```ts
   function canonicalArtifactPath(logicalRelPath: string): string
   function legacyRootArtifactPath(stageRelPath: string): string | undefined
   function writeCanonicalArtifact(logicalRelPath: string, data: unknown): void
   ```

   Keep `writeArtifact()` call-site semantics unchanged.

3. Update `writeArtifact()`:
   - accept the existing logical artifact names from pipeline call sites;
   - resolve them to canonical staged paths;
   - write only the staged artifact for stage-owned files;
   - use `writeText` for `.md` artifacts and `writeJson` for JSON artifacts.

4. Update `finalize()` summary writes:
   - keep root `run.json` and root `telemetry.json`;
   - write `model-calls-summary.json`, `tool-calls-summary.json`, `cost-profile.json`, and `budget-summary.json` under `stages/00-run/`;
   - optionally mirror `run.json` and `telemetry.json` to `stages/00-run/` for complete staged browsing, but do not remove root copies.

5. Add `artifact-manifest.json` generation during finalize. If the run fails before finalize, it is acceptable for the manifest to be absent; do not risk masking the original pipeline error. If implementation can write a partial manifest cheaply at attach time, that is optional.

6. Update artifact path validation so pipeline call sites may still pass existing logical artifact names, but physical new writes permit only:
   - root discovery/stream paths;
   - known mapped stage artifacts;
   - stage packet artifacts;
   - `artifact-manifest.json`.

   Historical root artifact paths should be supported by readers, not by new writers.

7. Update eval artifact readers:
   - add `readJsonWithFallback(dir, stagePath, legacyRootPath)`;
   - add `readOptionalJsonlWithFallback` only if a future JSONL mirror is added; otherwise leave JSONL root-only;
   - update packet loading to prefer `stages/06-packets/packets` and fallback to root `packets`.

8. Update tests.

## Tests

Add/adjust tests for:

- A telemetry run writes `stages/05-planner/review-plan.json` and does not write root `review-plan.json`.
- Packet artifacts are written to `stages/06-packets/packets/<id>.json` and not root `packets/<id>.json`.
- Finalize keeps root `run.json`, root `telemetry.json`, and root JSONL streams.
- Finalize writes summaries such as `model-calls-summary.json`, `tool-calls-summary.json`, and `cost-profile.json` under `stages/00-run/`.
- `artifact-manifest.json` exists after finalize and marks staged paths as canonical while documenting legacy root paths where applicable.
- `assertAllowedArtifactPath` rejects unknown root artifacts, old root stage-owned artifacts for new writes, and unknown `stages/**` artifacts.
- `loadEvalArtifacts()` can load:
  - old root-only telemetry;
  - new staged telemetry with only root discovery/stream files;
  - staged fixture for at least candidates, final findings, verification, review plan, coverage, and packets.

## Validation

Run:

```bash
pnpm test -- tests/telemetry.test.ts
pnpm test -- tests/evals.test.ts
pnpm typecheck
```

If the repo does not have a focused eval-artifact test file, run the full test suite:

```bash
pnpm test
```

Manual spot check on a small review or eval run:

```text
.codegenie/runs/<run-id>/
  run.json
  telemetry.json
  artifact-manifest.json
  stages/05-planner/review-plan.json
  stages/07-review/candidate-findings.json
```

## Risks and Mitigations

- **Clean break misses a reader.** Moving ordinary artifacts out of the root can break any reader that is not updated. Mitigation: update official eval artifact loading in the same change, add tests for old and new layouts, and keep root `run.json`/`telemetry.json` for run discovery.

- **Path mapping drifts from pipeline ownership.** Mitigation: keep one central map and cover representative artifacts in tests.

- **Old tooling assumes root-only layout.** Mitigation: official readers support both layouts. Ad hoc scripts should switch to `artifact-manifest.json` or staged paths for new runs.

- **New tooling cannot find summary files at root.** Mitigation: keep root `run.json`, `telemetry.json`, and JSONL streams; put summary JSON paths in `artifact-manifest.json`.

## Success Criteria

- New telemetry runs are browsable by stage under `stages/`.
- New telemetry runs do not duplicate ordinary stage-owned artifacts at root.
- Existing eval and comparison commands still work on old root-only runs.
- Eval artifact loading works with both root and stage-grouped layouts.
- No pipeline stage call sites need to know the stage directory names.
