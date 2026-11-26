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

- Changed conditions and states: compare which inputs, variants and stored values the old code accepted or rejected with what the new code accepts or rejects; look for a supported value now rejected, a retired or invalid value still accepted, inverted conditions, off-by-one boundaries, wrong defaults and incomplete state transitions.
- Accounting: an item, event, payment, retry or partial result that can be counted, credited or applied twice, skipped, or attributed to the wrong unit; trace one input to the caller-visible total.
- Failure handling: errors swallowed or turned into success, empty or default results the caller treats as success, retries that hide permanent failures, and ignored meaningful return values.
- Ordering and ownership: work that outlives its owner, and an owner that closes, cancels, frees or replaces a resource while work still uses it; missing close, cancel, rollback, unlock, unsubscribe or disposal; cleanup skipped on early return; unsynchronized shared state and lost cancellation.
- Sibling completion: a partial failure or early exit that skips a completion, acknowledgement, notification or rollback that sibling paths perform.
- Security correctness: authorization gaps, injection into shell/SQL/regex/path contexts, unsafe deserialization, secret exposure, overly broad permissions, and user-controlled paths crossing trust boundaries.
- API misuse: calls made with the wrong units, lifetime, ownership, mutability, nullability, or error contract; version-specific behavior that the code ignores.
- Architectural regressions: layering violations, circular dependencies, bypassed chokepoints, duplicated policy, and hidden global state.
- Performance risks: new unbounded loops, repeated I/O in hot paths, quadratic operations on user-sized input, and caches that go stale or leak.
- Conversions and caller-visible guarantees: validate raw external, provider, API, config or database values before a lossy conversion (overflow, truncation, rounding, precision loss or coercion); after the conversion, check that any value exposed as a caller-visible bound or guarantee is still satisfiable from the transformed value.

# False Positives

- Do not report style, naming, formatting, or subjective readability comments unless they hide a real defect.
- Do not flag a missing check when the same invariant is enforced by a nearby typed contract, validation chokepoint, or deterministic caller guarantee.
- Do not treat every theoretical exception as a bug; require a concrete path where the change makes behavior worse.
- Do not prefer a different architecture unless the current change creates a specific maintenance, correctness, or security failure mode.
- Do not report unavoidable precision dust when the caller-visible output is derived from the same transformed value; trace which value reaches the caller before treating precision loss as a finding.
- Calibrate severity for guarantee or contract violations by reachability and magnitude. Sub-unit, pathological-input-only, or author-confirmation-dependent violations are usually low or medium, not high.

# Safe Patterns

- Centralized validation, containment, authentication, and redaction chokepoints are safe when callers cannot bypass them.
- Idempotent cleanup in `finally` or equivalent ownership wrappers is usually safer than duplicated cleanup at each return.
- Small deterministic fallbacks are safe when they are disclosed and preserve the main contract.
- Explicit partial behavior is safer than pretending a degraded operation succeeded.

# Examples

- A changed path join that accepts `../` from external input is a real security finding when it can read outside the intended root.
- A retry loop that catches every error and returns an empty result is a correctness finding when callers interpret empty as success.
- A new async task that keeps using a request-scoped object after cancellation is a lifecycle finding.
- A database write that bypasses the repository layer is an architecture finding when it skips that layer's validation or tenancy chokepoint.
- Code rounds a value down during a conversion, but still reports the original un-rounded value to the caller as a guaranteed minimum.
