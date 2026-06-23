# codegenie 🧞

**High-signal AI code review for pull requests.** codegenie is a TypeScript CLI that reviews PR-style diffs at a staff-engineer level — real bugs, logic errors, security issues, architectural risks, and missing tests — and refuses to waste your attention on nitpicks. It prefers no comments over weak comments.

It is not a chatbot pointed at a diff. It is a **code review harness**: a staged pipeline where deterministic code owns the workflow's guarantees (coverage, anchoring, verification, dedup, budgets, telemetry) and LLM agents do the judgment work inside each stage.

## Install

```bash
# npm
npm install -g @0xsequence/codegenie

# bun
bun install -g @0xsequence/codegenie
```

This installs the `codegenie` command globally.

Or run directly without installing:

```bash
npx @0xsequence/codegenie --help
bunx @0xsequence/codegenie --help
```

NOTE: we will move `codegenie` npm package out of `@0xsequence` in the future.

## Usage

```bash
codegenie review                          # current branch vs its base (merge-base semantics)
codegenie review --pr 123                 # a GitHub PR — no checkout needed, fork PRs included
codegenie review feat                     # branch vs resolved base, if feat is a branch
codegenie review --branch feat --base main
codegenie review --head 49f4645b --base master # pinned PR-style review
codegenie review master...49f4645b        # shorthand for --base master --head 49f4645b
codegenie review abc1234                  # one commit
codegenie review abc1234 def5678          # a commit range
```

Common options:

```bash
codegenie review --depth light|normal|deep        # global budget & planner bias
codegenie review --lens lang/go --lens core/tests # restrict/enable lenses for this run
codegenie review --provider openai --model gpt-5  # override the user-level model default
codegenie review --reasoning high                 # override model reasoning effort
codegenie review --format json                    # machine-readable final review object
codegenie review --ci                             # disable interactive progress output
codegenie review --no-progress                    # disable the local spinner explicitly
codegenie review --pr 123 --post-github-comments  # publish inline comments (explicit flag, never config)
codegenie eval --eval-dir ./evals                 # run the eval suite
```

By default codegenie prints a structured Markdown report to stdout and exits `0` whether or not it found issues (a review with findings is a *successful* review). Posting to GitHub is a single `COMMENT`-type review with inline comments anchored to changed lines — it never approves or requests changes, and it only ever happens when you pass the flag.

A single positional target is branch-first: if it resolves as a local or remote branch, codegenie reviews that branch against its base. If it does not resolve as a branch, codegenie treats it as a single commit. `--base` can be used with this shorthand only when the target resolves as a branch.

Interactive reviews show a small stderr progress spinner with the active pipeline stage. It is automatically disabled when stderr is not a TTY or `CI` is set, and it can be disabled explicitly with `--ci` or `--no-progress`. The final Markdown/JSON report is still written only to stdout.

Model provider auth is configured through Pi-backed user state:

```bash
codegenie provider list
codegenie provider login <provider>
codegenie provider use <model-name>
codegenie provider models [provider-or-search] [--all]
codegenie provider config set-provider <provider>
codegenie provider config set-model <provider> <model>
```

Credentials and provider defaults live under `~/.codegenie/` by default, not in the repository.

### Configuration

Drop a `codegenie.toml` in your repo root. Everything has sensible defaults; a typical config is small:

```toml
[git]
baseBranch = "main"

[review]
depth = "normal"
budgetBoost = 1.0 # scales review/tool/token-call budgets; does not change finding caps

[telemetry]
enabled = true # opt into local run artifacts under .codegenie/runs
logLevel = "debug"
debugTrace = true

[[classification.pathRules]]
pattern = "lib/payments/**"
reviewPriority = "critical"
labels = ["payments", "critical-path"]
reason = "Payments code is business-critical."

[[classification.pathRules]]
pattern = "generated/**"
processingMode = "skip"
reason = "Generated files are not reviewed."
```

Telemetry is off by default. Enable it in repo `codegenie.toml` or user-level `~/.codegenie/config.toml` to write local run artifacts; repo config may only set `telemetry.enabled`, while user config can also set the run directory, log level, debug traces, and retention.

