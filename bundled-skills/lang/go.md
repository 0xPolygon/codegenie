---
id: lang/go
title: Go correctness
lenses: ["lang/go"]
languages: ["go"]
categories: ["correctness", "concurrency", "performance"]
enabledByDefault: true
---

# Purpose

Find Go-specific correctness, lifecycle, and concurrency bugs in changed code.

# Checks

- Goroutine leaks: goroutines started without a cancellation path, channel close path, or owner lifetime.
- Context misuse: replacing caller contexts, ignoring cancellation, passing nil contexts, storing contexts in structs, or using background context in request paths.
- Deferred work in loops: `defer` inside unbounded loops, delayed unlocks/closes, and cleanup whose lifetime is larger than intended.
- Nil writes: writes to nil maps, nil pointer dereferences, nil interface surprises, and methods called on possibly nil receivers.
- Error shadowing: `:=` that shadows an outer `err`, checks the wrong variable, or returns stale values.
- Channel deadlocks: sends without receivers, receives without close/cancel, double close, and buffering assumptions that break under load.
- Slice aliasing: append or sub-slice sharing that mutates caller-owned data or cached data unexpectedly.
- Mixed access without mutex: maps, slices, counters, and structs read and written from multiple goroutines.
- Lossy conversion ordering: validate raw provider/API/config/database values before narrowing casts such as `uint8(...)`, `uint16(...)`, `int8(...)`, `int16(...)`, or `int32(...)`; validation after the cast may be too late.

# False Positives

- Do not flag goroutines that are intentionally process-lifetime workers and have explicit ownership.
- Do not flag nil receiver methods when the method is intentionally nil-safe and handles that case.
- Do not report context background use in tests or startup code unless it can leak into request-scoped behavior.
- Do not flag narrowing casts of literals, generated enum-like values, or values already bounded by an immediately visible validator.

# Safe Patterns

- Passing caller context through unchanged is usually correct.
- `defer` directly after acquiring a resource is safe outside hot/unbounded loops.
- Copying slices before retaining or mutating them avoids aliasing bugs.
- Mutex-protected or channel-owned state is safe when all accesses use the same ownership rule.

# Examples

- `go func() { ch <- value }()` without selecting on `ctx.Done()` can leak if the receiver returns early.
- `m[key] = value` after `var m map[string]string` is a nil map write.
- `items = append(items[:0], filtered...)` can mutate shared backing storage if `items` was caller-owned.
