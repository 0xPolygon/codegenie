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
- Deleted versus replacement coverage: when tests are deleted or rewritten, compare what production behavior the old tests protected against what the new tests still exercise. Helper-level tests do not replace deleted integration, adapter, protocol, RPC, HTTP, database, IO, serialization, or provider tests unless they drive the same boundary wiring.
- Assertion quality: tests that only check calls happened, snapshots that hide the important behavior, or assertions unrelated to the risk introduced by the change.
- Negative paths: absent tests for invalid input, missing resources, auth failures, timeout/cancellation, empty results, and malformed data.
- Regression focus: missing tests for the exact failure mode the change claims to fix.
- Flaky patterns: timing sleeps, order dependence, shared mutable fixtures, network dependence, and tests that depend on local machine state.
- Test-only leakage: production behavior that changes only to satisfy a test, test hooks exposed without guardrails, or fixtures used as runtime defaults.

# False Positives

- Do not demand tests for generated files, purely mechanical renames, or unreachable compatibility code unless the diff changes behavior.
- Do not report a missing test when a nearby existing test already covers the specific behavior with meaningful assertions.
- Do not insist on a unit test when an integration test is the right level and already exercises the contract.
- Do not report deleted test coverage solely because the new tests are cleaner; require concrete evidence that a production boundary or behavior is no longer exercised.

# Safe Patterns

- Focused fixture tests around parsing, serialization, and configuration boundaries are high value.
- Tests that assert failure messages and typed error codes are useful for CLI and config behavior.
- Fake adapters are preferred for provider, network, and external-service paths so tests remain deterministic and cheap.

# Examples

- If a config precedence rule changes, a test should prove the exact precedence order and source attribution.
- If a path guard changes, tests should include absolute paths, `..`, hidden directories, and normal valid paths.
- If a client adds retry-on-failure behavior, tests should prove exactly one retry happens and that repeated failure surfaces an error instead of silence.
- If specialized adapter tests are replaced by a shared helper's tests, verify the replacement still exercises the adapter boundary, not only the pure helper callback.
