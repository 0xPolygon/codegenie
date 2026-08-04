# Issue 105: Competitive Benchmark — Measuring codegenie Against Other Review Harnesses

Status: PENDING
Planned from: owner request 2026-07-26, prompted by `alibaba/open-code-review` leading its README with a published benchmark against Claude Code while codegenie has no external number at all.
Planned at: commit `702be66` (branch `master`)
Recommended priority: high, and independent of pipeline work. It changes no model-facing behavior, so it cannot muddy an in-flight A/B; it produces the evidence every other claim in the README currently rests on; and its per-loss-stage output doubles as a roadmap generator. Best run after Plan 92 and Plan 101 settle, so the measured configuration is one we intend to keep.

## Problem

codegenie's design document asserts four advantages — coverage honesty, independent verification, diagnosable quality, precision economics — and none of them has ever been measured against an alternative. The eval suite (`src/evals/`, `evals/fixtures/`) is a regression harness: eight fixture cases, mostly fake-runner transport proofs, scoring codegenie against its own expectations. It answers "did this change break recall?" It does not answer "is this better than the alternatives, and by how much?"

Two things make that gap costly right now.

First, the competitive landscape has a published number and we do not. `alibaba/open-code-review` opens its README with a benchmark over 50 repositories, 200 pull requests, 10 languages, and 1,505 ground-truth issues cross-validated by 80+ senior engineers, reporting higher precision and F1 than Claude Code at roughly one-ninth the tokens. Whatever its methodological weaknesses, it is the first thing a reader sees, and "we prefer no comments over weak comments" reads as marketing next to a chart.

Second, and more important internally: the central thesis is *falsifiable and untested*. The README says the value of a review tool is not "finds bugs" — frontier models do that for free — but the guarantees around the findings. If a single frontier model call over the whole diff matches an eleven-stage harness on real PRs, that thesis is wrong and we should know before building more machinery. No experiment currently in the repository can tell us.

## Goal

1. A reproducible benchmark that measures codegenie against named alternatives on real pull requests with real defects, reporting recall, precision, F1, wall-clock, tokens, and dollars.
2. Ground truth that does not depend on our judgment about what counts as a finding — because we are an interested party and a benchmark we adjudicate alone is worth very little.
3. A **naive-baseline control**: one frontier model call over the whole diff, same model, no harness. This is the scientifically load-bearing comparator, and no published review benchmark we are aware of includes one.
4. Variance reporting. Single-shot precision/recall numbers on LLM systems are noise-dominated; Plan 79 already established meaningful run-to-run recall variance in our own pipeline. Every number ships as mean ± spread over K repeats or it does not ship.
5. Loss-stage attribution for codegenie's misses, so a disappointing result names the stage to fix rather than just the score.
6. Publication: corpus, method, adapters, raw run artifacts, and a re-run command, such that a skeptic — including a competitor — can reproduce or refute the result.

## Study: what `open-code-review`'s benchmark does, and where it is weak

Primary source: `README.md` and `imgs/benchmark-en.png` at tip 25c3661, plus the pipeline in `internal/agent/agent.go` that the numbers describe.

What they did well, and we should match:

- **Real PRs from real repositories**, not synthetic bug injection. Synthetic corpora measure pattern matching, not review.
- **Scale across languages** (10), so the number is not a Go-and-TypeScript result dressed up as a general one.
- **Multi-annotator ground truth** with cross-validation, which is the expensive, correct thing to do.
- **Cost and latency reported alongside quality.** A review tool that wins on F1 at nine times the token spend has not obviously won, and they say so.
- **Stating the trade-off honestly**: their recall is lower than the general-purpose agent's, and they lead with that rather than hiding it. Our positioning is the same, so we must be equally direct.

Where it is weak, and where a better-designed benchmark differentiates us:

1. **Model confound.** The comparison is "Open Code Review vs Claude Code with the same underlying model," but OCR's default endpoints and Claude Code's model are not obviously matched across all cells, and the chart does not resolve it. Any harness-vs-harness comparison that lets the model vary is measuring the model.
2. **Self-adjudicated ground truth.** 1,505 issues annotated by engineers, but the annotators are associated with the tool's authors and the annotation was, as far as the public materials show, not blinded to tool identity. Pooled blind adjudication costs less and is far harder to dispute.
3. **No naive baseline.** Without "one model call, whole diff," the benchmark cannot separate harness value from model value — which is precisely the question a reader is asking.
4. **Single-shot numbers.** No variance, no repeats, no confidence intervals. For a stochastic system this is the most serious methodological gap.
5. **Not reproducible.** The corpus, prompts, adapters, and raw runs are not published; the number cannot be checked.

