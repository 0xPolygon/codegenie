# codegenie fixture evals

This starter suite runs live review cases through the deterministic fake runner:

```bash
pnpm run dev eval --eval-dir evals/fixtures
```

The seven cases cover the bundled core, tests, Go, TypeScript, Rust, Python, and Solidity lens ids. Fixture sources under `repos/` are tracked as plain files and materialized into temporary git worktrees under `logs/` for each run. The Rust, Python, and Solidity fixtures each change both a `CODEGENIE_FAKE_FINDING` carrier and a marker-free negative-control file; this proves fake-runner transport and anchoring only. The Rust fixture is also a buildable Cargo library: its base wires `positive_marker` and the unchanged `positive_test` module, while its feature additionally wires the negative-control module and changes the fallback into a reachable `unwrap`. This lets the separately pinned real-model owner smoke reproduce a passing base test and failing feature test. Parser, symbol, likely-test, lens, and skill behavior remains owned by structural tests rather than fake candidate expectations.
