import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config/schema.js";
import { loadEvalSuite } from "../src/evals/eval-runner.js";
import { parseDiff } from "../src/git/diff-parser.js";
import { classifyChangedFiles, filterDiffFiles } from "../src/git/file-classifier.js";
import { resolveReviewInput } from "../src/git/review-input-resolver.js";
import { buildReviewPackets } from "../src/pipeline/packet-builder.js";
import { buildPlannerDossier, defaultPlan } from "../src/pipeline/planner.js";
import { buildRepositoryIndex } from "../src/repo/repository-index.js";
import { buildLensRegistry, skillsCompatibleWithLanguage } from "../src/skills/lens-registry.js";
import { projectSkills } from "../src/skills/prompt-builder.js";
import { loadSkills } from "../src/skills/skill-loader.js";
import type { Logger } from "../src/types.js";
import { nullTelemetry } from "./helpers/git.js";

const fixtureRoot = path.resolve("evals/skill-semantics/repos");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Plan 101 language-skill semantic fixtures", () => {
  it("pre-registers three marker-free uncached semantic eval cases", async () => {
    const suite = await loadEvalSuite(path.resolve("evals/skill-semantics"));
    expect(suite.cases.map((entry) => entry.evalCase.name)).toEqual([
      "skill-semantics-python-mutable-default",
      "skill-semantics-solidity-oracle-freshness",
      "skill-semantics-typescript-runtime-validation"
    ]);
    for (const { evalCase } of suite.cases) {
      expect(evalCase.repeat).toBe(3);
      expect(evalCase.review).toMatchObject({
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        reasoning: "high",
        cache: false,
        concurrency: 1
      });
      const raw = readFileSync(path.resolve("evals/skill-semantics", `${evalCase.name.split("-")[2]}.yml`), "utf8");
      expect(raw).not.toContain("CODEGENIE_FAKE_FINDING");
    }
  });

  it("builds exact-language packets with linked tests and untruncated guidance", async () => {
    const cases = [
      { language: "typescript", path: "src/config.ts", lens: "lang/typescript", testPath: "src/config.test.ts" },
      { language: "python", path: "src/collector.py", lens: "lang/python", testPath: "src/test_collector.py" },
      { language: "solidity", path: "src/PriceConsumer.sol", lens: "lang/solidity", testPath: "test/PriceConsumer.t.sol" }
    ];
    for (const semanticCase of cases) {
      const repo = initializeFixtureGit(semanticCase.language);
      const telemetry = nullTelemetry();
      const resolved = await resolveReviewInput(
        { mode: "branch", branchName: "feature" },
        defaultConfig,
        telemetry,
        { repoRoot: repo }
      );
      const diff = parseDiff(resolved.rawDiff);
      const { kept, decisions } = await filterDiffFiles(resolved, diff, defaultConfig, telemetry);
      const facts = await classifyChangedFiles(resolved, kept, decisions, defaultConfig, telemetry);
      const index = await buildRepositoryIndex(resolved, kept, facts, defaultConfig, telemetry);
      const loaded = await loadSkills({
        repoRoot: repo,
        extraSkillPaths: [],
        logger: silentLogger(),
        telemetry
      });
      expect(loaded.failures, semanticCase.language).toEqual([]);
      const registry = buildLensRegistry(loaded.skills, defaultConfig.lenses, silentLogger(), telemetry);
      const dossier = await buildPlannerDossier(
        resolved,
        kept,
        facts,
        decisions,
        index,
        defaultConfig,
        telemetry,
        { lenses: registry.enabledLenses() }
      );
      const plan = defaultPlan(dossier, registry.enabledLenses(), `Plan 101 ${semanticCase.language} fixture`);
      const packets = await buildReviewPackets(plan, kept, facts, index, telemetry, {
        config: defaultConfig,
        enabledLenses: registry.enabledLenses().map((lens) => lens.id)
      });
      const packet = packets.find((entry) => entry.path === semanticCase.path);
      expect(packet, semanticCase.language).toBeDefined();
      expect(packet).toMatchObject({ language: semanticCase.language, contextQuality: "full" });
      expect(packet?.lenses.filter((lens) => lens.startsWith("lang/"))).toEqual([semanticCase.lens]);
      expect(packet?.relevantTests.map((test) => test.path)).toContain(semanticCase.testPath);
      const skills = skillsCompatibleWithLanguage(
        packet!.lenses.flatMap((lens) => registry.skillsForLens(lens)),
        packet!.language
      );
      expect(skills.filter((skill) => skill.id.startsWith("lang/")).map((skill) => skill.id)).toEqual([semanticCase.lens]);
      for (const stage of [7, 8, 9] as const) {
        const projection = projectSkills(skills, stage);
        expect(projection.perSkill.every((entry) => !entry.omitted && entry.truncatedChars === 0), `${semanticCase.language} stage ${String(stage)}`).toBe(true);
      }
    }
  }, 15_000);

  it("builds TypeScript base/feature, preserves the safe control, and reproduces the runtime-validation failure", () => {
    const repo = materialize("typescript", false);
    const tsc = path.resolve("node_modules/.bin/tsc");
    run(tsc, ["-p", "tsconfig.json"], repo);
    run(process.execPath, ["dist/config.test.js"], repo);
    run(process.execPath, ["dist/safe-config.test.js"], repo);

    overlayFeature(repo, "typescript");
    rmSync(path.join(repo, "dist"), { recursive: true, force: true });
    run(tsc, ["-p", "tsconfig.json"], repo);
    run(process.execPath, ["dist/safe-config.test.js"], repo);
    expectFailure(process.execPath, ["dist/config.test.js"], repo, "malformed config reached runtime consumer");
  });

  it("compiles Python base/feature, preserves the None control, and reproduces cross-call state leakage", () => {
    const repo = materialize("python", false);
    const env = { ...process.env, PYTHONPATH: repo };
    run("python3", ["-m", "compileall", "-q", "-f", "src", "tests"], repo, env);
    run("python3", ["src/test_collector.py"], repo, env);
    run("python3", ["src/test_safe_collector.py"], repo, env);

    overlayFeature(repo, "python");
    run("python3", ["-m", "compileall", "-q", "-f", "src", "tests"], repo, env);
    run("python3", ["src/test_safe_collector.py"], repo, env);
    expectFailure("python3", ["src/test_collector.py"], repo, "['first', 'second'] != ['first']", env);
  });

  it("builds Foundry base/feature, preserves full oracle validation, and reproduces stale-price acceptance", () => {
    const repo = materialize("solidity", false);
    run("forge", ["build"], repo);
    run("forge", ["test", "--match-test", "testPositiveRejectsStaleRound"], repo);
    run("forge", ["test", "--match-test", "testSafeControlChecksFreshnessAndUnits"], repo);

    overlayFeature(repo, "solidity");
    run("forge", ["clean"], repo);
    run("forge", ["build"], repo);
    run("forge", ["test", "--match-test", "testSafeControlChecksFreshnessAndUnits"], repo);
    expectFailure("forge", ["test", "--match-test", "testPositiveRejectsStaleRound"], repo, "stale oracle data was accepted");
  }, 120_000);
});

