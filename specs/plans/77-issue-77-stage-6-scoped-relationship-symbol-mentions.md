# Issue 77: Stage 6 Scoped Relationship Symbol Mention Lookups

Status: PENDING
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

Call-site context hint resolution already has a scoped lookup helper and passes `pathGlob` when appropriate. The relationship graph pass should apply the same idea, but with one extra invariant: the scoped lookup must cover every changed file that could receive a relationship edge. Stage 6 relationship edges are only built from changed-file hits, so a scope that covers all changed files is behavior-preserving while avoiding repo-wide verification for broad symbols.

## Goal

Reduce avoidable Stage 6 degraded tool results caused by broad changed-symbol names (`New`, `Run`, `Start`, `Handle`, etc.) while preserving the useful relationship graph:

- Keep same-file and same-package changed-code relationships.
- Keep `pathGlob` as a strict hard filter.
- Use scoped search only when the scope covers every included changed file.
- Keep current repo-wide behavior when no safe coverage-preserving scope can be derived.
- Do not change model-facing tool semantics.

## Non-Goals

- Do not add `pathHintGlob` to the public tool schema in this plan.
- Do not make `pathGlob` mean "search here first, then the whole repo"; it must remain a hard filter.
- Do not suppress or hide real Stage 7 tool-result-budget truncation from final context-pressure reporting.
- Do not lower `find_symbol_mentions` precision rules globally just to reduce telemetry.

## Design

### 1. Add coverage-preserving scoped lookup for Stage 6 relationship edges

In `addSymbolMentionEdges()`, derive a changed-code search scope before the repo-wide search. The derived scope must match every included changed file path, because relationship edges are only built from changed-file mention results.

```text
preferred scope:
  common changed directory + language extension, e.g. lib/edge/*.go or lib/edge/**/*.go

single-file scope:
  exact changed file path, e.g. lib/edge/service.go

no scope:
  if no single safe glob can cover every included changed file without becoming too broad
```

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

### 2. Keep repo-wide lookup as the fallback for unscopable diffs

Repo-wide lookup is still appropriate when no safe coverage-preserving scope can be derived. Examples:

- changed files span unrelated top-level directories;
- changed files have mixed extensions and a common directory glob would be root-level or otherwise too broad;
- scope construction cannot prove that every included changed file is covered.

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

relationship_symbol_mentions_scope_unavailable
  reason: mixed_roots | mixed_extensions | root_scope | unsafe_glob
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

1. Extract a helper in `packet-builder.ts`:

   ```ts
   function relationshipMentionScope(planned: PlannedHunk[]): string | undefined
   ```

   It should derive a safe glob from changed file paths. For a single changed file, return that exact file path. For a common non-root directory and shared extension, return the narrowest glob that covers every included changed file. If deriving a safe coverage-preserving scope is unclear, return `undefined` and keep current behavior.

2. Add a small verification helper or test assertion for scope derivation:

   ```ts
   function relationshipMentionScopeCoversFiles(pathGlob: string, paths: string[]): boolean
   ```

   Use the same matching semantics as repository search where practical. At minimum, tests must cover direct children and nested children for the generated glob style.

3. Modify `addSymbolMentionEdges()`:
   - compute scope once from planned hunks;
   - call `findSymbolMentions(..., { pathGlob: scope })` when scope exists;
   - build relationship edges from scoped results filtered to changed files;
   - keep existing behavior when no scope can be derived.

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
  - It does not perform a repo-wide lookup when the scoped glob covers every changed file.
  - Relationship edges among changed `lib/edge` files are still built.

- A multi-root or mixed-extension diff where no safe single scope exists:
  - Stage 6 keeps the existing repo-wide lookup behavior.
  - Relationship edges are still built.

- Scope derivation:
  - exact single-file scopes cover the changed file;
  - common-directory/shared-extension scopes cover direct-child changed files and nested changed files;
  - root-level or unclear scopes return `undefined`.

- `pathGlob` remains hard-filtered for repository tools:
  - `findSymbolMentions("New", { pathGlob: "lib/edge/**/*.go" })` returns only matching paths under the glob.
  - No implicit repo-wide fallback happens inside the tool.

- Telemetry:
  - `relationship_symbol_mentions_scoped` is emitted for scoped lookups.
  - `relationship_symbol_mentions_scope_unavailable` is emitted when Stage 6 keeps repo-wide behavior because no safe scope exists.
  - No warn/error telemetry is emitted for normal scoped/fallback decisions.

## Validation

- `pnpm run typecheck`
- Focused tests for packet-builder / repository intelligence.
- `pnpm run build`
- Re-run a review on the trails-api branch from run `20260623-131851-e65f8991` and confirm:
  - Stage 6 no longer records a degraded `find_symbol_mentions(New)` from relationship building.
  - Packets still show full context quality.
  - Relationship graph still attaches the `New`/`edgeRail`/test relationships needed by the review.
  - Final review still reports no credible findings.

## Done Criteria

- Stage 6 relationship lookups are scoped-first for changed-symbol mentions.
- `pathGlob` remains a hard filter in the public tool.
- Broad symbols no longer trigger repo-wide relationship lookup when the changed-file set has a safe coverage-preserving scope.
- Relationship edges are not lost for the common changed-file/same-package case.
- The trails-api run pattern no longer reports avoidable Stage 6 degraded tool pressure for `New`.

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
