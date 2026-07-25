---
id: lang/rust
title: Rust correctness
lenses: ["lang/rust"]
languages: ["rust"]
categories: ["correctness", "concurrency", "performance", "security"]
enabledByDefault: true
---

# Purpose

Find reachable Rust runtime failures and invariant violations without reporting compiler-rejected code or treating idiomatic risk markers as defects by themselves.

# Checks

1. **Reachable panic paths.** Failure: production input reaches `panic!`, `unwrap`, or `expect` and terminates work. Materiality: exclude test-only or invariant-proven paths; severity follows the affected service/data path. Unsafe: `header.to_str().unwrap()`. Safe: `let value = header.to_str()?;` returns an error. Mitigation: remove input-reachable panics or enforce the claimed constructor invariant.
2. **Narrowing casts.** Failure: unbounded `as` conversion truncates a number into a wrong bound, index, amount, or protocol field. Materiality: require a reachable out-of-range value; severity follows consumer impact. Unsafe: `request.limit as u8` before validation. Safe: `let limit = u8::try_from(request.limit)?;` rejects it. Mitigation: validate bounds at the trust boundary and handle conversion failure.
3. **Ignored `Result`.** Failure: a discarded write/send/persist/cleanup failure exposes success or corrupt state. Materiality: exclude explicitly contained best-effort work; severity follows the lost operation. Unsafe: `let _ = ledger.persist(entry); return Ok(())`. Safe: `ledger.persist(entry)?; return Ok(())` preserves failure. Mitigation: propagate, retry, compensate, or record and contain noncritical failure.
4. **Async blocking.** Failure: synchronous I/O, sleep, lock contention, or CPU work stalls an async executor. Materiality: require runtime/workload evidence; severity follows the stalled workload. Unsafe: `std::thread::sleep(delay)` in a Tokio future. Safe: `tokio::time::sleep(delay).await` yields. Mitigation: prefer async APIs or isolate unavoidable work with `spawn_blocking`.
5. **Slice boundaries.** Failure: length/index arithmetic underflows, overflows, reverses, or indexes outside a slice. Materiality: name the boundary input; severity follows panic/data impact. Unsafe: `&payload[..payload.len() - trailer]` for an oversized trailer. Safe: `payload.len().checked_sub(trailer).and_then(|end| payload.get(..end))` returns absence. Mitigation: combine checked arithmetic/indexing and handle the missing range.
6. **Unsafe invariants.** Failure: unsafe code permits invalid aliasing, lifetime, initialization, layout, thread-safety, or ownership. Materiality: identify a reachable invariant violation; severity follows memory/thread impact. Unsafe: `from_raw_parts(ptr, len)` after free. Safe: `let slice = live.as_slice();` remains tied to its owner. Mitigation: keep proof checks adjacent and expose a safe wrapper enforcing every precondition.
7. **State across `.await`.** Failure: a runtime guard or unsafe/manual-`Send` assumption spans suspension and causes deadlock, starvation, or invalid access. Materiality: show suspension plus conflicting access; severity follows liveness/safety impact. Unsafe: `let guard = state.lock().unwrap(); callback().await; drop(guard);` holds the guard across suspension. Safe: `let snapshot = guard.clone(); drop(guard); callback(snapshot).await;` ends the guard first. Mitigation: end guards/unsafe borrows before suspension; use async ownership only when state must span it.

# False Positives

- Compiler-rejected lifetime, borrow, trait-bound, and `Send` paths cannot ship as runtime failures.
- Widening/nonnumeric/bounded casts do not truncate; contained best-effort results do not fake required success.
- Test-only or constructor-invariant-proven panics are safe when production input cannot violate the invariant.
- `unsafe`, sync APIs, mutexes, or `.await` need a reachable memory violation, executor stall, deadlock/starvation, or invalid access.

# Safe Patterns

- Prefer `TryFrom`, checked arithmetic/indexing, and typed errors at untrusted boundaries.
- Keep unsafe code small; state and validate preconditions behind a safe API.
- End lock/borrow scopes before `.await`; isolate blocking work while preserving cancellation/errors.
