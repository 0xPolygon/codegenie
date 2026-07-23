---
status: complete
---

# Phase 2: Rust vertical slice

## Overview

Add first-class Rust repository context on top of the shared Plan 98 foundation. This phase supplies a tree-sitter Rust adapter with stable declaration identity and ownership, deterministic v1 test discovery, a default-enabled evidence-driven Rust review skill, production-path and fake-transport fixtures, packed-layout coverage, and synchronized normative documentation. It deliberately leaves `exported` unset and defers same-file `#[cfg(test)]` discovery, arbitrary integration-test scanning, native semantic analysis, and real-model baselining.

## Steps

1. Add `src/repo/tree-sitter/rust-adapter.ts` and register it in `TreeSitterService`. Extract top-level and block-local Rust functions, methods, types, traits, modules, values, macros, associated items, and stable comment-free `use`/`extern crate` imports in source order with whitespace/comment/trailing-comma-neutral semantic deduplication that preserves the first compact display. Retain outer attributes across comment trivia in declaration ranges, keep function and macro signatures body-free and bounded, and reset trait/impl ownership inside callable bodies. Model every valid `impl_item` as ownership context, normalize unambiguous relative, root-absolute, Unicode, and raw-identifier nominal/generic targets from grammar-validated identifier nodes while retaining complete compact wrapper and projection-capable (`Self`/generic-rooted) targets, preserve AST depth for equal-line enclosure, and use path/kind/owner/name/range/signature identity so same-named trait and impl declarations remain distinct. Leave `exported` unset.
2. Extend `src/repo/likely-tests.ts` with Rust candidate paths for sibling `<stem>_test.rs` and nearest Cargo-package `tests/<stem>.rs`. Classify supported attributed Rust functions as `nativeKind: test case`, return deterministic deduplicated paths/symbols, and preserve the shared 20-result/source-selection/backend contract. Do not discover same-file `#[cfg(test)]` modules or arbitrary-name integration tests.
3. Add `bundled-skills/lang/rust.md` as a default-enabled Rust lens skill. Give every check an observable failure predicate, reachability/materiality and severity rule, concrete unsafe example, distinct concrete safe counterexample, and separate mitigation; include the required Checks, False Positives, Safe Patterns, and Examples sections. Add an evidence-bearing `lang/rust` entry to `BUNDLED_SKILL_WHY_LEDGER` and pin loading, budget, and compatible Stage-7/9 projection behavior.
4. Add a structural Rust repository fixture and integration assertions covering canonical identity, clean Rust parsing, symbols/ranges/owners/identity, attribute/header/body enclosure, imports, exact likely tests, packet outline/context/lens, and Rust-only Stage-7/9 skill projection. Add focused malformed/partial, adapter failure, cap, ordering, import, and impl-identity coverage where the shared harness does not already pin it.
5. Add `evals/fixtures/repos/rust/` and `evals/fixtures/rust.yml` with a feature-side marker case plus marker-free negative control. Extend the fixture materialization test and fixture inventory documentation from four to five cases, while keeping structural behavior out of fake candidate expectations.
6. Extend the packed-install test to require `lang/rust.md`, resolve the Rust grammar WASM from the installed dependency tree, and minimally parse Rust outside the source checkout.
7. Synchronize README and the normative functional, architecture, repository/context, pipeline, skills/telemetry, eval, and PUNCHLIST documentation for the completed Rust slice, its explicit deferrals, and its intermediate unreleased/cache-boundary status.
8. Run focused Rust and affected regression tests, then the complete `pnpm run check`, `pnpm test`, `pnpm build`, packed-layout gate, and fake fixture suite. Iterate until all checks pass without establishing an eval baseline or merging/releasing the integration series.

## Tests

- `RustAdapter` symbol contract: extracts exact kinds, names, owners, comment-tolerant attribute-inclusive ranges, bounded body-free function/macro signatures, associated and block-local declarations, and stable imports while leaving `exported` unset.
- Rust declaration identity: merges lines within one declaration but preserves same-named inherent/trait/overloaded declarations in distinct ownership or ranges.
- Rust enclosing declarations: attribute, header, and body lines bind to the smallest semantic declaration; impl ownership context does not become a standalone symbol.
- Rust likely tests: maps only sibling `<stem>_test.rs` and nearest Cargo-package `tests/<stem>.rs`, recognizes supported attributed functions as test cases, sorts/dedupes/caps results, and excludes deferred inline/arbitrary discovery.
- Rust structural integration: carries `rust` consistently through diff facts, adapter, outline, packet, lens, relevant tests, and Rust-only Stage-7/9 prompt projection on a clean production-path fixture.
- Rust degradation: malformed partial trees remain bounded and parser-unavailable/throw/timeout paths retain shared generic degradation semantics.
- Rust skill quality: verifies required sections, owner-matrix content, WHY-ledger evidence, default enablement, budgets, and language-compatible prompt projection.
- Rust fake fixture: positive marker transports and anchors; marker-free negative control yields no finding.
- Packed Rust layout: installed package contains the Rust skill and resolves/parses the Rust grammar WASM outside the checkout.
- Full regression suite: existing Go/TypeScript classification, adapters, packets, and Stage-7/9 skill isolation remain unchanged.
