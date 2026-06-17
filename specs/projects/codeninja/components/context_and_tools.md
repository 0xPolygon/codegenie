---
status: complete
---

# Component: Context And Tools

## Purpose And Scope

This component is codeninja's repository intelligence layer: the implementation behind `RepositoryIndex.tools`, Stage 4 changed-symbol extraction, static signal extraction, and deterministic packet context assembly. It is implemented under `src/repo/` and is the single place where reviewed source content is read, parsed, searched, and shaped into compact evidence for the planner, packet builders, packet reviewers, and verifiers.

This component owns:

- The `RepositoryTools` implementation: the nine tools `readRange`, `readFileOutline`, `readSymbol`, `findDefinition`, `readDiffBlocks`, `searchFiles`, `findSymbolMentions`, `findLikelyTests`, and `listFiles`, including backend routing between the tree-sitter and text backends, degradation behavior, result caps, and `ToolResultMeta` provenance. (`readSymbol` with a line selector returns the enclosing symbol; `readFileOutline` subsumes symbol listing.)
- The path-containment chokepoint required by Trust Boundaries: canonicalization, rejection of absolute paths and `..` traversal with typed `path_outside_repo` errors, the symlink policy for worktree access, and harness-side ref validation (model-facing source selectors are `head`/`base` only; models never supply refs).
- Revision access through git plumbing (`git show`, `git ls-tree`, `git grep` via `GitClient`), the bundled-ripgrep search fast path, and engine provenance.
- The `searchFiles` POSIX ERE query contract and engine flag alignment.
- The tree-sitter service: WASM runtime and grammar loading from `node_modules`, extension-to-grammar routing including `tsx`, ABI pinning behavior, in-memory parsing of revision content, and parse caching.
- The `LanguageAdapter` implementations: Go, TypeScript/JavaScript, and the generic fallback, including `SymbolKind` + `nativeKind` mapping rules and `ownerType` extraction.
- Stage 4 changed-symbol extraction producing `HunkSymbolFacts` (enclosing-symbol mapping and fallback detection).
- Static signal extraction: the two v1 cross-language rules (per-language rule packs are deferred to Future Considerations — see architecture.md).
- `PacketContext` assembly (path, package name, enclosing function/type/method) plus the file outline and the likely-tests list for `ReviewPacket.relevantTests`, all consumed by the Stage 6 packet builder.
- The delegated type definitions `SearchOptions`, `SearchResult`, `ParseInput`, and `ParsedFile`.

Explicitly not this component's responsibility:

- `GitClient` subprocess internals, diff parsing, file classification, and `FileFacts` production — see `components/repository_and_github.md`; this component consumes `GitClient` and the parsed `UnifiedDiff`.
- Pipeline orchestration, planner behavior, packet sizing/coalescing, and packet identity — see `components/review_pipeline.md`; this component supplies `PacketContext` and `HunkSymbolFacts`, the packet builder assembles packets.
- Exposing tools as LLM tool definitions, the worker agent loop, tool-budget enforcement per worker, and prompt plumbing — see `components/skills_llm_telemetry.md`.
- Eval scoring and replay — see `components/evals.md`.
- Everything listed under Future Considerations in `architecture.md`: the changed-symbol graph (`SymbolEdge`, `ChangedSymbolGraph`), the cross-packet `ReviewSignal` index, language analyzer backends, the diff-file input mode (worktree-as-head reads and the hunk-context staleness primitive), per-language static-signal packs, and rich pre-attached packet context (`AstNodeSummary` changed-node summaries, nearby imports, sibling symbols). The `ToolBackend` enum value `"language-analyzer"` exists in the contract but receives no design here; no v1 code path produces it.

All data contracts referenced here — `SymbolKind`, `SymbolRef`, `SymbolInfo`, `ChangedSymbol`, `HunkSymbolFacts`, `StaticSignal`, `ToolResultMeta`, `SourceSelector`, `FileOutline`, `ToolBackend`, `ToolPrecision`, `ToolCallRecord`, `PacketContext`, `RepositoryIndex`, `LanguageAdapter`, `GitClient`, and the `RepositoryTools` interface — are defined in `architecture.md` and are law. This document elaborates behavior; it does not change signatures. The only types defined here are the four delegated to this doc.

## Public Interface

### Index Construction

The pipeline entry point for this component matches the call in the main review algorithm:

```ts
async function buildRepositoryIndex(
  resolved: ResolvedReviewInput,
  kept: DiffFile[],
  facts: FileFacts[],
  config: CodeninjaConfig,
  telemetry: TelemetryRecorder
): Promise<RepositoryIndex>
```

`buildRepositoryIndex` should:

1. Derive the revision binding (effective head and base commits) for the review mode.
2. Run Stage 4 changed-symbol extraction over kept reviewable files, producing `HunkSymbolFacts[]`.
3. Run static signal extraction over the same parses, producing `StaticSignal[]`.
4. Construct the `RepositoryTools` facade bound to the repository root, revision binding, `GitClient`, tree-sitter service, adapter registry, parsed diff, and worktree snapshot.
5. Return `RepositoryIndex { facts, symbolFacts, staticSignals, tools }`, passing the input `facts` through unchanged.

`buildRepositoryIndex` must not call the LLM, must not write to the repository, and should be cheap enough to run on every review: parsing is restricted to kept reviewable files with available grammars, and base-side parses run only when a file needs old-side facts.

### Tools Host Wiring

The concrete tools object implements `RepositoryTools` (law) plus a narrow host interface used only by the orchestrator and packet builder. The host methods are not part of the model-facing tool surface and are never exposed as LLM tool definitions:

```ts
interface RepositoryToolsHost extends RepositoryTools {
  // Called by the orchestrator after Stage 6 so readDiffBlocks can resolve
  // packetId lookups. Before binding, packetId lookups return a degraded
  // empty result; path lookups work from the parsed diff at all times.
  bindPackets(packets: ReviewPacket[]): void

  // Called by the Stage 6 packet builder for each packet under construction.
  // relevantTests is the likely-tests list the builder assigns to
  // ReviewPacket.relevantTests — the single carrier of likely tests;
  // PacketContext itself has no tests field. The builder renders these
  // outputs — enclosing-symbol source, the file outline, the likely-tests
  // list — into ReviewPacket.contextText within its maxContextChars budget.
  buildPacketContext(
    file: DiffFile,
    hunks: DiffHunk[],
    symbolFacts: HunkSymbolFacts[]
  ): Promise<{ context: PacketContext; outline?: FileOutline; relevantTests: SymbolInfo[]; degradation?: string }>
}
```

`RepositoryIndex.tools` is typed as `RepositoryTools`; the orchestrator and packet builder may use the host interface on the same object.

### Diff-File Staleness Primitive (Deferred)

The diff-file input mode's worktree-as-head carve-out and its hunk-context staleness primitive (`validateHunkContextAgainstWorktree`) are deferred to Future Considerations — see architecture.md.

### Repository Tools Behavior Summary

The `RepositoryTools` interface in `architecture.md` is the contract. Behavioral elaboration per tool:

