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

1. **Mutable defaults.** Look for: a default container leaks mutation across calls. Unsafe: `def add(x,seen=[]): seen.append(x); return seen`. Safe: `def add(x,seen=None): seen=[] if seen is None else seen; seen.append(x); return seen`.
2. **Broad exceptions.** Look for: broad handling hides failure or returns false success. Unsafe: `try: persist(); except Exception: return True`. Safe: `try: cleanup(); except Exception: log.exception("cleanup"); raise`.
3. **Invalid `None`.** Look for: optional data violates a nonoptional caller contract. Unsafe: `return lookup_user(id).email`. Safe: `u=lookup_user(id); if u is None: raise LookupError(id); return u.email`.
4. **Inexact units.** Look for: float rounding violates an exact monetary/unit contract. Unsafe: `tax_cents=int(subtotal_cents*0.075)`. Safe: `tax_cents=subtotal_cents*75//1000`.
5. **Event-loop blocking.** Look for: synchronous work stalls unrelated async tasks. Unsafe: `async def poll(): time.sleep(5)`. Safe: `async def poll(): await asyncio.sleep(5)`.
6. **Code/command injection.** Look for: untrusted data reaches eval or an unsafe shell. Unsafe: `subprocess.run("convert "+name,shell=True)`. Safe: `subprocess.run(["convert",name],shell=False,check=True)`.
7. **TOCTOU files.** Look for: precheck and use observe different file identities. Unsafe: `if os.path.isfile(path): return open(path).read()`. Safe: `with open(path,"rb") as h: os.fstat(h.fileno()); data=h.read()`.
8. **Mutation during iteration.** Look for: sequence mutation skips, duplicates, or misorders elements. Unsafe: `for x in items: items.remove(x)`. Safe: `for x in list(items): items.remove(x)`.

# False Positives

- **Mutable defaults** — require a reachable later-call change; severity by impact.
- **Broad exceptions** — require a correctness/observability consequence; severity by impact.
- **Invalid `None`** — name the `None` source/consumer; severity by impact.
- **Inexact units** — name exact producer/consumer; severity by error.
- **Event-loop blocking** — require an event-loop workload; severity by stalled work.
- **Code/command injection** — trace source to sink; severity by execution authority.
- **TOCTOU files** — require mutation and identity-sensitive use; severity by file impact.
- **Mutation during iteration** — name an affected result; severity by data loss.

- Immutable/never-mutated defaults do not leak state; cleanup that re-raises does not hide failure.
- Handled optional results and exact minor-unit/`Decimal` computations preserve their named contracts.
- Fixed argv with `shell=False` avoids shell parsing, but validate untrusted values the target program treats as options/grammar.
- One opened descriptor avoids a path identity race; snapshot iteration avoids mutation skips/duplicates.

# Safe Patterns

- Allocate state per call, model optionality, and preserve narrow exception evidence.
- Use exact units, yield/offload event-loop work, fixed argv, descriptor operations, and snapshot/filter traversal.
