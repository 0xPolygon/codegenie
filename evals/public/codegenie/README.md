# codegenie public eval cases

Each `<case>/eval.yml` reviews a pinned base and head. The case's `oracle.md` holds the expected finding, anchor, severity notes and fixing evidence. Both stay in this repository; the reviewed checkout lives elsewhere, at `~/.cache/codegenie/public-evals/codegenie/<case>`. That checkout is a detached, depth-2 clone of the pinned head and its parent, so the oracle and any later fix commit are not in it.

## Setup

```bash
evals/public/codegenie/setup.sh   # fetches every case; re-running skips ready checkouts
```

Every codegenie case head lives only on `refs/pull/<N>/head`, because those PRs were squash-merged. GitHub serves PR-reachable commits by SHA, so `setup.sh` fetches the pinned SHA directly. It falls back to `refs/pull/<pr>/head` (the `pr:` field in `oracle.md`) if the direct fetch is refused.

`cg-10` is the public TypeScript case already used in #112 and #128, with a second expectation added (the primitive composer rejection). `cg-n3` is a weak negative control because it changes only three source lines.

## Runner settings (owner directive: full debug telemetry on every eval run)

Each case sets `review.debug: true`, which turns on `telemetry.debugTrace`, and sets `review.verify: true` and `review.cache: false`. The eval case schema cannot set the log level, so the runner's `$CODEGENIE_HOME/config.toml` must also contain:

```toml
[telemetry]
enabled = true
logLevel = "debug"
debugTrace = true
```

The comparison config pins provider, model and reasoning. Keep every per-run artifact under the case's `logs/`, which is not committed. Never pass `--post-github-comments`.

## Scoring

The matchers are deliberately conservative pre-filters: path, line range where the defect has one clear site, and a severity floor of `low`. They are not the verdict, because lexical matching was shown to be unreliable (#127). Adjudicate every published finding against the pinned source and `oracle.md`:
- **Expected severity:** a detection rated below the oracle's expected severity is a calibration note, not a miss.
- **Optional expectations:** `tier: optional` marks a second anchor for the same defect. Count a hit on either anchor as one detection.
- **Negative controls:** `role: negative-control` cases carry a `should_not_find` on the changed source at medium severity or higher. Adjudicate any hit before counting it as a false positive.
