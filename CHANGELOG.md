# Changelog

## 0.9.1

- **Breaking:** Remove `--depth` from CLI commands, `review.depth` from user and repository TOML and eval cases, and `depth` from GitHub Action inputs. Legacy provider `settings.json` files still load. Codegenie silently ignores `defaultDepth` and drops it on the next save. The `run.json` depth field still records `null`.
- Review local changes with `codegenie review --staged` (HEAD to index) or `codegenie review --uncommitted` (HEAD to tracked working tree). Both use local snapshots and disallow GitHub posting. Use `git add -N <path>` to include a new file in an uncommitted review.
- The GitHub Action accepts `stage-models` alongside `model` to set model and reasoning for plan, review, verify, and compose. Missing fields inherit the global selection. An authorized comment that selects a configured alias applies that alias to every stage.
- Public eval cases `go-11`, `pi-n2`, and `pi-n3` remain available for exploratory reviews and are excluded from clean-control and required-detection scoring in future comparisons.

## 0.9.0

- Reviews use one mode. The removed `--depth` and `review.depth` settings (`light`, `normal`, and `deep`) are accepted and ignored with a warning for one release; reviews use the former normal behavior and `run.json` records depth as null.
- The targeted Stage 8 follow-up was removed. The planner no longer skips eligible hunks.
- Published findings no longer include the original-assessments appendix. Composition sources retain the original assessments when telemetry is enabled; ordinary telemetry-off reviews do not retain them separately.
- Reports distinguish shown and omitted unresolved questions. Findings are grouped by severity and then ordered by file and line. Low-confidence findings admitted by the verified exception move to `summaryOnlyFindings` below the inline confidence floor; the floor is applied before inline-slot accounting.
- Streamed tool arguments are bounded. Stage 6 `degradedHunks` now counts real context loss and is not comparable across this change. Sliced context is recorded in the Stage 6 `pipeline_metrics` event rather than exposed as `slicedContextHunks` in the public budget summary.
- `final-review.json` can include `health.verificationCandidateCount`. The `human-attention-notes.json` artifact advances from schema version 3 to 4: always-empty legacy suppression and fallback fields are removed, while `keptForOutputGroupIds` remains.
- Bedrock Claude uses automatic tool choice. `forceSubmitToolChoice=false` also selects automatic choice for Bedrock models; other Bedrock models retain the named default.
- Advanced user-scoped `llm.stages` settings can override model and reasoning for plan, review, verify, and compose; run statistics include optional `stageModels` when used. Mixed-model quality is unmeasured and no model mix is recommended.
- Run retention only prunes authenticated, expired managed runs. A per-user HMAC seal from the run's configured home binds the resolved runs root, run ID, inode, and expiry. The live window is three times the greater of the effective per-run `maxTime` and 30 minutes (90-minute minimum; `--max-time` is honored). If the key path is in a Git worktree or is not a regular file, sealing and pruning are disabled with a warning. Unsealed legacy runs, runs using a different key, and runs whose resolved root changed are preserved and may require manual cleanup. Caller-selected artifact directories are not pruned; the prune event records the deletion count and a bounded name sample.
- Adaptive Stage 7 cache draws have separate cache identities, so cached supplemental reviews no longer reuse the primary draw.
- Invalid or inaccessible review targets now produce concise CLI usage errors instead of internal pipeline diagnostics.
- Provider credentials for reviews, evals and recommendation judging use the same resolved Codegenie home as configuration.
- Public eval labels and pins were corrected, and lexical matcher results require source adjudication.
