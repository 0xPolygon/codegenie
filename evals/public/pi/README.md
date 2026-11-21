# pi public eval cases

Each `<case>/eval.yml` reviews a pinned base and head. The case's `oracle.md` holds the expected finding, anchor, severity notes and fixing evidence. Both stay in this repository; the reviewed checkout lives elsewhere, at `~/.cache/codegenie/public-evals/pi/<case>`. That checkout is a detached, depth-2 clone of the pinned head and its parent, so the oracle and any later fix commit are not in it.

## Setup

```bash
evals/public/pi/setup.sh   # fetches every case; re-running skips ready checkouts
```

Cases come from https://github.com/earendil-works/pi. `oracle.md` front matter carries `contaminationSplit`: `pre-2026-08-01` marks a change that may predate a model's training data. `pi-04` is a spare (`role: spare`) and is excluded from the default set.

## Runner settings (owner directive: full debug telemetry on every eval run)

Each case sets `review.debug: true`, which turns on `telemetry.debugTrace`, and sets `review.verify: true` and `review.cache: false`. The eval case schema cannot set the log level, so the runner's `$CODEGENIE_HOME/config.toml` must also contain:

```toml
[telemetry]
enabled = true
logLevel = "debug"
debugTrace = true
```

The comparison config pins provider, model, reasoning and depth. Keep every per-run artifact under the case's `logs/`, which is not committed. Never pass `--post-github-comments`.

## Scoring

The matchers are deliberately conservative pre-filters: path, line range where the defect has one clear site, and a severity floor of `low`. They are not the verdict, because lexical matching was shown to be unreliable (#127). Adjudicate every published finding against the pinned source and `oracle.md`:
- **Expected severity:** a detection rated below the oracle's expected severity is a calibration note, not a miss.
- **Optional expectations:** `tier: optional` marks a second anchor for the same defect. Count a hit on either anchor as one detection.
- **Negative controls:** `role: negative-control` cases carry a `should_not_find` on the changed source at medium severity or higher. Adjudicate any hit before counting it as a false positive.
