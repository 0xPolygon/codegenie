---
id: lang/python
title: Python correctness
lenses: ["lang/python"]
languages: ["python"]
categories: ["correctness", "concurrency", "performance", "security"]
enabledByDefault: true
---

# Purpose

Find reachable Python correctness, observability, concurrency, and injection failures while excluding safe idioms that merely resemble risky syntax.

# Checks

1. **Mutable defaults.** Failure: a default container leaks mutation across calls. Materiality: require a reachable later-call change; severity by impact. Unsafe: `def add(x,seen=[]): seen.append(x); return seen`. Safe: `def add(x,seen=None): seen=[] if seen is None else seen; seen.append(x); return seen`. Mitigation: allocate the same mutable API value per call, or use an immutable default.
2. **Broad exceptions.** Failure: broad handling hides failure or returns false success. Materiality: require a correctness/observability consequence; severity by impact. Unsafe: `try: persist(); except Exception: return True`. Safe: `try: cleanup(); except Exception: log.exception("cleanup"); raise`. Mitigation: catch expected errors narrowly and preserve explicit failure.
3. **Invalid `None`.** Failure: optional data violates a nonoptional caller contract. Materiality: name the `None` source/consumer; severity by impact. Unsafe: `return lookup_user(id).email`. Safe: `u=lookup_user(id); if u is None: raise LookupError(id); return u.email`. Mitigation: handle absence before use or declare it in the return contract.
4. **Inexact units.** Failure: float rounding violates an exact monetary/unit contract. Materiality: name exact producer/consumer; severity by error. Unsafe: `tax_cents=int(subtotal_cents*0.075)`. Safe: `tax_cents=subtotal_cents*75//1000`. Mitigation: use integer minor units or contextual `Decimal` with explicit rounding.
5. **Event-loop blocking.** Failure: synchronous work stalls unrelated async tasks. Materiality: require an event-loop workload; severity by stalled work. Unsafe: `async def poll(): time.sleep(5)`. Safe: `async def poll(): await asyncio.sleep(5)`. Mitigation: use async APIs or offload with `asyncio.to_thread`/an executor.
6. **Code/command injection.** Failure: untrusted data reaches eval or an unsafe shell. Materiality: trace source to sink; severity by execution authority. Unsafe: `subprocess.run("convert "+name,shell=True)`. Safe: `subprocess.run(["convert",name],shell=False,check=True)`. Mitigation: remove eval, use fixed argv, and validate the target program's grammar.
7. **TOCTOU files.** Failure: precheck and use observe different file identities. Materiality: require mutation and identity-sensitive use; severity by file impact. Unsafe: `if os.path.isfile(path): return open(path).read()`. Safe: `with open(path,"rb") as h: os.fstat(h.fileno()); data=h.read()`. Mitigation: authorize/use one descriptor, adding relative/no-follow opens when required.
8. **Mutation during iteration.** Failure: sequence mutation skips, duplicates, or misorders elements. Materiality: name an affected result; severity by data loss. Unsafe: `for x in items: items.remove(x)`. Safe: `for x in list(items): items.remove(x)`. Mitigation: filter, snapshot, or defer mutation.

# False Positives

- Immutable/never-mutated defaults do not leak state; cleanup that re-raises does not hide failure.
- Handled optional results and exact minor-unit/`Decimal` computations preserve their named contracts.
- Fixed argv with `shell=False` avoids shell parsing, but validate untrusted values the target program treats as options/grammar.
- One opened descriptor avoids a path identity race; snapshot iteration avoids mutation skips/duplicates.

# Safe Patterns

- Allocate state per call, model optionality, and preserve narrow exception evidence.
- Use exact units, yield/offload event-loop work, fixed argv, descriptor operations, and snapshot/filter traversal.
