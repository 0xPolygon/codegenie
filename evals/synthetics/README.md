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

The text-tool investigation suite uses temporary committed Git repositories and
production tool schemas, wrappers and Git grep. It covers `.ridl` and arbitrary
unsupported formats: small outlines, locating a late section in a large file,
exact bounded reads, base/head isolation from dirty files, POSIX regexes, shared
glob semantics, invalid-query correction, text-only mentions, and bounded result
packing followed by exact source reads. Boundary cases (missing/fractional bounds,
EOF, empty/missing files, UTF-8, CRLF and truncation) live in
`tests/text-tool-contracts.test.ts`; runner tests verify invalid arguments do not
consume source-call slots or masquerade as provider failures.

These evaluate harness behavior, not whether a model identifies or phrases a
finding consistently. Use `codegenie eval --eval-dir ...` for live model comparisons.
Add additional `*.test.ts` scenarios here as harness failure patterns are found.
