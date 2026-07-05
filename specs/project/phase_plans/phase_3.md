---
status: draft
---

# Phase 3: Repository Intelligence

## Overview

Build the repository intelligence layer that supplies deterministic code context to the later review pipeline. This phase adds revision-bound repository tools, tree-sitter parsing with Go/TypeScript/JavaScript adapters, Stage 4 changed-symbol facts, the two v1 static signals, packet-context assembly, path/ref containment, search backends, and telemetry records for tool calls.

## Steps

1. Pin runtime dependencies in `package.json`/`pnpm-lock.yaml`: `web-tree-sitter`, `tree-sitter-go`, `tree-sitter-typescript`, `tree-sitter-javascript`, and `p-limit`. Verify `web-tree-sitter` exposes parse interruption via `ParseOptions.progressCallback`, and verify the installed tarballs include `tree-sitter.wasm`, `tree-sitter-go.wasm`, `tree-sitter-typescript.wasm`, `tree-sitter-tsx.wasm`, and `tree-sitter-javascript.wasm`.
2. Extend `src/types.ts` with the Phase 3 contracts: `SymbolKind`, `SymbolRef`, `SymbolInfo`, `ChangedSymbol`, `HunkSymbolFacts`, `StaticSignal`, `SourceSelector`, `ToolResultMeta`, `FileOutline`, `SearchOptions`, `PacketContext`, `RepositoryIndex`, `RepositoryTools`, and `RepositoryToolsHost`; update `SearchResult` for `enclosingSymbol` and align `ToolBackend`/`ToolPrecision` with the architecture.
3. Add `src/repo/path-guard.ts` implementing `containPath(repoRoot, input)`, `containGlob(repoRoot, input)`, `assertWorktreeContained(repoRoot, relPath)`, and `containRef(ref)` with typed `path_outside_repo`/`invalid_args` errors and warn telemetry hooks.
4. Add `src/repo/source-resolver.ts` to derive `RevisionBinding { headCommit, baseCommit }` from `ResolvedReviewInput`, resolve `SourceSelector`, memoize plumbing reads/blob shas, and list files.
5. Add `src/repo/tree-sitter/tree-sitter-service.ts` with lazy WASM init, grammar routing for `.go`, `.ts`/`.mts`/`.cts`/`.d.ts`, `.tsx`, `.js`/`.jsx`/`.mjs`/`.cjs`, a 1.5 MB parse guard, 1000 ms parse interruption via `progressCallback`, language-unavailable degradation, and a 128-entry parse cache.
6. Add `src/repo/language-adapter.ts` plus Go, TypeScript/JavaScript, and generic adapters. Implement imports, top-level symbols, test symbols, enclosing-symbol lookup, changed-symbol extraction helpers, qualified symbol rendering, and text fallback utilities.
7. Add `src/repo/search.ts`, `src/repo/diff-blocks.ts`, and `src/repo/likely-tests.ts` implementing `searchFiles`, `findSymbolMentions`, `findDefinition`, `readDiffBlocks`, `findLikelyTests`, and `listFiles` with result caps, revision reads, git-grep search, context enrichment, and meta/degradation fields.
8. Add `src/repo/symbol-extraction.ts` and `src/repo/static-signals.ts` for Stage 4 `HunkSymbolFacts` and the v1 `core/deleted-test-file`/`core/exported-api-change` signals, including deletion-only base-side handling and fallback regex detection.
9. Add `src/repo/packet-context.ts` and `src/repo/repository-index.ts` to assemble `PacketContext`, expose all nine repository tools plus `bindPackets`/`buildPacketContext`, and record every facade call through `TelemetryRecorder.recordToolCall`.
10. Update any existing telemetry tests that depended on the pre-Phase-3 backend enum values.

## Tests

- `path-guard rejects unsafe paths/globs/refs`: verifies absolute paths, `..`, `.git`, backslashes, NUL bytes, option-like refs, and malformed refs reject with typed errors.
- `path-guard normalizes safe paths`: verifies `./a//b/./c.go` canonicalizes to `a/b/c.go`.
- `tree-sitter service routes grammars`: verifies Go, TS, TSX, and JS routes parse and unsupported files use the generic path.
- `repository tools read and render revision content`: verifies `readRange`, `readFileOutline`, `readSymbol`, `readDiffBlocks`, and `listFiles` over temporary git repositories.
- `search tools use git-grep semantics`: verifies `searchFiles`, context windows, symbol enrichment, mention verification, base-side search, caps, and telemetry engine fields.
- `Stage 4 changed-symbol extraction`: verifies Go and TypeScript changed hunks, deletion-only base-side facts, fallback extraction, and one fact per kept hunk.
- `static signals`: verifies deleted test files and exported API signature changes produce the two v1 signal ids without generating extra language-specific rules.
- `packet context assembly`: verifies method/type/function fields, outline return, likely-test return, and degraded fallback behavior.
- `tool telemetry`: verifies successful calls, degraded calls, and containment rejections record normalized args, backend, precision, engine, duration, result chars, and status.
