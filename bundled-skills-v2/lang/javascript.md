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

1. **Floating promises.** Look for: detached work rejects or completes out of order, losing a required result. Unsafe: `save(record); return accepted`. Safe: `await save(record); return accepted`.
2. **Module interop mismatch.** Look for: ESM/CommonJS disagreement yields a wrong binding or load error. Unsafe: `const parse=require("pkg").default; parse(x)` when its CJS export is `{parse}`. Safe: `const {parse}=require("pkg"); parse(x)`.
3. **Lost receiver.** Look for: extracting a method changes `this` and accesses wrong state. Unsafe: `const run = client.run; run()`. Safe: `const run = client.run.bind(client); run()`.
4. **Coercion or truthiness collapse.** Look for: a check conflates meaningful `0`, `false`, or `""` with absence. Unsafe: `const retries = input.retries || 3`. Safe: `const retries = input.retries ?? 3`.
5. **Unsafe property handling.** Look for: inherited or attacker keys alter lookup, authority, or prototypes. Unsafe: `target[userKey] = value`. Safe: `const target = Object.create(null); target[userKey] = value`.
6. **Unvalidated runtime boundary.** Look for: external data violates a sensitive consumer's assumptions. Unsafe: `charge(JSON.parse(body).amount)`. Safe: `charge(PaymentSchema.parse(JSON.parse(body)).amount)`.
7. **Shared mutation or aliasing.** Look for: changing caller-owned or cached data surprises another observer. Unsafe: `function sortRows(rows){ return rows.sort(compare); }`. Safe: `function sortRows(rows){ return [...rows].sort(compare); }`.
8. **Leaked lifecycle work.** Look for: timers, listeners, subscriptions, or abortable work outlive their owner. Unsafe: `socket.on("data", onData)` on every reconnect. Safe: `socket.off("data", onData); socket.on("data", onData)`.

# False Positives

- **Floating promises** — require reachable failure or ordering; severity follows the operation.
- **Module interop mismatch** — require shipped mode/export shape; severity follows impact.
- **Lost receiver** — require an observing call; severity follows state/result impact.
- **Coercion or truthiness collapse** — require reachable distinct states; severity follows the wrong branch.
- **Unsafe property handling** — require a key source and affected access; severity follows corruption.
- **Unvalidated runtime boundary** — require an untrusted field-to-failure trace; severity follows the effect.
- **Shared mutation or aliasing** — require a named alias and wrong result; severity follows the impact.
- **Leaked lifecycle work** — require a repeat/unmount/close path; severity follows leak/duplication.

- Detached promises are safe when rejection/lifetime are contained; deliberate dual-package exports are safe when the shipped condition and binding are tested.
- Lexical-arrow `this`, nullish checks, `Object.hasOwn`, null-prototype maps, and validated keys avoid receiver/truthiness/prototype failures.
- Validated values, immutable copies, and idempotent cleanup are safe when they reach every consumer/owner transition.
- TypeScript-only compile-time concerns are outside this JavaScript runtime lens.

# Safe Patterns

- Preserve async ownership, package bindings, method receivers, exact checks, and own-property-safe containers.
- Validate before consumers, copy before mutation, and pair lifecycle setup with idempotent cleanup.
