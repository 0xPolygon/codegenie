# Issue 99: Plan 98 Correctness Follow-Up — Unicode-Safe Tree-sitter Extraction and Likely-Test Compatibility

Status: COMPLETE — implemented and validated 2026-07-24
Extends: Plan 98 (`98-issue-98-language-support-rust-python-solidity.md`)
Planned from: post-implementation `master...next` review, 2026-07-24
Planned at: commit `42665e5` (branch `next`)
Recommended priority: before Plan 98 merges to `master` or is included in a tagged/npm release. The Unicode bug corrupts ordinary packet context in repositories containing non-ASCII text; the likely-test change is an unapproved compatibility regression.

Implementation reconciliation (2026-07-24): the five affected extraction paths now use node-relative JavaScript-string slicing, generic exact-stem test-directory discovery is restored without the old cross-language sibling leakage, and the planned dead-code/ownership/classification cleanup is complete. Unicode fixtures include astral text and pin signatures, Python async classification, Rust imports/macros, Solidity ownership, and changed-symbol identity. The focused suite passed 47/47 tests; `pnpm run check`, `pnpm test` (37 files, 734 tests, including packed-package smoke), and `pnpm build` all passed. No skill, lens, prompt, registry-hash, dependency, or workflow boundary was created.

## Goal

Finish Plan 98's correctness contract without reopening its language scope:

1. Make every offset-based extraction in the new Rust, Python, and Solidity adapters compatible with web-tree-sitter's JavaScript-string indices.
2. Restore the pre-Plan-98 generic same-stem test-directory fallback for languages without a first-class likely-test convention.
3. Remove superseded/dead seams and resolve two small adapter/path-role inconsistencies found by the final branch review.
4. Pin all corrections with production-path tests and synchronize the normative specs.

This is one atomic deterministic follow-up. It changes no bundled skill content, lens inventory, prompt template, provider behavior, dependency, grammar version, or CI workflow.

## Problem 1: UTF-16 Tree-sitter Indices Used as UTF-8 Byte Offsets

`web-tree-sitter` parses JavaScript strings. Its `Node.startIndex` and `Node.endIndex` values are offsets compatible with JavaScript string slicing (UTF-16 code units), not byte offsets into `Buffer.from(text, "utf8")`.

Plan 98 introduced five offset operations across three adapters that mix those domains:

- `python-adapter.ts`: declaration signatures and declaration-header text;
- `solidity-adapter.ts`: declaration signatures;
- `rust-adapter.ts`: macro headers and comment removal from imports.

The existing Go and ECMAScript adapters use `node.text` or JavaScript string slicing and are not affected. Most Rust signature paths also use `node.text`; only the two Buffer-backed paths above are in scope.

The bug is content-dependent. Any non-ASCII character before a Python/Solidity declaration shifts its global byte position relative to its tree-sitter index. Non-ASCII text inside a Rust macro header or import comment shifts local Buffer slices. Verified at the planning revision:

- Python after `# émoji ünïcode 😀 comment` produced signature `ment def foo(x):`;
- Solidity after the same comment produced contract signature `ment contract Sa` and a corrupted function signature;
- Rust `use crate::{ /* émoji 😀 */ Foo, Bar };` produced import `crate::{*/ Foo, Bar}`;
- Rust macro headers containing the same comment were truncated mid-name/comment.

Besides poor outlines and packet context, Python's corrupted header text can misclassify `async def` as a synchronous function. Corrupted signatures also enter changed-symbol/declaration identity, so the issue can affect symbol grouping as well as presentation.

### Decision: Slice JavaScript Strings, Never UTF-8 Buffers

At each affected call site, use `String.prototype.slice` against the same coordinate space that produced the indices:

- prefer node-local text plus relative offsets (`node.text.slice(0, endIndex - node.startIndex)`) where the extraction starts at that node;
- use the decorated outer node's text plus a relative body/header offset for Python decorator-aware signatures;
- remove Rust comment spans from `node.text` with relative string indices and join string segments, preserving source order and the current single-space replacement;
- retain the existing compacting rules and 600-character caps.