Teams can also version project-specific review expertise as Markdown skills in `.codegenie/skills/` — concrete checks, false-positive rules, and safe patterns that travel with the repo.

Budget caps are dispatch controls, not mid-call interrupts. If a model call is already running and crosses a soft token/model-call cap, codegenie records the overrun, lets that call finish, and stops dispatching later non-essential work. Raise or lower `review.budgetBoost` to scale review effort/cost for a repo or eval run; high values can be expensive and are recorded in telemetry when telemetry is enabled.

## How a review runs

The numbered stages are the telemetry and artifact boundaries:

- **Stage 1: Resolve review input.** Resolve `--pr`, `--branch`, `--head`, commit ranges, or the default branch into trusted base/head revisions and the raw diff. No LLM calls. No Tree-sitter.
- **Stage 2: Parse and filter the diff.** Parse the unified diff, classify changed files as reviewable or skipped, apply generated/vendor/lock/binary/config skip rules, and short-circuit zero-work runs. No LLM calls. No Tree-sitter.
- **Stage 3: Classify kept files.** Assign language, test/source status, review priority, and path-rule labels to the kept files. No LLM calls. No Tree-sitter.
- **Stage 4: Index symbols.** Build the repository index and changed-symbol facts for kept files. This is where Tree-sitter first runs: Go and TypeScript/JavaScript files are parsed when grammars are available, static signals are extracted, and the repository tool facade is prepared with text fallbacks for unsupported files. No LLM calls.
- **Stage 5: Plan the review.** Build the planner dossier deterministically, then ask the planner model for intent framing, per-hunk coverage, targeted lenses, and hunk-scoped focus/context hints. Usually this is one LLM call; very large dossiers may be chunked, and schema repair can add a retry. The planner consumes Stage 4 symbol facts but does not run Tree-sitter itself, does not author proof obligations, and does not try to find bugs.
- **Stage 6: Build review packets.** Turn the plan into focused packets: changed hunks, absolute line numbers, enclosing symbols, file outlines, likely tests, bounded context, surrounding-context hints, configured labels, advisory attention notes, and bounded related changed context from a small deterministic changed-hunk relationship graph. No LLM calls. It uses Stage 4 data and repository tools; outline/symbol context is Tree-sitter-backed when available and text-backed otherwise.
- **Stage 7: Review hunks.** Run packet reviewers in parallel. Each packet gets its lenses, skill projections, advisory packet context, and read-only repo tools, then returns candidate findings, uncertainties, and follow-up hints. This is an LLM call per dispatched packet, plus possible schema-repair retries. Tool calls in this stage may use Tree-sitter-backed `read_symbol`, `read_file_outline`, `find_definition`, or mention search.
- **Stage 8: Check repeated follow-ups.** Run narrow system follow-up only when multiple packets independently raise the same scoped follow-up question. Most runs skip this with no model work. When it does run, it makes tightly capped LLM calls with the same read-only tool surface, including Tree-sitter-backed tools where available.
- **Stage 9: Verify findings.** Apply deterministic gates, then independently verify each surviving candidate in fresh context. This is usually one LLM call per candidate; if `review.verify = false`, candidates are kept with an explicit coverage disclosure instead. Verifiers can use the same repository tools and Tree-sitter-backed source lookups.
- **Stage 10: Compose the final review.** Dedupe, rank, cap, and format the verified findings. There is one composer LLM call to choose and phrase the final review, followed by deterministic validation and fallback composition if needed. No Tree-sitter runs here.
- **Stage 11: Publish or render.** Write stdout/JSON/Markdown output and, only when explicitly requested, post GitHub comments. No LLM calls. No Tree-sitter.

The unit of review is the changed hunk; the unit of understanding is the affected system. Reviewers don't get the repository dumped into context — they get a compact packet (the hunk, absolute line numbers, enclosing symbol source, a file outline, likely tests, advisory hunk-scoped attention notes, and bounded related changed context) plus bounded read-only repository tools (`read_symbol`, `search_files`, `find_definition`, …) to chase down exactly the surrounding code a concern depends on. The likely-test lookup remains available for test-focused review contexts, while ordinary packet reviewers usually rely on the likely tests already attached to the packet.

