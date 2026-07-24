# Issue 98: Language Support — Rust, Python, Solidity, JavaScript (tree-sitter adapters + bundled skills)

Status: IN PROGRESS — Phases 0-5 implemented; Phase 6 JavaScript follow-up pending
Planned from: owner requests 2026-07-23 (add first-class language support for Rust, Python, and Solidity, then split JavaScript from the TypeScript skill/lens oversight).
Planned at: commit `fbcc669` (branch `next`)
Design critique: `reviews/projects/plan-98-language-support-crit/crit_summary.md`
Recommended priority: first post-Action product arc. This creates the substrate for the PUNCHLIST eval-diversity guard; the real-repo, real-model second-language case remains a follow-up after landing.

Implementation reconciliation (2026-07-23): the intended single inventory boundary was preserved, but it occurred as a branch push before Phase-5 validation rather than as the final release action. The complete Phase 1-4 inventory reached `origin/next` at `eb20533` at `2026-07-23T20:28:11-04:00`, establishing the one external Stage-5 inventory/registry/cache boundary. Reviewed Phase-5 gate `40b87b0` was pushed at `2026-07-23T20:31:28-04:00` without changing bundled skill inventory/content or `LensRegistry.registryHash()`. Neither push was a master merge, tag, npm publication, or GitHub release; pre-`eb20533` and post-`eb20533` measurements are non-comparable.

JavaScript follow-up amendment (2026-07-23): the harness already classifies `.js`, `.jsx`, `.mjs`, and `.cjs` as canonical `javascript`, loads `tree-sitter-javascript`, parses them through the shared ECMAScript adapter implementation, and discovers JavaScript test conventions. The oversight is product guidance and projection: JavaScript currently aliases to `lang/typescript`, whose skill includes TypeScript-only checks. Phase 6 adds a dedicated `lang/javascript` lens/skill and end-to-end acceptance without duplicating the proven grammar/adapter infrastructure.

## Problem

At plan creation, codegenie reviewed any diff but only Go and a combined TypeScript/JavaScript path received first-class syntax context and language guidance. Phases 0-5 added Rust, Python, and Solidity support. The remaining oversight is that canonical JavaScript still projects through `lang/typescript`: JavaScript parsing and test discovery work, but prompts include TypeScript-only checks and there is no dedicated JavaScript fixture, skill acceptance gate, or language-lens isolation contract.

The original Plan 98 treated adapters as isolated extensions. Review against the then-current harness disproved that assumption:

- language identity is duplicated across tree-sitter routing, raw diff parsing, classification, packets, and lenses;
- deterministic packet fallback does not reliably choose an arbitrary new `lang/<language>` lens;
- skill `languages` metadata is descriptive in some paths rather than a complete enforcement gate;
- the optional adapter `findLikelyTests` hook is unused, while production discovery is owned by `likely-tests.ts`;
- adding default-enabled skills changes every Stage-5 lens/skill inventory and the registry-derived cache identity;
- fake-runner sentinel findings do not prove that parsing, symbols, tests, or skills worked;
- the repository had no PR-head CI workflow running the claimed gates (implemented in Phase 0).

Plan 98 therefore includes a bounded shared-foundation phase, three completed language slices, and a JavaScript follow-up slice. It does not change review posture, budgets, or LLM schemas.

## Accepted Design-Crit Decisions

1. All 19 design-crit issues are accepted.
2. `.pyi` support is removed from v1. Python stubs are explicitly deferred.
3. Same-file Rust `#[cfg(test)]` discovery and arbitrary-name integration-test tree scanning are deferred. V1 test discovery uses deterministic path conventions.
4. Solidity state variables and constants are emitted as minimal contract-owned `value` symbols. Storage-layout analysis, generated-getter semantics, and storage/API static signals are deferred.
5. No Stage-5 filtering machinery will be added merely to preserve old prompt bytes. `LensRegistry.registryHash()` hashes every loaded skill regardless of enablement, so setting new skills `enabledByDefault: false` would not preserve cache identity. Phases 1-4 developed as one integration series and were pushed together to `origin/next` at `eb20533`, producing one external Stage-5/cache measurement boundary before Phase-5 validation. Phase 5 does not alter the skill inventory/hash and therefore does not create a second boundary.
6. The Phase 1-5 Go/TypeScript non-regression contract pins classification, adapter output, packet construction, and Stage-7/9 language-specific projection. Phase 6 supersedes only the combined TypeScript/JavaScript projection: Go remains unchanged, while TypeScript is intentionally narrowed and JavaScript becomes distinct.
7. A proper PR-head CI workflow is a standalone prerequisite, separate from the trusted-base codegenie dogfood workflow, and lands immediately before the language integration series.
8. PR-head CI installs a pinned `actionlint` before any command that runs `check:workflows`, and uses `pnpm install --frozen-lockfile --config.ignore-scripts=false` so the repository's pnpm-11 `allowBuilds` policy can install esbuild for Vitest while explicitly denying unused dependency builds.
9. JavaScript receives its own default-enabled `lang/javascript` lens and skill. Phase 6 removes the JavaScript-to-`lang/typescript` fallback and narrows `lang/typescript` to TypeScript/TSX. Parser implementation may remain shared where ECMAScript AST semantics are identical, but language identity, guidance, fixtures, projection, acceptance, and telemetry are distinct.

