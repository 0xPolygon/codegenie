---
status: complete
---

# Phase 1: Shared language foundation

## Overview

Establish the shared, language-neutral seams needed for the later Rust, Python, and Solidity vertical slices. This phase pins exact grammar assets and their failure behavior, carries one canonical language identity through classification and packet routing, enforces language compatibility at planner and prompt projection boundaries, centralizes likely-test discovery, and extends declaration identity without changing the existing Go/TypeScript output contracts. It deliberately does not add Rust, Python, or Solidity symbol extraction or bundled language skills, and it does not create an eval baseline or release boundary.

## Steps

1. Add exact `tree-sitter-rust@0.24.0`, `tree-sitter-python@0.25.0`, and `tree-sitter-solidity@1.2.13` runtime dependencies in `package.json`/`pnpm-lock.yaml`; extend the pnpm build-script policy for their unused native builds, inspect both pnpm and npm dependency/install behavior, and record the Solidity peer/native decision and WASM provenance in this phase plan.
2. Extend `GrammarId`, grammar-WASM resolution, path routing, and adapter registration in `src/repo/tree-sitter/tree-sitter-service.ts` and the shared adapter registry so `.rs`, `.py`, and `.sol` lazily parse with requested adapter ids before their language-specific symbol adapters exist. Keep `.pyi` on the generic/unknown path.
3. Make the tree-sitter runtime lifecycle injectable at its external boundaries and preserve the exact clean, partial-error, unavailable, throw, timeout/null, and size-cap outcomes. Keep grammar resolution failures cached unavailable and emit `parser_unavailable` only for that failure class.
4. Update the raw diff parser, detectors/classifier, packet default-language routing, and fake planner routing so Rust, Python, and Solidity use canonical ids and exact `lang/<language>` defaults. Preserve the TypeScript/JavaScript alias and existing Go/TypeScript behavior.
5. In `src/pipeline/planner.ts`, reject enabled but language-incompatible language lenses with dedicated telemetry, then restore deterministic core/exact-language defaults when no compatible lens survives. In Stage 7 and Stage 9 skill projection, include only language-neutral skills or skills whose `languages` contain the packet language.
6. Remove the unused `LanguageAdapter.findLikelyTests` hook and make `src/repo/likely-tests.ts` the single contract for language-aware candidate paths, recognized parsed test symbols, deterministic sorting/deduplication, the 20-result cap, source selection, and text fallback. Add only the accepted Rust/Python/Foundry path conventions; keep deferred discovery modes out.
7. Add an optional identity callback to `changedSymbolsFromEnclosing`, defaulting to the current qualified-name identity so Go and TypeScript output remains unchanged while later adapters can distinguish overloads and owner-specific declarations.
8. Extend detector and per-consumer path-role rules for Python test names, Rust test paths/names, and Solidity `.t.sol` files, with positive/negative assertions and no ambiguous ecosystem-directory skips.
9. Add a reusable structural integration test harness that proves canonical identity through diff facts, grammar adapter/outline, packet language, and exact language lens selection; add focused lifecycle, planner, skill projection, likely-test, declaration-identity, and path-role tests.
10. Document in `specs/plans/PUNCHLIST.md` that Phases 1-4 are one unreleased integration series: the additional Stage-5 inventory and registry/cache hash are one expected Phase-5 release boundary, and intermediate states are not measurement baselines.

## Tests

- `loads every registered grammar from the installed dependency layout`: minimally parses Go, TypeScript, TSX, JavaScript, Rust, Python, and Solidity and asserts retained clean trees.
- `pins parser lifecycle failure semantics`: table-tests clean, syntax-error partial, grammar unavailable/cached telemetry, parser throw, timeout, null tree, and parse-size-cap results.
- `carries canonical language identity through the shared production seams`: for `.rs`, `.py`, and `.sol`, asserts matching diff/facts language, requested adapter id, outline language, packet language, and exact language lens; asserts `.pyi` remains unknown/generic.
- `normalizes planner lenses by hunk language`: covers omitted decisions, empty lens arrays, explicit wrong-language selections, compatible shared/core lenses, and deterministic degraded/default planning.
- `projects packet skills by canonical language in Stage 7 and Stage 9`: keeps neutral and matching skills while excluding Rust/Python/Solidity skills from incompatible packet prompts.
- `discovers deterministic likely-test candidates through one contract`: covers Rust, Python, and Solidity conventions, path-only versus symbol requests, source propagation, recognized parsed symbols, unparseable text fallback, stable dedupe/order, and the 20-result cap.
- `supports declaration-specific changed-symbol identity without regressing defaults`: merges repeated changed lines in one declaration, separates same-name declarations when a range/signature identity is supplied, and preserves Go/TypeScript qualified-name behavior by default.
- `classifies each language test path consistently per consumer`: pins positive and negative repository/classifier, composition, coverage, packet, and promotion roles, including inline Rust source staying source.
- `pnpm run check`, `pnpm test`, and `pnpm build`: run the complete repository gates after implementation.

## Dependency safety record

The exact package versions are recorded in both `package.json` and the frozen lockfile. Their published lockfile integrity hashes are retained by pnpm, and the installed WASM bytes have these SHA-256 hashes:

- `tree-sitter-rust@0.24.0/tree-sitter-rust.wasm`: `f65f354215611fd94ad34134b3427eb3d58cbb745df7b6509ba722184db73d57`
- `tree-sitter-python@0.25.0/tree-sitter-python.wasm`: `16108b50df4ee9a30168794252ab55e7c93bfc5765d7fa0aa3e335752c515f47`
- `tree-sitter-solidity@1.2.13/tree-sitter-solidity.wasm`: `07420813d7668445152a5d5d2017e0fb84cb27342257e1add3cc7462eec7f811`

`pnpm install --frozen-lockfile` succeeds under the repository build-script policy, and `pnpm peers check` reports no issues. All three packages declare `node-gyp-build` install scripts and publish prebuilt native artifacts, but codegenie never imports their native bindings; it resolves only the listed WASM files through `web-tree-sitter`. The policy therefore adds all three packages to `ignoredBuiltDependencies`. Direct offline execution of each package's install lifecycle from its real installed package directory also succeeds against its published prebuild, confirming that an npm-style script-enabled install does not require a local compiler on this supported platform.

`npm ls --all` confirms the installed dependency shape: each new grammar shares `node-gyp-build@4.8.4`, while neither `tree-sitter` nor `tree-sitter-cli` is needed by codegenie's runtime tree. Solidity 1.2.13 declares `tree-sitter@^0.25.0` as a peer but misspells the corresponding optional-peer metadata key as `tree_sitter`. Installing that unused native peer would expand the consumer surface without helping the WASM runtime, so `peerDependencyRules.ignoreMissing` explicitly documents and suppresses only the missing `tree-sitter` peer. The seven-grammar production load test resolves and parses all assets from `node_modules`, including Solidity, with no native peer present.

The Solidity vendored-WASM stop path is therefore not triggered: the frozen supported install, native lifecycle probe, peer audit, and actual WASM runtime all succeed. The Phase-5 packed-install gate remains responsible for repeating this proof from the final published tarball after all three vertical slices are present.
