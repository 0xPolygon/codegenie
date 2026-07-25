// Generates ./models.md from the pi model registry (models.dev data) using
// the same listing path as `codegenie provider models`, so the doc cannot
// drift from what the CLI actually offers. Runs against dist/ (like
// write-version.mjs); invoke via `make models-list`, which builds first.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPiModelRegistry } from "../dist/provider/provider-services.js";

const stubAuthStorage = {
  loadAll: () => ({}),
  get: () => undefined,
  set: () => undefined,
  delete: () => undefined,
  clear: () => undefined
};

const registry = createPiModelRegistry(stubAuthStorage);
const models = registry.listModels();

const byProvider = new Map();
for (const model of models) {
  const group = byProvider.get(model.provider) ?? [];
  group.push(model);
  byProvider.set(model.provider, group);
}

const lines = [
  "# Supported models",
  "",
  "> Generated from the pi model registry ([models.dev](https://models.dev)) — do not edit by hand.",
  "> Regenerate with `make models-list`.",
  "",
  `codegenie is multi-provider: **${models.length} models** across **${byProvider.size} providers**. Use any of them as:`,
  "",
  "- `codegenie review --provider <provider> --model <model> [--reasoning <level>]`",
  "- `codegenie provider use <fuzzy>` (e.g. `use opus`) to set a default",
  "- the GitHub Action `model` input: `provider/model[:reasoning]`, e.g. `anthropic/claude-opus-5:xhigh`",
  "",
  "The **Reasoning levels** column shows each model's native thinking levels from the registry (a dash means none).",
  "codegenie's `--reasoning` flag (and the `:reasoning` suffix) accepts `low`, `medium`, `high`, `xhigh`, or `auto`",
  "and maps onto whatever the model natively supports. Listing here means the model is known, not authenticated —",
  "connect a provider with `codegenie provider login <provider>` (or env vars / the Action's `llm-api-key`).",
  ""
];

for (const [provider, group] of byProvider) {
  lines.push(`## ${provider}`, "", "| Model | Name | Context | Max output | Reasoning levels |", "| --- | --- | --- | --- | --- |");
  for (const model of group) {
    const reasoning = model.reasoning && model.thinkingLevels.length > 0 ? model.thinkingLevels.join(", ") : "—";
    lines.push(
      `| \`${model.id}\` | ${escapeCell(model.name)} | ${formatTokens(model.contextWindow)} | ${formatTokens(model.maxOutputTokens)} | ${reasoning} |`
    );
  }
  lines.push("");
}

function formatTokens(value) {
  if (value === undefined || value <= 0) {
    return "—";
  }
  return value % 1000 === 0 ? `${value / 1000}k` : String(value);
}

function escapeCell(value) {
  return value
    .replace(/\\/gu, "\\\\")
    .replace(/\|/gu, "\\|");
}

const target = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "models.md");
writeFileSync(target, `${lines.join("\n")}\n`);
process.stdout.write(`wrote models.md: ${models.length} models across ${byProvider.size} providers\n`);
