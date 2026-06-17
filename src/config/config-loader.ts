import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import {
  codeninjaConfigSchema,
  defaultConfig,
  rawConfigSchema,
  reasoningLevelSchema,
  type RawCodeninjaConfig
} from "./schema.js";
import { getCodeninjaPaths } from "./paths.js";
import { loadProviderSettings } from "../provider/provider-settings.js";
import type {
  ClassificationPathRule,
  CodeninjaConfig,
  CodeninjaPaths,
  ConfigSource,
  ConfigWarning,
  ReasoningLevel,
  ReviewDepth
} from "../types.js";
import { CodeninjaError } from "../util/errors.js";

type RawPathRule = NonNullable<NonNullable<RawCodeninjaConfig["classification"]>["pathRules"]>[number];

export type CliConfigOverrides = {
  depth?: ReviewDepth;
  lenses?: string[];
  provider?: string;
  model?: string;
  reasoning?: ReasoningLevel | "auto";
  cacheEnabled?: boolean;
};

export type LoadConfigOptions = {
  repoRoot: string;
  homeOverride?: string;
  env?: NodeJS.ProcessEnv;
  cli?: CliConfigOverrides;
  loadRepoConfig?: boolean;
};

export type LoadedConfig = {
  config: CodeninjaConfig;
  paths: CodeninjaPaths;
  warnings: ConfigWarning[];
  sources: Record<string, ConfigSource>;
};

const DEFAULT_SOURCE_PATHS = [
  "lenses.enabled",
  "lenses.disabled",
  "lenses.restrictTo",
  "lenses.extraSkillPaths",
  "review.depth",
  "review.verify",
  "review.maxFindings",
  "review.softCommentCap",
  "review.minConfidence",
  "review.minInlineConfidence",
  "review.concurrency",
  "review.timeoutMs",
  "review.perPassTimeoutMs",
  "review.budgetMultiplier",
  "github.summaryWhenNoFindings",
  "classification.pathRules",
  "llm.maxConcurrentCalls",
  "cache.enabled",
  "cache.dir",
  "telemetry.enabled",
  "telemetry.logLevel",
  "telemetry.debugTrace",
  "telemetry.runDir",
  "telemetry.retainRuns",
  "eval.logsDir"
];

const REPO_SAFE_REVIEW_KEYS = new Set(["depth", "maxFindings", "softCommentCap", "budgetMultiplier"]);
const CREDENTIAL_KEY_PATTERN = /(?:api[_-]?key|apikey|secret|token|password|passwd|authorization|credentials|auth)/i;

export function loadConfig(opts: LoadConfigOptions): LoadedConfig {
  const env = opts.env ?? process.env;
  const repoRoot = path.resolve(opts.repoRoot);
  const paths = getCodeninjaPaths(opts.homeOverride, env);
  const warnings: ConfigWarning[] = [];
  const sources = defaultSources();
  const config = structuredClone(defaultConfig) as CodeninjaConfig;

  const userConfig = readConfigIfPresent(paths.configTomlPath, "user-config");
  if (userConfig) {
    applyRawConfig(config, userConfig, "user-config", sources);
  }

  const providerSettings = loadProviderSettings(paths);
  if (providerSettings.defaultProvider !== undefined) {
    config.llm.provider = providerSettings.defaultProvider;
    sources["llm.provider"] = "provider-settings";
  }
  if (providerSettings.defaultModel !== undefined) {
    config.llm.model = providerSettings.defaultModel;
    sources["llm.model"] = "provider-settings";
  }
  if (providerSettings.defaultReasoning !== undefined) {
    config.llm.reasoning = providerSettings.defaultReasoning;
    sources["llm.reasoning"] = "provider-settings";
  }
  if (providerSettings.defaultDepth !== undefined) {
    config.review.depth = providerSettings.defaultDepth;
    sources["review.depth"] = "provider-settings";
  }

  if (opts.loadRepoConfig !== false) {
    const repoConfigPath = path.join(repoRoot, "codeninja.toml");
    const repoConfig = readConfigIfPresent(repoConfigPath, "repo-config");
    if (repoConfig) {
      const safeRepoConfig = filterRepoConfig(repoConfig, warnings);
      applyRawConfig(config, safeRepoConfig, "repo-config", sources);
    }
  }

  applyEnvironment(config, env, sources);
  applyCliOverrides(config, opts.cli ?? {}, sources);

  const validated = codeninjaConfigSchema.safeParse(config);
  if (!validated.success) {
    throw new CodeninjaError("config_error", "resolved configuration is invalid", {
      context: { issues: validated.error.issues }
    });
  }

  return {
    config: validated.data as CodeninjaConfig,
    paths,
    warnings,
    sources
  };
}

