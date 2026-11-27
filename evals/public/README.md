# Public regression evals

Each directory under `evals/public/<repo>/` is a single eval suite. Its `eval.yml` pins the buggy change as `command.head` and its parent as `command.base`. Its `oracle.md` records the label, source anchors, severity and fixing evidence. Negative controls use the same layout and record the evidence for expecting no defect. Pi's oracles also tag whether the introducing commit predates 2026-08-01 for the contamination split.

## Prepare an isolated checkout

The eval runner requires a local Git worktree. Fetch the head and its parent into a fresh directory outside the codegenie checkout. Keep all manifests, oracles, and run artifacts in the eval workspace. The commands below prepare one goinfer case from the codegenie root. For cases that live on a pull request ref, follow the fetch instructions in the corresponding repository directory.

```sh
(
  set -eu
  case_dir=evals/public/goinfer/go-01
  url=https://github.com/townsendmerino/goinfer.git
  target="$HOME/.cache/codegenie/public-evals/${case_dir#evals/public/}"
  base=$(awk '$1 == "base:" { print $2; exit }' "$case_dir/eval.yml")
  head=$(awk '$1 == "head:" { print $2; exit }' "$case_dir/eval.yml")
  test "${#base}" -eq 40 && test "${#head}" -eq 40 || exit 1

  mkdir -p "$(dirname "$target")"
  mkdir "$target"
  git init --quiet "$target"
  git -C "$target" fetch --no-tags --depth=2 "$url" "$head"
  git -C "$target" -c advice.detachedHead=false checkout --quiet --detach "$head"
  test "$(git -C "$target" rev-parse HEAD^)" = "$base"
  test -z "$(git -C "$target" status --porcelain)"
)
```

This leaves the fixing revision out of the target history and keeps the working tree at the introducing revision. Keep the target clean when reusing it. If the target directory already exists, verify its head, parent and working tree before using it.

## Run with full telemetry

Start live reviews only after the campaign is approved. Use the same pinned provider, model and reasoning for every arm that compares runner versions. Each manifest enables verification and debug traces and disables the local model-call cache.

Set all three telemetry values in `config.toml` in the runner's `CODEGENIE_HOME` (`~/.codegenie` by default). Use this configuration for every arm, including installed releases.

```toml
[telemetry]
enabled = true
debugTrace = true
logLevel = "debug"
```

For an approved slot, run the chosen binary with `codegenie eval --eval-dir evals/public/goinfer/go-01 --no-cache` from the eval workspace. The runner captures the full run under the case's `logs/<n>/telemetry/` with the default log directory. Keep each slot's run directory, including its model-call ledger, debug prompts and responses, tool calls, stage events and timings, coverage, candidates, verdicts, and composition sources. Keep failed and partial slots with their diagnostics and usage.

## Adjudicate against the source

Treat the matchers as a pre-filter. Negated descriptions can still match lexical patterns. Source adjudication decides whether a finding counts. Check matches and misses against the pinned diff, repository context and oracle. For negative controls, adjudicate each medium-or-higher published claim against the pinned source and contract. Review other reported findings as well. Check each claim against the base, head and applicable contract, including whether the change introduces the behavior or makes it newly reachable.

Select `role: negative-control` for the clean-control denominator. Cases marked `role: contaminated-control` contain an introduced defect or contract gap. They have no scored expectations and stay outside both the clean-control and required-detection denominators. Cases marked `role: compatibility-question` have a source-grounded compatibility question in the oracle and no scored finding expectations. Report question credit separately from required detections and clean controls. Freeze those selections with the campaign inputs.

For comparisons, track where each adjudicated defect first appears and where it is lost or downgraded. Compare Stage 5 planning, Stage 6 packets, Stage 7 packet review, Stage 9 verification and Stage 10 composition across arms. Report calls, tokens, elapsed time and cost per stage, along with errors, repairs, timeouts, degraded tools and budget stops. Cite aggregate evidence for hardening and simplification proposals. Have two analysts using different models write independent assessments before the operator reconciles them, and record their disagreements.


### Clean-control adjudication

For each published medium-or-higher claim on a negative control, distinguish `wholly_false` (refuted by source or contract), `introduced_real_defect` (an evidenced introduced or newly reachable defect), and `policy_or_reachability` (an observable concern whose contract or reachability remains in question). Use `unresolved` with the missing evidence when the sources needed to decide are unavailable. Keep untracked real defects; add them as optional known causes or reclassify a contaminated control before the next campaign.

Before admitting a negative control, an analyst who has not seen its proposed role or oracle examines the pinned change in a mixed unlabelled queue; a different curator verifies any finding and freezes the role. Bind the audit scope and the revised oracle to the campaign. This does not prove absence outside the inspected scope. A `should_not_find` sentinel is a specific proposition adjudicated against source, not a lexical ban on a nearby real defect. Historical decisions remain unchanged when a later rule is used for a separately labelled counterfactual re-score.