- `readRange(path, startLine, endLine, source?)` — text backend always. Reads file content at the resolved revision via `git show`, returns the inclusive 1-based line window. Out-of-bounds ranges are clamped to file bounds with `truncated: true` and `omittedCount` set when lines were dropped by clamping or the per-call cap. `precision: "exact"`. Missing file at the revision returns empty text with `degraded: true` and a reason; it is not an error.
- `readFileOutline(path, source?)` — tree-sitter backend when a grammar is available: returns `FileOutline` with `packageName`, `imports`, `topLevelSymbols` (including methods of top-level types), `testSymbols`, and `notes` (`precision: "syntactic"`). Falls back to extension/filename heuristics plus a compact text outline with `backend: "text"`, `precision: "heuristic"`, `degraded: true`. Symbol enumeration is answered by this tool's `topLevelSymbols`; there is no separate symbol-listing tool.
- `readSymbol(path, { symbolName?, line? }, source?)` — exactly one selector is required. By name: exact-name match over the file's symbols (qualified `Owner.name` queries supported); by line: the smallest enclosing symbol containing that line, returned as `SymbolInfo` plus capped source text (`precision: "syntactic"`). Multiple same-name matches return the first in file order with `omittedCount` for the rest. Fallback: by name, exact-name text search within the file plus a bounded window; by line, a bounded ±20-line window with no `symbol`, `backend: "text"`, `precision: "text"`; both `degraded: true`.
- `findDefinition(symbolName, { pathGlob?, source? })` — `git grep` at the resolved revision (default head) finds candidate files; candidate files with grammars are parsed and filtered to definition sites whose symbol name (or `ownerType`-qualified name) matches. Unparseable candidates contribute plain text matches marked degraded. Base-side lookups support deleted-code questions.
- `readDiffBlocks({ packetId?, path? })` — renders hunks from the parsed diff with dual old/new line numbers and change markers. Requires exactly one selector. `backend: "text"`, `precision: "exact"`. Unknown packetId or path returns a degraded empty result.
- `searchFiles(query, options?)` — POSIX ERE search via `git grep -E` at the resolved revision, or bundled ripgrep on the worktree fast path. `contextMode` controls enrichment: `"none"` (matching line only), `"lines"` (±2 context lines), `"symbols"` (tree-sitter enclosing `SymbolRef` attached per match, best effort).
- `findSymbolMentions(symbolName, { pathGlob?, source? })` — word-boundary text search for the identifier at the resolved revision (default head), then tree-sitter token verification that drops string/comment hits for files with grammars. `precision: "syntactic"` when all returned mentions are token-verified, otherwise `"text"` with a degradation note. Never claims `semantic` or `exact` in v1.
- `findLikelyTests({ path?, symbol?, source? })` — test filename/path conventions plus, when a symbol is given, symbol-name mention filtering inside candidate test files, all at the resolved revision (default head). Always `precision: "heuristic"`. An empty result is a valid answer, not a degradation.
- `listFiles(glob)` — `git ls-tree -r` at the head revision filtered by the glob. Returns `{ paths, meta }` like every other tool; truncation at the cap sets `meta.truncated` and `meta.omittedCount` so the model knows the listing is incomplete, and is also recorded on the call's `ToolCallRecord` in `tool-calls.jsonl`.

All tools are read-only. `SourceSelector` is `head | base`: source-reading and symbol-searching tools default to `{ kind: "head" }` and accept `{ kind: "base" }` — `findDefinition`, `findSymbolMentions`, and `findLikelyTests` take `source?` first-class, and `searchFiles` takes it through `SearchOptions.source`. There is no model-facing raw-ref selector; refs are harness-resolved into the revision binding. Only `listFiles` has no `source` parameter and operates on the head revision.

### Delegated Type Definitions

These four types are delegated to this document by `architecture.md`.

```ts
type SearchContextMode = "none" | "lines" | "symbols"

type SearchOptions = {
  // Gitignore-style glob constraining searched paths, validated by the
  // containment chokepoint (no absolute globs, no ".." segments).
  pathGlob?: string
  // Enrichment level for matches. Default "none".
  contextMode?: SearchContextMode
  // Result cap for this call. Default 50, hard cap 200.
  maxResults?: number
  // Default true. Maps to `git grep -i` / `rg -i` when false.
  caseSensitive?: boolean
  // Revision to search. Default { kind: "head" }. { kind: "base" } supports
  // deleted-code questions. The fast path applies only to head searches.
  source?: SourceSelector
}

type SearchResult = {
  path: string
  // 1-based line number of the match.
  line: number
  // 1-based column of the match start when the engine reports it.
  column?: number
  // The matching line content, trimmed and capped.
  matchText: string
  // Present when contextMode = "lines".
  contextBefore?: string[]
  contextAfter?: string[]
  // Present when contextMode = "symbols" and tree-sitter enrichment succeeded.
  enclosingSymbol?: SymbolRef
}
```

`SearchResult` is also the return element of `GitClient.grep`. `GitClient.grep` fills only `path`, `line`, `column`, and `matchText`; `contextBefore`, `contextAfter`, and `enclosingSymbol` are enrichments added by this component.

```ts
type ParseInput = {
  // Repo-relative path, already validated by the containment chokepoint.
  path: string
  // Resolved language id routed by the adapter registry:
  // "go" | "typescript" | "tsx" | "javascript" | extension-derived ids
  // for unsupported languages handled by the generic adapter.
  language: string
  // Full file text at the requested revision; parsing is in-memory only.
  content: string
  // Provenance of content (head or base).
  source: SourceSelector
  // Git blob sha when content came from plumbing; sha256(content) otherwise.
  // Used as the parse-cache key.
  contentSha?: string
}

type ParsedFile = {
  path: string
  language: string
  adapterId: string
  source: SourceSelector
  contentSha?: string
  // Retained for snippet and window extraction.
  content: string
  // web-tree-sitter Tree handle; opaque outside src/repo. Undefined for the
  // generic adapter, parse failure, oversized files, or parse timeout.
  tree?: unknown
  // True when the tree contains ERROR/MISSING nodes or parsing timed out.
  hasErrors: boolean
}
```

`LanguageAdapter.parse` resolves with a `ParsedFile` even on failure (`tree: undefined`, `hasErrors: true`); it rejects only on programming errors. Degradation is data, not exceptions.

### Error Conditions

Tool methods reject with `CodeninjaError` using existing stable codes only:

- `path_outside_repo` — any path or glob that fails containment: absolute paths, `..` segments, NUL bytes, paths whose first segment is `.git`, or worktree paths whose resolved real path escapes the repository root.
- `invalid_args` — malformed tool arguments: empty or oversized query (over 500 chars), a pattern rejected by both search engines, `startLine < 1` or `startLine > endLine`, both or neither of `symbolName`/`line` in `readSymbol`, or both or neither of `packetId`/`path` in `readDiffBlocks`.

Model-facing source selectors (`head`/`base`) never fail to resolve: the revision binding pins both commits at construction (the resolver populates `mergeBase` in every mode), so `git_ref_missing` does not occur at the tool boundary.

