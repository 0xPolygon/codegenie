---
id: lang/typescript
title: TypeScript correctness
lenses: ["lang/typescript"]
languages: ["typescript", "tsx"]
categories: ["correctness", "async", "typing"]
enabledByDefault: true
---

# Purpose

Find TypeScript bugs around async behavior, erased type safety, mutation, and runtime contracts.

# Checks

1. **Promise completion.** Failure: owned async work rejects unseen or finishes after reported success. Unsafe: `persist(record); return accepted`. Safe: `await persist(record); return accepted`.
2. **Erased runtime proof.** Failure: `any`/assertion makes unchecked data reach a failing consumer. Unsafe: `const cfg=data as Config; connect(cfg.url)`. Safe: `const cfg=ConfigSchema.parse(data); connect(cfg.url)`.
3. **Absence assertion.** Failure: `!` or unchecked lookup sends `undefined`/`null` to a nonoptional operation. Unsafe: `users.get(id)!.email`. Safe: `const u=users.get(id); if(!u)return notFound; use(u.email)`.
4. **Closed-union exhaustiveness.** Failure: a variant reaches wrong/missing behavior. Unsafe: `switch(state)` omits `"cancelled"`. Safe: `default: const neverState:never=state`.
5. **Multi-promise failure.** Failure: rejection skips cleanup or leaves sibling effects running. Unsafe: `await Promise.all(tasks); close()`. Safe: `try { await Promise.all(tasks) } finally { close() }`.
6. **Coercion/truthiness.** Failure: `0`, `false`, or `""` becomes absence or mixed types take a wrong branch. Unsafe: `input.retries || 3`. Safe: `input.retries ?? 3`.
7. **Shared mutation.** Failure: mutation surprises a caller, cache, module, or UI observer. Unsafe: `return rows.sort(compare)`. Safe: `return [...rows].sort(compare)`.
8. **External boundary.** Failure: JSON/env/CLI/model data violates a runtime assumption. Unsafe: `start(JSON.parse(raw).port)`. Safe: `start(InputSchema.parse(JSON.parse(raw)).port)`.

# False Positives

- Detached work is safe when rejection and lifetime are contained; `void` alone is not proof.
- Post-validator/control-flow assertions are safe when the validated value reaches the consumer.
- Open string sets need no exhaustiveness; require evidence the domain is closed.
- `Promise.allSettled` is safe when every rejection and required cleanup is deliberately handled.

# Safe Patterns

- Validate `unknown` and forward the validated value; assertions do not validate runtime data.
- Await owned work, define sibling failure, put cleanup in `finally`, and handle absence explicitly.
- Use `never` for closed unions, copy shared values, and preserve falsy values with exact checks.
