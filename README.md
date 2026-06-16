# codeninja 🥷

**High-signal AI code review for pull requests.** codeninja is a TypeScript CLI that reviews PR-style diffs at a staff-engineer level — real bugs, logic errors, security issues, architectural risks, and missing tests — and refuses to waste your attention on nitpicks. It prefers no comments over weak comments.

It is not a chatbot pointed at a diff. It is a **review harness**: a staged pipeline where deterministic code owns the workflow's guarantees (coverage, anchoring, verification, dedup, budgets, telemetry) and LLM agents do the judgment work inside each stage.

## What you get

- **Findings that survive scrutiny.** Every candidate finding must cite changed-code evidence and a concrete failure mode, then pass an independent LLM verifier before it can be published. No evidence → no finding.
- **A handful of comments, not fifty.** The default target is ~3–7 high-signal comments per PR (a soft cap — verified critical/high findings are never hidden by it). Style, naming, and formatting commentary is off unless you explicitly enable a lint lens.
- **Honest coverage.** Every changed hunk is accounted for: planner overrides, deterministic default review, explicit skips, failures, and budget stops are tracked separately. If a review is partial, the report says so. codeninja never pretends it reviewed something it didn't.
- **Reviews of the actual revision.** Reviewed source reads resolve through git plumbing against the PR's base/head revisions — not whatever happens to be checked out. Review policy, config, and skills still load from your trusted local checkout.

## Usage

```bash
codeninja review                          # current branch vs its base (merge-base semantics)
codeninja review --pr 123                 # a GitHub PR — no checkout needed, fork PRs included
codeninja review --branch feat --base main
codeninja review abc1234                  # one commit
codeninja review abc1234 def5678          # a commit range
```

Common options:

```bash
codeninja review --depth light|normal|deep        # global budget & planner bias
codeninja review --lens lang/go --lens core/tests # restrict/enable lenses for this run
codeninja review --provider openai --model gpt-5  # override the user-level model default
codeninja review --reasoning high                 # override model reasoning effort
codeninja review --format json                    # machine-readable final review object
codeninja review --pr 123 --post-github-comments  # publish inline comments (explicit flag, never config)
codeninja eval --eval-dir ./evals                 # run the eval suite
```

By default codeninja prints a structured Markdown report to stdout and exits `0` whether or not it found issues (a review with findings is a *successful* review). Posting to GitHub is a single `COMMENT`-type review with inline comments anchored to changed lines — it never approves or requests changes, and it only ever happens when you pass the flag.

Model provider auth is configured through Pi-backed user state:

```bash
codeninja provider list
codeninja provider login <provider>
codeninja provider models [provider-or-search] [--all]
codeninja provider config set-provider <provider>
codeninja provider config set-model <provider> <model>
```

Credentials and provider defaults live under `~/.codeninja/` by default, not in the repository.

### Configuration

Drop a `codeninja.toml` in your repo root. Everything has sensible defaults; a typical config is small:

```toml
[git]
baseBranch = "main"

[review]
depth = "normal"
budgetMultiplier = 1.0 # scales review/tool/token-call budgets; does not change finding caps

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

Teams can also version project-specific review expertise as Markdown skills in `.codeninja/skills/` — concrete checks, false-positive rules, and safe patterns that travel with the repo.

Budget caps are dispatch controls, not mid-call interrupts. If a model call is already running and crosses a soft token/model-call cap, codeninja records the overrun, lets that call finish, and stops dispatching later non-essential work. Raise or lower `review.budgetMultiplier` to scale review effort/cost for a repo or eval run; high values can be expensive and are recorded in telemetry.

## How a review runs

```text
diff → detect/filter → classify kept files → changed-symbol extraction (deterministic)
  → planner: intent, risk areas, targeted coverage/lenses    (LLM)
  → review packets: focused diff slices + local context      (deterministic)
  → packet reviewers: candidate findings, in parallel        (LLM, tool-equipped)
  → independent verifier: keep / revise / reject             (LLM, per candidate)
  → dedupe, rank, compose final review                       (deterministic + 1 LLM call)
  → stdout report or GitHub review                           (deterministic)
