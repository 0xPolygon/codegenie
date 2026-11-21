---
repo: pi
case: pi-10
role: positive
intro: 7314819f0fe30fa616f32fa3a1fc8d1a856a1446
base: ed76cca69b136931fd93198b4d44f5c3b59e684c
introDate: 2026-10-23
fix: a7b94a03f09f20f4937fa1a76339014c60d261ad
kind: logic
severity: medium
contaminationSplit: post-2026-08-01
---

# pi pi-10

Review base `ed76cca69b136931fd93198b4d44f5c3b59e684c` (the parent) against head `7314819f0fe30fa616f32fa3a1fc8d1a856a1446`.

## Expectation `const-rewrite-corrupts-literal-data`

### Expected finding

`rewriteConstAsEnum` recurses into the value of every key of a schema object, but only some keywords hold subschemas. Others hold literal data (`default`, `examples`, `enum` values, and `const` itself when it is an object). An object inside that data that happens to have a `const` key is rewritten as if it were a schema, which changes the user's data. Separately, building the copy by assignment into `{}` mishandles a property named `__proto__`. Either half counts; the literal-data half is the main one.

### Anchor

packages/ai/src/api/google-shared.ts:385-388

### Severity floor

The matcher floor is low. Expected severity is medium; record it as a calibration note, not as a miss.

### Fixing evidence

a7b94a03f recurses only into schema-bearing keywords, copies with `Object.fromEntries`, and adds the test "rewrites only schema-bearing keywords" (closes #11308).
