# Language-skill semantic evals

These marker-free fixtures isolate one retained check in each language. They are separate from `evals/fixtures`, whose fake runner proves transport only.

Deterministic contract (versions recorded on 2026-07-24):

- TypeScript: Node `v26.5.0`, TypeScript `7.0.2`; base builds and both tests pass, feature builds, `dist/safe-config.test.js` passes, and `dist/config.test.js` fails with `malformed config reached runtime consumer`.
- Python: CPython `3.13.14`; base compiles and both tests pass, feature compiles, the safe-control test passes, and the positive test fails because a mutable default retains the first call's state.
- Solidity: Foundry `1.7.1-dev`; base builds and both tests pass, feature builds, the safe-control test passes, and the positive test fails because stale oracle data is accepted.

The focused Vitest gate materializes base plus feature overlays and proves those commands. Run it with:

```bash
pnpm exec vitest run tests/skill-semantic-fixtures.test.ts
```

The three YAML cases pre-register three uncached draws on `anthropic/claude-sonnet-4-6:high`, matching the existing owner-smoke primary arm. They must not be run until the owner explicitly authorizes the paid comparison. Run current-skill baselines from the provenance-foundation ref, then run an isolated one-skill candidate from the same fixture commits and settings. A split result requires the pre-registered extension described in Plan 101.

These synthetic cases do not satisfy the open second-language, second-real-repository diversity guard.