export function applyRepoConfigLayer(
  baseConfig: CodeninjaConfig,
  repoRoot: string
): { config: CodeninjaConfig; warnings: ConfigWarning[] } {
  const config = structuredClone(baseConfig) as CodeninjaConfig;
  const warnings: ConfigWarning[] = [];
  const sources = defaultSources();
  const repoConfig = readConfigIfPresent(path.join(path.resolve(repoRoot), "codeninja.toml"), "repo-config");
  if (repoConfig) {
    const safeRepoConfig = filterRepoConfig(repoConfig, warnings);
    applyRawConfig(config, safeRepoConfig, "repo-config", sources);
  }

  const validated = codeninjaConfigSchema.safeParse(config);
  if (!validated.success) {
    throw new CodeninjaError("config_error", "resolved configuration is invalid after repo config", {
      context: { issues: validated.error.issues }
    });
  }

  return { config: validated.data as CodeninjaConfig, warnings };
}

function readConfigIfPresent(filePath: string, source: ConfigSource): RawCodeninjaConfig | undefined {
  if (!existsSync(filePath)) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = parseToml(readFileSync(filePath, "utf8"));
  } catch (cause) {
    throw new CodeninjaError("config_error", `failed to parse config file at ${filePath}`, {
      context: { path: filePath },
      cause
    });
  }

  if (source === "repo-config") {
    assertNoCredentialKeys(parsed, filePath);
  }

  const result = rawConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new CodeninjaError("config_error", `invalid config file at ${filePath}`, {
      context: { path: filePath, issues: result.error.issues }
    });
  }
  return result.data;
}

function applyRawConfig(
  config: CodeninjaConfig,
  raw: RawCodeninjaConfig,
  source: ConfigSource,
  sources: Record<string, ConfigSource>
): void {
  if (raw.lenses?.enabled !== undefined) {
    config.lenses.enabled = [...raw.lenses.enabled];
    sources["lenses.enabled"] = source;
  }
  if (raw.lenses?.disabled !== undefined) {
    config.lenses.disabled = [...raw.lenses.disabled];
    sources["lenses.disabled"] = source;
  }
  if (raw.lenses?.extraSkillPaths !== undefined) {
    config.lenses.extraSkillPaths = [...raw.lenses.extraSkillPaths];
    sources["lenses.extraSkillPaths"] = source;
  }

  if (raw.review?.depth !== undefined) {
    config.review.depth = raw.review.depth;
    sources["review.depth"] = source;
  }
  if (raw.review?.verify !== undefined) {
    config.review.verify = raw.review.verify;
    sources["review.verify"] = source;
  }
  if (raw.review?.minSeverity !== undefined) {
    config.review.minSeverity = raw.review.minSeverity;
    sources["review.minSeverity"] = source;
  }
  if (raw.review?.maxFindings !== undefined) {
    config.review.maxFindings = raw.review.maxFindings;
    sources["review.maxFindings"] = source;
  }
  if (raw.review?.softCommentCap !== undefined) {
    config.review.softCommentCap = raw.review.softCommentCap;
    sources["review.softCommentCap"] = source;
  }
  if (raw.review?.minConfidence !== undefined) {
    config.review.minConfidence = raw.review.minConfidence;
    sources["review.minConfidence"] = source;
  }
  if (raw.review?.minInlineConfidence !== undefined) {
    config.review.minInlineConfidence = raw.review.minInlineConfidence;
    sources["review.minInlineConfidence"] = source;
  }
  if (raw.review?.concurrency !== undefined) {
    config.review.concurrency = raw.review.concurrency;
    sources["review.concurrency"] = source;
  }
  if (raw.review?.timeoutMs !== undefined) {
    config.review.timeoutMs = raw.review.timeoutMs;
    sources["review.timeoutMs"] = source;
  }
  if (raw.review?.perPassTimeoutMs !== undefined) {
    config.review.perPassTimeoutMs = raw.review.perPassTimeoutMs;
    sources["review.perPassTimeoutMs"] = source;
  }
  if (raw.review?.budgetMultiplier !== undefined) {
    config.review.budgetMultiplier = raw.review.budgetMultiplier;
    sources["review.budgetMultiplier"] = source;
  }
  if (raw.review?.maxTotalTokens !== undefined) {
    config.review.maxTotalTokens = raw.review.maxTotalTokens;
    sources["review.maxTotalTokens"] = source;
  }
  if (raw.review?.maxModelCalls !== undefined) {
    config.review.maxModelCalls = raw.review.maxModelCalls;
    sources["review.maxModelCalls"] = source;
  }

  if (raw.github?.summaryWhenNoFindings !== undefined) {
    config.github.summaryWhenNoFindings = raw.github.summaryWhenNoFindings;
    sources["github.summaryWhenNoFindings"] = source;
  }

  if (raw.git?.baseBranch !== undefined) {
    config.git.baseBranch = raw.git.baseBranch;
    sources["git.baseBranch"] = source;
  }

  if (raw.classification?.pathRules !== undefined) {
    config.classification.pathRules = raw.classification.pathRules.map(normalizePathRule);
    sources["classification.pathRules"] = source;
  }

  if (raw.llm?.provider !== undefined) {
    config.llm.provider = raw.llm.provider;
    sources["llm.provider"] = source;
  }
  if (raw.llm?.model !== undefined) {
    config.llm.model = raw.llm.model;
    sources["llm.model"] = source;
  }
  if (raw.llm?.reasoning !== undefined) {
    config.llm.reasoning = raw.llm.reasoning;
    sources["llm.reasoning"] = source;
  }
  if (raw.llm?.maxConcurrentCalls !== undefined) {
    config.llm.maxConcurrentCalls = raw.llm.maxConcurrentCalls;
    sources["llm.maxConcurrentCalls"] = source;
  }

  if (raw.cache?.enabled !== undefined) {
    config.cache.enabled = raw.cache.enabled;
    sources["cache.enabled"] = source;
  }
  if (raw.cache?.dir !== undefined) {
    config.cache.dir = raw.cache.dir;
    sources["cache.dir"] = source;
  }

  if (raw.telemetry?.enabled !== undefined) {
    config.telemetry.enabled = raw.telemetry.enabled;
    sources["telemetry.enabled"] = source;
  }
  if (raw.telemetry?.logLevel !== undefined) {
    config.telemetry.logLevel = raw.telemetry.logLevel;
    sources["telemetry.logLevel"] = source;
  }
  if (raw.telemetry?.debugTrace !== undefined) {
    config.telemetry.debugTrace = raw.telemetry.debugTrace;
    sources["telemetry.debugTrace"] = source;
  }
  if (raw.telemetry?.runDir !== undefined) {
    config.telemetry.runDir = raw.telemetry.runDir;
    sources["telemetry.runDir"] = source;
  }
  if (raw.telemetry?.retainRuns !== undefined) {
    config.telemetry.retainRuns = raw.telemetry.retainRuns;
    sources["telemetry.retainRuns"] = source;
  }

  if (raw.eval?.defaultEvalDir !== undefined) {
    config.eval.defaultEvalDir = raw.eval.defaultEvalDir;
    sources["eval.defaultEvalDir"] = source;
  }
  if (raw.eval?.logsDir !== undefined) {
    config.eval.logsDir = raw.eval.logsDir;
    sources["eval.logsDir"] = source;
  }
}

