import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config/schema.js";
import { parseDiff } from "../src/git/diff-parser.js";
import { classifyChangedFiles, filterDiffFiles } from "../src/git/file-classifier.js";
import { resolveReviewInput } from "../src/git/review-input-resolver.js";
import { buildReviewPackets } from "../src/pipeline/packet-builder.js";
import { buildPlannerDossier, defaultPlan } from "../src/pipeline/planner.js";
import { LanguageAdapterRegistry } from "../src/repo/language-adapter.js";
import { buildRepositoryIndex } from "../src/repo/repository-index.js";
import { TreeSitterService } from "../src/repo/tree-sitter/tree-sitter-service.js";
import { buildLensRegistry, skillsCompatibleWithLanguage } from "../src/skills/lens-registry.js";
import { BUNDLED_SKILL_WHY_LEDGER, createPromptBuilder } from "../src/skills/prompt-builder.js";
import { loadSkills } from "../src/skills/skill-loader.js";
import type { CandidateFinding, DiffHunk, Logger, RepositoryToolsHost } from "../src/types.js";
import { commitAll, git, initRepo, nullTelemetry, writeRepoFile } from "./helpers/git.js";

describe("Plan 98 Python vertical slice", () => {
  it("builds clean Python structural context, likely tests, lens selection, and Stage 7/9 skill prompts", async () => {
    const repo = initRepo();
    const featureSource = fixture("payment.py");
    const baseSource = featureSource.replace('        "authorize",', '        "authorize-v1",');
    expect(baseSource).not.toBe(featureSource);
    writeRepoFile(repo, "pyproject.toml", "[project]\nname = \"payment\"\nversion = \"0.1.0\"\n");
    writeRepoFile(repo, "src/payment.py", baseSource);
    writeRepoFile(repo, "src/payment_test.py", fixture("payment_test.py"));
    writeRepoFile(repo, "src/test_payment.py", fixture("test_payment.py"));
    writeRepoFile(repo, "tests/payment_test.py", fixture("integration_payment_test.py"));
    writeRepoFile(repo, "tests/test_payment.py", fixture("integration_test_payment.py"));
    commitAll(repo, "base");
    git(repo, ["checkout", "-b", "feature"]);
    writeRepoFile(repo, "src/payment.py", featureSource);
    commitAll(repo, "change authorize audit label");

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
    const { skills, failures } = await loadSkills({
      repoRoot: repo,
      extraSkillPaths: [],
      logger: silentLogger(),
      telemetry
    });
    expect(failures).toEqual([]);
    const lenses = buildLensRegistry(skills, defaultConfig.lenses, silentLogger(), telemetry);
    const dossier = await buildPlannerDossier(
      resolved,
      kept,
      facts,
      decisions,
      index,
      defaultConfig,
      telemetry,
      { lenses: lenses.enabledLenses() }
    );
    const plan = defaultPlan(dossier, lenses.enabledLenses(), "Python structural fixture");
    const packets = await buildReviewPackets(plan, kept, facts, index, telemetry, {
      config: defaultConfig,
      enabledLenses: lenses.enabledLenses().map((lens) => lens.id)
    });

    expect(diff.files).toEqual([expect.objectContaining({ path: "src/payment.py", language: "python" })]);
    expect(facts).toEqual([expect.objectContaining({ path: "src/payment.py", language: "python", testStatus: "source" })]);
    expect(index.symbolFacts).toEqual([
      expect.objectContaining({
        path: "src/payment.py",
        enclosingSymbol: "PaymentService.authorize",
        symbolKind: "method",
        symbolNativeKind: "async method",
        symbolRange: [28, 41],
        source: "tree-sitter",
        confidence: "syntactic"
      })
    ]);

    const adapter = new LanguageAdapterRegistry(new TreeSitterService()).forPath("src/payment.py");
    const parsed = await adapter.parse({
      path: "src/payment.py",
      language: "python",
      content: featureSource,
      source: { kind: "head" }
    });
    expect(adapter.id).toBe("python");
    expect(parsed).toMatchObject({ language: "python", adapterId: "python", hasErrors: false });
    expect(parsed.tree).toBeDefined();
    for (const line of [28, 30, 33, 39]) {
      expect(adapter.getEnclosingSymbol(parsed, line), String(line)).toMatchObject({
        name: "authorize",
        ownerType: "PaymentService",
        lineRange: [28, 41]
      });
    }

    const outline = await index.tools.readFileOutline("src/payment.py");
    expect(outline.meta).toMatchObject({ backend: "tree-sitter", precision: "syntactic", degraded: false });
    expect(outline.outline).toMatchObject({
      path: "src/payment.py",
      language: "python",
      imports: ["__future__", "decimal", "asyncio", "os.path", ".gateways", "..shared.money", "."]
    });
    expect(outline.outline.topLevelSymbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "PaymentService", kind: "type", lineRange: [24, 46] }),
      expect.objectContaining({ name: "authorize", kind: "method", ownerType: "PaymentService", lineRange: [28, 41] }),
      expect.objectContaining({ name: "normalized", kind: "function", lineRange: [36, 37] }),
      expect.objectContaining({ name: "Receipt", kind: "type", ownerType: "PaymentService" })
    ]));

    expect(packets).toHaveLength(1);
    const packet = packets[0]!;
    expect(packet).toMatchObject({
      path: "src/payment.py",
      language: "python",
      lenses: expect.arrayContaining(["lang/python"]),
      context: {
        path: "src/payment.py",
        enclosingMethod: expect.objectContaining({ name: "authorize", ownerType: "PaymentService", lineRange: [28, 41] }),
        enclosingType: expect.objectContaining({ name: "PaymentService", kind: "type" })
      }
    });
    expect(packet.contextText).toContain("@audit( \"authorize\", ) async def authorize(");
    expect(packet.packetSymbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "authorize", ownerType: "PaymentService" })
    ]));
    expect(packet.relevantTests).toEqual([
      expect.objectContaining({ path: "src/payment_test.py", name: "test_authorize_rejects_zero", nativeKind: "test case", lineRange: [9, 13] }),
      expect.objectContaining({ path: "src/payment_test.py", name: "test_authorize_accepts_positive", nativeKind: "test case", lineRange: [17, 19] }),
      expect.objectContaining({ path: "src/test_payment.py", name: "test_authorize_uses_gateway", nativeKind: "test case", lineRange: [4, 5] }),
      expect.objectContaining({ path: "tests/payment_test.py", name: "test_authorize_package_variant", nativeKind: "test case", lineRange: [4, 5] }),
      expect.objectContaining({ path: "tests/test_payment.py", name: "test_authorize_integration", nativeKind: "test case", lineRange: [5, 6] })
    ]);
    const publicLikelyTests = await index.tools.findLikelyTests({ path: "src/payment.py" });
    expect(publicLikelyTests.meta).toMatchObject({ backend: "tree-sitter", precision: "heuristic", degraded: false });
    expect(publicLikelyTests.tests).toEqual(packet.relevantTests);

    const compatibleSkills = skillsCompatibleWithLanguage(
      packet.lenses.flatMap((lensId) => lenses.skillsForLens(lensId)),
      packet.language
    );
    expect(compatibleSkills.map((skill) => skill.id)).toContain("lang/python");
    const promptBuilder = createPromptBuilder(lenses);
    const stage7 = promptBuilder.buildPacketReviewPrompt({ packet, skills: compatibleSkills });
    expect(stage7.prompt).toContain("Mutable defaults");
    expect(stage7.prompt).toContain("subprocess` argv with `shell=False");
    expect(stage7.prompt).not.toContain("Reachable panic paths");
    expect(stage7.prompt).not.toContain("Floating promises");
    expect(stage7.prompt).not.toContain("Goroutine leaks");
    expect(stage7.projection?.perSkill.every((entry) => !entry.omitted && entry.truncatedChars === 0)).toBe(true);

    const candidate = fixtureCandidate(packet.id);
    const stage9 = promptBuilder.buildVerifierPrompt({
      candidate,
      originContext: packet.contextText,
      hunksText: packet.hunks.map((hunk) => hunk.contentWithLineNumbers).join("\n"),
      skills: compatibleSkills
    });
    expect(stage9.prompt).toContain("integer minor units");
    expect(stage9.prompt).toContain("already-open descriptor");
    expect(stage9.prompt).not.toContain("mere presence of `unsafe`");
    expect(stage9.prompt).not.toContain("Promise.allSettled");
    expect(stage9.projection?.perSkill.every((entry) => !entry.omitted && entry.truncatedChars === 0)).toBe(true);
  });

  it("selects the containing nested class when owner names collide", async () => {
    const repo = initRepo();
    const featureSource = [
      "class Duplicate:",
      "    def unrelated(self) -> bool:",
      "        return False",
      "",
      "",
      "class Outer:",
      "    class Duplicate:",
      "        @audit(\"target\")",
      "        def target(self) -> bool:",
      "            return True",
      ""
    ].join("\n");
    const baseSource = featureSource.replace('@audit("target")', '@audit("legacy-target")');
    writeRepoFile(repo, "pyproject.toml", "[project]\nname = \"owner-collision\"\nversion = \"0.1.0\"\n");
    writeRepoFile(repo, "src/collision.py", baseSource);
    commitAll(repo, "base");
    git(repo, ["checkout", "-b", "feature"]);
    writeRepoFile(repo, "src/collision.py", featureSource);
    commitAll(repo, "change nested target decorator");

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
    const file = kept[0]!;
    const packetContext = await (index.tools as RepositoryToolsHost).buildPacketContext(file, file.hunks, index.symbolFacts);

    expect(index.symbolFacts).toEqual([
      expect.objectContaining({
        enclosingSymbol: "Duplicate.target",
        symbolRange: [8, 10],
        source: "tree-sitter"
      })
    ]);
    expect(packetContext.outline?.topLevelSymbols.filter((symbol) => symbol.name === "Duplicate")).toEqual([
      expect.objectContaining({ name: "Duplicate", nativeKind: "class", lineRange: [1, 3] }),
      expect.objectContaining({ name: "Duplicate", nativeKind: "nested class", ownerType: "Outer", lineRange: [7, 10] })
    ]);
    expect(packetContext.context).toMatchObject({
      enclosingMethod: expect.objectContaining({ name: "target", ownerType: "Duplicate", lineRange: [8, 10] }),
      enclosingType: expect.objectContaining({
        name: "Duplicate",
        nativeKind: "nested class",
        ownerType: "Outer",
        lineRange: [7, 10]
      })
    });
  });

  it("keeps Unicode signatures, async classification, and changed-symbol identity exact", async () => {
    const adapter = new LanguageAdapterRegistry(new TreeSitterService()).forPath("src/unicode.py");
    const parsed = await adapter.parse({
      path: "src/unicode.py",
      language: "python",
      content: fixture("unicode.py"),
      source: { kind: "head" }
    });

    expect(parsed).toMatchObject({ adapterId: "python", hasErrors: false });
    expect(adapter.listSymbols(parsed).find((entry) => entry.name === "fetch_value")).toMatchObject({
      name: "fetch_value",
      kind: "function",
      nativeKind: "async function",
      lineRange: [3, 10],
      signature: '@trace( "café", ) async def fetch_value( item_id: str, ) -> str:'
    });

    const hunk: DiffHunk = {
      id: "python-unicode-identity",
      path: parsed.path,
      oldStart: 9,
      oldLines: 0,
      newStart: 9,
      newLines: 2,
      header: "",
      lines: [9, 10].map((line) => ({ kind: "add" as const, content: "+", newLineNumber: line }))
    };
    expect(adapter.getChangedSymbols(parsed, hunk)).toEqual([
      expect.objectContaining({
        name: "fetch_value",
        signature: '@trace( "café", ) async def fetch_value( item_id: str, ) -> str:',
        changedLines: [9, 10]
      })
    ]);
  });

  it("holds every Python skill check to an independently parsed owner matrix", async () => {
    const { skills } = await loadSkills({
      repoRoot: process.cwd(),
      extraSkillPaths: [],
      logger: silentLogger(),
      telemetry: nullTelemetry()
    });
    const python = skills.find((skill) => skill.id === "lang/python");
    expect(python).toMatchObject({
      languages: ["python"],
      lenses: ["lang/python"],
      enabledByDefault: true
    });
    for (const section of ["checks", "falsePositives", "safePatterns", "examples"] as const) {
      expect(python?.sections[section]?.trim().length, section).toBeGreaterThan(0);
    }

    const checks = python?.sections.checks?.split(/\n(?=\d+\. \*\*)/u) ?? [];
    expect(checks).toHaveLength(8);
    for (const check of checks) {
      const matrix = parseOwnerMatrix(check);
      expect(matrix.failure.length, check).toBeGreaterThan(15);
      expect(matrix.materiality, check).toMatch(/severity/iu);
      expect(matrix.unsafe, check).toMatch(/^`[^`]+`/u);
      expect(matrix.safe, check).toMatch(/^`[^`]+`/u);
      expect(matrix.safe, check).not.toBe(matrix.unsafe);
      expect(matrix.mitigation.length, check).toBeGreaterThan(20);
      expect(matrix.mitigation, check).not.toBe(matrix.safe);
      if (check.includes("Invalid `None` propagation")) {
        expect(matrix.safe, check).toContain("-> str | None");
      }
    }
    expect(python?.sections.falsePositives).toContain("never-mutated defaults");
    expect(python?.sections.falsePositives).toContain("catches and re-raises");
    expect(python?.sections.falsePositives).toContain("integer minor units");
    expect(python?.sections.falsePositives).toContain("iteration over a copy");
    expect(python?.sections.falsePositives).toContain("argv with `shell=False`");

    const ledger = BUNDLED_SKILL_WHY_LEDGER["lang/python"];
    expect(ledger?.length).toBeGreaterThanOrEqual(3);
    expect(ledger?.every((entry) => entry.surface.length > 0 && entry.reason.length > 0 && entry.evidence.length > 0)).toBe(true);
  });
});

