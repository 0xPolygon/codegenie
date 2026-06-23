# Issue 77: Stage 6 Scoped Relationship Symbol Mention Lookups

Status: COMPLETE
Planned from: trails-api run `/home/peter/Dev/0xsequence/trails-api/.codegenie/runs/20260623-131851-e65f8991`, 2026-06-23
Planned at: commit `2bf82a1` (branch `next`)
Recommended priority: medium. This is a low-risk Stage 6 context-quality improvement: reduce noisy degraded tool results from broad deterministic symbol mention searches without weakening repo-wide model tools or hiding real cross-file relationships.

> Executor instructions: keep `pathGlob` as a hard filter. Do not change the public `find_symbol_mentions` semantics unless this plan explicitly says so. Implement a coverage-preserving scoped relationship lookup inside Stage 6 only.
>
> Drift check: `git diff --stat 2bf82a1..HEAD -- src/pipeline/packet-builder.ts src/repo/search.ts src/repo/repository-index.ts src/llm/tool-definitions.ts tests`
> If in-scope files changed since this plan was written, compare the "Current State" excerpts below against live code before editing.

## Problem

Run `20260623-131851-e65f8991` completed successfully and found no credible issues, but the final review reported:

```text
Local context pressure: 3 degraded tool results.
```

One of those degraded results was deterministic Stage 6 relationship building:

```text
toolCallId          tc-000005
stage               6
tool                find_symbol_mentions
symbolName          New
contextMode         symbols
source              head
maxResults          40
degradationReason   5 mention result(s) were not syntax-verified
resultCount         38
omittedCount        1
truncated           true
```

`New` is a real changed symbol in `lib/edge/service.go`, but it is also a very broad Go identifier. Stage 6 searched the entire repository, then filtered results down to changed files after the lookup. That means broad names can consume syntax-verification/result budget and emit degraded telemetry even when Stage 6 only needs changed-file relationship edges.

The degraded result did not break this run, but it is noisy and can obscure genuinely material context pressure such as Stage 7 `tool_result_budget` truncation.

## Current State

`find_symbol_mentions` already supports hard scoping through `pathGlob`:

```ts
// src/llm/tool-definitions.ts
{
  name: "find_symbol_mentions",
  description: "Find text/token mentions of an identifier, optionally constrained by pathGlob, contextMode, maxResults, and source.",
  parameters: Type.Object({
    symbolName: Type.String({ minLength: 1, maxLength: 200 }),
    pathGlob: Type.Optional(Type.String({ minLength: 1 })),
    contextMode: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("lines"), Type.Literal("symbols")])),
    maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 300 })),
    source: SourceSelectorSchema
  })
}
```

`find_symbol_mentions` marks a result degraded when some returned mention candidates cannot be syntax-verified:

```ts
// src/repo/search.ts
backend: unverified === 0 ? "tree-sitter" : "text",
precision: unverified === 0 ? "syntactic" : "text",
degraded: execution.degraded || unverified > 0,
degradationReason: `${unverified} mention result(s) were not syntax-verified`
```

Stage 6 relationship building currently performs a repo-wide search first:

```ts
// src/pipeline/packet-builder.ts
const lookup = await withRepositoryToolCallContext(
  repoIndex.tools,
  { stage: 6, initiator: "harness" },
  () => repoIndex.tools.findSymbolMentions(bareIdentifier(symbol), {
    source: { kind: "head" },
    contextMode: "symbols",
    maxResults: MAX_RELATIONSHIP_MENTION_RESULTS
  })
);
results = lookup.results.filter((result) => changedFiles.has(result.path));
```

Call-site context hint resolution already has a scoped lookup helper and passes `pathGlob` when appropriate. The relationship graph pass should apply the same idea, but with one extra invariant: the scoped lookup must cover the same changed-file set that Stage 6 filters results against. That keeps the change small and behavior-preserving.

## Goal

Reduce avoidable Stage 6 degraded tool results caused by broad changed-symbol names (`New`, `Run`, `Start`, `Handle`, etc.) while preserving the useful relationship graph:

- Keep same-file and same-package changed-code relationships.
- Keep `pathGlob` as a strict hard filter.
- Use scoped search only when the scope covers every included changed file path.
- Keep current repo-wide behavior when no safe coverage-preserving scope can be derived.
- Do not change model-facing tool semantics.

## Non-Goals

- Do not add `pathHintGlob` to the public tool schema in this plan.
- Do not make `pathGlob` mean "search here first, then the whole repo"; it must remain a hard filter.
- Do not suppress or hide real Stage 7 tool-result-budget truncation from final context-pressure reporting.
- Do not lower `find_symbol_mentions` precision rules globally just to reduce telemetry.

## Design

