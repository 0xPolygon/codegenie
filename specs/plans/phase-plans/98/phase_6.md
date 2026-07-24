---
status: complete
---

# Phase 6: Dedicated JavaScript support

## Overview

Complete Plan 98 by separating JavaScript product guidance from TypeScript while retaining the existing seven-grammar lifecycle and shared ECMAScript adapter implementation. Canonical `.js`, `.jsx`, `.mjs`, and `.cjs` files now receive only `lang/javascript`; TypeScript/TSX receive only `lang/typescript`. This phase adds the dedicated skill and WHY ledger, closes JavaScript structural gaps exposed by the acceptance fixtures, adds deterministic JavaScript integration/eval/package gates, synchronizes normative documentation, and records a real non-posting owner smoke.

## Implementation

1. Added default-enabled `bundled-skills/lang/javascript.md` with eight independently enforced runtime checks and required false-positive/safe-pattern coverage. Restricted `lang/typescript` metadata to `typescript`/`tsx` and added three evidence-bearing JavaScript WHY-ledger entries.
2. Removed JavaScript-to-TypeScript lens aliases from deterministic planner defaults, packet defaults/primary-lens selection, and fake planning. Exact language metadata plus the existing defensive Stage-7/9 filter now isolate both directions.
3. Retained `TypeScriptAdapter(service, "javascript")` as shared implementation while adding product-required JavaScript behavior: class-expression binding symbols and member ownership, generator function expressions, bounded 600-character signatures, source-ordered deduplicated re-export/import/literal-`require` sources, and correct curried `.each` test names.
4. Added production-path JavaScript fixtures and `tests/javascript-language.test.ts`, covering canonical extensions, async/generator/arrow/value symbols, declarations/class expressions, private/callable class fields, JSX, anonymous default exports, ESM/CommonJS forms, imports, enclosure, changed-symbol identity, likely tests, packet context, exact lens selection, Stage-7/9 projection, skill matrix, and WHY ledger.
5. Added `evals/fixtures/javascript.yml` with a marker-bearing positive source and marker-free negative control. Updated the public suite contract from seven to eight cases.
6. Updated the packed installed-consumer gate to require all eight bundled skill files, load `lang/javascript`, retain seven grammar assets, and inspect a JavaScript class-expression method through the installed package.
7. Synchronized README, functional/architecture/component specs, Plan 98 status, and PUNCHLIST evidence. This atomic phase commit is the second cache-boundary revision; its external visibility begins only on a later push or merge.

## Automated validation

- `pnpm run check`: passed (`tsc --noEmit` plus pinned workflow validation).
- `pnpm test`: passed, 37 test files and 729 tests.
- `pnpm build`: passed.
- `pnpm exec vitest run tests/package-build.test.ts`: passed, 4 tests; installed consumer loaded eight skills, resolved/parsed all seven grammars, and inspected JavaScript outside the source checkout.
- `pnpm run dev eval --eval-dir evals/fixtures`: passed, 8 cases and zero failures/errors/losses. JavaScript is run 52; the complete run set is 50-57.
- Fixture behavior: base `npm test` at `ff971a1dae48d4a84a4691d9a25e13f5c117feaf` passes one test; feature `npm test` at `864019b3ff3baaeb96061e576eaccc1bde410b49` fails because `saveRecord` resolves instead of propagating the `disk full` rejection.

## Real JavaScript owner smoke

- Invocation: `node dist/cli/main.js eval --eval-dir /tmp/codegenie-plan98-phase6-smoke` using non-posting `anthropic/claude-sonnet-4-6:high`, verification enabled, cache disabled, and debug artifacts enabled.
- Result: run 1 passed with 1 reported finding, 2/2 positive/negative expectations, complete 2/2-hunk review, zero budget overruns/losses, `$0.3605`, and 231.0 seconds.
- Reproducible fixture: `/tmp/codegenie-plan98-phase6-fixture`, base `ff971a1dae48d4a84a4691d9a25e13f5c117feaf`, head `864019b3ff3baaeb96061e576eaccc1bde410b49`.
- Expected context: `src/save-record.js::saveRecord`, range `[1,4]`, changed line 2; likely test `src/save-record.test.js::rejects when persistence fails`, range `[5,13]`; packet language/lens/skill `javascript` / `lang/javascript`.
- Packet evidence: `/tmp/codegenie-plan98-phase6-smoke/logs/1/telemetry/stages/06-packets/packets/efbacaabddd62c34bbbfe3332e08edf88e0cbb56f6117bbf7cc89cc46e092301.json` contains the exact symbol, test, full context, and only `lang/javascript`.
- Stage-7 evidence: `/tmp/codegenie-plan98-phase6-smoke/logs/1/telemetry/debug/llm-calls/mc-000002.request.json` projects `lang/javascript`, the floating-promise check, exact enclosing source, and exact likely test; it contains no `lang/typescript` section.
- Stage-9 evidence: `/tmp/codegenie-plan98-phase6-smoke/logs/1/telemetry/debug/llm-calls/mc-000008.request.json` projects only JavaScript false-positive/safe-pattern guidance and the same exact evidence; it contains no TypeScript guidance.
- Verification: `/tmp/codegenie-plan98-phase6-smoke/logs/1/telemetry/stages/09-verification/verification.json` keeps/revises the dropped-await finding with required evidence and low false-positive risk, while rejecting the safe `normalizeLabel` negative-control candidate for lack of a reachable caller failure.
- Final output: `/tmp/codegenie-plan98-phase6-smoke/logs/1/telemetry/stages/10-composition/final-findings.json` publishes one inline finding at `src/save-record.js:2`; `/tmp/codegenie-plan98-phase6-smoke/logs/1/codegenie-review.out.md` reports the exact broken rejection contract and unchanged failing test.
- Acceptance judgment: **ACCEPTED.** The run demonstrates canonical JavaScript, non-generic syntax context, exact likely-test linkage, dedicated skill isolation at both model stages, a concrete accepted floating-promise check, verifier rejection of the marker-free safe control, and concise final composition.

## Measurement boundary

Adding `lang/javascript` and changing `lang/typescript` content both alter `LensRegistry.registryHash()` and the Stage-5 skill inventory. They therefore form one atomic second Plan-98 measurement boundary. This phase's atomic commit is the boundary revision; no push, merge, tag, or publication is performed as part of this implementation turn. Record its first external visibility event when it is pushed or merged, and do not compare measurements across that event as the same prompt/cache regime. External visibility remains distinct from tag, npm, and GitHub release publication.