Do not add byte/code-unit conversion machinery, encode/decode round trips, or a shared abstraction for five straightforward slices. Do not change unrelated Buffer usage where offsets are genuinely byte-based.

### Unicode Regression Matrix

| Surface | Fixture | Required assertion |
| --- | --- | --- |
| Python signature | non-ASCII comment/docstring before a decorated multiline declaration | exact decorator/header signature; no leading/trailing fragments |
| Python classification | non-ASCII text before `async def` | `nativeKind: "async function"` or `"async method"` remains correct |
| Solidity signature | non-ASCII NatSpec/comment before a contract and direct function | exact bounded contract/function headers and stable owner/range/identity |
| Changed-symbol identity | astral text before a declaration with two changed lines in one hunk | exactly one `ChangedSymbol` containing both changed lines and the exact corrected signature |
| Rust macro | non-ASCII comment inside the macro header | exact, non-truncated macro signature |
| Rust import | non-ASCII block comment inside a grouped `use` | exact compact import with comment removed and identifiers preserved |

ASCII fixtures remain unchanged. Tests must include at least one astral character such as `😀`, not only Latin-1, so UTF-16 code-unit behavior is exercised explicitly.

## Problem 2: Generic Likely-Test Discovery Regressed

Before Plan 98, `find_likely_tests` considered any same-stem file under `test/`, `tests/`, or `__tests__/`, regardless of language. Plan 98 added explicit early-return conventions for Rust, Python, and Solidity, but also gated the remaining directory scan to Go/TypeScript/TSX/JavaScript. As a result, subjects such as `src/foo.rb` with `tests/foo.rb` now return no likely test from either the public tool or packet `relevantTests`.

Plan 98 did not authorize this removal. Its language-specific rules were additions and intentional deferrals, not a request to reduce generic repository intelligence.

### Decision: Restore the Generic Directory Fallback, Not Cross-Language Sibling Quirks

Retain the explicit language contracts:

- Rust: sibling `<stem>_test.rs` and nearest Cargo-package `tests/<stem>.rs` only;
- Python: the pinned sibling and nearest-package pytest paths only;
- Solidity: nearest default Foundry test paths only when `foundry.toml` exists;
- Go/TypeScript/TSX/JavaScript: current sibling/framework conventions.

After those language-specific branches, restore the old generic rule for every remaining language identity:

- candidate path is inside a segment named `test`, `tests`, or `__tests__`;
- `fileStem(candidate) === fileStem(subject)`;
- candidate must exist in the resolved revision's repository file list;
- existing symbol-name text filtering, deterministic sorting, 20-result public cap, 5-result packet cap, and degraded file-level fallback remain unchanged.

Master also applied its Go sibling name and TypeScript/JavaScript sibling name set without checking the subject language. That made `src/foo_test.go` or `src/foo.test.ts` a candidate for a `src/foo.rb` subject. Do not restore this accidental cross-language behavior: Go-specific sibling names apply only to Go subjects, and TypeScript/JavaScript sibling names apply only to those subjects.

Do not broaden the fallback to arbitrary siblings, fuzzy stems, framework discovery, build-system inspection, or additional extension-derived naming patterns. The target is to restore the useful master directory fallback while deliberately narrowing its unrelated-language sibling quirks, not to reproduce every incidental match or add a new generic-language feature.

### Compatibility Tests

1. Unit-pin `src/foo.rb` + `tests/foo.rb` as a candidate while excluding `tests/bar.rb`.
2. Pin the intentional compatibility narrowing: sibling `src/foo.test.ts` and `src/foo_test.go` are not candidates for a `src/foo.rb` subject, while the existing TypeScript/JavaScript and Go subject tests retain those conventions.
3. Exercise the public `find_likely_tests` tool through `buildRepositoryIndex`; a generic/unparseable candidate returns the existing file-level `SymbolRef` rather than pretending to have semantic test symbols.
4. Build a packet for a non-first-class source file and assert the restored test appears in `ReviewPacket.relevantTests`/rendered context.
5. Re-run the existing Rust/Python/Solidity/Go/TypeScript/JavaScript candidate tests unchanged, proving the fallback does not bypass their explicit contracts or deferrals.

