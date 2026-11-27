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

1. **Floating promises.** Failure: detached work rejects or completes out of order, losing a required result. Unsafe: `save(record); return accepted`. Safe: `await save(record); return accepted`.
2. **Module interop mismatch.** Failure: ESM/CommonJS disagreement yields a wrong binding or load error. Unsafe: `const parse=require("pkg").default; parse(x)` when its CJS export is `{parse}`. Safe: `const {parse}=require("pkg"); parse(x)`.
3. **Lost receiver.** Failure: extracting a method changes `this` and accesses wrong state. Unsafe: `const run = client.run; run()`. Safe: `const run = client.run.bind(client); run()`.
4. **Coercion or truthiness collapse.** Failure: a check conflates meaningful `0`, `false`, or `""` with absence. Unsafe: `const retries = input.retries || 3`. Safe: `const retries = input.retries ?? 3`.
5. **Unsafe property handling.** Failure: inherited or attacker keys alter lookup, authority, or prototypes. Unsafe: `target[userKey] = value`. Safe: `const target = Object.create(null); target[userKey] = value`.
6. **Unvalidated runtime boundary.** Failure: external data violates a sensitive consumer's assumptions. Unsafe: `charge(JSON.parse(body).amount)`. Safe: `charge(PaymentSchema.parse(JSON.parse(body)).amount)`.
7. **Shared mutation or aliasing.** Failure: changing caller-owned or cached data surprises another observer. Unsafe: `function sortRows(rows){ return rows.sort(compare); }`. Safe: `function sortRows(rows){ return [...rows].sort(compare); }`.
8. **Leaked lifecycle work.** Failure: timers, listeners, subscriptions, or abortable work outlive their owner. Unsafe: `socket.on("data", onData)` on every reconnect. Safe: `socket.off("data", onData); socket.on("data", onData)`.

# False Positives

- Detached promises are safe when rejection/lifetime are contained; deliberate dual-package exports are safe when the shipped condition and binding are tested.
- Lexical-arrow `this`, nullish checks, `Object.hasOwn`, null-prototype maps, and validated keys avoid receiver/truthiness/prototype failures.
- Validated values, immutable copies, and idempotent cleanup are safe when they reach every consumer/owner transition.
- TypeScript-only compile-time concerns are outside this JavaScript runtime lens.

# Safe Patterns

- Preserve async ownership, package bindings, method receivers, exact checks, and own-property-safe containers.
- Validate before consumers, copy before mutation, and pair lifecycle setup with idempotent cleanup.