Absence is never an exception: a missing file at a revision, a symbol not found, or zero search matches return empty results with appropriate `ToolResultMeta` (`degraded` set when the answer quality is reduced, not merely empty). `parser_unavailable` conditions are recoverable inside this component and never cross the tool boundary as exceptions; they surface as degraded results.

Tool rejections are rendered as model-visible tool errors by the worker runner (`components/skills_llm_telemetry.md`) and recorded in `tool-calls.jsonl` — containment denials surface as `status: "rejected"` `ToolCallRecord`s; they must never abort the run. Containment violations additionally emit a `warn`-level telemetry event, since a model-authored escape attempt is itself review-manipulation signal under Trust Boundaries.

## Internal Design

### Module Layout

Elaborating the `src/repo/` layout from `architecture.md`:

```text
src/repo/
  repository-index.ts        # buildRepositoryIndex, RepositoryToolsHost facade
  path-guard.ts              # containment chokepoint: paths, globs, refs
  source-resolver.ts         # RevisionBinding, content reads, engine selection
  search.ts                  # searchFiles/findSymbolMentions engines + alignment
  diff-blocks.ts             # readDiffBlocks rendering
  symbol-extraction.ts       # Stage 4 HunkSymbolFacts extraction
  static-signals.ts          # rule engine + v1 rule set
  packet-context.ts          # PacketContext assembly
  likely-tests.ts            # test conventions shared by tools and adapters
  language-adapter.ts        # LanguageAdapter registry + delegated types
  tree-sitter/
    tree-sitter-service.ts   # WASM runtime, grammar loading, parse cache
    go-adapter.ts
    typescript-adapter.ts    # covers typescript, tsx, javascript
    generic-adapter.ts
```

### Revision Binding

At construction, the index resolves a `RevisionBinding` once, preferring SHAs over ref names (Trust Boundaries):

```ts
type RevisionBinding = { headCommit: string; baseCommit: string } // baseCommit = ResolvedReviewInput.mergeBase
// (The deferred diff-file input mode would add a worktree binding variant —
// see architecture.md Future Considerations.)
```

Derivation per review mode from `ResolvedReviewInput`:

- `github_pr` and `branch`: `headCommit = headSha ?? revParse(headRef)`; `baseCommit = mergeBase` (the diff's old side under merge-base semantics).
- `commit_range` (single commit or range): `headCommit = revParse(endCommit ?? startCommit)`; `baseCommit = mergeBase` — the resolver populates `mergeBase` in every mode (`architecture.md`): the first parent for single-commit review, the empty-tree sentinel for a root commit, the start commit for ranges. The binding never re-derives `startCommit^`. For a root commit, base reads resolve against the empty tree and return missing-content degraded empty results.

`SourceSelector` resolution against the binding is total — `head | base` are the only model-facing selectors and both are pinned at construction:

- `{ kind: "head" }` → `headCommit`.
- `{ kind: "base" }` → `baseCommit`.

Harness-side ref values used to construct the binding (e.g. `headRef` when `headSha` is absent) are validated by the ref guard and resolved through `revParse` once; models never supply raw refs.

All content reads go through git plumbing: `GitClient.catFile(sha, path)` (`git show <sha>:<path>` semantics), tree listings through `GitClient.lsTree`, revision search through `GitClient.grep`. Tree-sitter parses revision content in memory; no temporary worktrees are materialized and parsing never depends on checked-out files. V1 deliberately does not use the optional worktree read fast path for content tools — `git show` is cheap, and confining worktree filesystem access to ripgrep search minimizes the symlink containment surface.

### Path And Ref Containment Chokepoint

`path-guard.ts` is the single chokepoint required by Trust Boundaries. Every externally supplied path — model tool arguments and glob patterns — passes through it before any git or filesystem use.

`containPath(repoRoot, input)` rules, applied in order:

1. Reject empty strings and any NUL byte.
2. Reject absolute paths (leading `/`) and any backslash (`\`) to avoid Windows-style separator ambiguity; v1 path handling is POSIX.
3. Normalize lexically: strip leading `./`, collapse repeated separators and `.` segments.
4. Reject any remaining `..` segment, even one that would lexically stay inside the root.
5. Reject paths whose first segment is `.git`.
6. The survivor is the canonical repo-relative path used as a git tree path. Git-plumbing reads with `<sha>:<path>` are inherently contained — a tree path cannot address content outside the repository object database.

Violations reject with `path_outside_repo` and emit a `warn` telemetry event including the tool name and offending input (truncated).

Worktree filesystem access (the ripgrep fast path's result paths) adds a physical check on top of the lexical rules: `realpath(join(repoRoot, rel))` must reside within `realpath(repoRoot)`; otherwise reject with `path_outside_repo`. Symlinks that resolve inside the repository root may be followed; symlinks resolving outside it must not be. Ripgrep is additionally invoked without `--follow` so directory traversal never walks through symlinks at all.

Glob containment: `pathGlob` and `listFiles` globs are validated with the same lexical rules (rules 1–5), treating `*`, `**`, `?`, and `[...]` as opaque literals during validation. Globs are then passed as `:(glob)` pathspecs to git or `--glob` arguments to ripgrep — never interpolated into a shell.

Ref guard: `containRef(ref)` validates harness-side ref values (revision-binding construction inputs; model-facing source selectors are `head`/`base` only, so no model-supplied ref ever reaches it). It accepts 4–64 character hex strings (SHA forms) or names passing the documented `git check-ref-format` rules, implemented locally and deterministically (no control characters, no `..`, no `~ ^ : ? * [ \`, no leading/trailing `/` or `.`, no `@{`, no `.lock` suffix, not `@`). Values matching `^-` are always rejected (`invalid_args`). Subprocess hygiene beyond validation — never invoking through a shell, `--` separators before untrusted positionals — is `GitClient`'s contract (`components/repository_and_github.md`); this component supplies only pre-validated values.

### Search Engines And The Worktree Fast Path

The text backend has two engines:

- `git grep -E <pattern> <sha>` through `GitClient.grep` — the authoritative engine, searching exactly the tracked tree at the resolved revision.
- Bundled `@vscode/ripgrep` over the worktree — a fast path only.

Fast-path eligibility is computed once at index construction into a `WorktreeSnapshot`:

```ts
type WorktreeSnapshot = {
  headEqualsReviewedHead: boolean // revParse("HEAD") === headCommit
  trackedClean: boolean           // no modified/staged/deleted tracked entries
  untrackedPaths: Set<string>     // untracked paths from git status --porcelain
}
```

The fast path applies to a search call iff: the source resolves to `headCommit`, `headEqualsReviewedHead` is true, and `trackedClean` is true. Base-revision searches and dirty or mismatched checkouts always use `git grep`. The snapshot is taken once; mid-run worktree edits are outside the v1 contract (plumbing reads remain correct regardless, and the fast path is best-effort).

Ripgrep invocation and alignment with the `git grep -E` contract:

- Flags: `--json --line-number --column --no-config --no-messages`, default ignore behavior retained (respects `.gitignore`), `--hidden` not set, `--glob '!.git/**'`, plus translated `--glob` patterns and `-i` when `caseSensitive: false`. `--follow` is never passed.
- Result alignment: matches in paths present in `untrackedPaths` are filtered out post-hoc, so fast-path results reflect tracked content at head.
- Pattern alignment: the query contract is POSIX ERE. `git grep -E` is the reference semantics. Ripgrep's Rust regex accepts the common ERE constructs (alternation, intervals, classes, anchors) with matching meaning; if ripgrep rejects the pattern, the call falls back to `git grep` transparently. If `git grep` also rejects the pattern, the call fails with `invalid_args`.
- Residual engine differences that cannot be aligned (`.ignore`/`.rgignore` handling, binary-detection heuristics) are disclosed as degradation notes when they are detected to have affected the result (for example, ripgrep reporting skipped binary candidates); in that case `degraded: true` with a `degradationReason` naming the engine difference. A clean fast-path result is not degraded.

Engine identity goes in-band on the record: the engine that answered is stamped on the call's `ToolCallRecord.engine` field (`"git-grep" | "ripgrep"`) in `tool-calls.jsonl`, with fallback transitions visible as `engine: "git-grep"` plus a fallback telemetry note. `ToolResultMeta.backend` remains `"text"` for both engines because `ToolBackend` does not distinguish engines.

Searches are executed with a bounded match count (engine-level `--max-count`/result truncation at `maxResults + 1`) so caps do not require reading unbounded output.

### Diff-File Mode Carve-Out (Deferred)

The diff-file input mode's tool-layer carve-out — worktree-as-head reads with degraded provenance, degraded-empty base reads, ripgrep-only search, and the hunk-context staleness validation flow — is deferred with the mode itself (see architecture.md Future Considerations).

### Tool Designs

#### readRange

Resolve content via the revision binding, split into lines once (memoized with the parse cache entry when present), slice `[startLine, endLine]` inclusive. Clamp to `[1, lineCount]`; enforce the per-call window cap by truncating at the cap from the start of the range. Meta: `backend: "text"`, `precision: "exact"`, `truncated` and `omittedCount` set when clamping or capping dropped lines.

#### readFileOutline

Route by adapter. Tree-sitter path: parse at the resolved revision, then build `FileOutline`:

- `packageName`: Go package clause; TS/JS: undefined (no package construct; the nearest `package.json` name is a Stage 3 fact, not re-derived here).
- `imports`: adapter `getImports` — Go import paths; TS/JS import specifiers plus literal `require("...")` arguments.
- `topLevelSymbols`: adapter `listSymbols` filtered to top-level declarations plus methods of top-level types, in source order, capped.
- `testSymbols`: test symbols per adapter conventions (see Language Adapters), capped.
- `notes`: parse-error notes (`hasErrors`), truncation notes, and fallback notes.

Fallback path (no grammar, oversized file, or parse failure): `language` from extension, `imports` from a single-pass regex over import-like lines (`^import\b`, `^from ... import`, `require(`), `topLevelSymbols` empty, `testSymbols` empty unless the filename matches test conventions (then one file-level `SymbolInfo` with `kind: "other"`), and a note describing the fallback. Meta: `backend: "text"`, `precision: "heuristic"`, `degraded: true`.

#### readSymbol

`readSymbol` absorbs enclosing-symbol lookup (formerly a separate tool): a line selector answers "what encloses this line", a name selector answers "show me this symbol". Symbol enumeration is `readFileOutline`'s job (`topLevelSymbols`).

Tree-sitter path: with a line selector, `getEnclosingSymbol(file, line)` returns the smallest symbol whose `lineRange` contains the line; the result includes the symbol's source text capped to the snippet limits, truncated tail-first with `truncated: true` when over the cap. With a name selector, resolution runs over the adapter's `listSymbols(file)` output: exact match on `name`, or on `ownerType + "." + name` for qualified queries; Go qualified queries are normalized by stripping `(*`, `)`, and package qualifiers, so `(*Store).SaveUser`, `Store.SaveUser`, and `SaveUser` all resolve. First match in file order wins; `omittedCount` counts the rest.

Fallback path: a line selector returns a ±20-line window centered on the requested line with `degraded: true` and no `symbol`. A name selector falls back to an exact-name text search within the file (word-boundary match) and returns a window around the first hit, `degraded: true`; no hit returns a degraded empty result.

#### findDefinition

1. Validate `pathGlob` if present; resolve `source` against the revision binding (default head).
2. `GitClient.grep(resolvedCommit, wordPattern(symbolName), { glob, maxResults })` where `wordPattern` produces a word-boundary ERE via `git grep -w` semantics with a fixed-string name.
3. Group matches by path; take the first 30 candidate files.
4. For each candidate with a grammar: parse content at the resolved revision, `listSymbols`, keep symbols whose `name` equals the query (or qualified match, as in `readSymbol`). Each kept symbol becomes a definition entry with a capped source snippet.
5. Candidates without grammars (or with failed parses) contribute their first text match as a degraded entry: `SymbolInfo` with `kind: "other"`, `lineRange: [line, line]`, no signature.
6. Meta: if every returned entry came from parsed definitions, `backend: "tree-sitter"`, `precision: "syntactic"`. If any text fallback entries are present, `degraded: true` with a reason counting them; if all entries are fallback, `backend: "text"`, `precision: "text"`.

The tool finds declaration-level definitions (top-level symbols, methods, members); it does not find local variable definitions, and it does not claim semantic resolution — name collisions return multiple candidates with provenance.

#### readDiffBlocks

Renders from the parsed `UnifiedDiff` retained at construction; no tree-sitter, no file reads. Each hunk renders as a header line (`<path> @@ -oldStart,oldLines +newStart,newLines @@ <hunkId>`) plus one line per `DiffLine` in the form `<oldNo|-> <newNo|-> <marker> <content>` where marker is `+`, `-`, or space. Selector resolution: `path` returns all hunks for that file (old or new path match); `packetId` resolves through the packet binding established by `bindPackets` and returns the packet's hunks. Blocks and total characters are capped with `truncated`/`omittedCount`.

#### searchFiles

1. Validate query (non-empty, ≤ 500 chars) and `pathGlob`.
2. Select engine per the fast-path rules; run the search with `maxResults + 1` to detect truncation.
3. Cap results, set `truncated`/`omittedCount`.
4. Enrichment:
   - `"lines"`: read ±2 context lines per match from the same revision content (batched per file, one read per file).
   - `"symbols"`: for the first 25 matches, parse the containing file (parse cache applies) and attach the enclosing `SymbolRef`. Enrichment is best effort; matches without a grammar or with failed parses simply omit `enclosingSymbol`. Enrichment failures are counted in telemetry, not in `degraded`.
5. Meta: `backend: "text"`, `precision: "text"` (enrichment does not change the answer's backend; the discovery was textual).

#### findSymbolMentions

1. Word-boundary search for the identifier at the resolved revision (default head; `git grep -w` with a fixed string, or ripgrep `-w -F` on the head fast path), `pathGlob` applied.
2. Token verification: for matches in the first 25 distinct files with grammars, parse and verify that the node at the match position is an identifier-class token exactly equal to the symbol name. Matches inside strings and comments are dropped.
3. Matches beyond the verification cap, or in files without grammars, are retained unverified.
4. Meta: all returned mentions verified → `backend: "tree-sitter"`, `precision: "syntactic"`. Any unverified mentions → `backend: "text"`, `precision: "text"`, `degraded: true` with a reason counting unverified entries. The result never claims `semantic` or `exact` in v1; only a future language-analyzer backend may upgrade precision, per `architecture.md`.

#### findLikelyTests

Input is a path or a `SymbolRef` (which carries its own path). Candidate test files by convention:

- Go: `*_test.go` in the same directory (same-package convention).
- TS/JS: sibling `<stem>.test.*` and `<stem>.spec.*`, `__tests__/` entries matching the stem, and `test/`/`tests/` directory entries matching the stem.
- Generic: filename stem match under the same conventions.

Candidates come from tree listings at the resolved revision (default head; `source?` supports base-side questions about deleted tests). With a symbol input, candidate files are filtered to those whose content mentions the symbol name (word-boundary text match). Files with grammars are parsed and their test symbols returned as `SymbolRef[]` (Go `Test*`/`Benchmark*`/`Fuzz*`/`Example*` functions; TS/JS `describe`/`it`/`test` call sites); when a symbol input is present, only test symbols whose source text mentions the symbol name are kept. Unparseable test files contribute one file-level `SymbolRef` (`kind: "other"`, `lineRange: [1, 1]`) so the model still learns the file exists. `LanguageAdapter.findLikelyTests` overrides the generic flow when implemented. Meta: `precision: "heuristic"` always; `backend` reflects whether parsing refined the answer; an empty list is a valid non-degraded answer.

#### listFiles

`GitClient.lsTree(headCommit, glob)`, capped at 500 paths. Returns `{ paths, meta }`: truncation at the cap sets `meta.truncated` and `meta.omittedCount` (model-visible through the standard tool-result rendering) and is recorded on the call's `ToolCallRecord`.

### Result Caps

Caps are component constants (not user configuration in v1; per-worker `ToolBudget.maxResultChars` enforcement is the worker runner's job and applies on top of these):

- `readRange`: 400 lines, 16000 chars per call.
- `readFileOutline`: 120 top-level symbols, 40 test symbols, 60 imports, 8000 chars.
- `readSymbol`: 250 lines, 10000 chars per snippet.
- `findDefinition`: 20 definitions, 30 candidate files parsed, 16000 chars total.
- `readDiffBlocks`: 20 blocks, 16000 chars.
- `searchFiles`: 50 results default, 200 hard cap, 500 chars per match line, 16000 chars total, 25 matches enriched in `"symbols"` mode.
- `findSymbolMentions`: 100 results default, 300 hard cap, 25 files token-verified.
- `findLikelyTests`: 20 test symbols.
- `listFiles`: 500 paths.

Every truncation sets `truncated: true` and `omittedCount` where the signature allows, and is recorded in telemetry with the omitted counts.

### Tree-Sitter Service

`tree-sitter-service.ts` owns the WASM runtime and grammar lifecycle:

- Initialization is lazy: `Parser.init()` runs on first parse request, locating `tree-sitter.wasm` inside the `web-tree-sitter` package. No grammars load eagerly.
- Grammar loading resolves `.wasm` files directly from `node_modules` via `createRequire(import.meta.url).resolve(...)` under ESM, per `architecture.md`: `tree-sitter-go/tree-sitter-go.wasm`, `tree-sitter-typescript/tree-sitter-typescript.wasm`, `tree-sitter-typescript/tree-sitter-tsx.wasm`, `tree-sitter-javascript/tree-sitter-javascript.wasm`. Loaded `Language` handles are cached per language id for the process lifetime.
- Extension routing: `.go` → go; `.ts`, `.mts`, `.cts`, `.d.ts` → typescript; `.tsx` → tsx; `.js`, `.jsx`, `.mjs`, `.cjs` → javascript (the javascript grammar parses JSX). Routing is by extension and known filename, consistent with the Stage 3 language fact for changed files; tools may read files outside the diff, so routing must not require `FileFacts`.
- ABI pinning: `web-tree-sitter` and the three grammar packages are version-pinned together in the lockfile; `Language.load` enforces ABI compatibility at runtime. A load failure (ABI mismatch, missing wasm) marks that language unavailable for the run: one `warn` telemetry event with the `parser_unavailable` classification, and all routing for that language degrades to the generic adapter for the rest of the run. It never fails the review.
- Parsing is in-memory over revision content. Guards: files over 1.5 MB are not parsed (degraded result); the parser timeout is 1000 ms per file, after which the file is treated as unparsed (`hasErrors: true`, `tree: undefined`).
- Parse cache: LRU of 128 entries keyed by `(contentSha, language)`. The git blob sha (from `ls-tree`, or computed once per read) keys plumbing content; `sha256(content)` is the fallback key when no blob sha is available. Concurrent requests for the same key share one in-flight promise. Evicted trees are explicitly disposed (`tree.delete()`) to release WASM memory.
- Trees with ERROR/MISSING nodes are still used: adapters extract what is syntactically sound and mark `hasErrors`. Extraction quality consequences are defined per consumer (see Stage 4).

### Language Adapters

The `LanguageAdapter` interface is law. The adapter registry routes by extension and exposes a shared base implementation that walks named node types per language (no `.scm` query assets in v1). Adapter authors map symbols with the single question defined in `architecture.md` and always pass the language's own word through `nativeKind`.

Qualified-name rendering: each adapter defines the conventional qualified rendering used wherever an enclosing symbol is shown as a string (`HunkSymbolFacts.enclosingSymbol`, snippets, prompts): Go methods render as `(*Store).SaveUser` for pointer receivers and `Store.SaveUser` for value receivers; TS/JS members render as `ClassName.method`; free functions render bare. `SymbolInfo.name` always carries the bare name; the owner lives in `ownerType`.

#### Go Adapter

`SymbolKind` mapping (node type → kind / `nativeKind`):

- `function_declaration` → `function` / `"func"`.
- `method_declaration` → `method` / `"method"`; `ownerType` is the receiver type identifier with pointer stars, parentheses, and generic type parameters stripped (`(s *Store[T])` → `Store`).
- `type_spec` containing `struct_type` → `type` / `"struct"`.
- `type_spec` containing `interface_type` → `interface` / `"interface"`.
- Any other `type_spec` (named types, aliases) → `type` / `"type"`.
- Top-level `const_spec` → `value` / `"const"`; top-level `var_spec` → `value` / `"var"` (one symbol per declared name).
- Anything else → `other` with the node type as `nativeKind`.

`exported` is true when the name starts with an uppercase letter. `packageName` comes from the package clause. `signature` is the declaration source from `func` through the parameter/result list, single-line normalized (the Stage 4 example signature shape). Imports are the `import_declaration` path literals. Test conventions: `*_test.go` files; test symbols are functions named `Test*`, `Benchmark*`, `Fuzz*`, or `Example*`.

#### TypeScript/JavaScript Adapter

One adapter implementation serves the `typescript`, `tsx`, and `javascript` grammars. `SymbolKind` mapping:

- `function_declaration` / generator declarations → `function` / `"function"`.
- Top-level `const`/`let`/`var` bound to an arrow function or function expression → `function` / `"arrow function"` (callable-defining bindings map as callables).
- `class_declaration` → `type` / `"class"`.
- `method_definition` → `method` / `"method"`; constructors → `method` / `"constructor"`; accessors → `method` / `"getter"` or `"setter"`; class fields whose value is a function → `method` / `"class field function"`. `ownerType` is the enclosing class name.
- `interface_declaration` → `interface` / `"interface"`.
- `type_alias_declaration` → `type` / `"type alias"`; `enum_declaration` → `type` / `"enum"`.
- Other top-level `const`/`let`/`var` → `value` / `"const"`, `"let"`, or `"var"`.
- `namespace`/internal module declarations → `container` / `"namespace"`; members are extracted one level deep with the namespace as their container context.
- Anything else → `other` with the node type as `nativeKind`.

`exported` is true for `export`-modified declarations, names in `export { ... }` lists, and `export default` (an anonymous default exports as name `"default"`). CommonJS `module.exports` assignment is not tracked as exported in v1 (honest precision). Imports are import-declaration module specifiers plus literal `require("...")` arguments. `signature` is the declaration header through the parameter list and return type annotation, single-line normalized. Test conventions: `*.test.*`, `*.spec.*`, `__tests__/`, `test/`, `tests/`; test symbols are `describe`/`it`/`test` call sites (including `.only`/`.skip`/`.each` member forms), named by their first string-literal argument, mapped to `function` / `"test case"`.

#### Generic Adapter

The generic adapter keeps call sites uniform for unsupported languages: `parse` resolves a `ParsedFile` with `tree: undefined` and `hasErrors: false` (there was no parse to fail); `listSymbols` and `getChangedSymbols` return empty; `getEnclosingSymbol` returns undefined; `getImports` returns the regex import scan used by the outline fallback. Every tool routed through it produces text-backend degraded results as specified per tool.

### Stage 4 Changed-Symbol Extraction

`extractChangedSymbolFacts` is deterministic, never calls the LLM, and emits one `HunkSymbolFacts` record per hunk of every kept reviewable file (processing mode `per-hunk` or `whole-file`), including records with no enclosing symbol so the planner sees honest gaps.

Side selection per hunk:

- Hunks with added lines: facts come from head content; `changedLines` are the added lines' new-side line numbers, with `changedLinesSide: "new"`.
- Deletion-only hunks (and all hunks of deleted files): facts come from base content; `changedLines` are the removed lines' old-side line numbers, with `changedLinesSide: "old"`. The required `changedLinesSide` field carries the side explicitly; consumers never infer it from line kinds.
- Files with no base-side content available (the empty-tree base of a root commit) skip base-side facts and emit fallback records for deletion-only hunks.

Tree-sitter path, per file side actually needed:

1. Parse once (parse cache shared with tools and signals).
2. For each hunk, call `getChangedSymbols(file, hunk)`: the innermost symbol enclosing each changed line, deduped, each with its covered `changedLines` attributed.
3. Pick the primary enclosing symbol deterministically: the symbol covering the most changed lines; ties break to the smallest line span, then the earliest start line.
4. Emit `HunkSymbolFacts` with the qualified `enclosingSymbol` rendering, `symbolKind`, `symbolNativeKind`, `symbolRange`, `changedLines`, `changedLinesSide`, `signature`, `source: "tree-sitter"`, `confidence: "syntactic"`.
5. If the smallest node covering the changed lines is an ERROR region or no symbol covers any changed line, fall through to fallback detection for that hunk.

Fallback detection (no grammar, parse failure/timeout, oversized file, or ERROR region):

1. Scan upward from the first changed line through at most 200 lines of the available content (diff context lines when no content is readable).
2. Match per-language declaration regexes: Go `^func\s+(\(\s*\w+\s+\*?(\w+)\s*\)\s*)?(\w+)`, TS/JS `^(export\s+)?(default\s+)?(async\s+)?function\s*\*?\s*(\w+)`, `^(export\s+)?(abstract\s+)?class\s+(\w+)`, `^(export\s+)?(const|let|var)\s+(\w+)\s*=\s*(async\s*)?\(`.
3. On match, emit name (receiver-qualified for Go), kind from the pattern class, `source: "fallback"`, `confidence: "heuristic"`, `signature` = the matched line trimmed, the side-selection `changedLinesSide`, and no `symbolRange` (the end is unknown).
4. No match: emit the record with only `path`, `hunkId`, `changedLines`, `changedLinesSide`, `source: "fallback"`, `confidence: "heuristic"`.

Parser gaps degrade packet context quality; they never block review.

### Static Signals: V1 Rule Set

`extractStaticSignals` runs in the same pass over the same parses. Signals are deterministic hints for the planner and reviewers — never findings, never published directly, promotable to candidates only by a reviewer citing them (`architecture.md`). Rules state syntactic facts with honest explanations; whether a fact matters is the model's call.

Rule engine: each rule declares `ruleId`, applicable languages, diff side, a matcher (a tree-sitter node check scoped to changed line ranges, a diff-line regex, or both), `category`, `lensHint`, fixed `confidence`, and an explanation template. Confidence grades certainty of the stated fact, not severity. Signals deduplicate per `(ruleId, path, line)`, and are capped at 20 per file and 200 per run (cap hits recorded in telemetry). Tree-backed rules go silent when parsing is unavailable; diff-regex rules run on diff line content alone and need no parse.

V1 ships exactly two cross-language rules — the complete rule set:

- `core/deleted-test-file` — a kept file with `testStatus: "test"` and status `deleted`. Diff/facts-derived (no parse needed). Confidence high, category `testing`, lensHint `core/tests`.
- `core/exported-api-change` — an exported enclosing symbol's normalized signature differs between base and head, or an exported symbol is deleted. Requires both-side parses; evaluated only for symbols overlapping changed lines, and base parses run only for files where the head side found an exported enclosing symbol. Confidence medium, category `architecture`, lensHint `core/code-review`.

Per-language rule packs (`lang/go/*`, `lang/ts/*` — ignored errors, goroutines, concurrency primitives, defer-in-loop, fresh contexts, panics, removed test functions, `any` casts, non-null assertions, empty catches, type-suppression comments, removed test cases) are deferred to Future Considerations — see architecture.md. `LanguageAdapter.getStaticSignals` remains the seam they plug into; no v1 adapter implements it.

The v1 set is intentionally conservative: each rule states a syntactic certainty, lint/style territory is excluded, and nothing requires type information or flow analysis. New rules require an eval-backed justification, per the project's compounding-assets stance.

### PacketContext Assembly

`buildPacketContext` produces the law-typed `PacketContext` for one packet's file and hunks. It is deterministic, uses only already-parsed content plus bounded local lookups, and performs no broad repository exploration (Stage 6 contract). The wrapper return carries a `degradation` note so the packet builder can set `ReviewPacket.degraded`; `PacketContext` itself has no meta field.

Assembly, on the side selected by Stage 4 rules (head for hunks with adds, base for deletion-only content):

- `path`, `packageName`: from the file outline data.
- `enclosingFunction` / `enclosingMethod` / `enclosingType`: resolved from the packet hunks' primary enclosing symbols. A `method` fills `enclosingMethod` and its `ownerType`'s type declaration (when found in the same file) fills `enclosingType`; a `function` fills `enclosingFunction`; changed lines directly inside a type declaration fill `enclosingType`. With multiple hunks, the primary symbol of the first hunk in file order wins; others remain visible through `symbolFacts`.
- `outline` (returned alongside the context, not a `PacketContext` field): the same `FileOutline` the `readFileOutline` tool produces for the packet's file and side, for the builder's context-budget assembly.
- `relevantTests` (returned alongside the context, not a `PacketContext` field): the internal `findLikelyTests` flow for the primary enclosing symbol, capped at 5. The packet builder assigns it to `ReviewPacket.relevantTests`, the single carrier of likely tests.

Richer pre-attached context — `changedNodes` (`AstNodeSummary`), `importsUsedNearby`, `nearbySiblingFunctions` — is deferred to Future Considerations (see architecture.md); reviewers fetch that context on demand with the read-only tools.

Handoff contract: the Stage 6 packet builder renders `buildPacketContext`'s outputs — the context metadata, the file outline, and the likely-tests list — plus its separately read enclosing-symbol source into `ReviewPacket.contextText` within `maxContextChars`, per `architecture.md`. The builder owns final sizing: ordinary symbol source starts compact, while important single-symbol packets can receive adaptive source context within the packet budget. When no parse is available, the context degrades to `path` plus a regex-scanned fallback outline and a `degradation` note; the packet still ships.

### Caching And Concurrency

- The tools facade is shared by concurrent packet workers and verifiers (`review.concurrency` bound). All state is read-only after construction except the parse cache and memoized content reads, both guarded by in-flight promise dedup; `bindPackets` runs once before Stage 7 concurrency begins.
- Git and ripgrep subprocesses are bounded by an internal `p-limit` semaphore of 8 to avoid process storms under concurrent workers.
- Content reads memoize `(sha, path) → content` alongside the parse cache so repeated windows over one file cost one `git show`.
- Nothing in this component caches across runs; the local review cache is a model-call cache and does not apply here.

### Telemetry

This component emits stage-attributed events through the injected recorder for its own passes: Stage 4 extraction (per-file parse outcomes, fallback usage, signal counts, cap hits).

The `RepositoryTools` facade supplies the per-call measurement behind the always-on `ToolCallRecord` contract (`architecture.md`): every invocation produces `backend`, `precision`, `degraded`/`degradationReason`, `truncated`, `resultCount`, `resultChars`, `durationMs`, and the normalized args (path/symbol/lines/query/glob/source/contextMode), and the facade reports them to the telemetry recorder, which owns persistence to `tool-calls.jsonl` and the `tool-calls-summary.json` aggregation (`components/skills_llm_telemetry.md`). Harness-initiated invocations that go through the facade — packet-context assembly, classifier reads if any — are recorded with `initiator: "harness"` and the current stage; for model-initiated calls, attaching `workerId`, `packetId`, `modelCallId`, and the other join ids is the worker runner's responsibility. Containment rejections surface as `status: "rejected"` records. Engine identity goes in-band on the record's `engine?: "git-grep" | "ripgrep"` field for text-search-backed calls, rather than in `ToolResultMeta`, as noted above. Containment violations additionally log at `warn`.

## Dependencies

This component depends on:

- `GitClient` (`components/repository_and_github.md`) for `revParse`, `catFile`, `lsTree`, and `grep` — all revision access flows through it; subprocess hygiene is its contract.
- The parsed `UnifiedDiff`, `DiffFile`/`DiffHunk`/`DiffLine` records, and `FileFacts` produced upstream (Stages 1–3).
- `web-tree-sitter` plus the pinned `tree-sitter-go`, `tree-sitter-typescript`, and `tree-sitter-javascript` grammar packages, resolved from `node_modules`.
- `@vscode/ripgrep` (>= 1.18.0) for the worktree search fast path.
- `p-limit` for subprocess concurrency bounds.
- The `Logger` and `TelemetryRecorder` interfaces (`components/skills_llm_telemetry.md`).

Depended on by:

- `components/review_pipeline.md`: `buildRepositoryIndex` output feeds the planner dossier (`HunkSymbolFacts`, `StaticSignal`); the packet builder calls `buildPacketContext` (context plus the file outline and the likely-tests list for `relevantTests`) and the orchestrator calls `bindPackets` between Stage 6 and Stage 7.
- `components/skills_llm_telemetry.md`: the worker runner wraps the nine `RepositoryTools` methods as LLM tool definitions for packet reviewers and verifiers, and enforces `ToolBudget` on top of this component's per-call caps.
- `components/evals.md`: consumes tool-call records (`tool-calls.jsonl`) and degradation telemetry to attribute losses; no direct code dependency.

## Test Plan

Unit tests (Vitest), grouped by area, with what each verifies:

Path and ref containment:

- `path-guard rejects absolute path` — `/etc/passwd` and `//x` reject with `path_outside_repo`.
- `path-guard rejects dot-dot traversal` — `a/../../b` and `..` reject even when lexically resolvable inside the root.
- `path-guard rejects git directory prefix` — `.git/config` rejects; `src/.gitignore-like/file.go` passes.
- `path-guard rejects backslash and nul` — Windows separators and NUL bytes reject.
- `path-guard normalizes accepted paths` — `./a//b/./c.go` canonicalizes to `a/b/c.go`.
- `worktree check rejects symlink escaping root` — fixture symlink to a temp dir outside the repo rejects on realpath check.
- `worktree check allows in-repo symlink` — symlink resolving inside the root is readable.
- `glob-guard applies lexical rules` — absolute and `..`-bearing globs reject; `src/**/*.go` passes.
- `ref-guard rejects option-like ref` — `-rf` and `--upload-pack=x` reject with `invalid_args`.
- `ref-guard enforces check-ref-format rules` — `a..b`, `a.lock`, `@{`, control chars reject; `feature/x` and 40-hex SHAs pass.
- `containment violation emits warn telemetry` — a rejected path produces a `warn` event naming the tool.

Revision binding and source resolution:

- `binding prefers shas over refs` — PR-mode binding resolves to `headSha`/`mergeBase` without re-deriving from ref names.
- `single-commit binding reads mergeBase` — base comes from `ResolvedReviewInput.mergeBase` (the first parent) with no `commit^` re-derivation; a root commit binds base to the empty-tree sentinel and base reads return missing-content degraded empties.
- `base read returns deleted file content` — a file deleted at head reads successfully with `{ kind: "base" }`.

Search engines:

- `fast path requires matching clean head` — engine is ripgrep only when HEAD equals the reviewed head and tracked files are clean; otherwise git grep (verified via the calls' in-band `ToolCallRecord.engine` field).
- `fast path filters untracked hits` — a match in an untracked file is absent from fast-path results.
- `rust-regex rejection falls back to git grep` — a pattern ripgrep rejects still answers via git grep; the call's `ToolCallRecord` carries `engine: "git-grep"` plus a fallback telemetry note.
- `invalid pattern on both engines is invalid_args` — an ERE both engines reject surfaces as a typed tool error.
- `ere parity fixture` — a pattern using alternation, intervals, and classes returns identical match sets from both engines on a fixture repo.
- `base search uses git grep at base sha` — `SearchOptions.source = base` never uses ripgrep.
- `search caps set truncated and omittedCount` — result over `maxResults` truncates with correct counts.
- `contextMode lines returns windows` — ±2 lines attached per match.
- `contextMode symbols attaches enclosing ref` — matches in parseable files carry `enclosingSymbol`; unparseable files omit it without degrading the call.

Tool behavior:

- `read-range clamps and reports truncation` — out-of-bounds range clamps; meta records omitted lines; `precision: "exact"`.
- `read-range missing file degrades empty` — nonexistent path at the revision returns empty degraded result, not an error.
- `outline go file` — package name, imports, top-level symbols with methods, and `Test*` symbols extracted from a Go fixture.
- `outline fallback for unsupported language` — a `.rb` file yields heuristic outline with `backend: "text"`, `degraded: true`, and a fallback note.
- `read-symbol line selector returns enclosing symbol` — a line inside a method returns that method as `SymbolInfo` with capped source text, `precision: "syntactic"`.
- `read-symbol line-selector fallback window` — parse failure returns ±20-line window, no symbol, degraded.
- `read-symbol selector validation` — both or neither of name/line rejects `invalid_args`.
- `read-symbol qualified go method lookup` — `(*Store).SaveUser`, `Store.SaveUser`, and `SaveUser` resolve to the same method; duplicates report `omittedCount`.
- `find-definition filters to definition nodes` — a name appearing in calls and one declaration returns only the declaration; meta `syntactic`.
- `find-definition mixed fallback` — an unparseable candidate file contributes a degraded text entry and sets `degraded: true` with a count.
- `diff-blocks renders dual line numbers` — old/new gutters and `+`/`-` markers match fixture expectations.
- `diff-blocks packet lookup requires binding` — packetId before `bindPackets` degrades empty; after binding returns the packet's hunks.
- `mentions token verification drops strings and comments` — identifier in a comment and string literal is excluded; code mention retained; meta `syntactic` when all verified.
- `mentions beyond verification cap degrade` — over-25-file result keeps unverified entries with `precision: "text"` and a counting reason.
- `likely-tests go sibling convention` — `store/user.go` symbol finds `store/user_test.go` `TestSaveUser`.
- `likely-tests ts conventions` — `foo.ts` finds `foo.test.ts`, `__tests__/foo.tsx`, and `test/foo.spec.ts` candidates filtered by symbol mention.
- `list-files caps at limit` — over-500 listing truncates and records telemetry.

Tree-sitter service:

- `tsx routes to tsx grammar` — `.tsx` parses with the tsx grammar; `.ts` with typescript; `.d.ts` with typescript; `.cjs` with javascript.
- `abi or load failure degrades language for run` — a failing `Language.load` marks the language unavailable; subsequent calls route to the generic adapter; one warn event.
- `parse cache hits by content sha` — same blob parsed once across tools, Stage 4, and signals; in-flight dedup under concurrency.
- `oversized file skipped` — a >1.5 MB file produces `tree: undefined`, `hasErrors: true`, degraded tool results.
- `error trees still extract sound symbols` — a file with a syntax error in one function still lists the other functions.

Stage 4 extraction (aligning with the fixture tests named in `architecture.md`):

- `go changed-function extraction` — changed lines inside `SaveUser` produce facts matching the functional-spec example, `source: "tree-sitter"`, `confidence: "syntactic"`.
- `go method receiver ownerType and qualified name` — pointer receiver yields `ownerType: "Store"` and `enclosingSymbol: "(*Store).SaveUser"`; value receiver renders without `(*)`.
- `typescript changed-function extraction` — class method and arrow-function-const changes map to `method`/`function` with correct `nativeKind`.
- `deletion-only hunk maps to base side` — removed lines map to the base-revision symbol with old-side `changedLines` and `changedLinesSide: "old"`; add-bearing hunks carry `changedLinesSide: "new"`.
- `primary symbol pick is deterministic` — a hunk spanning two functions picks the one covering more changed lines; tie breaks by span then start line.
- `fallback regex extraction` — with parsing disabled, a Go hunk yields `source: "fallback"`, `confidence: "heuristic"`, signature from the matched line, no `symbolRange`.
- `unsupported language fallback emits empty facts` — a hunk in a language with no fallback pattern still emits a record with `changedLines` only.
- `every kept hunk gets a record` — record count equals kept reviewable hunk count.

Static signals (one per rule plus engine behavior):

- `deleted test file signal` — deleted `_test.go` file emits `core/deleted-test-file`; a deleted non-test file does not.
- `exported api change signal` — exported Go function signature change emits `core/exported-api-change`; unexported change does not; base parse runs only when triggered.
- `signals capped per file and run` — caps enforced with telemetry records; signals carry correct `side` and line numbers.
- `tree rule silent without parse` — parse failure suppresses `core/exported-api-change` while the facts-derived `core/deleted-test-file` still fires.

PacketContext assembly:

- `packet context resolves method and owner type` — method change fills `enclosingMethod` and `enclosingType` from the same file.
- `packet context returns outline and tests alongside` — a parseable file yields the `FileOutline` and a ≤5-entry likely-tests list in the wrapper return; `PacketContext` itself carries no outline or tests field.
- `packet context degraded without parse` — unparseable file returns path plus a fallback outline and a degradation note.
- `packet context deletion-only uses base content` — deleted-file packet context assembles from base-side parse.

Integration (temporary git repositories):

- `index built against non-checked-out revision` — build the index with HEAD on an unrelated branch; reads, outlines, search, and Stage 4 facts all reflect the reviewed revisions (plumbing-only), and the fast path stays off.
- `dirty worktree never leaks into results` — modify a tracked file in the worktree; head reads and searches return committed content.
- `end-to-end tool meta and telemetry` — a scripted tool-call sequence produces meta and telemetry records with backend, precision, engine, degradation, and truncation fields populated as specified.
- `harness calls record initiator harness` — packet-context assembly, run through the facade, reports `ToolCallRecord`s to the recorder with `initiator: "harness"`, the executing stage, and populated measurement fields (backend, precision, durationMs, resultChars, normalized args).
- `containment rejection records rejected status` — a tool call failing containment produces a `status: "rejected"` `ToolCallRecord` alongside the `warn` telemetry event.
