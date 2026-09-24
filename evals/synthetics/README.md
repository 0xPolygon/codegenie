# Synthetic harness evals

Run `make evals` from the repository root. These deterministic scenarios use real
harness components with scripted model/GitHub boundaries: no credentials, network
requests, or paid inference. They also run under `pnpm test`.

The documentation comment suite simulates successive pushes through diff parsing,
publication, persisted comment markers, GitHub response parsing, and duplicate
matching. It checks shifted lines, changed anchor text, legacy comments, unrelated
issues on nearby and distant lines, different files, and capped comment bodies.
It also checks anchors supplied by the posting plan and makes the conservative
wording policy explicit: paraphrased findings remain eligible for posting.

The original PR #28 cases also live in `tests/pipeline-phase5.test.ts`: an unchanged
finding survives a seven-line shift at publication, while distinct same-category
findings in a document remain separate. The latter deliberately reverses PR #28's
file-wide merging tradeoff. Existing code fingerprint tests, including executable
examples under `docs/`, retain symbol-based identity.

These evaluate harness behavior, not whether a model identifies or phrases a
finding consistently. Use `codegenie eval --eval-dir ...` for live model comparisons.
Add additional `*.test.ts` scenarios here as harness failure patterns are found.
