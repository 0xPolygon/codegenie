/**
 * Every command and config snippet shown on the page, kept in one place so the
 * rendered copy can be diffed against the codegenie README (v0.5.1).
 *
 * NOTE: `\${` is an escaped `${` — these are literal shell/GitHub Actions
 * expressions, not JS template interpolations.
 */

export const installCommand = `npm install -g @0xsequence/codegenie`;

export const installAltCommand = `npx @0xsequence/codegenie --help`;

export interface QuickStartStep {
  step: number;
  title: string;
  body: string;
  code: string;
}

export const quickStartSteps: QuickStartStep[] = [
  {
    step: 1,
    title: "Connect a model provider",
    body: "Pick one. OAuth is the default; --api-key stores a key instead.",
    code: `codegenie provider login anthropic --api-key   # Anthropic API key
codegenie provider login openai-codex          # ChatGPT plan (browser OAuth)
codegenie provider login openai --api-key      # OpenAI API key`,
  },
  {
    step: 2,
    title: "Pick your default model",
    body: "Fuzzy-matched, so a short name is enough. It prints what it picked.",
    code: `codegenie provider use opus       # -> anthropic/claude-opus-5
codegenie provider use gpt-5.5    # -> openai-codex/gpt-5.5`,
  },
  {
    step: 3,
    title: "Review your current branch",
    body: "The report prints to stdout as Markdown.",
    code: `codegenie review`,
  },
];

export const reviewTargets = `codegenie review --pr 123              # a GitHub PR — no checkout needed, fork PRs included
codegenie review feat                  # branch vs resolved base
codegenie review abc1234 def5678       # a commit range
codegenie review master...49f4645b     # shorthand for --base master --head 49f4645b`;

export const actionYaml = `name: codegenie review
on:
  pull_request:
    types: [opened, synchronize, ready_for_review]
permissions:
  contents: read
  pull-requests: write
  issues: write
concurrency:
  group: codegenie-review-pr-\${{ github.event.pull_request.number }}
  cancel-in-progress: true  # newest event wins; a push supersedes the stale review
jobs:
  review:
    runs-on: ubuntu-latest
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@v7
        with:
          ref: \${{ github.event.pull_request.base.sha }}  # trusted base; PR head is fetched as review data
          fetch-depth: 0
      - uses: 0xPolygon/codegenie@v0.5.1
        with:
          model: "anthropic/claude-opus-5:high"
          llm-api-key: \${{ secrets.LLM_API_KEY }}`;

export const quickStartFootnote =
  "Credentials and defaults live under ~/.codegenie/, never in the repository. A review with findings is a successful review: the exit code is 0 either way.";

export const actionBullets = [
  "Runs on pull_request open / synchronize / ready_for_review — or on demand when a collaborator comments `codegenie review` on a PR.",
  "One status comment live-updates through the pipeline stages and finishes as the full report; findings post inline as a COMMENT-type review alongside it.",
  "All authorization — exact trigger-phrase match, live write-permission check — happens inside codegenie; the workflows contain no gating logic to drift.",
  "Costs are the usual two: GitHub Actions minutes and provider tokens.",
] as const;