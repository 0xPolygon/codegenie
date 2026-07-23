---
status: complete
---

# Phase 3: Python vertical slice

## Overview

Add first-class Python repository context on top of the shared Plan 98 foundation and Rust slice. This phase supplies a decorator-aware tree-sitter Python adapter, deterministic v1 pytest-path discovery, a default-enabled evidence-driven Python review skill, production-path and fake-transport fixtures, installed-package grammar/skill/parse coverage, and synchronized normative documentation. It deliberately supports only `.py`, leaves `exported` unset, and defers `.pyi`, custom pytest collection configuration, native semantic analysis, and real-model baselining.

## Steps

1. Add `src/repo/tree-sitter/python-adapter.ts` and register it in `LanguageAdapterRegistry`. Extract top-level and nested functions, direct class methods, and nested classes with exact immediate ownership/context. Build signatures from Python AST fields rather than brace-based helpers: begin at an outer `decorated_definition`, include decorators and the complete multiline header through its colon, stop before the suite, cap independently of body size, and use the decorated range for enclosure and changed-symbol lookup. Extract stable dependency module specifiers from direct and relative imports in source order with deduplication. Leave `exported` unset.
2. Complete `src/repo/likely-tests.ts` Python classification for convention-selected candidates. Generate sibling `test_<stem>.py` and `<stem>_test.py` paths plus nearest Python-package `tests/` variants. Mark top-level `test_*` functions and direct `test_*` methods of `Test*` classes as `nativeKind: "test case"`; exclude nested local functions and methods of non-`Test*` classes. Preserve deterministic sorting/deduplication, the shared 20-result cap, source selection, backend metadata, symbol mention gates, and parser fallback. Do not add custom pytest configuration discovery.
3. Add `bundled-skills/lang/python.md` as a default-enabled Python lens skill. Give every check an observable failure predicate, reachability/materiality and severity rule, concrete unsafe example, distinct concrete safe counterexample, and separate mitigation; include the required Checks, False Positives, Safe Patterns, and Examples sections. Add evidence-bearing `lang/python` entries to `BUNDLED_SKILL_WHY_LEDGER` and pin independently enforceable owner-matrix, budget, and compatible Stage-7/9 projection behavior.
4. Add a structural Python repository fixture and integration assertions covering canonical identity, clean Python parsing, symbols/ranges/owners/context/identity, decorator/header/body enclosure, imports, exact likely tests, packet outline/context/lens, and Python-only Stage-7/9 skill projection. Add focused malformed/partial, cap, ordering, import, nested declaration, and deferred-extension coverage where the shared harness does not already pin it.
5. Add `evals/fixtures/repos/python/` and `evals/fixtures/python.yml` with a feature-side marker case plus marker-free negative control. Extend the fixture materialization test and fixture inventory documentation from five to six cases, while keeping structural behavior out of fake candidate expectations.
6. Extend the packed-install test to require `lang/python.md`, resolve Python grammar WASM from the installed dependency tree, and minimally parse Python with the production adapter outside the source checkout.
7. Synchronize README and the normative functional, architecture, repository/context, pipeline, skills/telemetry, eval, and PUNCHLIST documentation for the completed Python slice, its `.pyi` and custom-pytest deferrals, unset `exported`, and intermediate unreleased/cache-boundary status.
8. Run focused Python and affected regression tests, then the complete `pnpm run check`, `pnpm test`, `pnpm build`, installed-package gate, and fake fixture suite. Iterate until all checks pass without establishing an eval baseline or merging/releasing the integration series.

## Tests

- `PythonAdapter` symbol contract: extracts exact kinds, names, immediate owners/context, decorator-inclusive ranges, bounded body-free multiline signatures, stable imports, and leaves `exported` unset.
- Python declaration identity and enclosure: multiple changed lines in one declaration merge, distinct nested declarations remain separate, and decorator/header/body lines bind to the smallest semantic declaration.
- Python test symbols: only top-level `test_*` functions and direct `test_*` methods under `Test*` classes in recognized candidate paths become `nativeKind: "test case"`.
- Python likely tests: maps only sibling and nearest-package `tests/` naming conventions, sorts/dedupes/caps results, preserves symbol filters and source selection, and does not infer custom pytest collection rules.
- Python structural integration: carries `python` consistently through diff facts, adapter, outline, packet, lens, relevant tests, and Python-only Stage-7/9 prompt projection on a clean production-path fixture.
- Python degradation: malformed partial trees remain bounded and parser-unavailable/throw/timeout paths retain shared generic degradation semantics.
- Python skill quality: verifies required sections, every check's independently parsed owner matrix, WHY-ledger evidence, default enablement, budgets, and language-compatible prompt projection.
- Python fake fixture: positive marker transports and anchors; marker-free negative control yields no finding.
- Packed Python layout: installed package contains the Python skill and resolves/parses the Python grammar WASM outside the checkout.
- Full regression suite: existing Go/TypeScript/Rust classification, adapters, packets, and Stage-7/9 skill isolation remain unchanged.
