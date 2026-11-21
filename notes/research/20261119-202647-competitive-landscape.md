---
created: 2026-11-19T20:26:47Z
author: lead-dev-2
source: "0xPolygon/codegenie#44 (deep review, workstream D part 2: competitive research); web research 2026-11-19 via the spec skill's research command (4 subtopic agents plus a summary agent; every claim below cites its URL); codegenie claims checked at master f240376"
status: provisional
---

# AI code review landscape: what codegenie should borrow, and what it should not

Workstream D, part 2. Products covered:
- Sentry Warden;
- Claude Code `/code-review` (levels low–max), ultra, and the managed Code Review;
- OpenAI Codex review;
- GitHub Copilot code review;
- CodeRabbit, Greptile, Graphite Agent (formerly Diamond), Cursor Bugbot, Qodo and PR-Agent;
- Kodus and smaller OSS harnesses;
- the public benchmarks and field studies.

Every number is a **vendor claim** unless it is marked independent. Where a statement is my inference, it is labelled as such. Sources were read on 2026-11-19. The research working tree (subtopic deep docs with longer quotes) is scratch at `/tmp/claude-1000/-home-peter-Dev-0xPolygon-codegenie-worktrees-peter-lead-dev-2/1e8f8501-fd34-4e8b-a65a-5fcadb806016/scratchpad/research/ai-code-review-landscape/`. The URLs below are the durable evidence.

## Bottom line