Stage 8 is deliberately narrow. It is not a broad whole-repo review pass. It runs only when multiple packet reviewers independently raise the same scoped follow-up question; otherwise it logs `system_review_skipped` and costs nothing beyond bookkeeping. When it does run, it creates at most a few focused system-review tasks, may resolve duplicate human-attention notes, and any findings still go through the normal verifier before publication.

## Design and philosophy

### Judgment in the model, invariants in the harness

The obvious way to build an AI reviewer in 2026 is one autonomous agent with repo tools and a good prompt. We deliberately didn't, and the reasoning is worth writing down.

Despite the pipeline diagram, codegenie has only **four primary LLM decision points** — planner, packet reviewer, verifier, composer. The optional Stage 8 follow-up is a bounded fifth decision point only when repeated scoped hints justify it; most runs skip it. Everything else is deterministic plumbing: parsing, bookkeeping, validation, serialization. A fully autonomous agent has *one* LLM decision point that internally makes hundreds of unauditable micro-decisions. We'd rather have a few auditable ones.

The deeper reason: a review tool's value isn't "finds bugs" — frontier models increasingly do that for free. The value is the **guarantees around the findings**, and each one is structurally impossible for an autonomous agent:

- **Coverage honesty.** "Every hunk got a decision or a skip reason" requires an inventory the model is checked against. An autonomous agent cannot tell you what it *didn't* look at — it doesn't know.
- **Independent verification.** Every candidate finding is re-examined by a verifier in a *fresh context* that never saw the reviewing agent's reasoning. An agent verifying its own findings is anchored on them — sunk-cost bias is exactly how single-agent reviewers ship plausible-but-wrong comments. Context separation only exists because the workflow enforces it.
- **Diagnosable quality.** Because stages have typed artifacts between them, the eval system can attribute every miss to a stage: *missed at candidate generation*, *killed by the verifier*, *deduped away*, *cut by the report cap*. An end-to-end agent tells you *that* it missed; a staged harness tells you *why*. That feedback loop is how review quality compounds.
- **Precision economics.** One wrong or duplicate comment posted publicly burns trust fast — developers tune out a noisy tool within a week. Autonomy optimizes exploration; a review product needs precision enforced in code.

