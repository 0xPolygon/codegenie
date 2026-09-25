# codegenie 🧞

**AI code review harness.** codegenie is a TypeScript CLI that reviews PR-style diffs at a staff-engineer level — real bugs, logic errors, security issues, architectural risks, and missing tests — and avoids wasting your attention on nitpicks. It prefers no comments over weak comments. codegenie supports all popular LLM providers.

It is not a chatbot pointed at a diff. It is a multi-staged code review harness: a staged pipeline where deterministic code owns the guarantees (coverage, anchoring, verification, dedup, budgets, telemetry) and LLM agents do the judgment work inside each stage. codegenie is built on pi AI library and tree-sitter language parser to offer the harness more powerful tools to traverse code more efficiently.

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
codegenie provider login openrouter --api-key  # OpenRouter API key setup

# 2. Pick your default model (fuzzy-matched)
codegenie provider use luna:xhigh                # -> openai/gpt-6-luna
codegenie provider use opus                      # -> anthropic/claude-opus-5
codegenie provider use gpt-5.5                   # -> openai-codex/gpt-5.5
codegenie provider use deepseek-v4.1-flash:max   # -> openrouter/deepseek/deepseek-v4.1-flash
codegenie provider use glm-5.3:max               # -> openrouter/z-ai/glm-5.3


