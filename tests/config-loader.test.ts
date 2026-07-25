import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_DEEP_ENSEMBLE_PASSES,
  MAX_PACK_HUNKS,
  MAX_REVIEW_TIME_MINUTES,
  codegenieConfigSchema,
  defaultConfig,
  rawConfigSchema
} from "../src/config/schema.js";
import type { CodegenieConfig } from "../src/types.js";
import { ensureCodegenieHome, getCodegeniePaths } from "../src/config/paths.js";
import { loadConfig } from "../src/config/config-loader.js";
import { loadProviderSettings, saveProviderSettings } from "../src/provider/provider-settings.js";
import { CodegenieError } from "../src/util/errors.js";

describe("config loader", () => {
  it("resolves maxTime minutes from defaults, user config, repo config, and CLI in precedence order", () => {
    const repoRoot = tempDir();
    const home = tempDir();

    const defaults = loadConfig({ repoRoot, homeOverride: home });
    expect(defaults.config.review.maxTimeMs).toBe(30 * 60 * 1000);
    expect(defaults.sources["review.maxTime"]).toBe("defaults");

    writeFileSync(path.join(home, "config.toml"), "[review]\nmaxTime = 45.5\n");
    const userConfigured = loadConfig({ repoRoot, homeOverride: home });
    expect(userConfigured.config.review.maxTimeMs).toBe(45.5 * 60 * 1000);
    expect(userConfigured.sources["review.maxTime"]).toBe("user-config");

    writeFileSync(path.join(repoRoot, "codegenie.toml"), "[review]\nmaxTime = 60\n");
    const repoConfigured = loadConfig({ repoRoot, homeOverride: home });
    expect(repoConfigured.config.review.maxTimeMs).toBe(60 * 60 * 1000);
    expect(repoConfigured.sources["review.maxTime"]).toBe("repo-config");
    expect(repoConfigured.warnings).toEqual([]);

    const cliConfigured = loadConfig({
      repoRoot,
      homeOverride: home,
      cli: { maxTimeMs: 75 * 60 * 1000 }
    });
    expect(cliConfigured.config.review.maxTimeMs).toBe(75 * 60 * 1000);
    expect(cliConfigured.sources["review.maxTime"]).toBe("cli");
  });

  it("accepts review.maxTime only within the representable hard-timeout range and rejects timeoutMs", () => {
    expect(rawConfigSchema.safeParse({ review: { maxTime: 0.5 } }).success).toBe(true);
    expect(rawConfigSchema.safeParse({ review: { maxTime: MAX_REVIEW_TIME_MINUTES } }).success).toBe(true);
    expect(rawConfigSchema.safeParse({ review: { maxTime: 0 } }).success).toBe(false);
    expect(rawConfigSchema.safeParse({ review: { maxTime: Number.POSITIVE_INFINITY } }).success).toBe(false);
    expect(rawConfigSchema.safeParse({ review: { maxTime: MAX_REVIEW_TIME_MINUTES * 2 } }).success).toBe(false);
    expect(rawConfigSchema.safeParse({ review: { timeoutMs: 60_000 } }).success).toBe(false);

    const repoRoot = tempDir();
    const home = tempDir();
    writeFileSync(path.join(home, "config.toml"), `[review]\nmaxTime = ${MAX_REVIEW_TIME_MINUTES}\n`);
    const maximum = loadConfig({ repoRoot, homeOverride: home });
    expect(Number.isSafeInteger(maximum.config.review.maxTimeMs * 2)).toBe(true);

    writeFileSync(path.join(repoRoot, "codegenie.toml"), "[review]\nmaxTime = 2e303\n");
    expect(() => loadConfig({ repoRoot, homeOverride: home })).toThrow(/invalid config file/);
  });

  it("merges safe and user-scoped layers with the required precedence", () => {
    const repoRoot = tempDir();
    const home = tempDir();
    mkdirSync(home, { recursive: true });

    writeFileSync(
      path.join(home, "config.toml"),
      `
[review]
depth = "light"
verify = false
concurrency = 2

[llm]
provider = "user-config-provider"
model = "user-config-model"
reasoning = "low"
maxConcurrentCalls = 3

[telemetry]
retainRuns = 5

[lenses]
extraSkillPaths = ["/trusted/skills"]
`
    );
    writeFileSync(
      path.join(home, "settings.json"),
      JSON.stringify({
        defaultProvider: "settings-provider",
        defaultModel: "settings-model",
        defaultDepth: "normal",
        defaultReasoning: "medium"
      })
    );
    writeFileSync(
      path.join(repoRoot, "codegenie.toml"),
      `
[review]
depth = "deep"
verify = true
maxFindings = 10
budgetBoost = 1.5

[llm]
provider = "repo-ignored"

[telemetry]
enabled = false

[git]
baseBranch = "master"

[lenses]
enabled = ["core/tests"]
extraSkillPaths = ["/repo/ignored"]

[[classification.pathRules]]
pattern = "lib/**"
reviewPriority = "critical"
labels = ["payments"]
reason = "critical lib"
`
    );

    const loaded = loadConfig({
      repoRoot,
      env: {
        CODEGENIE_HOME: home,
        CODEGENIE_PROVIDER: "env-provider",
        CODEGENIE_REASONING: "xhigh"
      },
      cli: {
        depth: "light",
        model: "cli-model",
        cacheEnabled: true
      }
    });

    expect(loaded.config.review.depth).toBe("light");
    expect(loaded.sources["review.depth"]).toBe("cli");
    expect(loaded.config.review.verify).toBe(false);
    expect(loaded.sources["review.verify"]).toBe("user-config");
    expect(loaded.config.review.maxFindings).toBe(10);
    expect(loaded.sources["review.maxFindings"]).toBe("repo-config");
    expect(loaded.config.review.budgetBoost).toBe(1.5);
    expect(loaded.sources["review.budgetBoost"]).toBe("repo-config");
    expect(loaded.config.review.maxBudgetTokens).toBe(8_000_000);
    expect(loaded.sources["review.maxBudgetTokens"]).toBe("defaults");
    expect(loaded.config.llm.provider).toBe("env-provider");
    expect(loaded.config.llm.model).toBe("cli-model");
    expect(loaded.config.llm.reasoning).toBe("xhigh");
    expect(loaded.config.llm.maxConcurrentCalls).toBe(3);
    expect(loaded.config.git.baseBranch).toBe("master");
    expect(loaded.config.lenses.enabled).toEqual(["core/tests"]);
    expect(loaded.config.lenses.extraSkillPaths).toEqual(["/trusted/skills"]);
    expect(loaded.config.cache.enabled).toBe(true);
    expect(loaded.config.telemetry.enabled).toBe(false);
    expect(loaded.config.telemetry.retainRuns).toBe(5);
    expect(loaded.config.classification.pathRules).toEqual([
      {
        pattern: "lib/**",
        reviewPriority: "critical",
        labels: ["payments"],
        reason: "critical lib"
      }
    ]);

    expect(loaded.warnings.map((warning) => warning.key)).toEqual(
      expect.arrayContaining([
        "review.verify",
        "llm.provider",
        "lenses.extraSkillPaths"
      ])
    );
  });

  it("rejects credential-bearing repo config fields", () => {
    const repoRoot = tempDir();
    const home = tempDir();
    writeFileSync(
      path.join(repoRoot, "codegenie.toml"),
      `
[llm]
apiKey = "sk-this-should-not-be-in-repo-config"
`
    );

    expect(() => loadConfig({ repoRoot, homeOverride: home })).toThrow(CodegenieError);
    expect(() => loadConfig({ repoRoot, homeOverride: home })).toThrow(/credential-bearing/);
  });

  it("rejects non-positive budget multipliers", () => {
    const repoRoot = tempDir();
    const home = tempDir();
    writeFileSync(
      path.join(home, "config.toml"),
      `
[review]
budgetBoost = 0
`
    );

    expect(() => loadConfig({ repoRoot, homeOverride: home })).toThrow(CodegenieError);
  });

  it("keeps adjacent precedence rules isolated for settings, repo review config, and reasoning auto", () => {
    const repoRoot = tempDir();
    const home = tempDir();
    writeFileSync(
      path.join(home, "config.toml"),
      `
[llm]
provider = "config-provider"
model = "config-model"
reasoning = "low"
`
    );
    writeFileSync(
      path.join(home, "settings.json"),
      JSON.stringify({
        defaultProvider: "settings-provider",
        defaultModel: "settings-model",
        defaultDepth: "light",
        defaultReasoning: "medium"
      })
    );
    writeFileSync(
      path.join(repoRoot, "codegenie.toml"),
      `
[review]
depth = "deep"
`
    );

    const loaded = loadConfig({
      repoRoot,
      homeOverride: home,
      cli: { reasoning: "auto" }
    });

    expect(loaded.config.llm.provider).toBe("settings-provider");
    expect(loaded.sources["llm.provider"]).toBe("provider-settings");
    expect(loaded.config.llm.model).toBe("settings-model");
    expect(loaded.sources["llm.model"]).toBe("provider-settings");
    expect(loaded.config.review.depth).toBe("deep");
    expect(loaded.sources["review.depth"]).toBe("repo-config");
    expect(loaded.config.llm.reasoning).toBe("medium");
    expect(loaded.sources["llm.reasoning"]).toBe("provider-settings");
  });

  it("allows repo telemetry opt-in but ignores repo-scoped telemetry and cache directories", () => {
    const repoRoot = tempDir();
    const home = tempDir();
    writeFileSync(
      path.join(repoRoot, "codegenie.toml"),
      `
[telemetry]
enabled = true
runDir = "../outside-runs"

[cache]
dir = "../outside-cache"
enabled = false

[review]
maxFindings = 3
`
    );

    const loaded = loadConfig({ repoRoot, homeOverride: home });

    expect(loaded.config.telemetry.enabled).toBe(true);
    expect(loaded.sources["telemetry.enabled"]).toBe("repo-config");
    expect(loaded.config.telemetry.runDir).toBe(".codegenie/runs");
    expect(loaded.config.cache.dir).toBe(".codegenie/cache");
    expect(loaded.config.cache.enabled).toBe(false);
    expect(loaded.config.review.maxFindings).toBe(3);
    expect(loaded.warnings.map((warning) => warning.key).sort()).toEqual([
      "cache.dir",
      "cache.enabled",
      "telemetry.runDir"
    ]);
  });
});

