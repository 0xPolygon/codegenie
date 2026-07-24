---
id: lang/javascript
title: JavaScript correctness
lenses: ["lang/javascript"]
languages: ["javascript"]
categories: ["correctness", "async", "reliability", "security"]
enabledByDefault: true
---

# Purpose

Find reachable JavaScript runtime, boundary, state, and lifecycle failures.

# Checks

1. **Floating promises.** Failure: detached work rejects or completes out of order, losing a required result. Materiality: require reachable failure or ordering; severity follows the operation. Unsafe: `save(record); return accepted`. Safe: `await save(record); return accepted`. Mitigation: await, return, aggregate, or handle rejection inside deliberate detached work.
2. **Module interop mismatch.** Failure: ESM/CommonJS disagreement yields a wrong binding or load error. Materiality: require shipped mode/export shape; severity follows impact. Unsafe: `const parse=require("pkg").default; parse(x)` when its CJS export is `{parse}`. Safe: `const {parse}=require("pkg"); parse(x)`. Mitigation: follow the export map and test shipped mode, binding shape, and top-level-await limits.
3. **Lost receiver.** Failure: extracting a method changes `this` and accesses wrong state. Materiality: require an observing call; severity follows state/result impact. Unsafe: `const run = client.run; run()`. Safe: `const run = client.run.bind(client); run()`. Mitigation: preserve the receiver; use arrows only for intended lexical `this`.
4. **Coercion or truthiness collapse.** Failure: a check conflates meaningful `0`, `false`, or `""` with absence. Materiality: require reachable distinct states; severity follows the wrong branch. Unsafe: `const retries = input.retries || 3`. Safe: `const retries = input.retries ?? 3`. Mitigation: use explicit nullish, type, and equality checks.
5. **Unsafe property handling.** Failure: inherited or attacker keys alter lookup, authority, or prototypes. Materiality: require a key source and affected access; severity follows corruption. Unsafe: `target[userKey] = value`. Safe: `const target = Object.create(null); target[userKey] = value`. Mitigation: validate keys and use own-property checks, maps, or safe dictionaries.
6. **Unvalidated runtime boundary.** Failure: external data violates a sensitive consumer's assumptions. Materiality: require an untrusted field-to-failure trace; severity follows the effect. Unsafe: `charge(JSON.parse(body).amount)`. Safe: `charge(PaymentSchema.parse(JSON.parse(body)).amount)`. Mitigation: validate at the boundary and pass only the validated value.
7. **Shared mutation or aliasing.** Failure: changing caller-owned or cached data surprises another observer. Materiality: require a named alias and wrong result; severity follows the impact. Unsafe: `function sortRows(rows){ return rows.sort(compare); }`. Safe: `function sortRows(rows){ return [...rows].sort(compare); }`. Mitigation: copy before mutation or make ownership transfer explicit.
8. **Leaked lifecycle work.** Failure: timers, listeners, subscriptions, or abortable work outlive their owner. Materiality: require a repeat/unmount/close path; severity follows leak/duplication. Unsafe: `socket.on("data", onData)` on every reconnect. Safe: `socket.off("data", onData); socket.on("data", onData)`. Mitigation: return idempotent cleanup for replacement, cancellation, and shutdown.

# False Positives

- Detached promises are safe when rejection/lifetime are contained; deliberate dual-package exports are safe when the shipped condition and binding are tested.
- Lexical-arrow `this`, nullish checks, `Object.hasOwn`, null-prototype maps, and validated keys avoid receiver/truthiness/prototype failures.
- Validated values, immutable copies, and idempotent cleanup are safe when they reach every consumer/owner transition.
- TypeScript-only compile-time concerns are outside this JavaScript runtime lens.

# Safe Patterns

- Preserve async ownership, package bindings, method receivers, exact checks, and own-property-safe containers.
- Validate before consumers, copy before mutation, and pair lifecycle setup with idempotent cleanup.