## Verified Dependency Baseline

The exact proposed packages were independently inspected and load-tested with the repository's `web-tree-sitter@0.26.11`:

| Language | Package | Grammar ABI | Published WASM | Load/parse result |
| --- | --- | ---: | --- | --- |
| Rust | `tree-sitter-rust@0.24.0` | 14 | `tree-sitter-rust.wasm` | verified |
| Python | `tree-sitter-python@0.25.0` | 15 | `tree-sitter-python.wasm` | verified |
| Solidity | `tree-sitter-solidity@1.2.13` | 15 | `tree-sitter-solidity.wasm` | verified |

The grammar premise is viable. Solidity's package metadata nevertheless adds a peer/install surface (`tree-sitter` and native install scripts) that must be validated in the packed consumer layout; ignored local pnpm build scripts alone are not sufficient proof.

JavaScript requires no new dependency: `tree-sitter-javascript@0.25.0` and its published `tree-sitter-javascript.wasm` are already pinned, loaded by the seven-grammar lifecycle test, and parsed by the packed-consumer gate. Phase 6 changes product specialization, not grammar arithmetic.

## Design

### 1. Shared Foundation

#### 1.1 Canonical language identity

The following identity must agree at every seam:

| Extension | Canonical language | Grammar id | Default language lens |
| --- | --- | --- | --- |
| `.rs` | `rust` | `rust` | `lang/rust` |
| `.py` | `python` | `python` | `lang/python` |
| `.sol` | `solidity` | `solidity` | `lang/solidity` |
| `.js`, `.jsx`, `.mjs`, `.cjs` | `javascript` | `javascript` | `lang/javascript` |

Update and pin all owning maps, not only tree-sitter routing:

- `TreeSitterService.routePath` / `GrammarId` / `GRAMMAR_WASM`;
- raw diff `languageFromPath`;
- `detectors.detectLanguage` and `FileFacts.language`;
- adapter registry routing and `ParsedFile.language`/`adapterId`;
- packet language and deterministic language-lens selection;
- fake-planner fixture routing.

Tests assert equality across `DiffFile.language`, `FileFacts.language`, adapter id, outline language, packet language, and selected lens for every supported extension. `.pyi` remains `unknown`/generic in v1 and is documented as deferred.

#### 1.2 Grammar lifecycle and failure semantics

There are seven grammar ids after this plan: Go, TypeScript, TSX, JavaScript, Rust, Python, and Solidity. Loading remains lazy through `TreeSitterService.parse`; adapter `init()` is not a grammar-loading gate.

Pin this behavior:

| Condition | Tree | `hasErrors` | Adapter id | Behavior |
| --- | --- | --- | --- | --- |
| Clean parse | retained | `false` | requested grammar | full adapter output |
| Syntax-error partial parse | retained | `true` | requested grammar | bounded partial AST output allowed |
| Grammar resolution/ABI failure | absent | `true` | requested grammar | parser-unavailable telemetry; text/generic degradation; grammar cached unavailable |
| Parser throw | absent | `true` | requested grammar | text/generic degradation |
| Timeout or null tree | absent | `true` | requested grammar | text/generic degradation |
| File above parse-size cap | absent | `true` | requested grammar | bounded text/generic degradation |

A table-driven load test minimally parses source with every `GrammarId`; it does not assert that malformed source switches to `GenericAdapter`.

#### 1.3 Language lens enforcement

Shared pipeline changes are explicit and limited:

1. Generalize deterministic fallback to prefer an enabled exact `lang/${canonicalLanguage}` lens. Phase 6 removes the temporary TypeScript/JavaScript alias: TypeScript/TSX select `lang/typescript`; canonical JavaScript selects `lang/javascript`.
2. During planner semantic normalization, remove language-specific lenses whose `LensDescriptor.languages` do not include the hunk language. Emit dedicated telemetry and use deterministic defaults if nothing survives.
3. At packet projection, defensively include a skill only when its `languages` list is empty or contains the packet's canonical language.
4. Keep language-neutral core lenses available under their existing rules.

Tests cover omitted planner decisions, empty planner lens arrays, explicit wrong-language planner output, shared lenses containing differently gated skills, and degraded/default-plan execution.

#### 1.4 Stage-5 prompt and cache boundary

Adding the initial three default-enabled skills intentionally changed:

- the global Stage-5 lens inventory;
- Stage-5 skill summaries;
- `LensRegistry.registryHash()`;
- the review/model-call cache identity derived from that registry.

`registryHash()` includes every loaded skill's content hash, not only enabled skills, plus the enabled-lens set. A ship-dark sequence that adds three disabled skill files separately and enables them later would therefore create four cache identities rather than one. Plan 98 does not use that mechanism and does not add language-scoped Stage-5 filtering solely to preserve old bytes.

