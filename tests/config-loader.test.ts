import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ensureCodegenieHome, getCodegeniePaths } from "../src/config/paths.js";
import { loadConfig } from "../src/config/config-loader.js";
import { loadProviderSettings, saveProviderSettings } from "../src/provider/provider-settings.js";
import { CodegenieError } from "../src/util/errors.js";

describe("config loader", () => {
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
    expect(loaded.config.review.maxBudgetTokens).toBe(5_850_000);
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

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "codegenie-"));
}