# 3. Review your current branch
codegenie review
```

Codegenie's built-in model overrides pin all OpenRouter models with IDs starting with `deepseek/` to the `deepseek`, `fireworks`, and `together` upstreams (in that order) with `only`/`order` and `allow_fallbacks: false`. For this pinned model family, submit calls expose only the submit tool and use `tool_choice: "auto"`, to accommodate the named forced-tool rejection observed on DeepSeek V4.1 Flash. Returned submissions still undergo strict validation, and missing submissions have bounded retries. These [OpenRouter routing preferences](https://openrouter.ai/docs/guides/routing/provider-selection) apply to every stage, including repairs; Codegenie's stage-specific reasoning levels still apply. Requests cannot fall back to upstreams outside that list. Routing is included in debug request traces and local model-call cache keys. The overrides live in `src/provider/models-override.ts`.

OpenRouter models with IDs starting with `z-ai/` use `only: ["together", "fireworks", "cloudflare"]`, `order: ["together", "fireworks", "cloudflare"]`, and `allow_fallbacks: false`. This routing override applies across stages, including repairs, and preserves the model's reasoning and tool-choice behavior. It does not add `require_parameters`.

In our trails-api eval, pinning OpenRouter to DeepSeek's own upstream together with the automatic submit-tool compatibility setting produced significantly better completion and performance: DeepSeek V4.1 Flash at `max` finished run 79 in **8m23s**, reviewed all **10/10 hunks**, found the expected bug, and passed with **zero timeouts**. Before these changes, run 77 took **42m19s** and failed completeness with seven unreviewed hunks. Composition dropped from almost six minutes (including a timed-out attempt) to **20 seconds**. Recorded cost rose from about **$0.14 to $0.26**; timed-out calls in run 77 had incomplete usage reporting. This is one eval comparison, not a guarantee for every DeepSeek model or workload: run 79 also used the fallback planner with normal coverage rather than run 77's mostly deep coverage, and still needed schema repairs. The override targets the `deepseek/` model namespace on OpenRouter; it does not call DeepSeek's API directly or change other model families.

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

First-class syntax context and default language guidance currently cover Go, TypeScript, JavaScript, Rust, Python, and Solidity. JavaScript has its own `lang/javascript` guidance for runtime semantics; `.js`, `.jsx`, `.mjs`, and `.cjs` share the proven ECMAScript adapter implementation without inheriting TypeScript-only checks. JavaScript CommonJS export inference, Flow/JSDoc semantic typing, unsupported proposal syntax, and framework/bundler semantics remain deferred. Solidity packets include contract-owned methods/types/events/errors/state values, source-only imports, overload-safe declaration identity, and deterministic default Foundry test links only when a nearest `foundry.toml` exists. File-level constants are not value symbols. Solidity storage-layout, generated-getter, ABI/export analysis, custom Foundry directories, and Hardhat TypeScript linking remain deferred; Solidity symbols intentionally leave `exported` unset. Python `.pyi` stubs/custom collection and Rust same-file/arbitrary integration-test discovery also remain deferred.

Rust, Python, and Solidity form one language-inventory unit. Their three default-enabled skills intentionally change the global Stage-5 skill inventory, registry hash, and model-call cache identity. That single external measurement boundary occurred when the complete Phase 1-4 inventory reached `origin/next` at `eb20533`; measurements from before and after that revision are not comparable as the same cache/prompt regime. The later Phase-5 gate at `40b87b0` changes validation, packaging policy, fixtures, tests, and documentation but not the bundled-skill inventory or registry hash. A branch push is not an npm/tagged release: `master`, the latest tag, and npm `latest` remain at `v0.4.2` until an explicit release occurs.

The dedicated JavaScript skill and narrowed TypeScript skill create a second intentional Stage-5 inventory/registry/cache boundary at the revision where this complete Phase-6 unit first becomes externally visible. Measurements across that landing are non-comparable prompt/cache regimes. A local implementation or branch push remains distinct from a master merge, tag, npm publication, or GitHub release.

Common options:

```bash
codegenie review --depth light|normal|deep         # review budget & planner bias
codegenie review --lens lang/go --lens core/tests  # restrict lenses for this run
codegenie review --provider anthropic --model claude-opus-5   # one-run model override
codegenie review --model claude-opus-5:max         # model[:reasoning] shorthand
codegenie review --reasoning high                  # minimal | low | medium | high | xhigh | max | auto
codegenie review --format json                     # machine-readable review object
codegenie review --pr 123 --post-github-comments   # publish inline comments (explicit flag, never config)
```

Posting to GitHub is a single `COMMENT`-type review with inline comments anchored to changed lines — it never approves or requests changes, and only happens when you pass the flag. Interactive runs show a stderr progress spinner (auto-disabled in CI; `--no-progress` disables it explicitly). Non-posting Markdown/JSON runs emit the full report to stdout; posting runs emit a concise posting summary instead. Action mode separately renders the full report into the status comment, step summary, and report artifact.

For prose files (`.md`, `.mdx`, `.rst`, `.txt`), unchanged inline comment content is deduplicated across shifted anchors on the same file and diff side. Matching uses the complete sanitized body before truncation; changed wording remains eligible for posting. Executable examples under `docs/` retain code fingerprint matching. Separate findings are not merged merely because they occur in the same document.

## GitHub Action

codegenie ships as a reusable GitHub Action: reviews run automatically on PR open/update, or on demand when a collaborator comments `codegenie review` on a PR. The run posts a single status comment ("Reviewing ...") that live-updates through the pipeline stages and finishes as the full markdown report; inline finding comments post as a PR review alongside it (on by default, `post-inline-comments: "false"` disables).

```yaml
# .github/workflows/codegenie.yml
name: codegenie review
on:
  pull_request:
    types: [opened, synchronize, ready_for_review]
permissions:
  contents: read
  pull-requests: write
  issues: write
concurrency:
  group: codegenie-review-pr-${{ github.event.pull_request.number }}
  cancel-in-progress: true  # newest event wins; a push supersedes the stale review
jobs:
  review:
    runs-on: ubuntu-latest
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@v7
        with:
          ref: ${{ github.event.pull_request.base.sha }}  # trusted base; PR head is fetched as review data
          fetch-depth: 0
      - uses: 0xPolygon/codegenie@v0.6.3
        with:
          # Works with any model!
          model: "openrouter/openai/gpt-6-luna:xhigh"
          # model: "openrouter/deepseek/deepseek-v4.1-flash:max"
          # model: "openrouter/z-ai/glm-5.3:max"
          # model: "anthropic/claude-opus-5:high"

          # Set the llm-api-key to the api key for the respective model provider.
          # for example, for Claude, pass an Anthropic key, for OpenRouter models
          # pass the OpenRouter API Key.
          llm-api-key: ${{ secrets.LLM_API_KEY }}
