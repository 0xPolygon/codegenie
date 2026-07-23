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

1. **Mutable defaults.** Failure: mutating a default container leaks state across calls. Materiality: require a reachable later-call change; severity follows its impact. Unsafe: `def add(x, seen=[]): seen.append(x); return seen`. Safe: `def add(x, seen=()): return (*seen, x)`. Mitigation: allocate per call via `None` or use an immutable default.
2. **Broad exception handling.** Failure: broad handling hides failure, returns false success, or destroys observability. Materiality: require a recovery/correctness consequence; severity follows it. Unsafe: `try: persist(); except Exception: return True`. Safe: `try: cleanup(); except Exception: log.exception("cleanup"); raise`. Mitigation: catch expected exceptions narrowly and preserve explicit failure.
3. **Invalid `None` propagation.** Failure: an optional result violates a caller-visible non-optional contract. Materiality: name the reachable `None` source and contract; severity follows caller impact. Unsafe: `return lookup_user(id).email`. Safe: `def email(id) -> str | None: user = lookup_user(id); return user.email if user else None`. Mitigation: validate absence or expose it in the return contract.
4. **Inexact named units.** Failure: float rounding violates an exact monetary/unit contract. Materiality: require a named exact producer/consumer; severity follows the amount error. Unsafe: `invoice.total = dollars * 0.1`. Safe: `invoice.cents = subtotal_cents + tax_cents`. Mitigation: use integer minor units or contextual `Decimal` with boundary rounding.
5. **Async event-loop blocking.** Failure: synchronous work stalls unrelated async tasks. Materiality: require an event-loop path and workload-sensitive delay; severity follows stalled work. Unsafe: `async def poll(): time.sleep(5)`. Safe: `async def poll(): await asyncio.sleep(5)`. Mitigation: use async APIs or offload with `asyncio.to_thread`/an executor.
6. **Code or command injection.** Failure: untrusted data reaches dynamic evaluation or an unsafe shell and executes code. Materiality: trace source to sink; severity follows execution authority. Unsafe: `subprocess.run("convert " + name, shell=True)`. Safe: `subprocess.run(["convert", name], shell=False, check=True)`. Mitigation: remove evaluation, use fixed argv, and validate the target grammar.
7. **TOCTOU file handling.** Failure: a check/use race changes path or file identity before a sensitive operation. Materiality: require a real mutation window; severity follows file impact. Unsafe: `if os.path.exists(path): open(path).read()`. Safe: `with open(path, "rb") as handle: data = handle.read()`. Mitigation: open once and use the descriptor, adding relative/no-follow flags when needed.
8. **Mutation during iteration.** Failure: mutating the iterated sequence skips, duplicates, or misorders elements. Materiality: name an affected element/result; severity follows data loss. Unsafe: `for item in items: items.remove(item)`. Safe: `for item in list(items): items.remove(item)`. Mitigation: filter, iterate a snapshot, or defer mutations.

# False Positives

- Exclude immutable/never-mutated defaults, cleanup that catches and re-raises, and callers that handle absence.
- Exclude integer minor units, deliberate iteration over a copy, and operations on one already-open descriptor.
- `subprocess` argv with `shell=False`, floats, broad catches, and preflight checks need the matching concrete failure.

# Safe Patterns

- Allocate mutable state per call, model optionality explicitly, and keep exception scope narrow while preserving failure evidence.
- Use exact unit representations at boundaries and yield or offload blocking work on event-loop paths.
- Prefer fixed subprocess argv, descriptor-based file operations, and snapshot/filter traversal over in-loop mutation.

# Examples

Each numbered check includes a concrete unsafe example, a distinct safe counterexample, and a separate mitigation; enforce the named reachability and materiality rule before reporting it.
