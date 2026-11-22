import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_REVIEW_TIME_MINUTES,
  codegenieConfigSchema,
  defaultConfig,
  rawConfigSchema
} from "../src/config/schema.js";
import { ensureCodegenieHome, getCodegeniePaths } from "../src/config/paths.js";
import { loadConfig } from "../src/config/config-loader.js";
import { loadEvalSuite } from "../src/evals/eval-runner.js";
import { loadProviderSettings, saveProviderSettings } from "../src/provider/provider-settings.js";
import { CodegenieError } from "../src/util/errors.js";

describe("config loader", () => {
  it("loads the repository tool surface and validates its value", () => {
    const repoRoot = tempDir();
    const homeOverride = tempDir();
    writeFileSync(path.join(homeOverride, "config.toml"), '[review]\ntoolSurface = "six"\n');
    const loaded = loadConfig({ repoRoot, homeOverride, env: {} });
    expect(loaded.config.review.toolSurface).toBe("six");
    expect(loaded.sources["review.toolSurface"]).toBe("user-config");
    expect(rawConfigSchema.safeParse({ review: { toolSurface: "unknown" } }).success).toBe(false);
  });

  it("keeps stage settings user-scoped and lets per-run fields override them", () => {
    const repoRoot = tempDir();
    const homeOverride = tempDir();
    writeFileSync(path.join(homeOverride, "config.toml"), '[llm.stages.review]\nmodel = "provider/model"\nreasoning = "low"\n[llm.stages.compose]\nreasoning = "medium"\n');
    writeFileSync(path.join(repoRoot, "codegenie.toml"), '[llm.stages.review]\nmodel = "other/model"\n');
    const loaded = loadConfig({ repoRoot, homeOverride, env: {} });
    expect(loaded.config.llm.stages).toEqual({ review: { model: "provider/model", reasoning: "low" }, compose: { reasoning: "medium" } });
    expect(loaded.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ key: "llm.stages", source: "repo-config" })]));
    const overridden = loadConfig({ repoRoot, homeOverride, env: { CODEGENIE_MODEL: "new" }, cli: { reasoning: "high" } });
    expect(overridden.config.llm.stages).toBeUndefined();
    expect(overridden.warnings.filter(warning => warning.source === "cli" && warning.key === "llm.stages")).toHaveLength(1);
    const auto = loadConfig({ repoRoot, homeOverride, env: { CODEGENIE_MODEL: "new" }, cli: { reasoning: "auto" } });
    expect(auto.warnings.filter(warning => warning.key === "llm.stages" && warning.source === "environment")).toHaveLength(1);
    expect(auto.config.llm.stages?.review).toEqual({ reasoning: "low" });
    expect(rawConfigSchema.safeParse({ llm: { stages: { review: { model: "provider/model:high" } } } }).success).toBe(false);
    expect(rawConfigSchema.safeParse({ llm: { stages: { wrong: { model: "provider/model" } } } }).success).toBe(false);
  });

  it("replaces user stages with Action stages after per-run global overrides", () => {
    const repoRoot = tempDir();
    const homeOverride = tempDir();
    writeFileSync(path.join(homeOverride, "config.toml"), '[llm.stages.review]\nmodel = "provider/standing"\nreasoning = "low"\n');
    const loaded = loadConfig({
      repoRoot, homeOverride, env: {},
      cli: { provider: "provider", model: "default", reasoning: "auto" },
      actionStageModels: { plan: { model: "provider/planner" }, compose: { reasoning: "medium" } }
    });
    expect(loaded.config.llm.stages).toEqual({ plan: { model: "provider/planner" }, compose: { reasoning: "medium" } });
    expect(loaded.sources["llm.stages"]).toBe("github-action");
  });

  it("layers composition step-down as a repo-safe boolean", () => {
    const repoRoot = tempDir();
    const homeOverride = tempDir();
    expect(loadConfig({ repoRoot, homeOverride }).config.review.compositionReasoningStepDown).toBe(true);
    writeFileSync(path.join(homeOverride, "config.toml"), "[review]\ncompositionReasoningStepDown = false\n");
    expect(loadConfig({ repoRoot, homeOverride }).config.review.compositionReasoningStepDown).toBe(false);
    writeFileSync(path.join(homeOverride, "config.toml"), "[review]\ncompositionReasoningStepDown = true\n");
    expect(loadConfig({ repoRoot, homeOverride }).config.review.compositionReasoningStepDown).toBe(true);
    writeFileSync(path.join(repoRoot, "codegenie.toml"), "[review]\ncompositionReasoningStepDown = false\n");
    expect(loadConfig({ repoRoot, homeOverride }).config.review.compositionReasoningStepDown).toBe(false);
    expect(loadConfig({ repoRoot, homeOverride, cli: { compositionReasoningStepDown: true } }).config.review.compositionReasoningStepDown).toBe(true);
    expect(rawConfigSchema.safeParse({ review: { compositionReasoningStepDown: "true" } }).success).toBe(false);
  });

  it("layers SVG skipping as a repo-safe boolean", () => {
    const repoRoot = tempDir();
    const homeOverride = tempDir();
    expect(loadConfig({ repoRoot, homeOverride }).config.review.skipSvgReview).toBe(true);
    writeFileSync(path.join(homeOverride, "config.toml"), "[review]\nskipSvgReview = false\n");
    expect(loadConfig({ repoRoot, homeOverride }).config.review.skipSvgReview).toBe(false);
    writeFileSync(path.join(homeOverride, "config.toml"), "[review]\nskipSvgReview = true\n");
    expect(loadConfig({ repoRoot, homeOverride }).config.review.skipSvgReview).toBe(true);
    writeFileSync(path.join(repoRoot, "codegenie.toml"), "[review]\nskipSvgReview = false\n");
    expect(loadConfig({ repoRoot, homeOverride }).config.review.skipSvgReview).toBe(false);
    expect(loadConfig({ repoRoot, homeOverride, cli: { skipSvgReview: true } }).config.review.skipSvgReview).toBe(true);
    expect(rawConfigSchema.safeParse({ review: { skipSvgReview: "true" } }).success).toBe(false);
  });

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
        defaultReasoning: "medium"
      })
    );
    writeFileSync(
      path.join(repoRoot, "codegenie.toml"),
      `
[review]
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
        model: "cli-model",
        cacheEnabled: true
      }
    });

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
        defaultReasoning: "medium"
      })
    );
    writeFileSync(path.join(repoRoot, "codegenie.toml"), "[review]\nmaxFindings = 10\n");

    const loaded = loadConfig({
      repoRoot,
      homeOverride: home,
      cli: { reasoning: "auto" }
    });

    expect(loaded.config.llm.provider).toBe("settings-provider");
    expect(loaded.sources["llm.provider"]).toBe("provider-settings");
    expect(loaded.config.llm.model).toBe("settings-model");
    expect(loaded.sources["llm.model"]).toBe("provider-settings");
    expect(loaded.config.llm.reasoning).toBe("medium");
    expect(loaded.sources["llm.reasoning"]).toBe("provider-settings");
    expect(loaded.config.review.maxFindings).toBe(10);
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
        defaultReasoning: "high"
      },
      paths
    );

    expect(loadProviderSettings(paths)).toEqual({
      defaultProvider: "openai",
      defaultModel: "gpt-5",
      defaultReasoning: "high"
    });
    expect(statSync(paths.home).mode & 0o077).toBe(0);
    expect(statSync(paths.settingsPath).mode & 0o077).toBe(0);
  });
});

describe("removed review depth inputs (#183)", () => {
  it.each(["user", "repository"])("rejects review.depth in %s TOML", (layer) => {
    const repoRoot = tempDir();
    const home = tempDir();
    const configPath = layer === "user" ? path.join(home, "config.toml") : path.join(repoRoot, "codegenie.toml");
    writeFileSync(configPath, '[review]\ndepth = "normal"\n');
    expect(() => loadConfig({ repoRoot, homeOverride: home })).toThrow(expect.objectContaining({
      code: "config_error",
      context: expect.objectContaining({
        path: configPath,
        issues: expect.arrayContaining([expect.objectContaining({ code: "unrecognized_keys", path: ["review"], keys: ["depth"] })])
      })
    }));
  });

  it("drops the obsolete stored depth default silently and keeps other settings", () => {
    const repoRoot = tempDir();
    const home = tempDir();
    const paths = getCodegeniePaths(undefined, { CODEGENIE_HOME: home });
    ensureCodegenieHome(paths);
    const legacySettings = { defaultProvider: "openai", defaultDepth: "normal", defaultReasoning: "low" };
    writeFileSync(paths.settingsPath, JSON.stringify(legacySettings));
    const settings = loadProviderSettings(paths);
    expect(settings).toEqual({ defaultProvider: "openai", defaultReasoning: "low" });
    const loaded = loadConfig({ repoRoot, homeOverride: home, env: {} });
    expect(loaded.warnings).toEqual([]);
    expect(loaded.config.llm).toMatchObject({ provider: "openai", reasoning: "low" });
    expect(JSON.parse(readFileSync(paths.settingsPath, "utf8"))).toEqual(legacySettings);
    saveProviderSettings({ ...settings, defaultModel: "gpt-5" }, paths);
    expect(JSON.parse(readFileSync(paths.settingsPath, "utf8"))).toEqual({
      defaultProvider: "openai", defaultModel: "gpt-5", defaultReasoning: "low"
    });
  });

  it("still rejects unknown provider settings alongside a legacy depth default", () => {
    const paths = getCodegeniePaths(tempDir());
    writeFileSync(paths.settingsPath, JSON.stringify({ defaultDepth: "deep", defaultMode: "extra" }));
    expect(() => loadProviderSettings(paths)).toThrow(expect.objectContaining({
      code: "config_error",
      context: expect.objectContaining({
        issues: expect.arrayContaining([expect.objectContaining({ code: "unrecognized_keys", keys: ["defaultMode"] })])
      })
    }));
  });
});

describe("removed review.deepEnsemblePasses (#115)", () => {
  it("rejects the key in user config and eval cases", async () => {
    expect(rawConfigSchema.safeParse({ review: { adaptiveSecondPass: true } }).success).toBe(true);
    expect(rawConfigSchema.safeParse({ review: { deepEnsemblePasses: 1 } }).success).toBe(false);
    const evalCase = (review: Record<string, unknown>) => {
      const dir = tempDir();
      writeFileSync(path.join(dir, "eval.yml"), JSON.stringify({ name: "example", artifacts: { path: "logs/1" }, review }));
      return loadEvalSuite(dir);
    };
    await expect(evalCase({ adaptiveSecondPass: true })).resolves.toMatchObject({ cases: [expect.anything()] });
    await expect(evalCase({ deepEnsemblePasses: 1 })).rejects.toMatchObject({
      context: { errors: [expect.stringContaining("deepEnsemblePasses")] }
    });
  });
});

describe("eval stage keys after Stage 8 removal (#114)", () => {
  it("rejects a maxPromptCharsByStage key for the deleted Stage 8", async () => {
    const evalCase = (stages: Record<string, number>) => {
      const dir = tempDir();
      writeFileSync(path.join(dir, "eval.yml"), JSON.stringify({ name: "example", artifacts: { path: "logs/1" }, expect: { maxPromptCharsByStage: stages } }));
      return loadEvalSuite(dir);
    };
    await expect(evalCase({ "7": 1000 })).resolves.toMatchObject({ cases: [expect.anything()] });
    await expect(evalCase({ "8": 1000 })).rejects.toMatchObject({
      context: { errors: [expect.stringContaining("maxPromptCharsByStage")] }
    });
  });
});

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "codegenie-"));
}