```

The `model` input is one spec: `provider/model[:reasoning]` — any model in [models.md](./models.md) works (`openai/gpt-5.5:xhigh`, `google/gemini-3-pro`, ...), with reasoning defaulting to `high`. `llm-api-key` is provider-generic: codegenie routes it to whatever variable the named provider reads. When `llm-api-key` is set it is the only model key — it overrides that provider's env vars. Without it, codegenie reads the provider's own env vars (see [Credentials](#credentials)).

### Several models, picked per comment

List named models once. `model` stays the default for automatic reviews and a bare `codegenie review`. A collaborator can comment `codegenie review opus` to run that one review with the `opus` entry instead.

```yaml
      - uses: 0xPolygon/codegenie@v0.6.3
        env:
          # one credential env var per provider in the list (see Credentials below)
          OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        with:
          model: luna                 # default: an alias below, or a full spec
          models: |
            luna:     openrouter/openai/gpt-6-luna:xhigh
            deepseek: openrouter/deepseek/deepseek-v4.1-flash:max
            glm:      openrouter/z-ai/glm-5.3:max
            opus:     anthropic/claude-opus-5:high
```

- **Grammar.** The first word after the trigger phrase, on the same line, is looked up in `models` (case-insensitive; surrounding quotes or backticks and trailing punctuation are ignored, so `` `opus` `` and `opus.` both work). Nothing else in the comment is read. Comments cannot supply a model spec, a reasoning level or any other option; to offer a reasoning variant, add an alias for it (`opus-max: anthropic/claude-opus-5:max`). Without `models`, text after the trigger phrase is ignored exactly as before.
- **Unknown names.** `codegenie review opsu` runs no review. codegenie replies with the configured names (`Unknown model. Available: luna (default), deepseek, …`), and only to collaborators who pass the permission check.
- **Keys.** `models` holds model specs only — never put keys in it. With several providers, set each provider's env var on the step, as above. If every configured model uses one provider, a single `llm-api-key` covers them all. When `llm-api-key` is set and the models span several providers, every run fails with a configuration error instead of sending one provider's key to another. On a self-hosted runner where someone ran `codegenie provider login` for that provider, the stored login would take precedence, so the run fails and says to log out there or drop `llm-api-key`.
- **Precedence change.** `llm-api-key` now wins over a provider env var for the same provider. Older releases preferred the env var. A workflow that sets both, with different values, now uses `llm-api-key`.
- **One status comment.** A `codegenie review opus` comment supersedes an in-flight run on the same PR (newest event wins), and the PR's single status comment shows the newest report.
- **A mistyped name still cancels.** `codegenie review opsu` starts a run that supersedes the running review, then only posts the reply — the same "any comment supersedes" trade-off described below.
- **Inline comments accumulate across models.** A `codegenie review opus` run after an automatic review posts its own inline findings. Duplicate suppression only matches unchanged wording, so two models reporting the same issue both appear. That is expected for a second opinion.

### Credentials

Each provider reads its key from its own env var. The common ones:

| Provider | Env var |
| --- | --- |
| `anthropic` | `ANTHROPIC_API_KEY` |
| `openai` | `OPENAI_API_KEY` |
| `openrouter` | `OPENROUTER_API_KEY` |
| `google` | **`GEMINI_API_KEY`** |
| `amazon-bedrock` | AWS credentials (`AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`, `AWS_BEARER_TOKEN_BEDROCK`, or OIDC via `aws-actions/configure-aws-credentials`) |
| `google-vertex` | `GOOGLE_CLOUD_API_KEY`, or Application Default Credentials plus `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION` |

Most names are the provider id in capitals plus `_API_KEY`. Exceptions include `google` → `GEMINI_API_KEY`, `vercel-ai-gateway` → `AI_GATEWAY_API_KEY`, `huggingface` → `HF_TOKEN`, `github-copilot` → `COPILOT_GITHUB_TOKEN`, and shared names such as `MOONSHOT_API_KEY` and `CLOUDFLARE_API_KEY`. `openai-codex` uses a stored ChatGPT-plan login, so in CI it needs a self-hosted runner with that login. The full table for every provider is in [models.md#credentials](./models.md#credentials). A missing key fails the review with a message naming the env var to set.

### Triggers, trust and cancellation

See [`examples/workflows/codegenie-review.yml`](./examples/workflows/codegenie-review.yml) for one workflow that serves both trigger lanes (automatic and comment-triggered). All authorization — exact trigger-phrase match, live write-permission check, model-name lookup — happens inside codegenie; the workflow contains no gating logic to drift. Cancellation policy is one rule: `cancel-in-progress: true`, newest event wins — a push supersedes the now-stale review. On the comment lane that also means any comment on a PR supersedes that PR's in-flight run before codegenie decides it's a skip; if your PR threads are chatty, set it to `false` (re-triggers queue instead), or gate a separate ungrouped job with the `preflight-only` input for the strictest setup. A preflight job needs no model credentials; give it the same `model`, `models` and trigger inputs as the review job. Fork `pull_request` events skip cleanly (the comment lane serves fork PRs), and all posting is deterministic harness code — reviewed content and comment text never reach the model as instructions or tools. Costs are the usual two: GitHub Actions minutes and provider tokens.

## Providers and models

```bash
codegenie provider list                  # known providers and auth status
codegenie provider login <provider>      # OAuth by default; --api-key to store a key
codegenie provider models [query]        # list available models (e.g. `models gpt`)
codegenie provider use <model>           # set the default by fuzzy model id
codegenie provider use <model>:<level>   # ...and its reasoning level (e.g. opus:max)
codegenie use <model>[:<level>]          # shorthand for `provider use`
```

The full list of supported models — every provider, model id, context window, and reasoning levels — lives in [models.md](./models.md) (generated from the [models.dev](https://models.dev) registry; regenerate with `make models-list`).

`provider use` fuzzy-matches: `use opus`, `use sonnet`, `use gpt-5.5` all resolve to a concrete provider/model pair and print what they picked (exact id first, then prefix, then whole-name tail, then substring; ties go to the later-listed id). A `:reasoning` suffix sets the level in the same step (`use deepseek-v4.1-flash:max`); an unsupported level is normalized to a supported one and the command prints and saves the effective level. Exact supported levels are preserved. Fallback preferences are `minimal → low`, `medium → high`, and `xhigh → max`; if that target is unavailable, choose the next supported level above it, or the highest available. This also applies to `provider config set-reasoning`; `:auto` clears the stored level. Models with no advertised reasoning levels retain the existing behavior. Credentials and defaults live under `~/.codegenie/`, never in the repository. Supported lanes include Anthropic (API key) and OpenAI via both the API and ChatGPT-plan Codex OAuth — all on each provider's current APIs.

## Configuration

Drop a `codegenie.toml` in your repo root. Everything has sensible defaults; a typical config is small:

```toml
[git]
baseBranch = "main"