describe("codegenie paths and provider settings", () => {
  it("resolves CODEGENIE_HOME and writes settings with private permissions", () => {
    const home = tempDir();
    const paths = getCodegeniePaths(undefined, { CODEGENIE_HOME: home });
    expect(paths.home).toBe(path.resolve(home));
    expect(paths.settingsPath).toBe(path.join(path.resolve(home), "settings.json"));

    ensureCodegenieHome(paths);
    saveProviderSettings(
      {
        defaultProvider: "openai",
        defaultModel: "gpt-5",
        defaultDepth: "deep",
        defaultReasoning: "high"
      },
      paths
    );

    expect(loadProviderSettings(paths)).toEqual({
      defaultProvider: "openai",
      defaultModel: "gpt-5",
      defaultDepth: "deep",
      defaultReasoning: "high"
    });
    expect(statSync(paths.home).mode & 0o077).toBe(0);
    expect(statSync(paths.settingsPath).mode & 0o077).toBe(0);
  });
});

describe("deepEnsemblePasses cap (plan 84)", () => {
  it("rejects values above the hard cap in raw config", () => {
    expect(rawConfigSchema.safeParse({ review: { deepEnsemblePasses: MAX_DEEP_ENSEMBLE_PASSES } }).success).toBe(true);
    expect(rawConfigSchema.safeParse({ review: { deepEnsemblePasses: MAX_DEEP_ENSEMBLE_PASSES + 1 } }).success).toBe(false);
  });
});

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "codegenie-"));
}