### 1. Add coverage-preserving scoped lookup for Stage 6 relationship edges

In `addSymbolMentionEdges()`, derive a changed-code search scope before the repo-wide search. The correctness invariant is:

```text
For every path in the existing changedFiles filter set, the generated pathGlob
must match that path under the same normalization and matching semantics used
by repository search.
```

Relationship edges are still built from `lookup.results.filter((result) => changedFiles.has(result.path))`. A scope that covers all of `changedFiles` can produce the same changed-file edge candidates as the current repo-wide lookup. A scope that fails to cover any changed file is unsafe and must be rejected.

```text
preferred scope:
  common non-root changed directory at depth >= 1 + shared extension,
  e.g. lib/edge/**/*.go

single-file scope:
  exact changed file path, e.g. lib/edge/service.go

no scope:
  if no single safe glob can cover every included changed file without becoming too broad
```

Use one deterministic rule for v1: exact safe file path for a single changed path; otherwise a single common non-root directory at depth >= 1 plus a single shared extension, emitted as `<dir>/**/*<ext>`. Return no scope for root-level common directories, mixed extensions, mixed unrelated roots, empty changed sets, or paths containing glob metacharacters such as `*`, `?`, `[`, `]`, `{`, or `}`. Do not add escaping in this first pass.

Then run:

```text
if coverage-preserving scope exists:
  scoped find_symbol_mentions(symbol, { pathGlob, contextMode: "symbols", source: head })
  build changed-file edges from scoped results
else:
  repo-wide find_symbol_mentions(...)
  build changed-file edges from repo-wide results
```

Important: do not perform a repo-wide fallback after a successful coverage-preserving scoped lookup just because no relationship edge was produced. Since the scope already covers all changed files, the repo-wide result cannot add a changed-file relationship edge except by relying on a bug or a deliberately incomplete scope. If tests expose such a bug, fix scope derivation or glob matching instead of adding broad fallback.

This intentionally diverges from the packet-context call-site hint path. Call-site callers may live outside the hinted file, so the call-site helper uses repo-wide fallback when the same-file search is empty. Relationship symbol edges only attach to changed files, so a coverage-preserving scoped lookup must not fall back repo-wide on empty scoped results.

### 2. Keep repo-wide lookup as the fallback for unscopable diffs

Repo-wide lookup is still appropriate when no safe coverage-preserving scope can be derived. Examples:

- changed files span unrelated top-level directories;
- changed files have mixed extensions and a common directory glob would be root-level or otherwise too broad;
- scope construction cannot prove that every changed path is covered.

Do not add broad-symbol skipping in the first implementation. Skipping repo-wide lookup for `New`, `Run`, or `Start` in unscopable diffs could silently lose relationship edges. If broad symbols continue to create noisy Stage 6 pressure in unscopable diffs, add a second plan with run evidence and regression fixtures.

### 3. Preserve `pathGlob` hard-filter semantics

No changes to:

- `src/llm/tool-definitions.ts`
- `src/repo/search.ts`
- `src/repo/repository-index.ts`

unless tests expose a bug in existing `pathGlob` handling. Model-facing tools should remain explicit: a model that wants a scoped pass and a repo-wide pass can make two calls.

### 4. Make scope selection observable

Add Stage 6 debug telemetry around relationship symbol lookups:

```text
relationship_symbol_mentions_scoped
  symbol
  pathGlob
  resultCount
  edgeCount
  degraded
  degradationReason?

relationship_symbol_mentions_repo_wide
  symbol
  reason
  resultCount
  edgeCount
  degraded
  degradationReason?
```

Do not add these as warn-level events. They are normal context-shaping decisions.

## In-Scope Files

- `src/pipeline/packet-builder.ts` — derive coverage-preserving changed-file scopes; perform scoped relationship symbol mention lookup when safe; retain repo-wide lookup when unscopable; debug telemetry.
- Tests covering Stage 6 relationship graph behavior. Prefer the existing packet-builder/pipeline tests if there is already a suitable harness; otherwise add focused unit coverage for helper functions.
- `specs/plans/README.md` — index entry.

## Out of Scope

- Public tool schema changes (`pathHintGlob`).
- Stage 7 model-facing search behavior.
- Global degradation accounting changes.
- Changing the final markdown wording for `degraded tool results`.

## Implementation Steps

1. Extract a small helper in `packet-builder.ts`:

   ```ts
   type RelationshipMentionScope =
     | { pathGlob: string; changedPaths: string[] }
     | { reason: "no_changed_files" | "mixed_roots" | "mixed_extensions" | "root_scope" | "unsafe_glob"; changedPaths: string[] };

   function relationshipMentionScope(planned: PlannedHunk[]): RelationshipMentionScope
   ```

   It should derive a safe glob from `dedupe(planned.map((entry) => entry.file.path))`. For a single safe changed file, return that exact file path. For a common non-root directory and shared extension, return `<dir>/**/*<ext>`. If deriving a safe coverage-preserving scope is unclear, return a reason and keep current repo-wide behavior.

