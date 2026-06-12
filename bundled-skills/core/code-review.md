---
id: core/code-review
title: Core code review
lenses: ["core/code-review"]
languages: []
categories: ["correctness", "security", "architecture", "performance"]
enabledByDefault: true
---

# Purpose

Find correctness, security, lifecycle, and design problems that would matter to a maintainer after this change ships.

# Checks

- Logic and correctness: boundary conditions, off-by-one behavior, inverted conditions, incorrect defaults, incomplete state transitions, and behavior that contradicts the surrounding contract.
- Error handling: swallowed errors, retry loops that hide permanent failures, missing cleanup after partial failure, and callers that ignore meaningful return values.
- Resource lifecycle: missing close, cancel, rollback, unlock, unsubscribe, clear-timeout, or disposal paths; leaked handles; cleanup skipped on early return.
- Concurrency basics: unsynchronized shared-state mutation, ordering assumptions, races between async tasks, lost cancellation, and work that can outlive its owner.
- Security correctness: authorization gaps, injection into shell/SQL/regex/path contexts, unsafe deserialization, secret exposure, overly broad permissions, and user-controlled paths crossing trust boundaries.
- API misuse: calls made with the wrong units, lifetime, ownership, mutability, nullability, or error contract; version-specific behavior that the code ignores.
- Architectural regressions: layering violations, circular dependencies, bypassed chokepoints, duplicated policy, hidden global state, and changes that make future review harder.
- Performance risks: new unbounded loops, repeated I/O in hot paths, quadratic operations on user-sized input, and caches that can go stale or leak memory.

# False Positives

- Do not report style, naming, formatting, or subjective readability comments unless they hide a real defect.
- Do not flag a missing check when the same invariant is enforced by a nearby typed contract, validation chokepoint, or deterministic caller guarantee.
- Do not treat every theoretical exception as a bug; require a concrete path where the change makes behavior worse.
- Do not prefer a different architecture unless the current change creates a specific maintenance, correctness, or security failure mode.

# Safe Patterns

- Centralized validation, containment, authentication, and redaction chokepoints are safe when callers cannot bypass them.
- Idempotent cleanup in `finally` or equivalent ownership wrappers is usually safer than duplicated cleanup at each return.
- Small deterministic fallbacks are safe when they are disclosed and preserve the main contract.
- Explicit partial behavior is safer than pretending a degraded operation succeeded.

# Examples

- A changed path join that accepts `../` from model output is a real security finding when it can read outside the repo.
- A retry loop that catches every error and returns an empty result is a correctness finding when callers interpret empty as success.
- A new async task that keeps using a request-scoped object after cancellation is a lifecycle finding.
- A direct file read that bypasses the existing source resolver is an architecture finding because it skips revision binding and containment.
