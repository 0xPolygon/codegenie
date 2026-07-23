# codegenie fixture evals

This starter suite runs live review cases through the deterministic fake runner:

```bash
pnpm run dev eval --eval-dir evals/fixtures
```

The five cases cover the bundled core, tests, Go, TypeScript, and Rust lens ids. Fixture sources under `repos/` are tracked as plain files and materialized into temporary git worktrees under `logs/` for each run. The Rust fixture changes both a `CODEGENIE_FAKE_FINDING` carrier and a marker-free negative-control file; this proves fake-runner transport and anchoring only. Parser, symbol, likely-test, lens, and skill behavior is proved by structural tests rather than candidate expectations.
