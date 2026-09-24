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

- Consequential missing coverage: establish a material behavioral requirement, identify a concrete regression that would violate it, and show why inspected relevant tests would accept that regression. A new branch or edge case alone does not justify a finding. Caller behavior and boundary tests can establish a contract without a written specification.
- Deleted or weakened tests: removed assertions, broadened matchers, skipped cases, looser fixtures, or coverage that no longer exercises the changed code.
- Deleted versus replacement coverage: when tests are deleted or rewritten, compare what production behavior the old tests protected against what the new tests still exercise. Helper-level tests do not replace deleted integration, adapter, protocol, RPC, HTTP, database, IO, serialization, or provider tests unless they drive the same boundary wiring.
- Assertion quality: tests that only check calls happened, snapshots that hide the important behavior, or assertions unrelated to the risk introduced by the change.
- Negative paths: report absent rejection tests when they leave an established important boundary unprotected, such as tenant isolation or a payment limit. A currently correct guard can still lack a necessary test; an existing production bug or executed mutation is not required. Check relevant sister tests and transport validation before claiming missing protection.
- Regression focus: proposed tests must exercise a reachable boundary, reject a weakened requirement, and accept valid remedies. A commit title or neighboring test style alone does not establish material impact.
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
- If a client adds retry-on-failure behavior, tests should prove exactly one retry happens and that repeated failure surfaces an error instead of silence.
- If specialized adapter tests are replaced by a shared helper's tests, verify the replacement still exercises the adapter boundary, not only the pure helper callback.

- A tenant-isolation assertion that passes for another tenant, or a payment-limit assertion that accepts an over-limit charge, is a concrete test defect.
- A Python handler lacking a duplicate malformed-input test is not a gap if the inspected transport test already enforces that same boundary.