[review]
depth = "normal"
maxTime = 60        # positive number of minutes; --max-time overrides this per run
budgetBoost = 1.0   # scales per-packet review budgets; does not change finding caps
compositionReasoningStepDown = true # default; set false to keep configured reasoning for composition

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
- **Budgets are dispatch controls, not mid-call interrupts.** `review.maxTime` defaults to 30 minutes and may be set in repo or user config; `--max-time <minutes>` is the final per-run override. Crossing a soft cap lets in-flight work finish, records the overrun, and stops dispatching non-essential work.

## How a review runs

Eleven stages, each with a telemetry and artifact boundary. Five make LLM calls (shaded); everything else is deterministic code — and the deterministic stages own the guarantees.

```mermaid
flowchart TB
    S1["1 · Resolve input<br/>PR / branch / commits → base, head, diff"]
    S2["2 · Parse & filter diff<br/>skip generated / vendor / binary"]
    S3["3 · Classify files<br/>language, test vs source, priority"]
    S4["4 · Index symbols<br/>tree-sitter parse, static signals"]
    S5(["5 · Plan (LLM)<br/>intent, coverage depth, lenses"])
    S6["6 · Build review packets<br/>hunks + symbols + tests + context"]
    S7(["7 · Review packets (LLM × packet)<br/>parallel, read-only repo tools"])
    S8(["8 · Follow-up (LLM, usually skipped)"])
    S9(["9 · Verify (LLM × candidate)<br/>fresh context, never sees reviewer reasoning"])
    S10(["10 · Compose (LLM)<br/>merge, rank, cap, phrase"])
    S11["11 · Publish<br/>stdout / JSON / optional GitHub comments"]

    S1 --> S2 --> S3 --> S4 --> S5 --> S6 --> S7
    S7 --> S9
    S7 -. "repeated scoped questions only" .-> S8 --> S9
    S9 --> S10 --> S11

    classDef llm fill:#fdf3d8,stroke:#c8963e,color:#5b4a1e;
    class S5,S7,S8,S9,S10 llm;
```

