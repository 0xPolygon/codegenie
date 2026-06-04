---
status: complete
---

# codeninja

codeninja is a code-reviewing AI harness and agent with configurable reviewing skills.

The goal is to build a high-quality code-reviewing agent that can review pull requests and give sound advice to developers. It should review code at a top-tier staff engineer level, with a focus on finding bugs, logical errors, poor architectural patterns, performance issues, and other meaningful problems. The review output should avoid fluff and nitpicks.

The system will include bundled skills and user-facing review lenses. A skill is the executable review unit: prompt, tools, schema, examples, filters, and concrete checks. A lens is the review perspective exposed to users, such as Go correctness, TypeScript correctness, security, API design, performance, architecture, database, concurrency, or tests. A lens may map to one or more skills. Skills should not be mostly persona; the best skills should encode concrete checks, false-positive rules, examples, safe patterns, and severity guidance tied to impact. Later, developers should be able to pass in their own bundled skills or lenses to give the reviewer additional expertise.

codeninja should be built in TypeScript and run as a CLI.

codeninja should focus on reviewing any git repository. It should also support referencing a GitHub pull request by PR number, but GitLab support is not an initial goal.

The first version should output clean, structured Markdown to stdout and also be able to post inline comments directly on a GitHub PR.

A successful review finds real correctness, security, and design issues; explains the impact; cites the relevant code; and avoids style nits unless they hide meaningful risk. By default, codeninja should avoid comments about formatting, naming, or subjective style. Style and lint-oriented review should only run when explicitly configured, potentially through a `codeninja.toml` file, a lint mode, or language-specific lint skills such as a Go lint skill.

codeninja will use `pnpm` for package management and `@earendil-works/pi-ai` as the LLM/agent library. It may also use tools such as `web-tree-sitter` and custom repository-inspection tools to query source structure, symbols, references, and relationships between changed code and surrounding code.

The implementation should use deterministic preprocessing wherever practical. The diff parser, syntax parser, changed-symbol extraction, hunk-to-line mapping, and review-packet construction should produce structured artifacts before the LLM reviews anything. Tree-sitter should be treated as the common cross-language syntax substrate: useful for finding enclosing symbols, changed AST nodes, imports, nearby declarations, and syntax-specific signals across languages such as Go, TypeScript, Rust, Solidity, and others. It should not be treated as perfect semantic truth. When a language has a stronger optional analyzer, such as `gopls`, `go/packages`, TypeScript compiler APIs, or Rust Analyzer, codeninja may use it to enrich the same common symbol/tool interface, but the product should remain useful with tree-sitter-only support.

The preferred review design is a staged pipeline:

1. Whole-PR planning pass: understand intent, changed files, changed symbols, risk areas, architecture boundaries, and tests touched or missing. This pass chooses the review order and selects relevant lenses based on risk tags, language, changed symbols, and touched subsystems; codeninja should not run every lens on every hunk by default.
2. Parallel hunk/file review passes: generate precise inline candidate findings anchored to changed lines.
3. Cross-file/system pass: inspect interactions across changed files, call sites, interfaces, migrations, tests, and architecture.
4. Verifier/deduper pass: reject speculative comments, merge duplicates, and publish only high-signal findings.

The unit of review should be the changed hunk, but the unit of understanding should be the affected system. The review flow should look like:

```text
PR diff
  -> PR summary / risk map
  -> changed symbol graph
  -> per-hunk / per-file review packets
  -> targeted repo exploration tools
  -> candidate findings
  -> independent verifier
  -> deduped staff-level review
```

codeninja should not dump the whole repository into model context. Instead, it should provide focused diff packets plus tools to inspect the repository as needed. This avoids attention dilution and keeps the reviewer focused on relevant code while still allowing deeper system exploration when a finding requires it.

Inline GitHub findings should almost always anchor to changed lines because PR review comments are tied to the pull request diff. Candidate findings should carry a validated GitHub anchor with path, line, side, hunk identity, and diff position or commit metadata when available. Broader architectural, systemic, or non-diff-local concerns may still be included in the stdout report or PR review body when they cannot be accurately attached to a changed line.

The final composer should prefer no comments over weak comments. By default, it should publish a small number of high-signal comments, roughly 3-7 per PR, but this should be a soft cap: verified critical and high-severity findings should not be hidden just to satisfy the default limit.
