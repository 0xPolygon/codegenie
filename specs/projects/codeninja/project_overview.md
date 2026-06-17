---
status: complete
---

# codeninja

codeninja is a code-reviewing AI harness and agent with configurable reviewing skills.

The goal is to build a high-quality code-reviewing agent that can review pull requests and give sound advice to developers. It should review code at a top-tier staff engineer level, with a focus on finding bugs, logical errors, poor architectural patterns, performance issues, and other meaningful problems. The review output should avoid fluff and nitpicks.

The system will include bundled skills and user-facing review lenses. A skill is the review knowledge unit: a Markdown file of concrete checks, false-positive rules, safe patterns, examples, and severity guidance tied to impact; the harness owns prompts, tools, and output schemas. A lens is the review perspective exposed to users, such as Go correctness, TypeScript correctness, security, API design, performance, architecture, database, concurrency, or tests. A lens may map to one or more skills. Skills should not be mostly persona; the best skills encode concrete checks rather than character description. Developers can add their own repo-local Markdown skills to give the reviewer additional expertise, with executable skill packages as a possible future extension.

codeninja should be built in TypeScript and run as a CLI.

codeninja should focus on reviewing any git repository. It should also support referencing a GitHub pull request by PR number, but GitLab support is not an initial goal. Reviewed source should target the actual base/head revisions through git, so codeninja can review a PR or branch that is not checked out and source reads are unaffected by local working-tree state. Review policy, config, and skills should still load from the trusted local checkout.

The first version should output clean, structured Markdown to stdout and also be able to post inline comments directly on a GitHub PR.

Review quality should be measurable, not vibes: codeninja should support local telemetry and run artifacts for reviews when enabled, and ship an eval system that always captures artifacts and can attribute every missed or lost finding to the pipeline stage that lost it. The eval suite, skills, and telemetry are the compounding assets; models are swappable underneath them.

Because codeninja reviews attacker-influenced content and can post publicly, it must treat reviewed content as data rather than instructions, contain repository tools to the repository root, and never let repo-resident configuration enable command execution or posting on its own.

A successful review finds real correctness, security, and design issues; explains the impact; cites the relevant code; and avoids style nits unless they hide meaningful risk. By default, codeninja should avoid comments about formatting, naming, or subjective style. Style and lint-oriented review should only run when explicitly configured, potentially through a `codeninja.toml` file, a lint mode, or language-specific lint skills such as a Go lint skill.

codeninja will use `pnpm` for package management and `@earendil-works/pi-ai` as the LLM/agent library. It may also use tools such as `web-tree-sitter` and custom repository-inspection tools to query source structure, symbols, references, and relationships between changed code and surrounding code.

codeninja should include a `codeninja provider` CLI namespace for model-provider setup: listing Pi-known providers and models, logging in or out of a provider, checking auth status, and setting user-level default provider/model/depth/reasoning preferences. Credentials and model defaults should live in user-scoped codeninja state, such as `~/.codeninja/`, not in repo configuration.

The implementation should use deterministic preprocessing wherever practical. The diff parser, syntax parser, changed-symbol extraction, hunk-to-line mapping, and review-packet construction should produce structured artifacts before the LLM reviews anything. Tree-sitter should be treated as the common cross-language syntax substrate: useful for finding enclosing symbols, changed AST nodes, imports, nearby declarations, and syntax-specific signals across languages such as Go, TypeScript, Rust, Solidity, and others. It should not be treated as perfect semantic truth. When a language has a stronger optional analyzer, such as `gopls`, `go/packages`, TypeScript compiler APIs, or Rust Analyzer, codeninja may use it to enrich the same common symbol/tool interface, but the product should remain useful with tree-sitter-only support.

The preferred review design is a staged pipeline:

1. Whole-PR planning pass: understand intent, changed files, changed symbols, risk areas, architecture boundaries, and tests touched or missing. This pass chooses the review order and selects relevant lenses based on risk tags, language, changed symbols, and touched subsystems; codeninja should not run every lens on every hunk by default.
2. Parallel hunk/file review passes: generate precise inline candidate findings anchored to changed lines.
3. Optional cross-file/system follow-up: resolve repeated scoped follow-up questions from packet reviewers. The broad system pass that proactively inspects interactions across changed files, call sites, interfaces, migrations, tests, and architecture is deferred; the shipped stage only runs when repeated hints justify it.
4. Verifier/deduper pass: reject speculative comments, merge duplicates, and publish only high-signal findings.

The unit of review should be the changed hunk, but the unit of understanding should be the affected system. The review flow should look like:

```text
PR diff
  -> file filtering / classification
  -> PR summary / risk map / coverage plan
  -> file facts + changed-symbol extraction
  -> per-hunk / per-file review packets
  -> selected lenses + targeted repo tools
  -> candidate findings
  -> cross-file follow-up hints recorded
  -> optional repeated-hint system follow-up
  -> independent verifier
  -> deduped staff-level review
```

codeninja should not dump the whole repository into model context. Instead, it should provide focused diff packets plus tools to inspect the repository as needed. This avoids attention dilution and keeps the reviewer focused on relevant code while still allowing deeper system exploration when a finding requires it.

Every changed hunk should receive an explicit review coverage decision or a skip reason, so large or partial reviews remain honest and inspectable.

Inline GitHub findings should almost always anchor to changed lines because PR review comments are tied to the pull request diff. Candidate findings should carry a validated GitHub anchor with path, line, side, hunk identity, and diff position or commit metadata when available. Broader architectural, systemic, or non-diff-local concerns may still be included in the stdout report or PR review body when they cannot be accurately attached to a changed line.

The final composer should prefer no comments over weak comments. By default, it should publish a small number of high-signal comments, roughly 3-7 per PR, but this should be a soft cap: verified critical and high-severity findings should not be hidden just to satisfy the default limit.