| # | Stage | What it does | LLM calls |
|---|-------|--------------|-----------|
| 1 | Resolve input | Turn `--pr` / branch / commit args into trusted base+head revisions and the raw diff. | — |
| 2 | Parse & filter | Parse the unified diff; skip generated/vendor/lock/binary files; short-circuit zero-work runs. | — |
| 3 | Classify | Assign language, test-vs-source status, review priority, and path-rule labels. | — |
| 4 | Index | Build the symbol index (tree-sitter), extract changed-symbol facts and static risk signals. | — |
| 5 | Plan | Decide intent framing, per-hunk coverage depth, and lenses. Doesn't hunt bugs. | 1 |
| 6 | Build packets | Assemble focused packets: changed hunks, enclosing symbols, file outline, likely tests, bounded related context. | — |
| 7 | Review | Parallel reviewers examine each packet with read-only repo tools (`read_symbol`, `find_definition`, …) and return candidate findings + uncertainties. | 1 per packet |
| 8 | Follow up | Runs only when several packets independently raise the same scoped question; most runs skip it. | 0–few |
| 9 | Verify | Every candidate is independently re-examined in a fresh context that never saw the reviewer's reasoning. | 1 per candidate |
| 10 | Compose | Dedupe and merge same-root-cause findings, rank, cap, and phrase the final review. | 1 |
| 11 | Publish | Write stdout/JSON; post GitHub comments only with the explicit flag. | — |

The unit of review is the changed hunk; the unit of understanding is the affected system. Reviewers don't get the repository dumped into context — they get a compact packet plus tools to pull exactly what a concern depends on, within per-packet budgets.

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

Eval YAML can also opt into an independent, observational recommendation judge:

```yaml
recommendationJudge:
  provider: openai-codex
  model: gpt-6-astra
  reasoning: medium
  checks:
    - id: preserves-caller-contract
      rubric: |
        State the established caller requirement and relevant source evidence.
        Assess whether the published remedy preserves that requirement.
        Accept equivalent implementations; distinguish withheld advice from
        an incorrect recommendation and from rejected historical alternatives.
```

This makes one additional LLM call after each live review, using the fixed judge above rather than the review model. Results are `correct`, `incorrect`, `withheld`, or `uncertain`, with report quotes and rationale. They appear separately in `info.json` and `recommendation-judge.json`; judge cost is separate from review cost, and neither a negative judgment nor a judge error changes the existing eval pass/fail. The judge sees the published report with the renderer's historical provenance removed and the case rubric; it does not independently inspect the repository. Supply the relevant contract in the rubric and calibrate against saved reports before using judgments as quality evidence. Invalid responses and a 180-second timeout produce an explicit error, with no repair loop.

Artifact rescoring stays offline by default. To explicitly re-judge a saved report against the current case YAML, use `codegenie eval --from-artifacts /path/to/logs/118 --judge`. Replay creates a new run; it does not change the original. Repeated live cases record judgments and separate usage in each repeat's `score.json` and judge artifact.

