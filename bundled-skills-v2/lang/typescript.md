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

1. **Promise completion.** Look for: owned async work rejects unseen or finishes after reported success. Unsafe: `persist(record); return accepted`. Safe: `await persist(record); return accepted`.
2. **Erased runtime proof.** Look for: `any`/assertion makes unchecked data reach a failing consumer. Unsafe: `const cfg=data as Config; connect(cfg.url)`. Safe: `const cfg=ConfigSchema.parse(data); connect(cfg.url)`.
3. **Absence assertion.** Look for: `!` or unchecked lookup sends `undefined`/`null` to a nonoptional operation. Unsafe: `users.get(id)!.email`. Safe: `const u=users.get(id); if(!u)return notFound; use(u.email)`.
4. **Closed-union exhaustiveness.** Look for: a new variant reaches wrong or missing behavior, or a retired variant or an old persisted or API value is still accepted at a runtime boundary after the change. Unsafe: `switch(state)` omits `"cancelled"`. Safe: `default: const neverState:never=state`.
5. **Multi-promise failure.** Look for: rejection skips cleanup or leaves sibling effects running. Unsafe: `await Promise.all(tasks); close()`. Safe: `try { await Promise.all(tasks) } finally { close() }`.
6. **Coercion/truthiness.** Look for: `0`, `false`, or `""` becomes absence or mixed types take a wrong branch. Unsafe: `input.retries || 3`. Safe: `input.retries ?? 3`.
7. **Shared mutation.** Look for: mutation surprises a caller, cache, module, or UI observer. Unsafe: `return rows.sort(compare)`. Safe: `return [...rows].sort(compare)`.
8. **External boundary.** Look for: JSON/env/CLI/model data violates a runtime assumption. Unsafe: `start(JSON.parse(raw).port)`. Safe: `start(InputSchema.parse(JSON.parse(raw)).port)`.

# False Positives

- **Promise completion** — require a lost error/result/order; severity by operation.
- **Erased runtime proof** — trace erased proof to runtime impact; severity by effect.
- **Absence assertion** — name source and consumer; severity by impact.
- **Closed-union exhaustiveness** — prove a closed set and unhandled variant; severity by result.
- **Multi-promise failure** — show the failure schedule; severity by partial work.
- **Coercion/truthiness** — require distinct reachable states; severity by result.
- **Shared mutation** — name alias and wrong result; severity by impact.
- **External boundary** — trace an untrusted field to consumer; severity by effect.

- Detached work is safe when rejection and lifetime are contained; `void` alone is not proof.
- Post-validator/control-flow assertions are safe when the validated value reaches the consumer.
- Open string sets need no exhaustiveness; require evidence the domain is closed.
- `Promise.allSettled` is safe when every rejection and required cleanup is deliberately handled.

# Safe Patterns

- Validate `unknown` and forward the validated value; assertions do not validate runtime data.
- Await owned work, define sibling failure, put cleanup in `finally`, and handle absence explicitly.
- Use `never` for closed unions, copy shared values, and preserve falsy values with exact checks.
