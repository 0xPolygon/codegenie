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

1. **Goroutine lifetime.** Look for: work blocks or runs after its owner exits, or the owner closes, cancels or releases a resource while that work still uses it. Unsafe: `go func(){ ch <- v }()` after the receiver may exit. Safe: `select { case ch<-v: case <-ctx.Done(): }`.
2. **Context ownership.** Look for: caller cancellation/deadlines no longer reach work. Unsafe: `req.WithContext(context.Background())`. Safe: `req.WithContext(ctx)`.
3. **Deferred loop cleanup.** Look for: resources/locks accumulate until the outer return. Unsafe: `for rows.Next(){ f,_:=os.Open(n); defer f.Close() }`. Safe: `for rows.Next(){ processOne() }` where `processOne` defers close.
4. **Nil use.** Look for: a nil map write or pointer/interface dereference panics. Unsafe: `var m map[string]int; m[k]=1`. Safe: `m:=make(map[string]int); m[k]=1`.
5. **Error shadowing.** Look for: `:=` hides an operation error and stale state is checked/returned. Unsafe: `v,err:=load()` in an inner scope followed by returning outer `err`. Safe: `v,err=load()` when outer ownership is intended.
6. **Channel protocol.** Look for: send/receive/close ordering deadlocks or panics. Unsafe: `ch<-v` after the only receiver exits. Safe: `select { case ch<-v: case <-ctx.Done(): }` with one close owner.
7. **Slice aliasing.** Look for: append/reslice mutation changes borrowed backing storage. Unsafe: `buf=append(buf[:0], filtered...)`. Safe: `out:=append([]T(nil), filtered...)`.
8. **Mixed concurrent access.** Look for: unsynchronized read/write access races or corrupts state. Unsafe: `go write(sharedMap)` beside an unlocked read. Safe: `mu.Lock(); sharedMap[k]=v; mu.Unlock()` with all accesses locked.
9. **Lossy conversion ordering.** Look for: post-cast validation accepts truncation/wrap. Unsafe: `v:=uint8(raw); if v<=max { use(v) }`. Safe: `if raw<0||raw>max{return err}; v:=uint8(raw)`.

# False Positives

- **Goroutine lifetime** — require a reachable leak/stale effect; severity by resource or state impact.
- **Context ownership** — trace context to affected I/O; severity by stalled work.
- **Deferred loop cleanup** — require repetition and exhaustion/blocking; severity by impact.
- **Nil use** — name the reachable nil source; severity by lost work.
- **Error shadowing** — trace the wrong `err`; severity by hidden failure.
- **Channel protocol** — show participants and a reachable schedule; severity by liveness.
- **Slice aliasing** — name the alias and wrong observer; severity by data impact.
- **Mixed concurrent access** — show concurrency and a write; severity by state impact.
- **Lossy conversion ordering** — require out-of-range external input; severity by consumer impact.

- An explicit process-lifetime worker is not a leak without blocked work, accumulation, or a stale effect.
- Background context in tests/startup is safe unless it escapes into request work whose cancellation matters.
- Nil-safe receiver methods and literals/generated/already-bounded casts do not create nil or narrowing failures.
- Channel/shared state is safe when every participant follows one close, cancellation, and synchronization rule.

# Safe Patterns

- Pass caller context, make goroutine termination observable, and scope deferred cleanup to its lifetime.
- Copy borrowed slices, initialize required state, validate before narrowing, and synchronize every shared access.