function materialize(language: string, includeFeature: boolean): string {
  const directory = mkdtempSync(path.join(tmpdir(), `codegenie-plan101-${language}-`));
  temporaryDirectories.push(directory);
  cpSync(path.join(fixtureRoot, language, "base"), directory, { recursive: true });
  if (includeFeature) {
    overlayFeature(directory, language);
  }
  return directory;
}

function overlayFeature(repo: string, language: string): void {
  cpSync(path.join(fixtureRoot, language, "feature"), repo, { recursive: true });
}

function initializeFixtureGit(language: string): string {
  const repo = materialize(language, false);
  run("git", ["init", "-b", "main"], repo);
  run("git", ["config", "user.name", "Codegenie Fixture"], repo);
  run("git", ["config", "user.email", "fixture@example.com"], repo);
  run("git", ["add", "."], repo);
  run("git", ["commit", "-m", "base"], repo);
  run("git", ["checkout", "-b", "feature"], repo);
  overlayFeature(repo, language);
  run("git", ["add", "."], repo);
  run("git", ["commit", "-m", "semantic regression and safe control"], repo);
  return repo;
}

function silentLogger(): Logger {
  const noop = () => undefined;
  return { debug: noop, info: noop, warn: noop, error: noop };
}

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  return execFileSync(command, args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function expectFailure(
  command: string,
  args: string[],
  cwd: string,
  expected: string,
  env: NodeJS.ProcessEnv = process.env
): void {
  try {
    run(command, args, cwd, env);
  } catch (error) {
    const output = commandFailureOutput(error);
    expect(output).toContain(expected);
    return;
  }
  throw new Error(`expected ${command} ${args.join(" ")} to fail`);
}

function commandFailureOutput(error: unknown): string {
  if (typeof error !== "object" || error === null) {
    return String(error);
  }
  const candidate = error as { stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
  return [candidate.stdout, candidate.stderr, candidate.message]
    .map((value) => value?.toString() ?? "")
    .join("\n");
}
