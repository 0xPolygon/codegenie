/**
 * Single source of truth for every URL, name, and stat shown on the page.
 * Change the npm scope or Action ref here and the whole site follows.
 */

export const site = {
  name: "codegenie",
  title: "codegenie — AI code review harness",
  tagline: "AI code review that prefers no comments over weak comments.",
  description:
    "codegenie is an AI code review harness that reviews PR-style diffs at a staff-engineer level — real bugs, logic errors, security issues, architectural risks, and missing tests — and avoids wasting your attention on nitpicks.",

  // Repo / distribution. Update `npmPackage` when it leaves the @0xsequence scope.
  repo: "https://github.com/0xPolygon/codegenie",
  npmPackage: "@0xsequence/codegenie",
  npmUrl: "https://www.npmjs.com/package/@0xsequence/codegenie",
  actionRef: "0xPolygon/codegenie@v0.5.1",
  license: "MIT",
} as const;

/** Deep links into repo files referenced from the footer / body copy. */
export const links = {
  models: `${site.repo}/blob/master/models.md`,
  workflows: `${site.repo}/tree/master/examples/workflows`,
  license: `${site.repo}/blob/master/LICENSE`,
  install: "#quick-start",
  howItWorks: "#how-it-works",
  githubAction: "#github-action",
} as const;

export const stats = [
  { value: "1,103", label: "models" },
  { value: "37", label: "providers" },
  { value: "6", label: "languages" },
  { value: "11", label: "stage pipeline" },
] as const;

export const languages = [
  "Go",
  "TypeScript",
  "JavaScript",
  "Rust",
  "Python",
  "Solidity",
] as const;

export const providers = [
  "Anthropic",
  "OpenAI",
  "Google",
  "Amazon Bedrock",
  "Azure",
  "OpenRouter",
  "Groq",
  "Mistral",
  "xAI",
  "DeepSeek",
  "Fireworks",
  "Together",
] as const;

export const providerOverflow = "+25 more";

export const polygonUrl = "https://polygon.technology";