function parseOwnerMatrix(check: string): Record<"failure" | "materiality" | "unsafe" | "safe" | "mitigation", string> {
  const match = /Failure: (?<failure>.*?) Materiality: (?<materiality>.*?) Unsafe: (?<unsafe>.*?) Safe: (?<safe>.*?) Mitigation: (?<mitigation>.*)$/u.exec(check);
  expect(match?.groups, check).toBeDefined();
  return match!.groups as Record<"failure" | "materiality" | "unsafe" | "safe" | "mitigation", string>;
}

function fixture(fileName: string): string {
  return readFileSync(path.join(process.cwd(), "tests", "fixtures", "tree-sitter", "python", fileName), "utf8");
}

function silentLogger(): Logger {
  const noop = () => undefined;
  return { debug: noop, info: noop, warn: noop, error: noop };
}

function fixtureCandidate(packetId: string): CandidateFinding {
  return {
    id: "python-structural-candidate",
    title: "Authorize audit label changed",
    severity: "medium",
    confidence: "high",
    path: "src/payment.py",
    changedLine: true,
    category: "correctness",
    evidence: { changedCode: '@audit("authorize")' },
    failureMode: "The changed decorator routes audit records under a different label.",
    whyThisMatters: "Payment authorization observability changes.",
    verification: "Compare the old and new audit decorator arguments.",
    producedBy: {
      kind: "packet",
      stage: 7,
      packetId,
      lensId: "lang/python",
      skillIds: ["lang/python"]
    }
  };
}
