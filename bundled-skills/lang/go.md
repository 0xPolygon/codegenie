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

1. **Goroutine lifetime.** Failure: work blocks or runs after its owner exits. Materiality: require a reachable leak/stale effect; severity by resource or state impact. Unsafe: `go func(){ ch <- v }()` after the receiver may exit. Safe: `select { case ch<-v: case <-ctx.Done(): }`. Mitigation: bind goroutines to cancellation, completion, or explicit process lifetime.
2. **Context ownership.** Failure: caller cancellation/deadlines no longer reach work. Materiality: trace context to affected I/O; severity by stalled work. Unsafe: `req.WithContext(context.Background())`. Safe: `req.WithContext(ctx)`. Mitigation: pass caller context and derive bounded children.
3. **Deferred loop cleanup.** Failure: resources/locks accumulate until the outer return. Materiality: require repetition and exhaustion/blocking; severity by impact. Unsafe: `for rows.Next(){ f,_:=os.Open(n); defer f.Close() }`. Safe: `for rows.Next(){ processOne() }` where `processOne` defers close. Mitigation: end acquisition and cleanup within one iteration.
4. **Nil use.** Failure: a nil map write or pointer/interface dereference panics. Materiality: name the reachable nil source; severity by lost work. Unsafe: `var m map[string]int; m[k]=1`. Safe: `m:=make(map[string]int); m[k]=1`. Mitigation: initialize required state and handle optional values before use.
5. **Error shadowing.** Failure: `:=` hides an operation error and stale state is checked/returned. Materiality: trace the wrong `err`; severity by hidden failure. Unsafe: `v,err:=load()` in an inner scope followed by returning outer `err`. Safe: `v,err=load()` when outer ownership is intended. Mitigation: keep error ownership explicit and narrow.
6. **Channel protocol.** Failure: send/receive/close ordering deadlocks or panics. Materiality: show participants and a reachable schedule; severity by liveness. Unsafe: `ch<-v` after the only receiver exits. Safe: `select { case ch<-v: case <-ctx.Done(): }` with one close owner. Mitigation: define ownership, termination, cancellation, and buffering together.
7. **Slice aliasing.** Failure: append/reslice mutation changes borrowed backing storage. Materiality: name the alias and wrong observer; severity by data impact. Unsafe: `buf=append(buf[:0], filtered...)`. Safe: `out:=append([]T(nil), filtered...)`. Mitigation: copy before retaining or mutating borrowed slices.
8. **Mixed concurrent access.** Failure: unsynchronized read/write access races or corrupts state. Materiality: show concurrency and a write; severity by state impact. Unsafe: `go write(sharedMap)` beside an unlocked read. Safe: `mu.Lock(); sharedMap[k]=v; mu.Unlock()` with all accesses locked. Mitigation: enforce one mutex or owner-goroutine rule.
9. **Lossy conversion ordering.** Failure: post-cast validation accepts truncation/wrap. Materiality: require out-of-range external input; severity by consumer impact. Unsafe: `v:=uint8(raw); if v<=max { use(v) }`. Safe: `if raw<0||raw>max{return err}; v:=uint8(raw)`. Mitigation: validate provider/API/config/database values before narrowing.

# False Positives

- An explicit process-lifetime worker is not a leak without blocked work, accumulation, or a stale effect.
- Background context in tests/startup is safe unless it escapes into request work whose cancellation matters.
- Nil-safe receiver methods and literals/generated/already-bounded casts do not create nil or narrowing failures.
- Channel/shared state is safe when every participant follows one close, cancellation, and synchronization rule.

# Safe Patterns

- Pass caller context, make goroutine termination observable, and scope deferred cleanup to its lifetime.
- Copy borrowed slices, initialize required state, validate before narrowing, and synchronize every shared access.