Our benchmark should be *smaller than theirs and more credible than theirs.* Sixty well-chosen PRs with objective recall ground truth, pooled blind precision, a naive baseline, matched models, and published artifacts is a stronger claim than 200 PRs with none of those properties.

## Design

### 1. Two-track ground truth

Human annotation at OCR's scale is not available to us, and self-annotation is not credible. Split the two metrics and use a different, cheaper, more defensible source for each.

**Track A — recall, from bug-fix archaeology (objective).**

Select pull requests that *introduced* a defect which a later, identifiable commit *fixed*. The fix commit gives the ground truth for free: the defect's location (files and lines in the introducing PR), its nature (the fix diff and message), and independent confirmation that it was real (a human found it in production or in later review, without any tool's involvement).

Selection is mechanical and auditable via the GitHub API: a fix commit or PR that references an issue, reverts a prior PR, or is described as fixing behavior introduced by a PR merged within a bounded window; then a manual pass to discard cases where the defect is not visible in the introducing diff (dependency bumps, environment failures, spec changes). Every case records the introducing PR SHA, the fix SHA, and the reasoning, so the selection is reviewable.

This track measures **recall only**. A tool that reports a bug the fixer never noticed is not wrong — it just is not scored here. That asymmetry is deliberate and must be stated in the published method.

**Track B — precision, by pooled blind adjudication (standard IR practice).**

Run every tool over the Track A corpus. Pool the union of all findings from all tools. Strip tool identity, normalize wording (the fingerprinting work from Plan 83 is directly reusable), deduplicate across tools, and adjudicate the pool once: is this a real defect in this diff — yes, no, or unclear.

Adjudication is a frontier-model panel with **mandatory human adjudication of all disagreements and a random human-audited sample of the agreements**, with inter-rater agreement published. Pool size scales with what tools actually report — on the order of a few hundred items for a 60-PR corpus — which is affordable in a way that annotating every PR exhaustively is not.

Pooling is what makes this fair: each tool's precision is computed over the same adjudicated pool, and no tool's findings get a easier judge. It is also what makes it defensible: we never decide in advance what "should" be found.

### 2. Comparators, and the model-fairness rule

| Comparator | Why it is in |
|---|---|
| **codegenie** | The subject. |
| **Naive baseline: one call, whole diff, structured output** | Isolates harness value from model value. The single most important cell in the table. |
| **Claude Code with a code-review skill** | The general-purpose-agent baseline; also OCR's comparator, so results are loosely commensurable. |
| **`ocr review`** | The closest architectural peer: deterministic-engineering-plus-agent, per-file unit, published benchmark. |

**Model-fairness rule, non-negotiable:** every comparator runs on the same underlying model at the same reasoning level wherever the tool permits configuration. Where a tool cannot be pointed at the matched model, that cell is reported separately and labelled as a model-confounded result, never averaged into the headline. A benchmark that lets the model float is a model benchmark wearing a harness costume, and it is the exact flaw we are criticizing in §Study.

Explicitly out for v1: commercial services (Greptile, CodeRabbit, Copilot review). Terms of service, non-configurable models, and no local reproduction make them incompatible with every property above. Note them as a future track that would have to be reported as model-confounded.

### 3. Metrics

Per tool, per repeat, per case:

- **Recall** over Track A ground truth: did the tool report *this* defect, anchored within tolerance.
- **Precision** over the Track B adjudicated pool.
- **F1**, derived, reported with both inputs visible so it cannot hide a lopsided trade.
- **Findings volume** — the noise number. Precision alone rewards a tool that reports one thing.
- **Wall-clock**, **total tokens**, **dollars** at published list prices on the run date.
- **codegenie only: loss stage** for every missed Track A defect — not generated, killed at verification, deduped, or capped. This is the diagnostic asset the other tools cannot produce about themselves, and the reason the benchmark pays for itself internally even if the headline number disappoints.

Every metric is reported as mean ± spread over **K = 3** repeats minimum, with the per-repeat values published. A tool whose recall swings 40% between runs has a materially different product than its mean suggests, and readers deserve to see it.

### 4. Matching: tool-agnostic, adjudicated, auditable

Cross-tool matching cannot use codegenie's schema, or codegenie wins by construction. Normalize every tool's output into:

```
BenchmarkFinding { tool, caseId, path, line?, endLine?, severity?, category?, title, body }
```