function filterRepoConfig(raw: RawCodeninjaConfig, warnings: ConfigWarning[]): RawCodeninjaConfig {
  const safe: RawCodeninjaConfig = {};

  if (raw.review) {
    for (const key of Object.keys(raw.review)) {
      if (!REPO_SAFE_REVIEW_KEYS.has(key)) {
        warnIgnoredRepoKey(warnings, `review.${key}`);
      }
    }
    safe.review = {};
    if (raw.review.depth !== undefined) {
      safe.review.depth = raw.review.depth;
    }
    if (raw.review.maxFindings !== undefined) {
      safe.review.maxFindings = raw.review.maxFindings;
    }
    if (raw.review.softCommentCap !== undefined) {
      safe.review.softCommentCap = raw.review.softCommentCap;
    }
    if (raw.review.budgetMultiplier !== undefined) {
      safe.review.budgetMultiplier = raw.review.budgetMultiplier;
    }
  }

  if (raw.git?.baseBranch !== undefined) {
    safe.git = { baseBranch: raw.git.baseBranch };
  }

  if (raw.lenses) {
    safe.lenses = {};
    if (raw.lenses.enabled !== undefined) {
      safe.lenses.enabled = [...raw.lenses.enabled];
    }
    if (raw.lenses.disabled !== undefined) {
      safe.lenses.disabled = [...raw.lenses.disabled];
    }
    if (raw.lenses.extraSkillPaths !== undefined) {
      warnIgnoredRepoKey(warnings, "lenses.extraSkillPaths");
    }
  }

  if (raw.classification?.pathRules !== undefined) {
    safe.classification = { pathRules: raw.classification.pathRules };
  }

  warnTopLevelRepoSection(warnings, raw.github, "github");
  warnTopLevelRepoSection(warnings, raw.llm, "llm");
  warnTopLevelRepoSection(warnings, raw.cache, "cache");
  if (raw.telemetry) {
    safe.telemetry = {};
    if (raw.telemetry.enabled !== undefined) {
      safe.telemetry.enabled = raw.telemetry.enabled;
    }
    for (const key of Object.keys(raw.telemetry)) {
      if (key !== "enabled") {
        warnIgnoredRepoKey(warnings, `telemetry.${key}`);
      }
    }
  }
  warnTopLevelRepoSection(warnings, raw.eval, "eval");

  return safe;
}