describe("plan 103 packing settings", () => {
  it("defaults to dark packing at the shipped cap", () => {
    const loaded = loadConfig({ repoRoot: tempDir(), homeOverride: tempDir() });
    expect(loaded.config.review.packCompatibleAtoms).toBe(false);
    expect(loaded.config.review.packMaxHunks).toBe(MAX_PACK_HUNKS);
    expect(MAX_PACK_HUNKS).toBe(5);
  });

  it("refuses both settings from every config file surface", () => {
    // Plan 103 keeps these eval-only: no codegenie.toml and no user config may
    // reach them, so strict parsing must reject rather than silently filter.
    expect(rawConfigSchema.safeParse({ review: { packCompatibleAtoms: true } }).success).toBe(false);
    expect(rawConfigSchema.safeParse({ review: { packMaxHunks: 3 } }).success).toBe(false);

    const repoRoot = tempDir();
    const home = tempDir();
    writeFileSync(path.join(repoRoot, "codegenie.toml"), "[review]\npackCompatibleAtoms = true\n");
    expect(() => loadConfig({ repoRoot, homeOverride: home })).toThrow(/invalid config file/);

    const userHome = tempDir();
    writeFileSync(path.join(userHome, "config.toml"), "[review]\npackMaxHunks = 2\n");
    expect(() => loadConfig({ repoRoot: tempDir(), homeOverride: userHome })).toThrow(/invalid config file/);
  });

  it("bounds packMaxHunks by the shipped packet cap in the resolved schema", () => {
    const base = structuredClone(defaultConfig) as CodegenieConfig;
    for (const value of [1, 3, MAX_PACK_HUNKS]) {
      expect(codegenieConfigSchema.safeParse({ ...base, review: { ...base.review, packMaxHunks: value } }).success).toBe(true);
    }
    for (const value of [0, -1, MAX_PACK_HUNKS + 1]) {
      expect(codegenieConfigSchema.safeParse({ ...base, review: { ...base.review, packMaxHunks: value } }).success).toBe(false);
    }
  });
});