```

The unit of review is the changed hunk; the unit of understanding is the affected system. Reviewers don't get the repository dumped into context — they get a compact packet (the hunk, absolute line numbers, enclosing symbol source, a file outline, likely tests) plus bounded read-only repository tools (`read_symbol`, `search_files`, `find_likely_tests`, …) to chase down exactly the surrounding code a concern depends on.

## Design and philosophy

### Judgment in the model, invariants in the harness

The obvious way to build an AI reviewer in 2026 is one autonomous agent with repo tools and a good prompt. We deliberately didn't, and the reasoning is worth writing down.

Despite the pipeline diagram, codeninja has only **four LLM decision points** — planner, packet reviewer, verifier, composer. Everything else is deterministic plumbing: parsing, bookkeeping, validation, serialization. A fully autonomous agent has *one* LLM decision point that internally makes hundreds of unauditable micro-decisions. We'd rather have four auditable ones.

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

Long-context attention dilution is real: a model handed a 100k-token diff dump reviews everything a little and nothing well. codeninja inverts this — small, dense packets plus tools to pull exactly the context a concern needs. The packet says *here are changed lines 55–56 inside `(*Store).SaveUser`, here's the enclosing function, here are its likely tests* — and the reviewer escalates from there only with cause.

### Skills are checks, not personas

A skill is a Markdown file of concrete checks, false-positive rules, safe patterns, and examples — not "you are a meticulous senior engineer" theater. Skills are projected per stage (reviewers get Checks + False Positives + Examples; the verifier gets False Positives + Safe Patterns) so guidance lands where it changes behavior. Lenses (`core/code-review`, `core/tests`, `lang/go`, …) are the user-facing perspectives that map onto skills, and teams can add their own per repo.

### Built to be evaluated

Every run writes typed local artifacts — the plan, every packet, every candidate, every verdict, every selection decision, budget summary, and per-call token/cost telemetry. The `codeninja eval` command replays real repos and fixtures against expected findings and scores them *by loss stage*. Eval YAML can set `review.budgetMultiplier`, require `expect.reviewCompleteness: complete`, and bound budget crossings with `expect.maxBudgetOverruns: 0`. High-cost evals can tune workflow and provider concurrency separately:

```yaml
review:
  concurrency: 6       # packet/verifier workers
llm:
  maxConcurrentCalls: 6 # simultaneous provider calls
```

Increasing both can finish large evals faster, but it can also hit provider rate limits or increase burst spend. The `--cache` flag controls codeninja's local model-call cache, which reuses prior LLM responses during iteration; provider-side prompt cache reads/writes are reported separately because they are billing/runtime metadata from the LLM provider. In telemetry artifacts, prefer `localModelCallCache` and `providerPromptCache`; the older `cache` field is only a compatibility alias for local model-call cache counts. The eval suite, the skills, and the telemetry are the compounding assets — models swap underneath them.

For high-throughput evals, set `review.concurrency` and `llm.maxConcurrentCalls` to the same value unless you are intentionally throttling provider calls. A value of `6` is a reasonable first step; try `8` only when the provider account tolerates the burst rate. Higher concurrency reduces elapsed time, not token use or model cost, and codeninja records a `concurrency_mismatch` telemetry event when workers outnumber provider slots.

### Reviewing untrusted code is a security problem

A PR is attacker-controlled input that flows into tool-equipped LLMs whose output gets posted publicly. codeninja draws explicit trust boundaries: untrusted content is structurally delimited in prompts as data-not-instructions; repository tools enforce repo-root path containment (no traversal, no symlink escapes); repo-resident config can never enable command execution or posting — those need user-level opt-in; review policy loads from *your* checkout, never the PR's; model-composed comments pass deterministic sanitization (mention-neutralizing, marker stripping, secret scrubbing) before posting.

### Fail honestly, degrade predictably

Budgets and failures don't produce silent gaps. A failed planner falls back to a deterministic default plan; a failed packet worker marks its hunks `review_failed` in coverage; budget exhaustion blocks future dispatch without discarding already-completed work. Final reports include complete/partial status plus compact token/model-call budget accounting when useful. Partial reviews exit `0`, finalize as `completed_partial` in artifacts, and *say they're partial*.

### Build when evidence demands it

Several richer designs — a cross-file system follow-up pass, hierarchical planning with sub-planners, a cross-packet signal index, spec-document alignment, per-role model tiering, a changed-symbol graph — are specified but deliberately **deferred** behind simple v1 behavior. Each has a written trigger ("build when evals show…"). The rule is the project's own: advanced machinery is added behind stable interfaces when telemetry shows it improves review quality — never speculatively.

## Status

codeninja is in the design phase. The full specifications live in [`specs/projects/codeninja/`](specs/projects/codeninja/):

- [`project_overview.md`](specs/projects/codeninja/project_overview.md) — goals and shape
- [`functional_spec.md`](specs/projects/codeninja/functional_spec.md) — behavior, stages, contracts
- [`architecture.md`](specs/projects/codeninja/architecture.md) — components, data model, technology choices

Built with TypeScript, [`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai), web-tree-sitter, and `git`/`gh` as the only external CLI dependencies.