For optional judge calibration, `scripts/calibrate-recommendations.ts` loads one eval case's rubric and a separate JSON array of `{ id, report, expected, reason }` examples. Run it with `pnpm exec tsx scripts/calibrate-recommendations.ts --eval-dir <suite> --cases <cases.json> --out <new-directory> --repeats 2`; add `--live` to make paid judge calls. Gold labels stay out of the prompt. Every repetition and disagreement is saved, alongside usage and input hashes. This calibration does not change eval pass/fail.



**Reviewing untrusted code is a security problem.** A PR is attacker-controlled input flowing into tool-equipped LLMs whose output gets posted publicly. Untrusted content is structurally delimited as data-not-instructions; tools enforce repo-root containment; repo config can never enable command execution or posting; comments pass deterministic sanitization before posting.

**Fail honestly, degrade predictably.** A failed planner falls back to a deterministic plan; a failed packet marks its hunks in coverage; budget exhaustion stops future dispatch without discarding completed work. Partial reviews exit `0` and *say they're partial*.

**Build when evidence demands it.** Richer designs (hierarchical planning, per-role model tiering, cross-packet indexes) are specified but deferred behind written triggers — machinery is added when telemetry shows it improves review quality, never speculatively.

Eval cases can opt into stricter reliability checks:

```yaml
expect:
  planningQuality: non-degraded
  compositionQuality: non-degraded
  recoveryFidelity: preserved
```

The planning check rejects degraded plans even when every hunk was reviewed. The composition check rejects degraded report synthesis separately from coverage completeness. The recovery check requires complete telemetry, no unresolved structured-output obligations, and demonstrated preservation; regenerated or revised content is reported as `unknown`, not assumed preserved. Repairs retain draft progress across retries and validate the whole merged submission. For unreadable JSON, repair prompts include a bounded, redacted syntax excerpt and parser diagnostic when available. Fragments remain untrusted diagnostics, never accepted data or proof that a replacement preserved the original.

SVG files are skipped by default. Set `[review] skipSvgReview = false` in `codegenie.toml`, or run `codegenie review --no-skip-svg-review`, to include them subject to other exclusion rules. `--skip-svg-review` enables the skip explicitly. This controls changed-file review; repository evidence searches can still find SVG content and disclose oversized matches they omit.

Local investigation budgets are soft targets, with hard ceilings of **2×** the target for aggregate tool calls, investigation rounds, and result characters. This applies to packet review, system review, and verification. At normal depth with `budgetBoost = 1`, investigate packets target 20 calls / 6 rounds / 48,000 characters for deep coverage, 6 / 2 / 12,000 for normal coverage, and 4 / 2 / 4,000 for light coverage. System review targets 6 / 2 / 12,000; verification targets 8 / 3 / 32,000. Depth and budget scaling apply before deriving the ceilings. Zero budgets remain disabled. Existing source extensions are subsumed by this allowance and cannot add capacity beyond it. Per-result caps, explicit spending limits, provider context limits, stage deadlines, and repair budgets are unchanged.

Before the first request and after each repository-tool batch, models receive remaining soft targets and a nudge to finish or resolve concrete remaining questions when a target is reached. Traces record soft targets, hard ceilings, and remaining capacity in `tool_budget_initial` / `tool_budget_remaining`, plus a single `tool_budget_soft_target_reached` event per investigation. Crossing a target alone is not a refusal or an incomplete-review diagnostic. Executed calls and cache hits each count; invalid arguments and pre-execution refusals do not consume those calls, but a separate refusal limit and the round ceiling bound repeated invalid requests. Source allocations are guidance within the shared character allowance. Discovery results retain their per-result cap of 4,000 characters (2,000 for light investigations), subject to existing budget scaling. Searches and file lists keep whole entries and disclose omissions. Invalid raw tool arguments receive correction feedback before SDK coercion. `read_range` requires both inclusive 1-based bounds; requests entirely beyond EOF return empty text, not a different line.