Instead, Phase 0 landed independently, then Phases 1-4 remained one integration series until the complete inventory was pushed to `origin/next` at `eb20533`. No intermediate language commit established an external measurement state. That push, before Phase-5 validation committed, exposed all three default-enabled skills together and created the one external Stage-5 inventory/registry/cache boundary recorded in the PUNCHLIST. Results before `eb20533` and at/after it are not compared as like-for-like measurements. Phase-5 commit `40b87b0` subsequently reached the same branch but does not change skill inventory/content or the registry hash, so it is not a second cache boundary. Branch exposure remains distinct from a master merge, tag, npm publication, or GitHub release.

Phase 6 intentionally creates a second disclosed boundary when `lang/javascript` and the narrowed `lang/typescript` skill land together. Both skill files affect `registryHash()`, even if the new skill were disabled. JavaScript work therefore lands atomically as one reviewed phase; results before and after its landing are non-comparable prompt/cache regimes. No filtering or ship-dark mechanism is added merely to preserve old bytes.

The non-regression gate instead pins:

- Go, Rust, Python, and Solidity classification, adapter output, packet structure, and Stage-7/9 language-skill projection remain unchanged for unchanged fixtures;
- TypeScript/TSX retain `lang/typescript`, but its metadata/content is intentionally narrowed to TypeScript/TSX-focused guidance;
- JavaScript packets receive only `lang/javascript` language guidance and exclude TypeScript/Rust/Python/Solidity/Go skills;
- cache invalidation is expected and documented, not treated as a regression.

#### 1.5 Declaration identity and shared adapter helpers

`SymbolInfo` is the adapter contract, not merely a list of grammar node types. Each adapter must define:

- `kind`, `nativeKind`, `name`, `ownerType`, `lineRange`, bounded `signature`, and deterministic ordering;
- the smallest semantic enclosing declaration for header, attribute/decorator, and body lines;
- stable import output;
- explicit test-symbol classification;
- whether `exported` is set.

Rust and Solidity allow same-named declarations in the same owner. Extend `changedSymbolsFromEnclosing` with an optional identity callback (defaulting to current behavior so Go/TypeScript remain unchanged); the new adapters use an identity containing path, kind, owner, name, declaration range, and, where needed, signature. Multiple changed lines in one declaration still merge, while overloads/trait impls do not collapse.

For v1, all three new adapters leave `exported` unset. This prevents accidental activation of `core/exported-api-change`. Language-specific public API semantics remain deferred.

#### 1.6 Likely-test contract

Production behavior is owned by `src/repo/likely-tests.ts`, not the unused optional adapter hook. Remove `LanguageAdapter.findLikelyTests?` from the interface so there is one mechanism.

The shared contract has two parts:

1. language-aware candidate-path generation from a contained subject path and repository file list;
2. language-aware test-symbol classification on parsed candidates.

Common rules:

- deterministic sorted paths and symbols;
- dedupe before the existing 20-result cap;
- preserve requested `head`/`base` source selection and backend/precision metadata;
- path-only requests return all recognized test symbols from candidates;
- symbol requests retain the existing cheap candidate-file mention gate and symbol-body mention filter;
- cleanly parsed candidates return only recognized test symbols; text fallback remains for unparseable candidates;
- packet `relevantTests` and the public `find_likely_tests` tool use the same results.

V1 path conventions:

| Language | Subject-to-candidate conventions | Test symbols |
| --- | --- | --- |
| Rust | sibling `<stem>_test.rs`; nearest Cargo-package `tests/<stem>.rs` | functions carrying supported `#[test]`/async-test attributes in candidate test files, `nativeKind: test case` |
| Python | sibling `test_<stem>.py` and `<stem>_test.py`; nearest package `tests/` variants | top-level `test_*` functions and `test_*` methods directly under `Test*` classes, `nativeKind: test case` |
| Solidity | nearest Foundry test dir `<Stem>.t.sol` and `<Stem>Test.t.sol` | contract methods beginning `test` or `invariant`, excluding `setUp`, `nativeKind: test case` |

Explicit deferrals:

- same-file Rust `#[cfg(test)]` discovery;
- arbitrary-name Rust integration-test scanning;
- custom pytest collection configuration;
- custom Foundry test-directory configuration beyond the detected/default package test directory;
- Solidity-to-Hardhat-TypeScript cross-linking.

#### 1.7 Classification and per-consumer test roles

Built-in language, lockfile, vendored, generated, and test-path rules live in `src/git/detectors.ts`; `file-classifier.ts` consumes their facts.

Existing lockfile coverage for `Cargo.lock`, `poetry.lock`, `uv.lock`, and `Pipfile.lock` is tested rather than reimplemented.

No ambiguous global segment skips are added in v1 for `lib`, `target`, `out`, `cache`, `artifacts`, `venv`, or similar generic names. Without a pre-filter marker-aware mechanism, use existing gitignore/generated detection and repository `pathRules`. Distinctive Python noise such as `__pycache__`, `.tox`, and `*.egg-info` may be added only with paired positive and negative tests and a match shape supported by the detector.

Pin each current path-role consumer independently:

