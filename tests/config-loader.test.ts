import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ensureCodeninjaHome, getCodeninjaPaths } from "../src/config/paths.js";
import { loadConfig } from "../src/config/config-loader.js";
import { loadProviderSettings, saveProviderSettings } from "../src/provider/provider-settings.js";
import { CodeninjaError } from "../src/util/errors.js";

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
      path.join(repoRoot, "codeninja.toml"),
      `
[review]
depth = "deep"
verify = true
maxFindings = 10

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
        CODENINJA_HOME: home,
        CODENINJA_PROVIDER: "env-provider",
        CODENINJA_REASONING: "xhigh"
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
    expect(loaded.config.llm.provider).toBe("env-provider");
    expect(loaded.config.llm.model).toBe("cli-model");
    expect(loaded.config.llm.reasoning).toBe("xhigh");
    expect(loaded.config.llm.maxConcurrentCalls).toBe(3);
    expect(loaded.config.git.baseBranch).toBe("master");
    expect(loaded.config.lenses.enabled).toEqual(["core/tests"]);
    expect(loaded.config.lenses.extraSkillPaths).toEqual(["/trusted/skills"]);
    expect(loaded.config.cache.enabled).toBe(true);
    expect(loaded.config.telemetry.enabled).toBe(true);
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
        "telemetry.enabled",
        "lenses.extraSkillPaths"
      ])
    );
  });

  it("rejects credential-bearing repo config fields", () => {
    const repoRoot = tempDir();
    const home = tempDir();
    writeFileSync(
      path.join(repoRoot, "codeninja.toml"),
      `
[llm]
apiKey = "sk-this-should-not-be-in-repo-config"
`
    );

    expect(() => loadConfig({ repoRoot, homeOverride: home })).toThrow(CodeninjaError);
    expect(() => loadConfig({ repoRoot, homeOverride: home })).toThrow(/credential-bearing/);
  });
});

describe("codeninja paths and provider settings", () => {
  it("resolves CODENINJA_HOME and writes settings with private permissions", () => {
    const home = tempDir();
    const paths = getCodeninjaPaths(undefined, { CODENINJA_HOME: home });
    expect(paths.home).toBe(path.resolve(home));
    expect(paths.settingsPath).toBe(path.join(path.resolve(home), "settings.json"));

    ensureCodeninjaHome(paths);
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
  return mkdtempSync(path.join(tmpdir(), "codeninja-"));
}