Autonomy still lives where it earns its keep: *inside* the stages. Packet reviewers and verifiers are genuinely agentic — they investigate with tools, within budgets. The planner makes the judgment calls (what's risky, what gets deep coverage, which lenses apply). The harness owns only invariants: anchoring, gating, dedup, accounting, publishing. **Policy by model, invariants by code.**

### Deterministic first

Everything that *can* be deterministic *is*: diff parsing, file classification, changed-symbol extraction (tree-sitter), packet construction, anchor validation, fingerprinting, caps. Deterministic preprocessing is the cheapest reliability you can buy — it's testable with fixtures, it never hallucinates, and it gives every LLM stage clean, structured input instead of raw repository soup.

Tree-sitter is the cross-language syntax substrate — used for enclosing symbols, outlines, imports, and static signals — and treated as *syntactic evidence, not semantic truth*. Tool results carry backend provenance and precision (`exact`/`syntactic`/`heuristic`/`text`) so a reviewer always knows how much to trust what it read.

### Focused context beats big context

Long-context attention dilution is real: a model handed a 100k-token diff dump reviews everything a little and nothing well. codegenie inverts this — small, dense packets plus tools to pull exactly the context a concern needs. The packet says *here are changed lines 55–56 inside `(*Store).SaveUser`, here's the enclosing function, here are its likely tests* — and the reviewer escalates from there only with cause.

### Skills are checks, not personas

A skill is a Markdown file of concrete checks, false-positive rules, safe patterns, and examples — not "you are a meticulous senior engineer" theater. Skills are projected per stage (reviewers get Checks + False Positives + Examples; the verifier gets False Positives + Safe Patterns) so guidance lands where it changes behavior. Lenses (`core/code-review`, `core/tests`, `lang/go`, …) are the user-facing perspectives that map onto skills, and teams can add their own per repo.

### Built to be evaluated

When telemetry is enabled, every run writes typed local artifacts — the plan, every packet, every candidate, every verdict, every selection decision, budget summary, and per-call token/cost telemetry. The `codegenie eval` command always captures these artifacts, replays real repos and fixtures against expected findings, and scores them *by loss stage*. Eval YAML can set `review.budgetBoost`, require `expect.reviewCompleteness: complete`, and bound budget crossings with `expect.maxBudgetOverruns: 0`. High-cost evals can tune workflow and provider concurrency separately:

```yaml
review:
  concurrency: 6       # packet/verifier workers
llm:
  maxConcurrentCalls: 6 # simultaneous provider calls
```

For PR-style evals pinned to an immutable revision, prefer `command.head: <sha>` with `command.base: <branch>`; codegenie computes the merge-base diff just like GitHub rather than doing an endpoint `base..head` diff.

Increasing both can finish large evals faster, but it can also hit provider rate limits or increase burst spend. The `--cache` flag controls codegenie's local model-call cache, which reuses prior LLM responses during iteration; provider-side prompt cache reads/writes are reported separately because they are billing/runtime metadata from the LLM provider. codegenie passes Pi a short, stage-scoped prompt-cache session hint so providers that support session caching can reuse repeated reviewer/verifier prefixes without changing prompt text. In telemetry artifacts, prefer `localModelCallCache` and `providerPromptCache`; the older `cache` field is only a compatibility alias for local model-call cache counts. The eval suite, the skills, and the telemetry are the compounding assets — models swap underneath them.

For high-throughput evals, set `review.concurrency` and `llm.maxConcurrentCalls` to the same value unless you are intentionally throttling provider calls. A value of `6` is a reasonable first step; try `8` only when the provider account tolerates the burst rate. Higher concurrency reduces elapsed time, not token use or model cost, and codegenie records a `concurrency_mismatch` telemetry event when workers outnumber provider slots.

### Reviewing untrusted code is a security problem

A PR is attacker-controlled input that flows into tool-equipped LLMs whose output gets posted publicly. codegenie draws explicit trust boundaries: untrusted content is structurally delimited in prompts as data-not-instructions; repository tools enforce repo-root path containment (no traversal, no symlink escapes); repo-resident config can never enable command execution or posting — those need user-level opt-in; review policy loads from *your* checkout, never the PR's; model-composed comments pass deterministic sanitization (mention-neutralizing, marker stripping, secret scrubbing) before posting.

### Fail honestly, degrade predictably

Budgets and failures don't produce silent gaps. A failed planner falls back to a deterministic default plan; a failed packet worker marks its hunks `review_failed` in coverage; budget exhaustion blocks future dispatch without discarding already-completed work. Final reports include complete/partial status plus compact token/model-call budget accounting when useful. Partial reviews exit `0`, finalize as `completed_partial` in artifacts, and *say they're partial*.

### Build when evidence demands it

Several richer designs — a broad cross-file system review pass, hierarchical planning with sub-planners, a cross-packet signal index, spec-document alignment, per-role model tiering, a changed-symbol graph — are specified but deliberately **deferred** behind simple v1 behavior. The shipped Stage 8 is only the small repeated-follow-up variant, not the broad system pass. Each richer design has a written trigger ("build when evals show…"). The rule is the project's own: advanced machinery is added behind stable interfaces when telemetry shows it improves review quality — never speculatively.

## Status

codegenie is implemented as a pre-1.0 CLI and being hardened through live evals. The full specifications live in [`specs/projects/codegenie/`](specs/projects/codegenie/):

- [`project_overview.md`](specs/projects/codegenie/project_overview.md) — goals and shape
- [`functional_spec.md`](specs/projects/codegenie/functional_spec.md) — behavior, stages, contracts
- [`architecture.md`](specs/projects/codegenie/architecture.md) — components, data model, technology choices

Built with TypeScript, [`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai), web-tree-sitter, and `git`/`gh` as the only external CLI dependencies.