| Path form | Repository/classifier role | Composition/coverage/packet/promotion role |
| --- | --- | --- |
| `test_foo.py`, `foo_test.py`, `tests/foo.py` | test | test |
| `Foo.t.sol`, `test/Foo.t.sol`, `test/FooTest.t.sol` | test | test |
| `tests/foo.rs`, `foo_test.rs` | test | test |
| Rust source containing inline tests | source | source (inline discovery deferred) |

### 2. Rust Vertical Slice

#### 2.1 Symbol contract

| Rust construct | `kind` | Name/owner/range contract |
| --- | --- | --- |
| `function_item` outside trait/impl | `function` | declared name; leading contiguous outer attributes included in range/signature |
| `struct_item`, `union_item`, `enum_item`, `type_item` | `type` | declared name; bounded declaration header; attributes included |
| `trait_item` | `interface` | trait name; contains ownership context for associated items |
| `mod_item` | `container` | module name; native kind records module |
| `const_item`, `static_item` | `value` | declared name; owner retained when associated |
| `macro_definition` | `other` | macro name; native kind records macro definition |
| `function_item` / `function_signature_item` directly in trait/impl | `method` | owner is normalized nominal trait/target type; leading attributes included |
| associated type/constant | `type` / `value` | declared name; owner metadata retained |

`impl_item` is ownership context, not a standalone public symbol. Normalize `Foo<T>` to nominal owner `Foo` when resolvable, while retaining the complete impl header in contextual signature/native data. Trait methods without bodies, inherent impl methods, and same-named methods from different trait impls remain distinct.

Signature extraction stops before the body, preserves bounded multiline headers and leading attributes, and has an explicit character cap. Attribute-only changes (`cfg`, `repr`, derive/procedural attributes) resolve to the decorated item.

Imports are stable dependency specifiers: preserve the compact `use` argument (including grouped/aliased/wildcard forms) and supported `extern crate` source, in source order with dedupe.

#### 2.2 Rust skill acceptance

The default-enabled `lang/rust` skill may cover:

- reachable production panic/`unwrap`/`expect` paths;
- actually narrowing or truncating `as` casts on unbounded values;
- materially ignored `Result` values;
- blocking calls that materially stall an async executor;
- range/slice arithmetic with a concrete boundary failure;
- unsafe code with a violated safety invariant, not merely missing prose;
- runtime synchronization or unsafe/manual trait behavior across `.await`.

Compiler-rejected lifetime/`Send` claims, widening/nonnumeric casts, deliberate ignored results, test-only panics, and the mere existence of `unsafe` are required false-positive cases.

### 3. Python Vertical Slice

`.py` is the only v1 extension. `.pyi` is deferred.

#### 3.1 Symbol contract

| Python construct | `kind` | Name/owner/range contract |
| --- | --- | --- |
| top-level `function_definition` (including async) | `function` | function name; decorated wrapper start when present |
| function directly inside a class body | `method` | immediate class owner; decorated wrapper start when present |
| nested local function | `function` | no class owner inherited through an enclosing method |
| `class_definition` | `type` | class name; decorated wrapper start when present |

Use a Python-specific declaration builder, never brace-based `compactSignature`:

- start at the outer `decorated_definition` when present;
- include decorator lines and the complete multiline header through its colon;
- stop at the `body` field before the suite;
- keep a fixed character cap independent of implementation-body size;
- use the decorated range for enclosing-symbol lookup so decorator-only changes bind correctly.

Nested classes are supported as `type` symbols with their immediate enclosing class recorded as native/context metadata; v1 does not claim module-value or type-alias symbol coverage.

Imports are dependency module specifiers: emit each direct `import a, b` module, preserve relative dots in `from .pkg import x`, include `__future__`, exclude local aliases/imported member names, retain source order, and dedupe.

#### 3.2 Python skill acceptance

The default-enabled `lang/python` skill may cover:

- mutable defaults only when mutation creates cross-call state;
- broad/bare exception handling only when it changes correctness, recovery, or observability materially;
- `None` propagation that violates a caller-visible contract;
- float use where a named monetary/unit contract requires exact arithmetic;
- materially blocking work on an async event loop;
- `eval`/shell/subprocess injection with concrete untrusted-data flow into an unsafe sink;
- TOCTOU file handling with an exploitable or correctness-relevant race;
- sequence mutation during iteration with a concrete skipped/duplicated-element failure.

Safe cases include `subprocess` argv with `shell=False`, cleanup that catches and re-raises, integer minor units, deliberate iteration over a copy, and immutable/never-mutated defaults.

### 4. Solidity Vertical Slice

#### 4.1 Symbol contract

| Solidity construct | `kind` | Name/owner/range contract |
| --- | --- | --- |
| contract / abstract contract / library | `type` | declaration name; enclosing owner for direct members |
| interface | `interface` | declaration name; enclosing owner for direct members |
| direct contract function | `method` | declared name plus owner; overload identity includes signature/range |
| constructor | `method` | synthetic name `constructor`; owner required |
| fallback / receive | `method` | synthetic name `fallback` or `receive`; owner required |
| modifier | `method` | modifier name; native kind distinguishes modifier |
| file-level free function | `function` | no contract owner |
| state variable / constant | `value` | declared name; immediate contract owner; bounded declaration signature |
| struct / enum / user-defined value type | `type` | declared name; immediate owner when nested |
| event / custom error | `other` | declared name; immediate owner and explicit native kind |