## Cleanup and Small Correctness Decisions

### 1. Delete the Superseded `GrammarAdapter`

`src/repo/tree-sitter/grammar-adapter.ts` was the Phase-1 grammar-registration placeholder. Rust, Python, and Solidity now have real adapters, and nothing imports the placeholder from production or tests.

Delete the file and remove its stale architecture tree entry. Do not replace it with another base class; the concrete adapters share grammar lifecycle through `TreeSitterService` already.

### 2. Do Not Report Rust Type Parameters as Nominal Owners

For `impl<T> Trait for T`, `T` is a projection/type parameter, not a resolvable nominal target. The current bare-`type_identifier` branch returns it without consulting `projectionRoots`.

Make `nominalOwner` reject a bare identifier present in `projectionRoots`, and ensure `implOwner` does not reintroduce the rejected value through its textual fallback. Use the existing deterministic sentinel `"impl target"` when no nominal target exists. Pin:

- `impl<T> Trait for Payment<T>` → owner `Payment` (unchanged);
- `impl<T> Trait for T` → owner `impl target`;
- method contextual signature still carries the complete impl header, preserving declaration identity.

Do not add type resolution or attempt to infer a concrete implementor for blanket impls.

### 3. Preserve the Solidity File-Level Constant Deferral

The pinned Solidity grammar emits `constant_variable_declaration` at file scope, while contract-owned constants use `state_variable_declaration` and already produce `value` symbols with `nativeKind: "constant"`. Plan 98 explicitly excludes file-level constants.

Delete the unreachable/misleading `constant_variable_declaration` switch branch. Keep a test proving a contract-owned constant is present and a file-level constant is absent. Do not expand storage/ABI/export analysis.

### 4. Simplify Rust Test-Path Classification

In `detectTestStatus`, `segments.includes("tests")` inside the Rust-specific clause duplicates the later generic `test`/`tests` segment rule. Remove the duplicate; retain Rust's `_test.rs` filename signal and the shared directory rule. Pin both forms as tests.

## Explicit Non-Goals and Accepted Observations

- Python `test_*` functions nested under a module-level conditional remain ordinary functions; Plan 98's top-level/direct-class pytest contract is unchanged.
- Stage-9 language guidance for packetless candidates with ambiguous/no diff language remains defensively omitted.
- Phase-6 improvements to TypeScript function-expression native kinds and signature caps remain accepted; no ECMAScript adapter changes are planned here.
- GitHub Action dependencies remain tag-pinned. SHA-pinning is separate supply-chain hardening, not a Plan-98 correctness repair.
- File-level Solidity constants, custom Foundry/pytest discovery, same-file Rust tests, arbitrary Rust integration tests, CommonJS export inference, `.pyi`, and native language analyzers remain deferred.
- No real-model owner eval is required: every change is deterministic repository-context behavior with exact structural regression tests.

## Normative Documentation Changes

Implementation must update the current project specs alongside code:

1. Replace Python's incorrect “byte-slicing” description with node-relative JavaScript-string/UTF-16-coordinate slicing.
2. Document the restored generic same-stem `test`/`tests`/`__tests__` fallback after explicit language conventions.
3. Document the blanket-impl owner sentinel for non-nominal targets.
4. Remove `grammar-adapter.ts` from the repository tree.
5. Keep Solidity file-level constants explicitly excluded.
6. Add a short Plan-98 reconciliation note linking this corrective extension; Plan 98 remains complete as the feature plan, while Plan 99 owns post-review corrections.

No bundled skill changes occur, so Plan 99 creates no third Stage-5 skill-inventory or `LensRegistry.registryHash()` boundary. Corrected signatures/tests will naturally change packet/request content only for affected reviews.

## In-Scope Files