1. **The industry has converged on codegenie's deep shape.** That shape is narrow parallel finders, then a separate verification step, then dedup and ranking, with deterministic code owning posting. Anthropic's managed Code Review does Find, Verify, Rank, Post ([docs](https://code.claude.com/docs/en/code-review)). Greptile v5 is a "swarm of agents that each explore one hypothesis" ([v5](https://www.greptile.com/blog/greptile-v5)). Qodo uses specialist agents plus a judge, and Warden runs skill agents per hunk with a verifier and a merge ([architecture](https://warden.sentry.dev/architecture/)). codegenie's architecture is not behind. Its differentiators are the whole-PR planner, packet coverage accounting, stage-level loss attribution and model-family portability through Pi. No public product or benchmark offers stage-level loss attribution.
2. **Everyone shipped effort tiers in 2026, and the good ones route up when unsure:**
   - Copilot: Lite, Balanced, Max, Adaptive ([docs](https://docs.github.com/en/copilot/concepts/agents/code-review));
   - Bugbot: low, default, high, smart ([docs](https://cursor.com/docs/bugbot));
   - Greptile: Base, Plus, Apex, Auto, where a comment "can raise the tier but not lower it" ([tiers](https://www.greptile.com/docs/code-review/review-tiers.md));
   - Qodo Auto: "When Auto cannot confidently determine the appropriate review depth … routes the review to a higher review depth" ([Qodo](https://docs.qodo.ai/code-review/use-qodo-in-prs/control-review-effort));
   - Kodus: fast, balanced, heavy, deep, with risky PRs routed to heavy ([kodus-ai](https://github.com/kodustech/kodus-ai)).

   **Nobody's fast tier drops verification.** Fast tiers cut breadth, passes and model size.
3. **Higher effort is not reliably better.** CodeRabbit's own test of Opus 5.5 Max against Standard: recall 62.5% vs 63.8%, precision 35.7% vs 38.6%, +58% tokens ([CodeRabbit 2026-09-22](https://www.coderabbit.ai/blog/opus-5-5-model-review)). Warden: higher effort is "not a strict superset" of lower ([benchmarking](https://warden.sentry.dev/benchmarking/)). This agrees with codegenie's own history: deep packets never produced a matched expectation in RV2's attention addendum, and `budgetBoost: 1.5` changed no outcome in RV3.
4. **Bugbot ran codegenie's ensemble experiment at scale and dropped voting.** V1 (July 2025) was 8 parallel passes in randomized order with a majority vote and a validator. In fall 2025 it became a single agent with more aggressive prompts, and resolution went from 52% to over 70% over 40 experiments ([Building a better Bugbot](https://cursor.com/blog/building-bugbot)). That is independent support for codegenie's K=1 decision, confounded by the simultaneous prompt change. An informal 51-run study found that voting "picks persistence, not correctness" and drops real bugs whose reported line drifts ([dev.to](https://dev.to/tauridev/i-had-a-local-llm-review-the-same-code-51-times-majority-voting-picks-persistence-not-correctness-4g15)).
5. **Nobody trusts raw LLM confidence.**
   - Greptile found LLM 1–10 severity filtering "nearly random" and replaced it with an embedding filter over voted comments ([Greptile 2024-12-18](https://www.greptile.com/blog/make-llms-shut-up)).
   - No product or paper publishes a calibration curve for review-finding confidence. Calibration for code reasoning needs labelled outcomes ([arXiv 2511.02197](https://arxiv.org/abs/2511.02197)).
   - Codex gates on **priority** instead: only P0 and P1 are posted to GitHub ([Codex GitHub docs](https://developers.openai.com/codex/integrations/github)).

   This is the strongest outside evidence on codegenie's composition-confidence cliff: `minConfidence: medium` gates on an uncalibrated number.
6. **Verification works only when it brings new evidence.**
   - Tencent's tool-grounded verification removed 94–98% of false positives across four model families ([arXiv 2601.18844](https://arxiv.org/html/2601.18844)).
   - ByteDance's second-stage filter added 8.5–15 precision points ([BitsAI-CR](https://arxiv.org/html/2501.15134v1)).
   - A same-context LLM judge had "minimal effect" at Atlassian ([RovoDev](https://arxiv.org/html/2601.01129v2)).
   - Reflexion-style self-critique raises recall but drops SNR from 5.11 to 1.95 ([CR-Bench](https://arxiv.org/html/2603.11078v1)).

   codegenie's Stage 9 is a tool-using, evidence-gathering verifier, which is the right kind.
7. **A harness transfers across model families, but its operating point does not.**
   - Factory (13 models, one harness, 3 runs) and Qodo (13 models, 38 configs) rank families in opposite orders. Newer models in a family can be worse (Factory: GPT-5.5 below GPT-5.2, Opus 4.7 below 4.6) ([Factory](https://factory.com/news/code-review-benchmark), [Qodo](https://www.qodo.ai/?p=22396)).
   - Greptile measured cross-model review (Claude-authored PRs reviewed by GPT and the reverse) at 60–62% P0/P1 recall, against 50–54% when a model reviews its own code. GPT "identified bugs in reasoning, then omitted them from the final review" ([model inversion](https://www.greptile.com/blog/model-inversion)).

   This matches RV3's complementarity finding. Multi-model robustness means measured per-model settings, not one tuned prompt.
8. **No neutral, decision-grade ranking exists.** Martian's open Code Review Bench (Feb 2026) shows the top 13 tools within about 8 F1 points on its online leaderboard ([repo](https://github.com/withmartian/code-review-benchmark), [live](https://codereview.withmartian.com/), read 2026-11-19). About 45% of GitHub's ReviewBench answer key came from Copilot ([GitHub](https://github.blog/news-insights/research/reviewbench-an-open-benchmark-for-ai-code-review/), [critique](https://runtimewire.com/article/github-launches-reviewbench-an-open-benchmark-for-ai-code-re-4528d7)). Vendor benchmarks reuse the same 50 PRs and flip rankings depending on whether false positives count. **Do not chase a leaderboard.** Use Martian's offline set as an outside sanity check next to the private evals; this is the cheap version of never-built plan 105.

## Per product

### Sentry Warden: the closest analogue

- **Architecture.** Warden is getsentry/warden, v0.54.0 released 2026-11-19, FSL-1.1-ALv2, launched 2026-02-02. It is TypeScript, and **Pi is its default runtime**. Deterministic orchestration runs up to a "runtime boundary", then one agent runs per (skill × hunk), with no whole-PR planning pass. Auxiliary lanes handle repair, verify, dedup and fix-eval, and each lane has its own model and effort. A merge lane combines cross-location findings. The GitHub Action splits analyze from report. Sources: [architecture](https://warden.sentry.dev/architecture/), [models](https://warden.sentry.dev/config/models/), [launch post](https://cra.mr/your-code-is-under-new-management).
- **Signal and noise.**
  - The per-finding read-only verifier's stance: "When reachability or impact is plausible but not fully proven, keep the finding and revise severity, confidence, or scope instead of rejecting it".
  - It **fails open** on parse or runtime errors, and `minConfidence` defaults to medium (`packages/warden/src/sdk/verify.ts`, `config/schema.ts` in the repo).
  - Its own benchmark attributes losses to the pipeline: 7 known bugs were lost to an array-vs-string schema field, and the merge "combined unrelated issues" ([benchmarking](https://warden.sentry.dev/benchmarking/)).
- **Fast and deep modes.**
  - **Content-keyed incremental review** (0.52.0, 2026-11-04). Hunks are matched on path plus body, not line numbers. The baseline fingerprint covers prompt, version and settings, and is trusted only from a named GitHub App. It refuses to skip if the prior run requested changes, lost findings or skipped files, and it fails open to a full review ([workflow](https://warden.sentry.dev/github/workflow/)).
  - Cheap deterministic pre-gates (regex and path) decide whether a hunk reaches a model at all.
- **Multi-model.** Each lane has its own model. Warden's benchmark: Sonnet 4.6 on Pi scored 25/86 for $19.84, against 24/86 for $103.59 on the Claude SDK runtime. These are vendor-run, single-run, security-only numbers, but they are outside evidence for codegenie's runtime choice.
- **Skills.** Markdown skills in the agentskills.io format. Field claim: over 100 previously unknown vulnerabilities, and about $1,000 of opus-4.7 for one authorization skill on Sentry's backend ([cra.mr 2026-04-28](https://cra.mr/finding-vulnerabilities-with-warden)).
- **Borrow:**
  - content-keyed incremental review, including its refusal conditions and fail-open (fast lane; see below);
  - reporting benchmark losses by pipeline stage, as codegenie's eval scorer already does;
  - per-lane model choice as the shape of #29, if that is ever built.
- **Don't borrow:**
  - per-(skill × hunk) agents without a planner (cost scales with skills × hunks, and the whole-PR view is lost);
  - a fail-open verifier that keeps findings when the verifier breaks (codegenie's degrade-and-disclose discloses instead).

### Claude Code: `/code-review` levels, ultra, and the managed Code Review

- **Local `/code-review` levels.**
  - From the docs: "At `low`, the review reports the findings it's most confident in … From `medium` through `max`, the review broadens coverage."
  - `--fix` applies findings through the user's permission mode, `--comment` posts inline comments, and `--max-findings` overrides the documented cap of 32. As of v2.1.328 it reports only bugs and CLAUDE.md violations, labelled Important, Pre-existing and Nit.
  - Since v2.1.274, models without tuned settings get "leaner inline review prompts … instead of spawning many review subagents": **per-model tuned recipes with a lean fallback**.
  - No per-level agent counts are published. A user-quoted xhigh recipe is "5+5 angles × 8 candidates × 1-vote verify → sweep → ≤15 findings" (July 2026; may be stale).
  - Sources: [docs](https://code.claude.com/docs/en/code-review-local), [CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md), [issue #78257](https://github.com/anthropics/claude-code/issues/78257).
- **Ultra** (`/code-review ultra`, formerly `/ultrareview`, added 2026-04-16). A research-preview cloud "fleet" review where "every reported finding is independently reproduced and verified". Runs typically take 5–15 minutes, with caps of 500 files and 8,000 lines. It costs about $5–25 per run after 3 free runs. It never starts on its own and shows a cost estimate before launch. `claude ultrareview` runs it from CI ([ultrareview docs](https://code.claude.com/docs/en/ultrareview)). The models it uses and how it "reproduces" findings are not published.
- **Managed Code Review** (research preview 2026-03-09, GA 2026-10-15).
  - Pipeline: Find, Verify, Rank, Post. It never builds or runs code.
  - Levels Quick, Standard and Deep; 6–10 minutes at GA; about $15–25 per review at launch.
  - Claims: "Fewer than 1% of findings are marked incorrect"; PRs with substantive comments went from 16% to 54%.
  - `REVIEW.md` is read **only from the base branch**, and suppressions apply only when that branch is protected.
  - Re-reviews cover only what changed, and output includes a CI-parsable severity JSON line.
  - Sources: [docs](https://code.claude.com/docs/en/code-review), [customize](https://code.claude.com/docs/en/code-review-customize), [launch](https://claude.com/blog/code-review), [GA](https://claude.com/blog/code-review-is-now-generally-available).
- **Open-source plugin recipe** (used with claude-code-action): a Haiku gate, then 2 Sonnet CLAUDE.md agents and 2 Opus bug agents, then one validation subagent per issue, then anything unvalidated is dropped. Its README still describes an older 0–100 confidence threshold of ≥80, which validation agents have since replaced ([command](https://github.com/anthropics/claude-plugins-official/blob/main/plugins/code-review/commands/code-review.md)). Anthropic moved off a confidence threshold to per-finding validation, the same direction as finding 5.
- **Borrow:**
  - the **cost estimate and consent before an expensive run** (codegenie has budgets but no up-front estimate);
  - **per-model tuned settings with a lean fallback** for unmeasured models (multi-model robustness);
  - re-review of only what changed;
  - a CI-parsable severity line.
- **Don't borrow:** the vendor-locked fleet (no Bedrock, Vertex or ZDR) and its unpublished internals, which can't be checked.
- **Already matched.** codegenie reads repository config and skills from the checkout, and the example workflow checks out the **base** SHA (`examples/workflows/codegenie-review.yml:42–46`). Repo `codegenie.toml` cannot set user-scoped or credential keys (`src/config/config-loader.ts:449,559`). This matches Anthropic's base-branch rule, verified (me). On the comment lane, `base.sha` is empty and the checkout falls back to the default branch.

### OpenAI Codex review

- **Architecture.** One trained reviewer agent with repository access and execution. It emits structured JSON: priority P0–P3, `confidence_score` and an `overall_correctness` verdict. GitHub posts only P0 and P1. The rubric is open source and its bug bar includes "one must identify the other parts of the code that are provably affected" ([rubric.md](https://github.com/openai/codex/blob/main/codex-rs/prompts/templates/review/rubric.md)).
- **Signal and noise.** OpenAI's alignment post (2025-12-01) says they traded "modestly reduced recall" for trust. Extra compute "mainly improves calibration and reduces false alarms", and 52.7% of comments get addressed with a code change ([alignment post](https://alignment.openai.com/scaling-code-verification/)).
- **Rules.** `AGENTS.md` "Code Review Rules" are path-scoped and cited in findings. On an eval with known violations plus safe counterexamples, rule-guided review recovered 98% of required custom findings against a 58.3% baseline ([dev blog](https://developers.openai.com/blog/custom-code-review-rules-for-codex)). The docs don't say which branch `AGENTS.md` is read from.
- **Borrow:**
  - the **severity/priority gate as the publication rule**, in place of an uncalibrated confidence threshold;
  - the open rubric's bug bar as prompt text for Stage 7 and Stage 9 (cheap to A/B);
  - the eval design of **violations plus safe counterexamples** for skills (it measures false positives, not just recall).
- **Don't borrow:** the trained-model route, which costs model portability.

### GitHub Copilot code review

- **Architecture.** Agentic, with tool calling on Actions runners (GA 2026-03-05). Effort tiers:
  - Lite, about $0.25;
  - Balanced (default), about $1.50;
  - **Max**, about $10: independent agents on models from different providers, reconciled by an aggregation agent;
  - Adaptive: risk-based, capped by an admin.

  GitHub reports that 29% of reviews post nothing, with about 5.1 comments per review. The model is locked ("Model switching is not supported"). Sources: [docs](https://docs.github.com/en/copilot/concepts/agents/code-review), [Max](https://github.blog/changelog/2026-10-28-copilot-code-review-merge-with-confidence-with-max-and-approvals), [60M blog](https://github.blog/ai-and-ml/github-copilot/60-million-copilot-code-reviews-and-counting/).
- **Rules and trust.** It reads `copilot-instructions.md`, path-scoped `*.instructions.md`, `AGENTS.md`, skills, MCP and Memory **from the PR head branch**, and it can approve PRs (opt-in) ([customize](https://docs.github.com/en/copilot/tutorials/customize-code-review)).
- **Borrow:**
  - "post nothing" as a first-class outcome (codegenie already has honest no-finding reports, plan 123);
  - thread resolution reasons (Addressed, Won't fix, Incorrect) as dogfood telemetry;
  - multi-provider Max as evidence that a cross-family deep tier is commercially credible (RV3 complementarity).
- **Don't borrow:** head-branch instructions (a PR can weaken its own review), and model-driven approval.

### CodeRabbit

- **Architecture.** Verification agents generate grep and ast-grep scripts to confirm premises ([2025-09-05](https://www.coderabbit.ai/blog/how-coderabbit-delivers-accurate-ai-code-reviews-on-massive-codebases)). Other context sources: `.coderabbit.yaml` path instructions, learnings taken from replies, and AGENTS.md, CLAUDE.md and `.claude/rules` ([config](https://docs.coderabbit.ai/reference/configuration)). The CLI has `--light` and `--deep` modes. A task-graph planner and a 7–8-model ensemble are described only by a third party ([The AI Engineer](https://theaiengineer.substack.com/p/how-coderabbit-actually-works)), not by CodeRabbit.
- **Signal evidence.** In CodeRabbit's own GPT-5.5 eval, precision was 11.6–13.2% on a large real-world set ([2026-04-23](https://www.coderabbit.ai/blog/gpt-5-5-benchmark-results)). An independent field study found CodeRabbit comments 36.4% accepted and 56.3% rejected, with 58% of the rejections being false positives, redundant or out of scope ([arXiv 2607.03316](https://www.alphaxiv.org/abs/2607.03316v1)).
- **Borrow:** deterministic premise checks (grep or AST) as verifier evidence. codegenie's Stage 9 already has repository tools; the idea is to make the "premise confirmed" verdict cite the tool result.
- **Don't borrow:** running repository-configured linters in a sandbox. It reportedly led to a CodeRabbit remote-code-execution exploit in August 2025; I saw that only in search summaries.

### Greptile

- **Architecture.** A graph and wiki index of the codebase, then v3 agentic review and the v5 hypothesis swarm. TREX adds a per-issue execution sandbox (June 2026). Severity is P0–P2 with a PR-level confidence of 0–5 ([docs](https://www.greptile.com/docs/llms.txt), [v5](https://www.greptile.com/blog/greptile-v5), [TREX](https://www.greptile.com/blog/trex-code-execution)).
- **Signal and noise.** An embedding filter over past up- and down-voted comments took the address rate from 19% to over 55% ([2024-12-18](https://www.greptile.com/blog/make-llms-shut-up)). Its recall-only benchmark (Greptile 82%, Bugbot 58%, CodeRabbit 44%) flips once false positives are scored ([Greptile](https://www.greptile.com/benchmarks) vs [Augment](https://www.augmentcode.com/blog/we-benchmarked-7-ai-code-review-tools-on-real-world-prs-here-are-the-results)).
- **Multi-model.** "Model Inversion" routes Claude-authored PRs to GPT and vice versa (see bottom line 7).
- **Borrow:**
  - the "a comment can raise the tier but not lower it" rule, if a fast lane is ever triggerable from a comment;
  - a cross-family reviewer as a **measured experiment** only. The gain is 2–3 points and vendor-reported.
- **Don't borrow:** a hosted feedback-memory store. codegenie has no feedback corpus, and skills are the inspectable equivalent.

### Graphite Agent (formerly Diamond)

Renamed in October 2025, and Cursor acquired Graphite in December 2025 ([Cursor](https://cursor.com/blog/graphite)). It claims a negative-comment rate under 5% ([features](https://graphite.com/features/ai-reviews)). A competitor benchmark puts its catch rate at 6% (3 of 50) ([Greptile benchmarks](https://www.greptile.com/benchmarks), vendor). I found no 2026 reviewer development, and the primary launch posts now return 404.
- **Lesson:** optimizing for low noise alone collapses recall. **Don't** adopt the negative-comment rate as a target.
- **Borrow:** per-exclusion "issues caught" counts. Every suppression rule should report how often it fired, which would also make codegenie's note-suppression tiers auditable.

### Cursor Bugbot

- **Architecture.** It began as 8-pass voting with a validator and became a single agent (see bottom line 4). Since June 2026 it runs on Cursor's Composer 2.5 ([June 2026](https://cursor.com/blog/bugbot-updates-june-2026)).
- **Rules and filtering.**
  - `.cursor/BUGBOT.md` is found by walking up from the changed files, with caps of 30k characters per rule and 100k in total.
  - `bugbot.yaml` policy is read from the base branch, and YAML can lower autofix but not raise it.
  - **Rule-citation filtering** (2026-10): "Findings that cite a rule the diff breaks are kept even if the PR calls the change intentional. Findings citing rules the diff doesn't break are filtered out."
  - "Smart" effort routes from title, author, repository and a trimmed diff, and **deliberately ignores the PR description**.
  - Sources: [docs](https://cursor.com/docs/bugbot), [release notes](https://cursor.com/docs/release-notes/bugbot).
- **Metric.** Resolution rate is judged by an LLM at merge, about 78–80%. Bugbot also publishes a cross-vendor table (Greptile 63.5, CodeRabbit 49.0, Copilot 46.7, Codex 45.1) ([learned rules](https://cursor.com/blog/bugbot-learning)). The metric is precision-like and blind to misses.
- **Borrow:**
  - rule-citation verification: a skill-guided finding survives Stage 9 only if the diff actually breaks the rule it cites;
  - **treating the PR description as untrusted framing.** Framing a change as bug-free cuts vulnerability detection by 16–93%, and redaction plus explicit instruction restores it ([arXiv 2603.18740](https://arxiv.org/html/2603.18740v1)). codegenie feeds the PR body into the planner (`prompt-builder.ts:233,477`, up to 1,600 characters) and into the intent signals that drive "intentional change" framing and severity capping (`intent-signals.ts:129–131`, plans 31 and 82). That is exactly this attack surface. Verified (me); impact on codegenie is unmeasured.
- **Don't borrow:** majority voting; learned rules that activate automatically.

### Qodo (commercial) and PR-Agent (open source)

- **Qodo.** Specialist agents plus a judge. Auto depth routing goes up when unsure (bottom line 2). Rule Miner counts only comments that were accepted and fixed, weights them by reviewer ownership, and adds at most 10 and then 5 rules per two weeks. It imports Agent Skills `SKILL.md` in either "rules enforcement" or "skill steering" mode ([Rule Miner](https://docs.qodo.ai/governance/rule-enforcement/rule-miner), [skills](https://docs.qodo.ai/governance/manage-skills-across-repositories)).
- **PR-Agent** (16.4k stars; handed to the community on 2026-04-23, [Qodo blog](https://www.qodo.ai/blog/qodo-is-handing-pr-agent-over-to-the-community/)).
  - It is **single-shot by design**: "dispatches single-shot model calls" with "no tool-use loop".
  - It uses compression and dynamic context, and opt-in chunking with a conservative merge: "never less alarming than the worst chunk". `num_max_findings` is 6 ([review](https://docs.pr-agent.ai/commands/review/)).
  - On unreleased main, `/improve` runs `/review`, and the 0–10 self-reflection scoring pass is gone (it had a fail-open default of 7) ([v0.50.0](https://github.com/The-PR-Agent/pr-agent/blob/v0.50.0/docs/docs/core-abilities/self_reflection.md) vs [main](https://github.com/The-PR-Agent/pr-agent/blob/main/docs/docs/core-abilities/self_reflection.md)).
  - Its merge verdict is deterministic, and the model "may only veto a clean result, never raise a blocked one" (`pr_agent/algo/merge_verdict.py`).
  - A field study at Beko found 73.8% of comments resolved, but PR closure time rose ([arXiv 2412.18531](https://arxiv.org/html/2412.18531v2)).
- **Borrow:**
  - "route up when unsure" for any automatic tier choice;
  - accepting the `SKILL.md` layout for repository skills (reusing an existing convention);
  - the veto-only model pattern for any merge or approve gate. That is directly relevant to PR #40 approve mode (RV4 H3/H4).
- **Don't borrow:** single-shot diff-only review as the fast lane's core. It has no tools and no verifier, and PR-Agent's own maintainers removed its one self-check.

### Kodus and the smaller OSS harnesses

- **Kodus** is the most sophisticated OSS staged reviewer.
  - Risk-routed modes (deep runs separate bug, security and performance agents; fast skips the recall pass).
  - A verifier that drops a finding only on explicit refutation.
  - A **fail-closed claim checker**: "'I could not check' is never 'I checked and it holds'".
  - Findings outside the hunk are dropped rather than re-anchored. Repository instructions are read from the target branch.
  - The strongest OSS eval discipline found: production code only, paired act and must-not cases, floors set from repeated runs, paired bootstrap 95% CIs, and "ships only if no model got worse and one is better" ([evals README](https://github.com/kodustech/kodus-ai/blob/main/evals/README.md)).
- **Others** mostly show what to avoid:
  - Shippie also runs on Pi, but a single agent posts comments through a tool and has `bash` ([shippie](https://github.com/mattzcarey/shippie)).
  - claude-code-security-review fails open (confidence 10.0 on an API error) and is "not hardened against prompt injection" ([repo](https://github.com/anthropics/claude-code-security-review)).
  - The agent-runner actions ([claude-code-action](https://github.com/anthropics/claude-code-action), [codex-action](https://github.com/openai/codex-action), [run-gemini-cli](https://github.com/google-github-actions/run-gemini-cli)) let the model post.
  - Persona-debate reviewers.
- **Borrow:** Kodus's eval acceptance rule, which is the missing piece in codegenie's history note (no-regression on every model plus one improvement, with CIs from repeats), and its fail-closed claim check. codegenie's "drop out-of-hunk rather than re-anchor" already exists in spirit, since plan 76's representative-anchor fabrication was deleted.

## Benchmarks and measurement: what codegenie should adopt

From the independent evidence: SWR-Bench, CR-Bench, the field studies, Martian, Factory and Kodus.

- **Headline metric.** Recall on seeded bugs, broken down by severity and category. Add **clean PRs** to measure noise directly; SWR-Bench has 500 ([SWR-Bench](https://arxiv.org/html/2509.01494v2)).
- **Repeats.** At least 3 runs per arm with mean ± sd and paired comparisons. SWR-Bench shows that aggregating 5–10 runs raises recall by up to 119%, so single runs understate what a configuration can find and overstate differences between arms.
- **Dogfood.** Use a deterministic acted-on metric: ByteDance's Outdated Rate, whether the anchored lines changed before merge ([BitsAI-CR](https://arxiv.org/html/2501.15134v1)). codegenie's Action already knows the anchors.
- **Outside sanity check.** Use Martian's offline set next to the private eval cases. It gives a signal from other languages and domains at a fraction of plan 105's projected $400–2,000.
- **Don't adopt:** recall-only scoring, single-run scoring, or leaderboard rank as a target.

## Fast-lane implications (shared with @architect-2)

| Lever | Who does it | Evidence | Fit for codegenie |
| --- | --- | --- | --- |
| Content-keyed incremental re-review | Warden (path plus body; refuses to skip when prior run requested changes, lost findings or skipped files; fails open), Anthropic managed (changed-only re-review), Bugbot (patch-ID skip) | No published recall cost; the benefit is fewer packets on re-push | **Best fit.** Deterministic, no new model judgment, reuses packet identity. Also overlaps GitHub #30: a correct content key is also the cache key the issue says is missing. Kill if a re-push review misses a finding the full review catches on the same head, across N paired runs. |
| Risk router that routes up when unsure | Qodo Auto, Kodus, Copilot Adaptive, Bugbot smart, Greptile Auto | Vendor claims only | Plausible later, but the planner already does depth routing per hunk. A PR-level router adds a second decision-maker; "don't let the planner drive control flow" (plan 66) applies twice over. |
| Fewer passes or less breadth, verifier kept | Every vendor's fast tier | CodeRabbit Max vs Standard; Warden "not a superset"; codegenie RV2/RV3 | Consistent with @architect-2's option A (`--depth light`). No vendor's fast tier drops verification. |
| Single-shot, no tools, no verifier | PR-Agent | Beko: 73.8% resolved but slower closure; PR-Agent removed its own self-check | Do not use as the fast lane; at most as a triage pre-gate. RV2: deep amplification did not decide outcomes, but verification did. |
| Severity gate (P0/P1 only) | Codex | Vendor (52.7% addressed) | A fast lane could publish only high/critical findings. That is a publication rule, not a new threshold, and it **reuses** the existing severity field. |
| Cheap or other-family model | Copilot Lite, Bugbot low, Greptile Base | Factory/Qodo: operating point does not transfer | Needs per-model measured settings (bottom line 7). This is @architect-2's option D. |

## Ranked borrow list (each needs a measurement and a kill criterion)

1. **Publish on severity, and treat confidence as advisory until it is calibrated** (Codex, Anthropic validation agents, Greptile, arXiv 2511.02197). It reuses existing fields and attacks the confidence cliff directly.
   - **Measure:** replay retained private case A runs 52–57 and private case B through composition under both rules. Count found-but-unpublished true positives and newly published adjudicated false positives.
   - **Kill:** more than 0 new adjudicated material false positives per case across N runs.
   - **Caveat from @architect-2:** gates whose job is precision register zero rescues by design. Judge them by counterfactual replay plus adjudicated harmful publishes, not by rescue counts.
2. **Content-keyed incremental review** (Warden). Measure and kill as in the fast-lane table.
3. **Treat the PR description as untrusted framing** (arXiv 2603.18740, Bugbot smart). Run the eval cases with the PR body redacted from intent signals.
   - **Kill:** recall unchanged and intent framing visibly worse.
   - Related: Bugbot's rule that a finding citing a broken rule survives an "intentional" claim.
4. **Rule-citation verification for skill-guided findings** (Bugbot 2026-10). Stage 9 keeps a skill-cited finding only if the diff breaks the cited rule. Measure with violation plus safe-counterexample skill fixtures (Codex's eval design).
5. **Per-model operating-point profiles filled only from eval runs** (Anthropic's per-model recipes with lean fallback; Factory, Qodo). This replaces "one prompt tuned on opus". Defining every enum and decision rule (RV3 L21–22) is the zero-cost first step.
6. **Eval protocol:** Kodus's acceptance rule plus repeats, Martian's offline set as a second corpus, and clean PRs for noise. This is the cheap version of plan 105.
7. **A cost estimate before expensive runs** (ultra). Budgets already exist in `maxBudgetTokens`; this would surface an estimate before the run starts.
8. **Accept the `SKILL.md` layout for repository skills** (Qodo, Warden's agentskills.io). Reuses an existing convention. Low value until users ask.

## Deliberately do not borrow

- Majority voting or a blanket ensemble (Bugbot dropped it; the 51-run study; codegenie's own K=1 decision).
- Model self-scored 1–10 severity or confidence as a filter (Greptile: "nearly random").
- Reflexion or self-critique loops (CR-Bench SNR collapse).
- Instructions or skills read from the PR head branch (Copilot). codegenie already uses base.
- Model-authored approval or merge decisions (Copilot opt-in; PR-Agent's deterministic veto-only verdict is the safe form).
- Executing repository-configured tools on untrusted PR code (CodeRabbit RCE, Shippie `bash`).
- Fine-tuned or vendor-locked reviewer models (Codex, Composer 2.5); they cost model portability.
- Hosted feedback memory or rules that activate automatically from reactions, before dogfood shows rejection patterns that skills can't encode.
- A low negative-comment rate as the optimization target (Graphite).
- Leaderboard rank as a goal.

## Gaps

- Anthropic does not publish agent counts, models or finding caps for `/code-review` levels, ultra, or Quick/Standard/Deep.
- CodeRabbit's internals come from a third party.
- Graphite's primary posts return 404.
- Martian's offline numbers were seen only through a vendor reproduction ([CodeAnt](https://codeant.ai/blogs/ai-code-review-benchmark-results-from-200-000-real-pull-requests)).
- No source isolates the effect of comment caps, dedup or voting on their own.
- No source measures verifier-induced false negatives.
- OpenAI's GPT-5 vs GPT-5-Codex comment numbers came only from search snippets (openai.com returned 403) and are not used here.