A finding matches a Track A defect when the path matches and the line falls within a tolerance window of the fix's changed lines **and** an adjudicator agrees the finding describes that defect. Positional overlap alone produces false credit — two different problems on the same line are common. The adjudicator is the same blinded panel from §1, and the human-audited sample covers matching decisions as well as pool adjudication.

Tolerance, panel composition, and audit sample size are fixed **before** any comparator runs and recorded in the pre-registration (§6). Tuning a tolerance after seeing results is how benchmarks become press releases.

### 5. Corpus shape and scale for v1

- **60 pull requests, 10 repositories, 6 languages** — Go, TypeScript, JavaScript, Rust, Python, Solidity, matching codegenie's first-class language set. A seventh "unsupported language" slice (Java or Ruby, exercising the `GenericAdapter` fallback) is a stretch goal; if included it is reported separately, because it measures a different thing.
- Permissively licensed public repositories. The corpus stores **references only** — repo URL, introducing SHA, fix SHA, defect description — never vendored source. Reproduction clones at the pinned SHA.
- Selection criteria and every rejected candidate with its rejection reason are committed. A corpus whose exclusions are invisible is not auditable.
- Cost envelope: roughly 60 cases × 4 comparators × 3 repeats ≈ 720 reviews. At a plausible $0.50–$3.00 per review this is a $400–$2,000 sweep, plus adjudication. Budget is a stop condition (§Stop Conditions), and a `--sample` flag supports cheap partial sweeps during development.

### 6. Honesty protocol

These are binding, not aspirational, and they are the difference between a benchmark and an advertisement:

1. **Pre-register.** Corpus, comparators, metrics, matching tolerance, repeat count, and adjudication procedure are committed to the repository *before* any comparator run. The commit hash is cited in the published result.
2. **Publish losses.** Every configuration run is published, including ones where codegenie places second or worse. No cell is dropped after the fact.
3. **Disclose authorship.** The published document states plainly that codegenie's authors built the benchmark, names the specific bias controls (blinding, pooling, pre-registration, matched models, published artifacts), and links the raw runs.
4. **Version everything.** Tool versions, model ids, reasoning levels, prices, and dates are recorded per run. A benchmark without them expires silently.
5. **Invite refutation.** Ship the re-run command and a documented path to add a comparator. If someone reruns it and gets a different answer, that is the system working.

### 7. Relationship to the existing eval harness

Reuse, do not fork:

- `EvalCase.repo.external` and `command.pr` already express "review this PR in this external repository" — the corpus is expressible as eval cases.
- `repeat` + `aggregateRepeatScores` (Plan 79) already implement multi-run aggregation and variance.
- `attributeLoss` already produces per-loss-stage attribution.
- Fingerprint normalization (Plan 83) is reused for cross-tool dedup in the pool.

What is genuinely new, and belongs in `src/bench/` rather than `src/evals/`: comparator adapters, the normalized cross-tool finding schema, pooled adjudication, cross-tool matching, cost/latency accounting, and report rendering. The line is that `src/evals/` scores codegenie against expectations, `src/bench/` scores *tools* against *adjudicated ground truth*. Blurring them would make the regression suite depend on network access and paid comparator runs, which would be a serious mistake.

## Non-Goals

- **Continuous benchmarking in CI.** This is a periodic campaign — on releases and on major pipeline changes — not a per-commit gate. Paid comparator runs in CI is not a thing we are building.
- **Benchmarking commercial services** in v1 (§2).
- **A leaderboard or a hosted site.** A markdown document plus raw artifacts in the repository.
- **Optimizing codegenie against the corpus.** The corpus is a measurement instrument. Tuning prompts or skills to score on it destroys it; if the benchmark reveals a real weakness, the fix is validated on the *eval* suite and the corpus is refreshed before the next published sweep.
- **Synthetic or injected bugs.** They measure a different, easier task.
- **Settling "is codegenie better than Claude Code at coding."** The scope is diff review on the corpus, and the published document says so.

## In-Scope Files

