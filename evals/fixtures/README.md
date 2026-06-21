# codegenie fixture evals

This starter suite runs live review cases through the deterministic fake runner:

```bash
pnpm run dev eval --eval-dir evals/fixtures
```

The cases cover the bundled core, tests, Go, and TypeScript lens ids. Fixture sources under `repos/` are tracked as plain files and materialized into temporary git worktrees under `logs/` for each run.
