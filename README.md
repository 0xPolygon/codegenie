# codegenie 🧞

**High-signal AI code review for pull requests.** codegenie is a TypeScript CLI that reviews PR-style diffs at a staff-engineer level — real bugs, logic errors, security issues, architectural risks, and missing tests — and refuses to waste your attention on nitpicks. It prefers no comments over weak comments.

It is not a chatbot pointed at a diff. It is a **code review harness**: a staged pipeline where deterministic code owns the guarantees (coverage, anchoring, verification, dedup, budgets, telemetry) and LLM agents do the judgment work inside each stage.

## Install

```bash
npm install -g @0xsequence/codegenie   # or: bun install -g @0xsequence/codegenie
```

Or run without installing: `npx @0xsequence/codegenie --help`

> Note: the npm package will move out of the `@0xsequence` scope in the future.

## Quick start

```bash
# 1. Connect a model provider (pick one)
codegenie provider login anthropic --api-key   # Anthropic API key
codegenie provider login openai-codex          # ChatGPT plan (browser OAuth)
codegenie provider login openai --api-key      # OpenAI API key

# 2. Pick your default model (fuzzy-matched)
codegenie provider use opus       # -> anthropic/claude-opus-4-8
codegenie provider use gpt-5.5    # -> openai-codex/gpt-5.5

# 3. Review your current branch
codegenie review
```

The report prints to stdout as Markdown. A review with findings is a *successful* review: the exit code is `0` either way.

## Reviewing

```bash
codegenie review                            # current branch vs its base (merge-base semantics)
codegenie review --pr 123                   # a GitHub PR — no checkout needed, fork PRs included
codegenie review feat                       # branch vs resolved base
codegenie review --branch feat --base main
codegenie review master...49f4645b          # shorthand for --base master --head 49f4645b
codegenie review abc1234                    # one commit
codegenie review abc1234 def5678            # a commit range
```

A single positional target is branch-first: if it resolves as a branch, codegenie reviews it against its base; otherwise it is treated as a single commit.

Common options:

```bash
codegenie review --depth light|normal|deep         # review budget & planner bias
codegenie review --lens lang/go --lens core/tests  # restrict lenses for this run
codegenie review --provider anthropic --model claude-opus-4-8   # one-run model override
codegenie review --reasoning high                  # low | medium | high | xhigh | auto
codegenie review --format json                     # machine-readable review object
codegenie review --pr 123 --post-github-comments   # publish inline comments (explicit flag, never config)
```

Posting to GitHub is a single `COMMENT`-type review with inline comments anchored to changed lines — it never approves or requests changes, and only happens when you pass the flag. Interactive runs show a stderr progress spinner (auto-disabled in CI; `--no-progress` disables it explicitly); the report itself always goes to stdout.

## Providers and models

```bash
codegenie provider list                  # known providers and auth status
codegenie provider login <provider>      # OAuth by default; --api-key to store a key
codegenie provider models [query]        # list available models (e.g. `models gpt`)
codegenie provider use <model>           # set the default by fuzzy model id
```

`provider use` fuzzy-matches: `use opus`, `use sonnet`, `use gpt-5.5` all resolve to a concrete provider/model pair and print what they picked. Credentials and defaults live under `~/.codegenie/`, never in the repository. Supported lanes include Anthropic (API key) and OpenAI via both the API and ChatGPT-plan Codex OAuth — all on each provider's current APIs.

## Configuration

Drop a `codegenie.toml` in your repo root. Everything has sensible defaults; a typical config is small:

```toml
[git]
baseBranch = "main"

[review]
depth = "normal"
budgetBoost = 1.0   # scales per-packet review budgets; does not change finding caps

[telemetry]
enabled = true      # opt into local run artifacts under .codegenie/runs

[[classification.pathRules]]
pattern = "lib/payments/**"
reviewPriority = "critical"
labels = ["payments"]

[[classification.pathRules]]
pattern = "generated/**"
processingMode = "skip"
```

- **Telemetry is off by default.** Repo config may only set `telemetry.enabled`; user-level `~/.codegenie/config.toml` can also set run directory, log level, and retention.
- **Skills travel with the repo.** Teams can version project-specific review expertise as Markdown skills in `.codegenie/skills/` — concrete checks, false-positive rules, and safe patterns.
- **Budgets are dispatch controls, not mid-call interrupts.** Crossing a soft cap lets in-flight work finish, records the overrun, and stops dispatching non-essential work.

## How a review runs

