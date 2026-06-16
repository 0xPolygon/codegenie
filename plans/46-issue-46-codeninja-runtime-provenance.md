# Issue 46: Codeninja Runtime Provenance in Eval and Telemetry

Status: COMPLETE
Planned from: eval/debugging workflow, 2026-06-16
Recommended priority: small observability item; implement before the next serious eval comparison

## Problem

Eval runs and review telemetry are hard to compare unless we know exactly which codeninja code produced them.

Today the telemetry path has a legacy `codeninjaVersion` field, but it is package-version oriented. In development and eval workflows, many runs happen from source on the same package version, often with uncommitted changes. That makes `0.1.0` insufficient for answering:

- Which codeninja commit produced this eval result?
- Was the worktree dirty?
- Was the run from an installed build or from the source checkout?
- Did two eval logs actually run the same codeninja code?

This should be recorded as first-class runtime provenance in both normal review telemetry and eval logs.

## Goals

- Record codeninja runtime provenance in every review/eval run.
- Include the package version, git commit hash, short commit hash, branch name, and dirty-worktree state when available.
- Prefer build-time embedded metadata when present, so installed builds still know their source revision.
- Fall back to runtime git inspection when running from source.
- Keep the existing `codeninjaVersion` field for compatibility, but add a richer structured field.
- Never fail a review or eval just because version metadata cannot be resolved.

## Non-Goals

- Do not require the codeninja worktree to be clean.
- Do not hash or snapshot the full codeninja source tree.
- Do not mix codeninja runtime provenance with the target repository revision being reviewed.
- Do not make eval scoring depend on the codeninja commit.
- Do not require provider/network access.

## Proposed Data Shape

```ts
type CodeninjaRuntimeProvenance = {
  packageVersion: string
  commit?: string
  shortCommit?: string
  branch?: string
  dirty?: boolean
  source: "build_env" | "git" | "package" | "unknown"
}
```

`packageVersion` should be populated whenever possible. Git fields should be omitted or set to `undefined` when unavailable rather than guessed.

## Plan

1. Add a small runtime provenance helper.
   - Create a focused helper such as `src/util/runtime-provenance.ts`.
   - Read package version from `package.json` or `npm_package_version`.
   - Prefer environment/build metadata when set:
     - `CODENINJA_BUILD_VERSION`
     - `CODENINJA_BUILD_COMMIT`
     - `CODENINJA_BUILD_BRANCH`
     - `CODENINJA_BUILD_DIRTY`
   - If build metadata is absent, run lightweight git commands from the codeninja project root:
     - `git rev-parse HEAD`
     - `git rev-parse --abbrev-ref HEAD`
     - `git status --porcelain`
   - Return `source: "git"` when runtime git metadata was found.
   - Return package-only or unknown metadata without throwing if git is unavailable.

2. Write the provenance into telemetry artifacts.
   - In `src/telemetry/run-artifacts.ts`, include a structured field such as `codeninjaRuntime` or `codeninjaProvenance` in `run.json`.
   - Keep the existing `codeninjaVersion` field and map it to the package version for backward compatibility.
   - Include the same object in any high-level telemetry summaries where it is useful for run comparison.

3. Write the provenance into eval artifacts.
   - In `src/evals/eval-runner.ts`, include the same structured provenance in eval `info.json`.
   - Make sure `logs/<n>/info.json` can answer which codeninja commit ran the eval without opening nested telemetry files.
   - Keep target repo revision fields separate from codeninja runtime fields.

4. Optionally wire build-time metadata later.
   - If the package install/build flow already has a natural place to inject env vars, add it.
   - If not, keep the helper build-env-ready and defer build-script embedding to a later small task.
   - Runtime git fallback is sufficient for source-driven evals.

5. Add tests.
   - Env/build metadata takes precedence over runtime git metadata.
   - Git metadata fallback produces commit, short commit, branch, and dirty state when git is available.
   - Missing git metadata returns package-only or unknown provenance without throwing.
   - `run.json` includes the structured provenance and legacy `codeninjaVersion`.
   - Eval `info.json` includes the structured provenance.

## Likely Files

- `src/util/runtime-provenance.ts`
- `src/telemetry/run-artifacts.ts`
- `src/evals/eval-runner.ts`
- `tests/*runtime*provenance*.test.ts`
- `tests/*eval*.test.ts`

## Acceptance Criteria

- Every normal review telemetry run records codeninja runtime provenance in `run.json`.
- Every eval run records codeninja runtime provenance in `logs/<n>/info.json`.
- Source runs include the current codeninja git commit and dirty state when available.
- Installed/build-env runs can use embedded commit metadata when available.
- Existing consumers of `codeninjaVersion` continue to work.
- Missing git metadata never fails review, eval, or telemetry writing.

## Validation

- Run focused provenance and eval artifact tests.
- Run the full test suite.
- Run `make build`.
- Start one small eval/review and confirm the resulting `info.json` and telemetry `run.json` include the codeninja commit, branch, dirty state, package version, and provenance source.