Minimal state-variable symbols provide precise packet context only. V1 does not analyze storage layout, generated getters, upgrade compatibility, or public ABI changes, and leaves `exported` unset.

Same-named overloads remain distinct through declaration identity. Enclosing lookup chooses the smallest direct member for header/body lines and the containing contract only when no member applies.

Imports emit only the unquoted source path from every supported alias/named-import form, in source order with dedupe.

#### 4.2 Solidity skill acceptance

The default-enabled `lang/solidity` skill may cover:

- reentrancy with a concrete externally controlled call before an affected invariant is secured;
- unchecked failure from `send` or low-level `call`/`delegatecall`/`staticcall`, not ordinary high-level calls that revert;
- token decimals or unit scaling only when a named producer/consumer unit contract is inconsistent;
- missing access control only for a privileged state transition or asset/authority effect;
- actually narrowing integer casts or arithmetic truncation with a concrete failure mode;
- repeated credit/use of full `msg.value` inside a loop, not loop presence alone;
- delegatecall/storage-context hazards with a named invariant;
- stale/zero oracle data where the consuming contract relies on freshness/nonzero value;
- missing state-transition events only when an external correctness/audit contract requires them; missing events alone are not state corruption.

Every check must distinguish safe CEI/guarded patterns, deliberate permissionless functions, checked low-level calls, explicit unit conversions, and documented delegatecall/storage invariants.

### 5. JavaScript Follow-up Vertical Slice

The harness already has canonical JavaScript routing and the `tree-sitter-javascript@0.25.0` WASM. Phase 6 does not add another grammar id or dependency. It keeps `TypeScriptAdapter(service, "javascript")` as the shared ECMAScript implementation unless structural tests expose a JavaScript-specific defect; shared implementation is not shared language identity.

Supported extensions are `.js`, `.jsx`, `.mjs`, and `.cjs`. They all remain canonical `javascript`. Flow syntax, TypeScript-in-JavaScript, JSDoc type analysis, proposal syntax unsupported by the pinned grammar, bundler-specific resolution, and framework-specific compiler semantics are deferred.

#### 5.1 JavaScript symbol, import, and test contract

| JavaScript construct | `kind` | Name/owner/range contract |
| --- | --- | --- |
| function / generator declaration | `function` | declared name; body-free bounded signature |
| top-level variable initialized with arrow/function expression | `function` | binding name; signature stops at the arrow/body boundary |
| class declaration/expression | `type` | declared or default-export identity; contains direct member ownership |
| class method / constructor / callable field | `method` | immediate class owner; private `#name` remains non-exported |
| non-callable top-level `const`/`let`/`var` | `value` | binding name and bounded declaration signature |

JavaScript preserves the existing ESM export semantics of the shared adapter. CommonJS export inference (`module.exports` / `exports.name`) remains deferred rather than guessed, and Phase 6 does not introduce a new exported-API static-signal fork. Enclosing lookup must choose the smallest callable/member declaration. JavaScript structural fixtures must cover async/generator functions, arrow functions, anonymous default exports, classes, private fields, JSX, and CommonJS/ESM module forms without admitting TypeScript-only syntax.

Imports are stable literal dependency specifiers from static ESM imports, side-effect imports, re-exports, and literal `require()` calls, in source order with dedupe. Dynamic/computed module specifiers are not guessed.

Likely-test discovery retains the existing deterministic conventions for sibling `*.test.*` / `*.spec.*`, `__tests__/`, and matching `test/` or `tests/` paths across `.js`, `.jsx`, `.mjs`, and `.cjs`. Parsed candidates return `describe`/`it`/`test` cases, including supported `.only`, `.skip`, and `.each` forms, under the single public/internal likely-test contract.

#### 5.2 JavaScript skill acceptance

The default-enabled `lang/javascript` skill may cover:

- floating promises and unhandled rejections with a reachable lost-failure or ordering effect;
- ESM/CommonJS interop errors with a concrete runtime import/export mismatch;
- lost or accidentally rebound `this` where the call site observes the wrong receiver;
- coercion/truthiness bugs that conflate meaningful `0`, `false`, empty-string, `null`, or `undefined` states;
- unsafe prototype/property handling with a concrete inherited-property, `__proto__`, or prototype-pollution path;
- unvalidated runtime data crossing JSON, environment, CLI, message, storage, or network boundaries;
- shared mutation/aliasing with a named caller, cache, state, or iteration failure;
- leaked timers, listeners, subscriptions, or abortable work with a reachable lifecycle/resource impact.

Required safe cases include intentionally detached promises with internal rejection handling, deliberate dual-package exports, arrow lexical `this`, explicit nullish checks, `Object.hasOwn`/null-prototype maps, values produced by a real validator, deliberate immutable copies, and idempotent cleanup. JavaScript guidance must not mention `any`, TypeScript casts, non-null assertions, discriminated unions, interfaces, or compile-time exhaustiveness as JavaScript findings.

### 6. Bundled Skill Content Gate