For formats without a syntax adapter, outlines explicitly mark symbol extraction as unavailable. Small files include complete source text; larger files provide a `read_range` hint. Empty symbol arrays do not establish that definitions are absent. Complete source supplied through an outline can also serve as evidence during attention reconciliation.

Composition uses the next lower supported reasoning level by default, including retries: for a model supporting `low`, `high`, and `max`, `max` becomes `high`. Set `[review] compositionReasoningStepDown = false` in `codegenie.toml` to keep the configured review reasoning level for composition. The lowest supported level stays unchanged; models without advertised reasoning levels retain the configured behavior. Override this per run with `codegenie review --composition-reasoning-step-down` or `--no-composition-reasoning-step-down`. Omitting both flags preserves the configuration, which defaults to `true`. Investigation and verification keep their configured reasoning; traces record configured and selected levels. Structured-output repairs continue to use the model’s lowest supported reasoning level. Each composition attempt has a 300-second deadline, with at most one retry. The outer composition deadline is 780 seconds (two attempts plus the shared 180-second repair allowance); overall review cancellation still takes precedence. Repair attempts share that 180-second allowance, rather than receiving 180 seconds each.

Composition validates source references before acceptance. It locally removes repeated known references and misplaced references already correctly accounted for in the same finding, records those removals, and validates the whole result. Remaining attribution errors receive bounded repairs in a fresh context with exact field paths and source inventories. Attribution patches replace only permitted reference lists; finding order and prose stay intact, and the assembled report must pass full validation. If a recommendation lacks support, a bounded composition repair may instead omit or rewrite that advice section while preserving the diagnosis and retaining its original sources. Reports consolidate identical evidence and keep additional verbatim evidence and caveats in expandable sections. If synthesis fails, the report identifies its source-based presentation and retains distinct contributions. `stages/10-composition/composition-sources.json` records all inputs and dispositions; references establish attribution, not proof of semantic equivalence. Verification distinguishes essential missing proof from secondary uncertainty: unresolved hypotheses remain visible under human attention, while established defects may still have uncertainty about severity.

Verification receives up to 6,000 characters of relevant source already collected by completed packets, with file, revision and tool provenance. Attention reconciliation also matches concern file/symbol metadata when selecting source evidence; selection does not establish that a question is answered.

Verification assesses proposed fixes and tests independently from the defect, using the existing optional assessment fields and investigation budget. The verifier selects a concrete remedy that preserves the original caller requirement and checks its test against both the defect and a weakened guarantee. In verifier submissions, `suggestionText` may be omitted: the harness binds the assessment to the named final suggestion before retaining a repair draft. Explicit text mismatches still lose support; changing a suggestion alone cannot transfer a retained assessment to it. Support requires evidence for the observable requirement; tests should reject weakened guarantees without excluding other valid implementations. Prominent fix/test sections and structured recommendation fields contain only supported current proposals. Unverified, incompatible and replaced proposals remain in expandable provenance. The composer is instructed to keep summaries diagnosis-focused and advice out of impact/verification prose; source validation checks attribution and eligibility, not the semantic correctness of arbitrary prose.

## Development

Run `pnpm run check` for TypeScript and GitHub workflow validation, then `pnpm test` and `pnpm build` for the full suite. Workflow validation uses [`actionlint`](https://github.com/rhysd/actionlint); `pnpm test` runs it automatically so GitHub expression/context errors cannot pass while unit tests remain green.

Run `make evals` for the deterministic [synthetic harness evals](evals/synthetics/README.md). These scenarios exercise harness behavior without network requests or model inference, and also run in `pnpm test`.

## Status

codegenie is a pre-1.0 CLI being hardened through live evals. Full specifications live in [`specs/project/`](specs/project/):

- [`project_overview.md`](specs/project/project_overview.md) — goals and shape
- [`functional_spec.md`](specs/project/functional_spec.md) — behavior, stages, contracts
- [`architecture.md`](specs/project/architecture.md) — components, data model, technology choices

Built with TypeScript, [`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai), web-tree-sitter, and `git`/`gh` as the only external CLI dependencies.