Eleven stages; each is a telemetry and artifact boundary. Deterministic stages (1–4, 6, 11) parse and filter the diff, classify files, index symbols with Tree-sitter, build focused review packets, and publish — no LLM calls. The model stages:

- **Stage 5 — Plan.** One planner call decides intent framing, per-hunk coverage depth, and lenses. It doesn't hunt bugs.
- **Stage 7 — Review.** Parallel packet reviewers examine hunks with read-only repo tools (`read_symbol`, `find_definition`, `search_files`, …) and return candidate findings, uncertainties, and follow-up hints.
- **Stage 8 — Follow up (usually skipped).** Runs only when multiple packets independently raise the same scoped question.
- **Stage 9 — Verify.** Every surviving candidate is independently re-examined in a fresh context that never saw the reviewer's reasoning.
- **Stage 10 — Compose.** One call dedupes, ranks, caps, and phrases the final review, with deterministic validation and fallback.

The unit of review is the changed hunk; the unit of understanding is the affected system. Reviewers don't get the repository dumped into context — they get a compact packet (changed lines, enclosing symbol, file outline, likely tests, bounded related context) plus tools to pull exactly what a concern depends on.

## Design and philosophy

**Judgment in the model, invariants in the harness.** codegenie has four primary LLM decision points — planner, reviewer, verifier, composer — and everything else is deterministic plumbing. A fully autonomous agent is one decision point making hundreds of unauditable micro-decisions; we'd rather have a few auditable ones. The value of a review tool isn't "finds bugs" (frontier models do that for free) — it's the guarantees around the findings:

- **Coverage honesty.** Every hunk gets a decision or a disclosed skip reason. An autonomous agent cannot tell you what it *didn't* look at.
- **Independent verification.** Verifiers never see the reviewer's reasoning, so they can't anchor on it — that separation only exists because the workflow enforces it.
- **Diagnosable quality.** Typed artifacts between stages mean every miss is attributable: missed at generation, killed at verification, deduped, or cut by the cap. An end-to-end agent tells you *that* it missed; a staged harness tells you *why*.
- **Precision economics.** One wrong comment posted publicly burns trust fast. Autonomy optimizes exploration; a review product needs precision enforced in code.

Autonomy still lives where it earns its keep — *inside* the stages, where reviewers and verifiers investigate with tools, within budgets. **Policy by model, invariants by code.**

**Deterministic first.** Everything that can be deterministic is: diff parsing, classification, symbol extraction, packet construction, anchoring, fingerprinting, caps. Tree-sitter is the cross-language syntax substrate, treated as *syntactic evidence, not semantic truth* — tool results carry backend and precision provenance so a reviewer knows how much to trust what it read.

**Focused context beats big context.** A model handed a 100k-token diff reviews everything a little and nothing well. Small dense packets plus targeted tools invert that.

**Skills are checks, not personas.** A skill is a Markdown file of concrete checks, false-positive rules, safe patterns, and examples — not "you are a meticulous senior engineer" theater. Guidance is projected per stage so it lands where it changes behavior.

**Built to be evaluated.** With telemetry enabled, every run writes typed artifacts — plan, packets, candidates, verdicts, selections, budgets, per-call cost. `codegenie eval` replays real repos against expected findings and scores misses *by loss stage*. The eval suite, the skills, and the telemetry are the compounding assets — models swap underneath them.

**Reviewing untrusted code is a security problem.** A PR is attacker-controlled input flowing into tool-equipped LLMs whose output gets posted publicly. Untrusted content is structurally delimited as data-not-instructions; tools enforce repo-root containment; repo config can never enable command execution or posting; comments pass deterministic sanitization before posting.

**Fail honestly, degrade predictably.** A failed planner falls back to a deterministic plan; a failed packet marks its hunks in coverage; budget exhaustion stops future dispatch without discarding completed work. Partial reviews exit `0` and *say they're partial*.

**Build when evidence demands it.** Richer designs (hierarchical planning, per-role model tiering, cross-packet indexes) are specified but deferred behind written triggers — machinery is added when telemetry shows it improves review quality, never speculatively.

## Status

codegenie is a pre-1.0 CLI being hardened through live evals. Full specifications live in [`specs/project/`](specs/project/):

- [`project_overview.md`](specs/project/project_overview.md) — goals and shape
- [`functional_spec.md`](specs/project/functional_spec.md) — behavior, stages, contracts
- [`architecture.md`](specs/project/architecture.md) — components, data model, technology choices

Built with TypeScript, [`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai), web-tree-sitter, and `git`/`gh` as the only external CLI dependencies.
