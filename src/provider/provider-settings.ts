import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ensureCodeninjaHome, getCodeninjaPaths } from "../config/paths.js";
import type { CodeninjaPaths, ProviderSettings } from "../types.js";
import { CodeninjaError } from "../util/errors.js";

const providerSettingsSchema = z
  .object({
    defaultProvider: z.string().min(1).optional(),
    defaultModel: z.string().min(1).optional(),
    defaultDepth: z.enum(["light", "normal", "deep"]).optional(),
    defaultReasoning: z.enum(["low", "medium", "high", "xhigh"]).optional()
  })
  .strict();

export function loadProviderSettings(paths: CodeninjaPaths = getCodeninjaPaths()): ProviderSettings {
  if (!existsSync(paths.settingsPath)) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(paths.settingsPath, "utf8"));
  } catch (cause) {
    throw new CodeninjaError("config_error", `failed to read provider settings at ${paths.settingsPath}`, {
      context: { path: paths.settingsPath },
      cause
    });
  }

  const result = providerSettingsSchema.safeParse(parsed);
  if (!result.success) {
    throw new CodeninjaError("config_error", `invalid provider settings at ${paths.settingsPath}`, {
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
  paths: CodeninjaPaths = getCodeninjaPaths()
): void {
  ensureCodeninjaHome(paths);
  const result = providerSettingsSchema.safeParse(settings);
  if (!result.success) {
    throw new CodeninjaError("config_error", "invalid provider settings", {
      context: { issues: result.error.issues }
    });
  }

  const tmpPath = path.join(paths.home, `.settings-${process.pid}-${Date.now()}.tmp`);
  writeFileSync(tmpPath, `${JSON.stringify(result.data, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmpPath, paths.settingsPath);
}
