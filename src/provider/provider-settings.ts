import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ensureCodegenieHome, getCodegeniePaths } from "../config/paths.js";
import { deprecatedReviewDepthSchema, reasoningLevelSchema } from "../config/schema.js";
import type { CodegeniePaths, ProviderSettings } from "../types.js";
import { CodegenieError } from "../util/errors.js";

const providerSettingsSchema = z
  .object({
    defaultProvider: z.string().min(1).optional(),
    defaultModel: z.string().min(1).optional(),
    // #129: still parsed so an old settings.json loads; the loader warns.
    defaultDepth: deprecatedReviewDepthSchema.optional(),
    defaultReasoning: reasoningLevelSchema.optional()
  })
  .strict();

export function loadProviderSettings(paths: CodegeniePaths = getCodegeniePaths()): ProviderSettings {
  if (!existsSync(paths.settingsPath)) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(paths.settingsPath, "utf8"));
  } catch (cause) {
    throw new CodegenieError("config_error", `failed to read provider settings at ${paths.settingsPath}`, {
      context: { path: paths.settingsPath },
      cause
    });
  }

  const result = providerSettingsSchema.safeParse(parsed);
  if (!result.success) {
    throw new CodegenieError("config_error", `invalid provider settings at ${paths.settingsPath}`, {
      context: { path: paths.settingsPath, issues: result.error.issues }
    });
  }
  const settings: ProviderSettings = {};
  if (result.data.defaultProvider !== undefined) {
    settings.defaultProvider = result.data.defaultProvider;
  }
  if (result.data.defaultModel !== undefined) {
    settings.defaultModel = result.data.defaultModel;
  }
  if (result.data.defaultDepth !== undefined) {
    settings.defaultDepth = result.data.defaultDepth;
  }
  if (result.data.defaultReasoning !== undefined) {
    settings.defaultReasoning = result.data.defaultReasoning;
  }
  return settings;
}

export function saveProviderSettings(
  settings: ProviderSettings,
  paths: CodegeniePaths = getCodegeniePaths()
): void {
  ensureCodegenieHome(paths);
  // The removed depth default is never written back (#129).
  const { defaultDepth: _ignored, ...current } = settings;
  const result = providerSettingsSchema.safeParse(current);
  if (!result.success) {
    throw new CodegenieError("config_error", "invalid provider settings", {
      context: { issues: result.error.issues }
    });
  }

  const tmpPath = path.join(paths.home, `.settings-${process.pid}-${Date.now()}.tmp`);
  writeFileSync(tmpPath, `${JSON.stringify(result.data, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmpPath, paths.settingsPath);
}