2. Add a small verification helper or test assertion for scope derivation:

   ```ts
   function relationshipMentionScopeCoversFiles(pathGlob: string, paths: string[]): boolean
   ```

   Reuse the same matching semantics as repository search: normalize with `containGlob(...)`, then match with `picomatch(normalizedGlob, { dot: true })`. Do not hand-roll glob coverage checks. At minimum, tests must cover direct children and nested children for the generated glob style.

3. Modify `addSymbolMentionEdges()`:
   - compute scope once from planned hunks;
   - call `findSymbolMentions(..., { pathGlob: scope })` when scope exists;
   - build relationship edges from scoped results filtered to changed files;
   - keep existing repo-wide behavior when no scope can be derived;
   - do not add repo-wide fallback after scoped lookup returns zero results or zero edges.

4. Keep relationship edge semantics unchanged:
   - same edge source (`symbol_mention`);
   - same strength calculation;
   - same ambiguity handling;
   - same changed-file filtering.

5. Add debug telemetry for scoped lookup and repo-wide/unscopable decisions.

6. Update tests and fixtures.

## Tests

Add focused coverage for:

- A broad changed symbol named `New` in `lib/edge/service.go` with unrelated `New` mentions elsewhere:
  - Stage 6 uses scoped `pathGlob`.
  - It does not perform a repo-wide lookup when the scoped glob covers every changed path.
  - Relationship edges among changed `lib/edge` files are still built.

- A multi-root or mixed-extension diff where no safe single scope exists:
  - Stage 6 keeps the existing repo-wide lookup behavior.
  - Relationship edges are still built.

- Scope derivation:
  - exact single-file scopes cover the changed file;
  - common-directory/shared-extension scopes cover direct-child changed files and nested changed files;
  - root-level or unclear scopes return the appropriate reason.
  - paths with glob metacharacters return reason `unsafe_glob`.

- `pathGlob` remains hard-filtered for repository tools:
  - `findSymbolMentions("New", { pathGlob: "lib/edge/**/*.go" })` returns only matching paths under the glob.
  - No implicit repo-wide fallback happens inside the tool.

- Telemetry:
  - `relationship_symbol_mentions_scoped` is emitted for scoped lookups.
  - `relationship_symbol_mentions_repo_wide` is emitted with a reason when Stage 6 keeps repo-wide behavior because no safe scope exists.
  - No warn/error telemetry is emitted for normal scoped/fallback decisions.

## Validation

- `pnpm run typecheck`
- Focused tests for packet-builder / repository intelligence.
- `pnpm run build`
- Re-run a review on the trails-api branch from run `20260623-131851-e65f8991` and confirm:
  - Stage 6 no longer records a repo-wide relationship-building `find_symbol_mentions(New)` when a safe scope exists.
  - If the scoped changed-file candidates are syntax-verifiable, the prior degraded `find_symbol_mentions(New)` pressure disappears.
  - Packets still show full context quality.
  - Relationship graph still attaches the `New`/`edgeRail`/test relationships needed by the review.
  - Final review still reports no credible findings.

## Done Criteria

- Stage 6 relationship lookups are scoped-first for changed-symbol mentions.
- `pathGlob` remains a hard filter in the public tool.
- Broad symbols no longer trigger repo-wide relationship lookup when the changed paths have a safe coverage-preserving scope.
- Scope coverage is proven with the same `containGlob` + `picomatch(..., { dot: true })` semantics used by repository search.
- Relationship edges are not lost for the common changed-file/same-package case.
- The trails-api run pattern no longer performs the avoidable repo-wide Stage 6 relationship lookup for `New`; degraded pressure should disappear when the scoped candidates are syntax-verifiable.

## Stop Conditions

- If scoped-first lookup causes relationship edges between changed files to disappear in tests, stop and fix edge construction before changing fallback policy.
- If deriving a safe common glob is brittle for multi-directory diffs, restrict the first implementation to the single-common-directory case and keep current repo-wide behavior otherwise.
- If suppressing repo-wide lookup for broad names in unscopable diffs becomes desirable, do not add a denylist ad hoc; write a follow-up plan with run evidence and regression fixtures.

## Future Work

If model-facing broad searches continue to create noisy context pressure, revisit a public `pathHintGlob` option with explicit semantics:

```text
pathGlob      hard filter; never searches outside it
pathHintGlob  soft first-pass scope; may fall back repo-wide if empty
```

That should be a separate plan because it changes the public tool contract and prompt guidance.
