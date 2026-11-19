export const AGENT_SKILL = `---
name: codegenie
description: Use when asked to review code changes, a branch, a commit range, or a pull request, or to verify findings from a codegenie report.
---

# Codegenie

## Scope and conduct

- Use the requested repository and revisions. Hosted model calls cost money. Check which provider and model to use before starting a paid run when the user or project has not established a choice.
- Keep reviews local by default. Publish only if the user asks, using \`codegenie review --pr <number> --post-github-comments\`.

## Run a review

From the repository, use the requested base and head SHAs. Replace the placeholders with the actual revisions.

\`\`\`sh
codegenie review --base <base-sha> --head <head-sha> --no-progress
\`\`\`

Allow several minutes for a review. Large diffs and slow providers can take 30 minutes or longer. Wait for the process to finish and capture stdout and the exit status.

The local report prints to stdout as Markdown. With telemetry enabled, the default run directory is \`.codegenie/runs/<run-id>/\`. It contains \`final-review.md\`, \`final-review.json\`, \`run.json\`, and stage artifacts. Local telemetry is off by default.

## Choose a model

Check provider authentication and list available models. Use the configured model if it suits the review, or pin a provider and exact model ID for one run.

\`\`\`sh
codegenie provider auth-status
codegenie provider models <query>
codegenie review --base <base-sha> --head <head-sha> --no-progress --provider <provider> --model <model-id>
\`\`\`

## Read the report

- Treat each finding as a lead. Verify the affected code, failure conditions, and impact before adopting it in your review. Check any suggested fix or test against the intended behavior.
- Read the coverage and health sections, including excluded or unreviewed hunks, budget stops, and unresolved questions. Check relevant gaps yourself before drawing a conclusion. A successful exit means the command ran successfully, regardless of whether it found issues.
`;
