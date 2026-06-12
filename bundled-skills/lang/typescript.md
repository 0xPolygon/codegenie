---
id: lang/typescript
title: TypeScript correctness
lenses: ["lang/typescript"]
languages: ["typescript", "tsx", "javascript"]
categories: ["correctness", "async", "typing"]
enabledByDefault: true
---

# Purpose

Find TypeScript and JavaScript bugs around async behavior, erased type safety, mutation, and runtime contracts.

# Checks

- Floating promises: async calls not awaited, returned, intentionally detached, or handled with `.catch`.
- `any` and unsafe casts: casts that erase important validation, widen untrusted data, or bypass discriminated unions.
- Non-null assertions: `!` hiding a real nullable path from config, I/O, DOM, map lookup, or optional input.
- Exhaustiveness: switches or unions missing a case, defaults that hide new variants, and impossible states reaching runtime.
- Async error handling: unhandled rejections, lost stack/context, Promise.all failure behavior, and cleanup skipped after rejected awaits.
- Equality and coercion: loose comparisons, truthiness checks that confuse empty strings/zero/false, and Date/string/number coercion.
- Shared mutation: mutating arrays/objects passed by caller, cached config objects, React state, or module-level values.
- Runtime validation: trusting JSON, environment variables, CLI input, or model output without schema validation.

# False Positives

- Do not flag `void somePromise()` when surrounding code clearly uses that as an intentional detached-task marker with error handling inside the task.
- Do not object to narrow casts immediately after a trustworthy runtime validator.
- Do not demand exhaustive checks for open string sets that intentionally accept unknown future values.

# Safe Patterns

- Schema validation before using unknown data is safe when the validated value, not the raw value, flows forward.
- `Promise.allSettled` is appropriate when partial failure is deliberately handled.
- Immutable copies before mutation protect callers and cached state.
- Exhaustive `never` checks make union growth visible at compile time.

# Examples

- `fetchThing(); return ok;` can report success before the async work fails.
- `const parsed = data as Config` is unsafe when `data` comes from disk or a model.
- `value!` is risky when `value` comes from `map.get` and no presence check guards it.