function warnTopLevelRepoSection(
  warnings: ConfigWarning[],
  section: Record<string, unknown> | undefined,
  name: string
): void {
  if (!section) {
    return;
  }
  for (const key of Object.keys(section)) {
    warnIgnoredRepoKey(warnings, `${name}.${key}`);
  }
}

function warnIgnoredRepoKey(warnings: ConfigWarning[], key: string): void {
  warnings.push({
    source: "repo-config",
    key,
    message: `repo codeninja.toml cannot set user-scoped key ${key}; value ignored`
  });
}

function applyEnvironment(
  config: CodeninjaConfig,
  env: NodeJS.ProcessEnv,
  sources: Record<string, ConfigSource>
): void {
  if (env.CODENINJA_PROVIDER) {
    config.llm.provider = env.CODENINJA_PROVIDER;
    sources["llm.provider"] = "environment";
  }
  if (env.CODENINJA_MODEL) {
    config.llm.model = env.CODENINJA_MODEL;
    sources["llm.model"] = "environment";
  }
  if (env.CODENINJA_REASONING) {
    const parsed = reasoningLevelSchema.safeParse(env.CODENINJA_REASONING);
    if (!parsed.success) {
      throw new CodeninjaError("config_error", "invalid CODENINJA_REASONING value", {
        context: {
          key: "CODENINJA_REASONING",
          value: env.CODENINJA_REASONING,
          allowed: ["low", "medium", "high", "xhigh"]
        }
      });
    }
    config.llm.reasoning = parsed.data;
    sources["llm.reasoning"] = "environment";
  }
}

function applyCliOverrides(
  config: CodeninjaConfig,
  cli: CliConfigOverrides,
  sources: Record<string, ConfigSource>
): void {
  if (cli.depth !== undefined) {
    config.review.depth = cli.depth;
    sources["review.depth"] = "cli";
  }
  if (cli.lenses !== undefined) {
    config.lenses.restrictTo = [...cli.lenses];
    sources["lenses.restrictTo"] = "cli";
  }
  if (cli.provider !== undefined) {
    config.llm.provider = cli.provider;
    sources["llm.provider"] = "cli";
  }
  if (cli.model !== undefined) {
    config.llm.model = cli.model;
    sources["llm.model"] = "cli";
  }
  if (cli.reasoning !== undefined && cli.reasoning !== "auto") {
    config.llm.reasoning = cli.reasoning;
    sources["llm.reasoning"] = "cli";
  }
  if (cli.cacheEnabled !== undefined) {
    config.cache.enabled = cli.cacheEnabled;
    sources["cache.enabled"] = "cli";
  }
}

function normalizePathRule(rule: RawPathRule): ClassificationPathRule {
  const normalized: ClassificationPathRule = {
    pattern: rule.pattern,
    reason: rule.reason
  };
  if (rule.processingMode !== undefined) {
    normalized.processingMode = rule.processingMode;
  }
  if (rule.reviewPriority !== undefined) {
    normalized.reviewPriority = rule.reviewPriority;
  }
  if (rule.labels !== undefined) {
    normalized.labels = [...rule.labels];
  }
  return normalized;
}

function assertNoCredentialKeys(input: unknown, filePath: string, trail: string[] = []): void {
  if (!input || typeof input !== "object") {
    return;
  }

  if (Array.isArray(input)) {
    input.forEach((item, index) => assertNoCredentialKeys(item, filePath, [...trail, String(index)]));
    return;
  }

  for (const [key, value] of Object.entries(input)) {
    const nextTrail = [...trail, key];
    if (CREDENTIAL_KEY_PATTERN.test(key)) {
      throw new CodeninjaError("config_error", "repo codeninja.toml cannot contain credential-bearing fields", {
        context: { path: filePath, key: nextTrail.join(".") }
      });
    }
    assertNoCredentialKeys(value, filePath, nextTrail);
  }
}

function defaultSources(): Record<string, ConfigSource> {
  const sources: Record<string, ConfigSource> = {};
  for (const key of DEFAULT_SOURCE_PATHS) {
    sources[key] = "defaults";
  }
  return sources;
}
