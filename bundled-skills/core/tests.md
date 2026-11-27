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

- Deleted or weakened tests: removed assertions, broadened matchers, skipped cases, looser fixtures, or replacement tests that no longer drive the same boundary (adapter, protocol, IO, serialization, provider) as the tests they replace.
- Missing coverage: a finding when a specific regression in the changed behavior would still pass the inspected tests. A new branch alone is not one.
- Assertion quality: tests that only check calls happened, snapshots that hide the important behavior, or assertions unrelated to the risk introduced by the change.
- Flaky patterns: timing sleeps, order dependence, shared mutable fixtures, network dependence, and tests that depend on local machine state.
- Test-only leakage: production behavior that changes only to satisfy a test, test hooks exposed without guardrails, or fixtures used as runtime defaults.

# False Positives

- Do not demand tests for generated files, purely mechanical renames, or unreachable compatibility code unless the diff changes behavior.
- Do not report a missing test when a nearby existing test already covers the specific behavior with meaningful assertions.
- Do not insist on a unit test when an integration test is the right level and already exercises the contract.
- Do not report deleted test coverage solely because the new tests are cleaner; require concrete evidence that a production boundary or behavior is no longer exercised.

- Scope absence claims to tests actually inspected; bounded or unsuccessful searches cannot prove repository-wide absence.
- Omit optional extra coverage instead of creating human-attention noise. Routine uncovered validation without established consequence is not a demonstrated defect.

# Safe Patterns

- Focused fixture tests around parsing, serialization, and configuration boundaries are high value.
- Tests that assert failure messages and typed error codes are useful for CLI and config behavior.
- Fake adapters are preferred for provider, network, and external-service paths so tests remain deterministic and cheap.

# Examples

- If a config precedence rule changes, a test should prove the exact precedence order and source attribution.
- If a path guard changes, tests should include absolute paths, `..`, hidden directories, and normal valid paths.
- If specialized adapter tests are replaced by a shared helper's tests, verify the replacement still exercises the adapter boundary, not only the pure helper callback.

- A tenant-isolation assertion that passes for another tenant, or a payment-limit assertion that accepts an over-limit charge, is a concrete test defect.