Each new skill is default-enabled and must contain `Checks`, `False Positives`, `Safe Patterns`, and `Examples`. Every individual check must pass this owner-reviewed matrix before its language slice can complete:

1. observable failure predicate;
2. reachability/materiality rule and impact-based severity guidance;
3. one concrete unsafe example;
4. one safe counterexample/false-positive rule;
5. one safe pattern or mitigation.

Add evidence-bearing `BUNDLED_SKILL_WHY_LEDGER` entries for `lang/rust`, `lang/python`, `lang/solidity`, and `lang/javascript`. Tests assert all eight bundled skills load, project without unexpected truncation, remain within per-skill/total caps, and inject only into compatible Stage-7/9 packet prompts.

A language slice whose skill fails owner review remains `PARTIAL/BLOCKED`; adapter-only support does not satisfy Plan 98 Done Criteria.

### 7. Validation Strategy

#### 7.1 Structural integration tests

For each language, a production-path fixture builds the repository index and packets from a base/feature diff and asserts:

- canonical `DiffFile` and `FileFacts` language;
- requested adapter id and clean tree-sitter parse without degradation;
- expected symbol kind/name/range/owner and changed-symbol identity;
- expected enclosing symbol for header/attribute/decorator/body boundary lines;
- packet outline and symbol context contain the expected declaration;
- exact `relevantTests` paths and returned test-symbol names/ranges;
- packet lenses include the matching language lens;
- Stage-7 and Stage-9 prompts include the matching skill and exclude the other language skills.

Tests also cover malformed partial trees, forced unavailable/throw/timeout paths, overload/impl identity, imports, caps, and deterministic ordering.

#### 7.2 Fake eval fixtures

Add `evals/fixtures/repos/{rust,python,solidity,javascript}/` and one suite YAML per language. These remain zero-spend transport/anchoring sentinels using `CODEGENIE_FAKE_FINDING`; they prove the diff reaches packet review, verification, composition, and anchoring, not that a model or skill detects a real bug.

The public fixture inventory becomes eight cases after Phase 6. Each language fake fixture has a marker-free negative control. Structural tests—not candidate expectations—prove adapter, symbol, likely-test, lens, and skill behavior.

#### 7.3 PR-head CI

Add a conventional PR-head CI workflow, separate from the trusted-base codegenie-review dogfood workflow. It performs:

1. checkout of the PR revision;
2. supported Node and pnpm setup;
3. installation of a pinned `actionlint` binary before any check/test command (`check` and `test` both invoke `check:workflows`, which exits 127 when `actionlint` is absent);
4. `pnpm install --frozen-lockfile --config.ignore-scripts=false` using the repository's pnpm-11 `allowBuilds` policy—Vitest/tsx require esbuild's platform binary while unused dependency builds remain explicitly denied;
5. `pnpm run check`;
6. `pnpm test`;
7. `pnpm build`.

The fixture materialization/integration test is part of `pnpm test`; if a separate fixture invocation is introduced, it becomes an explicit required gate. Workflow tests pin that the CI workflow tests PR-head code rather than the trusted base, installs pinned `actionlint` before the gates, and does not copy the dogfood workflow's `--ignore-scripts` install flag.

#### 7.4 Packed-install gate

`npm pack`/installed-layout validation must prove:

- all eight bundled skill Markdown files are published and loadable;
- all seven grammar WASM paths resolve from the installed dependency tree;
- minimal Rust/Python/Solidity/JavaScript parses work outside the source checkout;
- no unexpected native install requirement makes the supported install path fail.

Before accepting the Solidity dependency, record pnpm and npm dependency trees and install-script decisions. If its native peer/install surface cannot be made safe for consumers, use the vendored-WASM stop path below.

#### 7.5 Owner acceptance smoke

Run one real review on a Rust or Solidity diff after automated gates pass. Record:

- fixture/repository revision and invocation;
- expected enclosing symbol and likely-test path;
- expected language lens and skill id;
- packet and prompt artifact locations inspected;
- owner acceptance of skill quality and packet context.

This smoke is product-content acceptance, not a substitute for automated shipping gates.

Phase 6 additionally requires one non-posting real JavaScript review with the same evidence record. It must demonstrate canonical `javascript`, a non-generic enclosing symbol, an exact JavaScript likely-test symbol, `lang/javascript` at Stage 7/9, exclusion of `lang/typescript`, one concrete accepted JavaScript check, and a marker-free negative control.

### 8. Delivery Plan

#### Phase 0 — Standalone PR-head CI prerequisite (land immediately)

- Land this phase as its own PR/commit before the language arc; it has independent value and is not held for later phases.
- Add the PR-head CI workflow with pinned `actionlint`, explicit scripts-enabled frozen pnpm install governed by pnpm-11 `allowBuilds` (with compatible pnpm-10 legacy keys), and check/test/build gates.
- Pin workflow contract tests for PR-head checkout, actionlint availability/order, pnpm 11.15.1, and exact `--config.ignore-scripts=false` installation.

#### Phase 1 — Shared language foundation

