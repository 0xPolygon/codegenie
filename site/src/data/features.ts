export interface Feature {
  title: string;
  body: string;
  /** Short mono label rendered above the title. */
  tag: string;
}

/** Six cards for §7.6 of PLAN.md. */
export const features: Feature[] = [
  {
    tag: "cli",
    title: "Review anything",
    body: "Branches, commits, ranges, or a GitHub PR with --pr — no checkout needed, fork PRs included. The report prints to stdout as Markdown.",
  },
  {
    tag: "models",
    title: "Any model, any provider",
    body: "1,103 models across 37 providers: Anthropic, OpenAI (API key or ChatGPT-plan OAuth), Google, Bedrock, Azure, OpenRouter, Groq, and more. Models swap underneath; the harness stays.",
  },
  {
    tag: "skills",
    title: "Skills travel with the repo",
    body: "Eight bundled skills (core review, tests, Go, TypeScript, JavaScript, Rust, Python, Solidity). Add your own in .codegenie/skills/ as Markdown: concrete checks, false-positive rules, safe patterns. Skills are checks, not personas.",
  },
  {
    tag: "context",
    title: "Focused context, targeted tools",
    body: "tree-sitter (WASM, no native toolchain) indexes symbols so reviewers get small dense packets plus read-only tools like read_symbol, find_definition, and find_likely_tests — instead of a 100k-token diff.",
  },
  {
    tag: "evals",
    title: "Built to be evaluated",
    body: "codegenie eval replays real repos against expected findings and scores every miss by loss stage. Review quality should be measurable, not vibes.",
  },
  {
    tag: "security",
    title: "Security-minded by design",
    body: "A PR is attacker-controlled input flowing into tool-equipped LLMs. Tools are read-only, the Action checks out the trusted base SHA, and codegenie never approves or requests changes — comments only.",
  },
];