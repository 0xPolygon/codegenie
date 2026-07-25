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

1. **Promise completion.** Failure: owned async work rejects unseen or finishes after reported success. Materiality: require a lost error/result/order; severity by operation. Unsafe: `persist(record); return accepted`. Safe: `await persist(record); return accepted`. Mitigation: await, return, aggregate, or internally handle deliberate detached work.
2. **Erased runtime proof.** Failure: `any`/assertion makes unchecked data reach a failing consumer. Materiality: trace erased proof to runtime impact; severity by effect. Unsafe: `const cfg=data as Config; connect(cfg.url)`. Safe: `const cfg=ConfigSchema.parse(data); connect(cfg.url)`. Mitigation: narrow `unknown` with validation or a proven guard.
3. **Absence assertion.** Failure: `!` or unchecked lookup sends `undefined`/`null` to a nonoptional operation. Materiality: name source and consumer; severity by impact. Unsafe: `users.get(id)!.email`. Safe: `const u=users.get(id); if(!u)return notFound; use(u.email)`. Mitigation: handle absence or expose it in the contract.
4. **Closed-union exhaustiveness.** Failure: a variant reaches wrong/missing behavior. Materiality: prove a closed set and unhandled variant; severity by result. Unsafe: `switch(state)` omits `"cancelled"`. Safe: `default: const neverState:never=state`. Mitigation: exhaustively check intentionally closed unions.
5. **Multi-promise failure.** Failure: rejection skips cleanup or leaves sibling effects running. Materiality: show the failure schedule; severity by partial work. Unsafe: `await Promise.all(tasks); close()`. Safe: `try { await Promise.all(tasks) } finally { close() }`. Mitigation: define aggregation, cancellation, and cleanup ownership together.
6. **Coercion/truthiness.** Failure: `0`, `false`, or `""` becomes absence or mixed types take a wrong branch. Materiality: require distinct reachable states; severity by result. Unsafe: `input.retries || 3`. Safe: `input.retries ?? 3`. Mitigation: use explicit nullish, type, and equality checks.
7. **Shared mutation.** Failure: mutation surprises a caller, cache, module, or UI observer. Materiality: name alias and wrong result; severity by impact. Unsafe: `return rows.sort(compare)`. Safe: `return [...rows].sort(compare)`. Mitigation: copy first or make ownership transfer explicit.
8. **External boundary.** Failure: JSON/env/CLI/model data violates a runtime assumption. Materiality: trace an untrusted field to consumer; severity by effect. Unsafe: `start(JSON.parse(raw).port)`. Safe: `start(InputSchema.parse(JSON.parse(raw)).port)`. Mitigation: validate at ingress and forward only validated values.

# False Positives

- Detached work is safe when rejection and lifetime are contained; `void` alone is not proof.
- Post-validator/control-flow assertions are safe when the validated value reaches the consumer.
- Open string sets need no exhaustiveness; require evidence the domain is closed.
- `Promise.allSettled` is safe when every rejection and required cleanup is deliberately handled.

# Safe Patterns

- Validate `unknown` and forward the validated value; assertions do not validate runtime data.
- Await owned work, define sibling failure, put cleanup in `finally`, and handle absence explicitly.
- Use `never` for closed unions, copy shared values, and preserve falsy values with exact checks.