- Begin the single Plan-98 integration series after Phase 0 merges; keep its intermediate language commits from establishing separate external measurement boundaries.
- Add exact grammar dependencies, inspect frozen pnpm/npm install behavior, and prove the three proposed WASMs load from the installed dependency tree or trigger the vendored-WASM stop path.
- Canonical routing across tree-sitter, detectors, diff parser, classification, packets, and fake planner.
- Seven-grammar lifecycle tests and failure matrix.
- Generic language-lens fallback, planner compatibility validation, and defensive skill projection.
- Single likely-test candidate/test-symbol contract; remove the unused adapter hook.
- Optional declaration-identity callback preserving current Go/TypeScript defaults.
- Per-consumer test-role extensions and safe classifier decisions.
- Structural-test harness and Stage-5/cache measurement-boundary documentation.

#### Phase 2 — Rust vertical slice

- Rust grammar registration and adapter contract.
- Rust deterministic likely-test conventions and test symbols.
- `lang/rust` skill, WHY-ledger entry, owner content gate.
- Structural fixture, fake transport fixture, packed-layout assertion, docs/spec updates, full gates.

#### Phase 3 — Python vertical slice

- Python grammar registration and decorator-aware adapter contract for `.py`.
- Python deterministic likely-test conventions and test symbols.
- `lang/python` skill, WHY-ledger entry, owner content gate.
- Structural fixture, fake transport fixture, packed-layout assertion, docs/spec updates, full gates.

#### Phase 4 — Solidity vertical slice

- Solidity grammar registration and adapter contract, including minimal state-variable symbols.
- Foundry deterministic likely-test conventions and test symbols.
- `lang/solidity` skill, WHY-ledger entry, owner content gate.
- Structural fixture, fake transport fixture, packed-layout assertion, docs/spec updates, full gates.

#### Phase 5 — Cross-language release gate

- Run all checks, tests, build, fixture suites, packed-install validation, and recorded owner smoke.
- Verify Go/TypeScript Stage-7/9 projection isolation and disclose Stage-5/cache identity change.
- Finish normative docs and PUNCHLIST eval-diversity linkage.
- Validate the already-exposed complete Phase 1-4 inventory and record that its `eb20533` push was the single external language-skill inventory/cache measurement boundary; distinguish this branch boundary from later tag/npm/GitHub release operations.

#### Phase 6 — Dedicated JavaScript support

- Keep the existing JavaScript grammar, extension routing, shared adapter implementation, and likely-test substrate; add structural tests that prove those production paths for `.js`, `.jsx`, `.mjs`, and `.cjs` rather than treating grammar presence as language support.
- Add default-enabled `lang/javascript` and its WHY-ledger entry. Narrow `lang/typescript` metadata and content to TypeScript/TSX; remove TypeScript-only claims from JavaScript projection.
- Replace every JavaScript-to-`lang/typescript` alias in planner defaults, packet defaults, fake planning, verifier projection, and tests with exact `lang/javascript` selection.
- Add a JavaScript structural fixture and production-path integration suite covering symbols, enclosure, imports, changed-symbol identity, likely tests, packet context, language lens, and Stage-7/9 isolation.
- Add `evals/fixtures/repos/javascript/` plus `evals/fixtures/javascript.yml` with a positive transport marker and marker-free negative control; expand the public fixture inventory from seven to eight.
- Update packed-consumer assertions from seven to eight skills while retaining seven grammars; load the installed JavaScript skill and parse/inspect JavaScript outside the source checkout.
- Run the JavaScript owner-matrix content gate and one recorded real JavaScript owner smoke. Synchronize normative docs and disclose the second intentional Stage-5/registry/cache boundary when Phase 6 lands.
- Run full check/test/build, workflow, fixture, and packed-install gates. Phase 6 is one atomic implementation/release unit; do not split the TypeScript narrowing from the JavaScript skill/lens landing.

Each language phase is implementation-complete only when its parser/adapter contract, test discovery, skill/ledger, structural tests, fake transport fixture, documentation, and full gates coexist. No Phase 1-4 commit established an independent external boundary; Phase 6 establishes one new disclosed boundary only when its complete JavaScript unit lands.

## In-Scope Files

### Dependencies, packaging, and CI

- `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`
- build/package scripts or asset directory if the vendored-WASM stop path is triggered
- `.github/workflows/ci.yml` (new) and workflow contract tests

### Parser, adapters, repository context

- `src/types.ts`
- `src/repo/language-adapter.ts`
- `src/repo/tree-sitter/tree-sitter-service.ts`
- `src/repo/tree-sitter/typescript-adapter.ts` (shared ECMAScript implementation; change only where JavaScript structural tests require it)
- `src/repo/tree-sitter/rust-adapter.ts` (new)
- `src/repo/tree-sitter/python-adapter.ts` (new)
- `src/repo/tree-sitter/solidity-adapter.ts` (new)
- `src/repo/likely-tests.ts`
- `src/repo/packet-context.ts`
- `src/repo/repository-index.ts` only if required to expose the single likely-test contract without duplicating behavior

### Diff, classification, and path roles

- `src/git/detectors.ts`
- `src/git/diff-parser.ts`
- `src/git/file-classifier.ts`
- `src/util/path-roles.ts`

### Planner, packets, skills, and fake runner