- `src/bench/` (new): `corpus.ts` (case loading and SHA pinning), `adapters/` (one per comparator: `codegenie.ts`, `naive.ts`, `claude-code.ts`, `ocr.ts`), `normalize.ts` (the `BenchmarkFinding` schema), `pool.ts` (cross-tool dedup and pool construction), `adjudicate.ts` (panel + human-audit interface), `match.ts`, `score.ts`, `cost.ts`, `report.ts`, `bench-command.ts`.
- `src/cli/main.ts` — subcommand dispatch line only.
- `bench/` (new, data): `corpus/*.yml` (references only), `PREREGISTRATION.md`, `SELECTION.md` (criteria, accepted and rejected candidates with reasons), `runs/` (raw artifacts, gitignored during development, published per sweep).
- `src/evals/` — **imports only**, no behavior change. `attributeLoss`, `aggregateRepeatScores`, and fingerprint normalization are consumed as-is. If any of them needs to change to serve the benchmark, that is an amendment, because the regression suite must not shift under a measurement campaign.
- `BENCHMARK.md` (new, repo root) — the published result. Linked from README once a sweep completes, and not before.
- `specs/project/components/evals.md` — a section distinguishing the regression harness from the benchmark harness, and the honesty protocol.

## Implementation Steps

1. **Corpus first, before any code that could bias it.** Build the Track A selection tooling, assemble and hand-verify 60 cases, write `SELECTION.md` with accepted and rejected candidates. This is the long pole and the part that cannot be rushed.
2. `PREREGISTRATION.md` — metrics, tolerance, repeats, panel, adjudication, comparators, model-matching rule. Commit before step 4.
3. `normalize.ts` + the codegenie and naive-baseline adapters; the naive baseline is a small module (whole diff → one structured call → normalized findings) and must be genuinely fair — same model, same reasoning, a competent review prompt, no strawman.
4. Matching, pooling, and adjudication over a **10-case pilot** with all four comparators. Measure human/panel agreement, sanity-check tolerance, confirm cost per case. Adjust method only here, and record every adjustment in the pre-registration before the full sweep.
5. Remaining adapters (Claude Code, `ocr`), each pinned to a version and configured onto the matched model.
6. Full sweep at K=3. Publish raw artifacts.
7. `report.ts` + `BENCHMARK.md`: results, method, limitations, per-loss-stage attribution for codegenie's misses, re-run instructions.
8. Convert the loss-stage attribution into concrete follow-up plans. This step is the internal payoff and is not optional.

## Validation

- **Ground-truth integrity.** Every Track A case is independently re-verified by a second reader: the defect is genuinely visible in the introducing diff, and the fix genuinely addresses it. Cases that fail are removed, and the removal is recorded.
- **Adapter fidelity.** Each adapter is tested against a captured tool output fixture, proving normalization loses no finding and invents none. An adapter that silently drops findings would fabricate a precision advantage.
- **Matcher agreement.** Published inter-rater agreement between the panel and the human auditor on the audited sample. Below a pre-registered threshold, the matching procedure is revised and the sweep re-run — not shipped with a caveat.
- **Blinding integrity.** A test proving pooled items carry no tool-identifying markers: no tool name, no schema-specific field, no characteristic formatting. This is easy to get wrong and fatal to the result.
- **Reproducibility.** A third party following `BENCHMARK.md` reproduces the codegenie and naive-baseline cells within the published variance band, from a clean checkout.
- **Cost accounting.** Reported dollars reconcile against provider billing for the sweep window, within a stated tolerance.

## Done Criteria

- `BENCHMARK.md` publishes recall, precision, F1, volume, wall-clock, tokens, and dollars for four comparators over 60 real PRs at K=3, with variance, matched models, and a documented method.
- The naive-baseline cell is present and honestly configured, and the document states directly what it implies about harness value — including if it implies less than we hoped.
- codegenie's misses are attributed by loss stage, and at least one follow-up plan is opened from the result.
- Corpus, adapters, pre-registration, and raw runs are in the repository; the re-run command works from a clean checkout.
- The eval regression suite is unchanged: `pnpm test` neither slows down nor acquires a network or paid dependency.

## Stop Conditions

- **If Track A yields fewer than ~40 usable cases** after selection, stop and reconsider the ground-truth source before spending on comparator runs. A thin corpus produces a number too noisy to publish, and publishing it anyway is worse than publishing nothing.
- **If the pilot's panel/human agreement is poor**, stop and fix adjudication. Every downstream number inherits that error, and no amount of scale repairs it.
- **If a comparator cannot be pointed at the matched model**, report it separately as model-confounded or drop it. Do not average it into the headline.
- **If the sweep exceeds its budget envelope**, cut repeats before cutting cases — corpus breadth matters more than K — and say so in the method.
- **If codegenie loses**, publish anyway and convert the result into a fix list. Suppressing or delaying a losing result would poison the eval culture that is the actual compounding asset here, and would make every future number we publish worthless.
- **If anyone proposes tuning prompts, skills, or budgets against corpus results before publication**, stop: that converts the instrument into a training set and the benchmark into marketing.
