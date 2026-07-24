import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config/schema.js";
import { detectLanguage } from "../src/git/detectors.js";
import { parseDiff } from "../src/git/diff-parser.js";
import { classifyChangedFiles, filterDiffFiles } from "../src/git/file-classifier.js";
import { resolveReviewInput } from "../src/git/review-input-resolver.js";
import { defaultFakeLenses } from "../src/llm/fake-runner.js";
import { buildReviewPackets } from "../src/pipeline/packet-builder.js";
import { buildPlannerDossier, defaultPlan } from "../src/pipeline/planner.js";
import { LanguageAdapterRegistry } from "../src/repo/language-adapter.js";
import { candidateTestPaths } from "../src/repo/likely-tests.js";
import { buildRepositoryIndex } from "../src/repo/repository-index.js";
import { TreeSitterService } from "../src/repo/tree-sitter/tree-sitter-service.js";
import { buildLensRegistry, skillsCompatibleWithLanguage } from "../src/skills/lens-registry.js";
import { BUNDLED_SKILL_WHY_LEDGER, createPromptBuilder } from "../src/skills/prompt-builder.js";
import { loadSkills } from "../src/skills/skill-loader.js";
import type { CandidateFinding, DiffHunk, Logger } from "../src/types.js";
import { commitAll, git, initRepo, nullTelemetry, writeRepoFile } from "./helpers/git.js";