- `src/repo/tree-sitter/python-adapter.ts`
- `src/repo/tree-sitter/solidity-adapter.ts`
- `src/repo/tree-sitter/rust-adapter.ts`
- `src/repo/tree-sitter/grammar-adapter.ts` (delete)
- `src/repo/likely-tests.ts`
- `src/git/detectors.ts`
- Existing Rust/Python/Solidity fixture and test files, `tests/language-foundation.test.ts`, and repository/packet integration tests as needed
- `specs/project/architecture.md`
- `specs/project/functional_spec.md`
- `specs/project/components/context_and_tools.md`
- Plan 98 reconciliation link, Plan 99, plan index, and implementation evidence/PUNCHLIST only if this repository's normal completion bookkeeping requires it

No dependency, lockfile, grammar registration, skill, prompt-builder, lens, provider, verifier, GitHub Action, or workflow file is in scope.

## Implementation Order

1. Add failing Unicode fixtures/assertions for Python, Solidity, and the two Rust paths; prove at least one test catches async misclassification, not only malformed display text.
2. Replace the five Buffer-backed offset operations with node-relative string slicing; rerun the focused adapter tests.
3. Add generic likely-test compatibility tests, restore the language-neutral directory fallback, and prove first-class language rules remain unchanged.
4. Delete `GrammarAdapter`, fix blanket-impl ownership, remove the dead Solidity case, and simplify the Rust detector rule with focused pins.
5. Synchronize normative specs and completion evidence, then run the full gates.

Keep this as one commit unless a failing test disproves one of the contracts above. There is no measurement or rollout benefit to splitting deterministic test-first corrections into externally visible partial states.

## Validation

Focused gates:

```bash
pnpm exec vitest run \
  tests/language-foundation.test.ts \
  tests/rust-language.test.ts \
  tests/python-language.test.ts \
  tests/solidity-language.test.ts \
  tests/repository-intelligence.test.ts
```

Full gates:

```bash
pnpm run check
pnpm test
pnpm build
```

`pnpm test` includes the packed-package smoke; if a sandbox blocks npm cache writes, rerun that gate with the required filesystem permission rather than weakening or skipping it.

## Done Criteria

- No tree-sitter JavaScript-string index is passed to a UTF-8 Buffer slice in the Rust, Python, or Solidity adapters.
- Non-ASCII and astral characters cannot corrupt signatures, Python async classification, Rust import text, or macro headers.
- Two changed lines inside one declaration still merge into exactly one `ChangedSymbol` with the corrected signature when non-ASCII text precedes it.
- Existing ASCII fixture outputs remain unchanged except where a separately named cleanup decision above intentionally changes them.
- Generic same-stem test-directory discovery works through both the public tool and packet `relevantTests`, while all explicit first-class-language conventions/deferrals remain pinned.
- `GrammarAdapter` and its current-spec reference are gone.
- Blanket Rust impls do not claim a type parameter as a nominal owner; ordinary generic nominal targets remain unchanged.
- Contract-owned Solidity constants remain visible and file-level constants remain absent; the dead switch branch is gone.
- Rust test classification has one directory rule, not two equivalent checks.
- Normative specs describe string-coordinate slicing and generic likely-test compatibility accurately.
- Focused tests, `pnpm run check`, all tests including package smoke, and `pnpm build` pass.

## Stop Conditions

- If the pinned web-tree-sitter version exposes different index semantics for callback-based/binary input than for the repository's current string input, stop and document the actual parser-input contract before introducing conversion logic. Do not mix coordinate systems heuristically.
- If restoring generic fallback requires scanning beyond the already-loaded repository file list or changes the explicit Rust/Python/Solidity candidate sets, stop and narrow it to the documented generic-directory compatibility subset. Do not re-enable master's cross-language Go/TypeScript sibling quirks.
- If blanket-impl ownership cannot use the existing sentinel without destabilizing symbol identity, preserve the full impl header in identity and document a deterministic alternative; do not invent type resolution.
- If any cleanup requires a new shared abstraction or a pipeline/verifier change, leave that cleanup in place and escalate separately rather than expanding this corrective plan.
