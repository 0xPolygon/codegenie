---
id: core/tests
title: Test coverage review
lenses: ["core/tests"]
languages: []
categories: ["testing", "correctness"]
enabledByDefault: true
---

# Purpose

Review whether the changed behavior is protected by useful tests and whether existing tests were weakened.

# Checks

- Missing coverage for changed behavior: new branches, edge cases, failure paths, permission checks, parser cases, and backwards-compatibility contracts.
- Deleted or weakened tests: removed assertions, broadened matchers, skipped cases, looser fixtures, or coverage that no longer exercises the changed code.
- Deleted coverage versus replacement coverage: when tests are deleted, compare what production behavior the deleted tests protected against what the new tests still exercise.
- Specialized boundary coverage: do not treat helper-level tests as equivalent to deleted integration, adapter, protocol, RPC, HTTP, database, IO, serialization, or provider tests unless the replacement exercises the same boundary wiring.
- Assertion quality: tests that only check calls happened, snapshots that hide the important behavior, or assertions unrelated to the risk introduced by the change.
- Negative paths: absent tests for invalid input, missing resources, auth failures, timeout/cancellation, empty results, and malformed data.
- Regression focus: missing tests for the exact failure mode the change claims to fix.
- Flaky patterns: timing sleeps, order dependence, shared mutable fixtures, network dependence, and tests that depend on local machine state.
- Test-only leakage: production behavior that changes only to satisfy a test, test hooks exposed without guardrails, or fixtures used as runtime defaults.

# False Positives

- Do not demand tests for generated files, purely mechanical renames, or unreachable compatibility code unless the diff changes behavior.
- Do not report a missing test when a nearby existing test already covers the specific behavior with meaningful assertions.
- Do not insist on a unit test when an integration test is the right level and already exercises the contract.
- Do not report deleted test coverage solely because the new helper tests are cleaner; require concrete evidence that the production boundary or behavior is no longer exercised.

# Safe Patterns

- Focused fixture tests around parser, diff, config, and repository-boundary behavior are high value.
- Tests that assert failure messages and typed error codes are useful for CLI and config behavior.
- Fake adapters are preferred for provider, network, and LLM paths so tests remain deterministic and cheap.
- Replacement helper tests are safe when they still drive the same production path, adapter, protocol boundary, or observable behavior as the deleted tests.

# Examples

- If a config precedence rule changes, a test should prove the exact precedence order and source attribution.
- If a path guard changes, tests should include absolute paths, `..`, `.git`, and normal valid paths.
- If a model runner adds schema repair, tests should prove one repair attempt happens and that repeated invalid output fails.
- If specialized adapter tests are replaced by a shared helper, verify the helper test still exercises the adapter boundary, not only the pure helper callback.