describe("Plan 98 JavaScript vertical slice", () => {
  it("builds JavaScript structural context, likely tests, exact lens selection, and Stage 7/9 prompts", async () => {
    const repo = initRepo();
    const featureSource = fixture("service.jsx");
    const baseSource = featureSource.replace("return fetchRecord(id);", "return Promise.resolve(fetchRecord(id));");
    expect(baseSource).not.toBe(featureSource);
    writeRepoFile(repo, "src/service.jsx", baseSource);
    writeRepoFile(repo, "src/service.test.js", fixture("service.test.js"));
    commitAll(repo, "base");
    git(repo, ["checkout", "-b", "feature"]);
    writeRepoFile(repo, "src/service.jsx", featureSource);
    commitAll(repo, "simplify record loading");

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
    const plan = defaultPlan(dossier, lenses.enabledLenses(), "JavaScript structural fixture");
    const packets = await buildReviewPackets(plan, kept, facts, index, telemetry, {
      config: defaultConfig,
      enabledLenses: lenses.enabledLenses().map((lens) => lens.id)
    });

    expect(diff.files).toEqual([expect.objectContaining({ path: "src/service.jsx", language: "javascript" })]);
    expect(facts).toEqual([expect.objectContaining({ path: "src/service.jsx", language: "javascript", testStatus: "source" })]);
    expect(index.symbolFacts).toEqual([
      expect.objectContaining({
        path: "src/service.jsx",
        enclosingSymbol: "loadRecord",
        symbolKind: "function",
        symbolNativeKind: "function",
        symbolRange: [10, 12],
        source: "tree-sitter",
        confidence: "syntactic"
      })
    ]);

    const registry = new LanguageAdapterRegistry(new TreeSitterService());
    const adapter = registry.forPath("src/service.jsx");
    const parsed = await adapter.parse({
      path: "src/service.jsx",
      language: "javascript",
      content: featureSource,
      source: { kind: "head" }
    });
    expect(adapter.id).toBe("javascript");
    expect(parsed).toMatchObject({ language: "javascript", adapterId: "javascript", hasErrors: false });
    expect(parsed.tree).toBeDefined();
    expect(adapter.getImports(parsed)).toEqual([
      "./polyfill.js",
      "./legacy.cjs",
      "./normalize.js",
      "./fetch-record.js",
      "./helpers.js"
    ]);

    const symbols = adapter.listSymbols(parsed);
    expect(symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "legacy", kind: "value", nativeKind: "const", exported: false }),
      expect.objectContaining({ name: "SERVICE_VERSION", kind: "value", nativeKind: "const", exported: true }),
      expect.objectContaining({ name: "loadRecord", kind: "function", signature: "async function loadRecord(id)", exported: true }),
      expect.objectContaining({ name: "streamRecords", kind: "function", signature: "function* streamRecords(records)", exported: true }),
      expect.objectContaining({ name: "makeLoader", kind: "function", nativeKind: "arrow function", signature: "makeLoader = (transport) =>" }),
      expect.objectContaining({ name: "RecordService", kind: "type", nativeKind: "class", lineRange: [22, 35] }),
      expect.objectContaining({ name: "#refresh", kind: "method", ownerType: "RecordService", exported: false }),
      expect.objectContaining({ name: "constructor", kind: "method", ownerType: "RecordService" }),
      expect.objectContaining({ name: "load", kind: "method", ownerType: "RecordService" }),
      expect.objectContaining({ name: "render", kind: "method", ownerType: "RecordService", signature: "render = (record) =>" }),
      expect.objectContaining({ name: "ExpressionService", kind: "type", nativeKind: "class", signature: "ExpressionService = class" }),
      expect.objectContaining({ name: "execute", kind: "method", ownerType: "ExpressionService" })
    ]));
    expect(symbols.find((symbol) => symbol.name === "#token")).toBeUndefined();
    expect(symbols.every((symbol) => (symbol.signature?.length ?? 0) <= 600)).toBe(true);
    expect(adapter.getEnclosingSymbol(parsed, 11)).toMatchObject({ name: "loadRecord", lineRange: [10, 12] });
    expect(adapter.getEnclosingSymbol(parsed, 24)).toMatchObject({ name: "#refresh", ownerType: "RecordService" });
    expect(adapter.getEnclosingSymbol(parsed, 39)).toMatchObject({ name: "execute", ownerType: "ExpressionService" });

    const identityHunk: DiffHunk = {
      id: "javascript-load-record",
      hunkHash: "0000000000000000000000000000000000000000000000000000000000000000",
      path: parsed.path,
      oldStart: 10,
      oldLines: 0,
      newStart: 10,
      newLines: 3,
      header: "",
      lines: [10, 11].map((line) => ({ kind: "add" as const, content: "+", newLineNumber: line }))
    };
    expect(adapter.getChangedSymbols(parsed, identityHunk)).toEqual([
      expect.objectContaining({ name: "loadRecord", lineRange: [10, 12], changedLines: [10, 11] })
    ]);

    const parsedTests = await adapter.parse({
      path: "src/service.test.js",
      language: "javascript",
      source: { kind: "head" },
      content: fixture("service.test.js")
    });
    expect(adapter.listSymbols(parsedTests).filter((symbol) => symbol.nativeKind === "test case").map((symbol) => symbol.name)).toEqual([
      "service",
      "loads a record",
      "preserves missing records",
      "loads record %s"
    ]);

    const outline = await index.tools.readFileOutline("src/service.jsx");
    expect(outline.meta).toMatchObject({ backend: "tree-sitter", precision: "syntactic", degraded: false });
    expect(outline.outline).toMatchObject({
      path: "src/service.jsx",
      language: "javascript",
      imports: ["./polyfill.js", "./legacy.cjs", "./normalize.js", "./fetch-record.js", "./helpers.js"]
    });

    expect(packets).toHaveLength(1);
    const packet = packets[0]!;
    expect(packet).toMatchObject({
      path: "src/service.jsx",
      language: "javascript",
      lenses: expect.arrayContaining(["lang/javascript"]),
      context: {
        path: "src/service.jsx",
        enclosingFunction: expect.objectContaining({ name: "loadRecord", lineRange: [10, 12] })
      }
    });
    expect(packet.lenses).not.toContain("lang/typescript");
    expect(packet.contextText).toContain("async function loadRecord(id)");
    expect(packet.packetSymbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "loadRecord", lineRange: [10, 12] })
    ]));
    expect(packet.relevantTests).toEqual([
      expect.objectContaining({ path: "src/service.test.js", name: "service", nativeKind: "test case", lineRange: [3, 15] }),
      expect.objectContaining({ path: "src/service.test.js", name: "loads a record", nativeKind: "test case", lineRange: [4, 6] }),
      expect.objectContaining({ path: "src/service.test.js", name: "preserves missing records", nativeKind: "test case", lineRange: [8, 10] }),
      expect.objectContaining({ path: "src/service.test.js", name: "loads record %s", nativeKind: "test case", lineRange: [12, 14] })
    ]);
    const publicLikelyTests = await index.tools.findLikelyTests({ path: "src/service.jsx" });
    expect(publicLikelyTests.meta).toMatchObject({ backend: "tree-sitter", precision: "heuristic", degraded: false });
    expect(publicLikelyTests.tests).toEqual(packet.relevantTests);

    const compatibleSkills = skillsCompatibleWithLanguage(
      packet.lenses.flatMap((lensId) => lenses.skillsForLens(lensId)),
      packet.language
    );
    expect(compatibleSkills.map((skill) => skill.id)).toContain("lang/javascript");
    expect(compatibleSkills.map((skill) => skill.id)).not.toContain("lang/typescript");
    const promptBuilder = createPromptBuilder(lenses);
    const stage7 = promptBuilder.buildPacketReviewPrompt({ packet, skills: compatibleSkills });
    expect(stage7.prompt).toContain("Floating promises");
    expect(stage7.prompt).toContain("Module interop mismatch");
    expect(stage7.prompt).not.toContain("Non-null assertions");
    expect(stage7.prompt).not.toContain("discriminated unions");
    expect(stage7.projection?.perSkill.every((entry) => !entry.omitted && entry.truncatedChars === 0)).toBe(true);
    expect(stage7.projection?.totalChars).toBeLessThanOrEqual(12_000);

    const stage9 = promptBuilder.buildVerifierPrompt({
      candidate: fixtureCandidate(packet.id),
      originContext: packet.contextText,
      hunksText: packet.hunks.map((hunk) => hunk.contentWithLineNumbers).join("\n"),
      skills: compatibleSkills
    });
    expect(stage9.prompt).toContain("detached promises with contained rejection");
    expect(stage9.prompt).toContain("Object.hasOwn");
    expect(stage9.prompt).not.toContain("Exhaustive `never` checks");
    expect(stage9.projection?.perSkill.every((entry) => !entry.omitted && entry.truncatedChars === 0)).toBe(true);
    expect(stage9.projection?.totalChars).toBeLessThanOrEqual(12_000);
  });

  it("pins JavaScript extensions, fake planning, default exports, and deterministic test conventions", async () => {
    const registry = new LanguageAdapterRegistry(new TreeSitterService());
    for (const extension of ["js", "jsx", "mjs", "cjs"]) {
      const filePath = `src/module.${extension}`;
      expect(detectLanguage(filePath).value).toBe("javascript");
      expect(registry.languageForPath(filePath)).toBe("javascript");
      expect(registry.forPath(filePath).id).toBe("javascript");
      expect(defaultFakeLenses(filePath)).toContain("lang/javascript");
      expect(defaultFakeLenses(filePath)).not.toContain("lang/typescript");
    }

    const adapter = registry.forPath("src/defaults.mjs");
    const parsed = await adapter.parse({
      path: "src/defaults.mjs",
      language: "javascript",
      source: { kind: "head" },
      content: fixture("defaults.mjs")
    });
    expect(parsed.hasErrors).toBe(false);
    expect(adapter.listSymbols(parsed)).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "default", kind: "function", signature: "function (input)", exported: true }),
      expect.objectContaining({ name: "NamedClass", kind: "type", signature: "NamedClass = class", exported: true }),
      expect.objectContaining({ name: "run", kind: "method", ownerType: "NamedClass", exported: true })
    ]));

    const allPaths = [
      "src/service.jsx",
      "src/service.test.js",
      "src/service.spec.mjs",
      "src/__tests__/service.cjs",
      "test/service.jsx",
      "tests/service.test.jsx",
      "tests/service.spec.cjs",
      "src/unrelated.test.js"
    ];
    expect(candidateTestPaths("src/service.jsx", allPaths, "javascript")).toEqual([
      "src/__tests__/service.cjs",
      "src/service.spec.mjs",
      "src/service.test.js",
      "test/service.jsx",
      "tests/service.spec.cjs",
      "tests/service.test.jsx"
    ]);
  });

  it("holds every JavaScript skill check to the owner matrix and keeps TypeScript guidance separate", async () => {
    const { skills, failures } = await loadSkills({
      repoRoot: process.cwd(),
      extraSkillPaths: [],
      logger: silentLogger(),
      telemetry: nullTelemetry()
    });
    expect(failures).toEqual([]);
    const javascript = skills.find((skill) => skill.id === "lang/javascript");
    const typescript = skills.find((skill) => skill.id === "lang/typescript");
    expect(javascript).toMatchObject({
      languages: ["javascript"],
      lenses: ["lang/javascript"],
      enabledByDefault: true
    });
    expect(typescript).toMatchObject({ languages: ["typescript", "tsx"], lenses: ["lang/typescript"] });
    for (const section of ["checks", "falsePositives", "safePatterns", "examples"] as const) {
      expect(javascript?.sections[section]?.trim().length, section).toBeGreaterThan(0);
    }

    const checks = javascript?.sections.checks?.split(/\n(?=\d+\. \*\*)/u) ?? [];
    expect(checks).toHaveLength(8);
    for (const check of checks) {
      const matrix = parseOwnerMatrix(check);
      expect(matrix.failure.length, check).toBeGreaterThan(15);
      expect(matrix.materiality, check).toMatch(/require/iu);
      expect(matrix.materiality, check).toMatch(/severity/iu);
      expect(matrix.unsafe, check).toMatch(/^`[^`]+`/u);
      expect(matrix.safe, check).toMatch(/^`[^`]+`/u);
      expect(matrix.safe, check).not.toBe(matrix.unsafe);
      expect(matrix.mitigation.length, check).toBeGreaterThan(20);
    }
    expect(javascript?.sections.falsePositives).toContain("detached promises with contained rejection");
    expect(javascript?.sections.falsePositives).toContain("deliberate dual-package exports");
    expect(javascript?.sections.falsePositives).toContain("Object.hasOwn");
    expect(javascript?.sections.falsePositives).toContain("validated values");
    expect(javascript?.sections.falsePositives).toContain("immutable copies");
    expect(javascript?.sections.falsePositives).toContain("idempotent cleanup");
    const javascriptGuidance = Object.values(javascript?.sections ?? {}).join("\n");
    expect(javascriptGuidance).not.toContain("Non-null assertions");
    expect(javascriptGuidance).not.toContain("discriminated unions");
    expect(javascriptGuidance).not.toContain("Exhaustive `never` checks");

    const ledger = BUNDLED_SKILL_WHY_LEDGER["lang/javascript"];
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
  return readFileSync(path.join(process.cwd(), "tests", "fixtures", "tree-sitter", "javascript", fileName), "utf8");
}

function silentLogger(): Logger {
  const noop = () => undefined;
  return { debug: noop, info: noop, warn: noop, error: noop };
}

function fixtureCandidate(packetId: string): CandidateFinding {
  return {
    id: "javascript-structural-candidate",
    title: "Record loading no longer preserves the wrapper contract",
    severity: "medium",
    confidence: "high",
    path: "src/service.jsx",
    changedLine: true,
    category: "correctness",
    evidence: { changedCode: "return fetchRecord(id);" },
    failureMode: "The changed loader bypasses the fixture's wrapper behavior.",
    whyThisMatters: "Callers observe a different loading contract.",
    verification: "Compare the old and new loader implementation.",
    producedBy: {
      kind: "packet",
      stage: 7,
      packetId,
      lensId: "lang/javascript",
      skillIds: ["lang/javascript"]
    }
  };
}