- `src/pipeline/planner.ts`
- `src/pipeline/packet-builder.ts`
- `src/pipeline/lens-runner.ts`
- `src/skills/lens-registry.ts`
- `src/skills/prompt-builder.ts`
- `src/llm/fake-runner.ts`
- `bundled-skills/lang/typescript.md` (narrow languages/content to TypeScript/TSX)
- `bundled-skills/lang/javascript.md` (new)
- `bundled-skills/lang/rust.md` (new)
- `bundled-skills/lang/python.md` (new)
- `bundled-skills/lang/solidity.md` (new)

### Fixtures and tests

- `evals/fixtures/repos/{rust,python,solidity,javascript}/`
- `evals/fixtures/{rust,python,solidity,javascript}.yml`
- `tests/javascript-language.test.ts` and JavaScript tree-sitter fixtures (new)
- adapter/tree-sitter, repository intelligence, likely-test, path-role, classifier, packet, planner, prompt/skill, eval, package-build, and workflow tests

### Documentation/spec synchronization

- `README.md`
- `evals/fixtures/README.md`
- `specs/project/functional_spec.md`
- `specs/project/architecture.md`
- `specs/project/components/context_and_tools.md`
- `specs/project/components/repository_and_github.md`
- `specs/project/components/review_pipeline.md`
- `specs/project/components/skills_llm_telemetry.md`
- `specs/project/components/evals.md` where fixture inventory/validation is described
- `specs/plans/PUNCHLIST.md`

## Non-Goals and Explicit Deferrals

- `.pyi` Python stub support.
- Same-file Rust `#[cfg(test)]` discovery and arbitrary-name integration-test scanning.
- Custom pytest and Foundry test-discovery configuration.
- Solidity-to-Hardhat-TypeScript test cross-linking.
- Rust Analyzer, Pyright, solc, or other native semantic analyzers.
- New per-language static-signal forks.
- `exported`/public-API static signals for the new adapters.
- Solidity storage-layout, generated-getter, upgrade-compatibility, or ABI analysis; minimal state-variable symbols are still in scope.
- Vyper, language lenses beyond the dedicated JavaScript follow-up, lint mode, or review-budget/LLM-schema changes.
- Real-model eval baselines for the new languages; owner-run follow-up after landing.
- New marker-aware classifier machinery solely to skip ambiguous ecosystem directory names.
- Flow/JSDoc semantic type analysis, CommonJS exported-API inference, unsupported proposal syntax, bundler-specific resolution, and framework compiler semantics for JavaScript.

## Done Criteria

### Shared foundation

- Seven grammar ids load through the installed package layout, and the parser failure matrix is pinned.
- `.rs`, `.py`, `.sol`, `.js`, `.jsx`, `.mjs`, and `.cjs` carry one canonical language through diff, classification, parsing, packets, and lens selection.
- Omitted/invalid planner lenses still yield the matching language lens; incompatible skills cannot enter packet prompts.
- Both Stage-5/cache identity changes are disclosed; every language-specific Stage-7/9 projection is isolated.
- PR-head CI installs pinned `actionlint`, performs `pnpm install --frozen-lockfile --config.ignore-scripts=false` under the repository build-script policy, and runs check, test, and build successfully.

### Per language

- A clean fixture diff produces expected non-generic symbols, enclosing context, imports, changed-symbol identities, likely-test symbols, packet lens, and Stage-7/9 skill projection.
- The language's skill passes the owner acceptance matrix and has a WHY-ledger entry.
- Its fake eval transport fixture passes with a negative control.
- Its grammar and skill resolve from the packed/installed layout.
- Its normative docs are synchronized.

### Plan completion

- Rust, Python, Solidity, and JavaScript vertical slices all satisfy their per-language criteria.
- Existing Go/TypeScript/Rust/Python/Solidity tests and packet/prompt isolation assertions pass.
- Full `pnpm run check`, `pnpm test`, `pnpm build`, packed-install gate, fixture suites, and recorded owner smoke pass.
- The initial language inventory boundary at `eb20533` and the later atomic JavaScript boundary are both recorded with non-comparability rules and kept distinct from master/tag/npm/GitHub release state.

## Stop Conditions

- If the Solidity package's peer/native install surface breaks the supported consumer install, vendor the verified WASM at a pinned grammar commit. The vendored path must include provenance, integrity hash, build copy, package allow-list, resolution, and packed-install tests; do not upgrade `web-tree-sitter` mid-plan.
- If any grammar fails the pinned lazy-load/parse contract, stop that language slice and resolve the grammar asset independently rather than weakening structural assertions.
- If an ambiguous ecosystem directory cannot be skipped without false positives using current mechanisms, ship without that skip and rely on gitignore/configured `pathRules`.
- If a bundled skill cannot pass the concrete positive/negative owner rubric, mark that language slice partial/blocked; adapter-only support does not complete Plan 98.
- If structural tests pass only through generic fallback, fake sentinels, or wrong-language lenses, the language slice is not complete regardless of eval summary.
- If JavaScript remains projected through `lang/typescript`, or its acceptance depends on TypeScript-only checks, Phase 6 is not complete even if parsing succeeds.
