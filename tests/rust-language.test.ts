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
import { createPromptBuilder } from "../src/skills/prompt-builder.js";
import { loadSkills } from "../src/skills/skill-loader.js";
import type { CandidateFinding, Logger } from "../src/types.js";
import { commitAll, git, initRepo, nullTelemetry, writeRepoFile } from "./helpers/git.js";

describe("Plan 98 Rust vertical slice", () => {
  it("builds clean Rust structural context, likely tests, lens selection, and Stage 7/9 skill prompts", async () => {
    const repo = initRepo();
    const featureSource = fixture("payment.rs");
    const baseSource = featureSource.replace(
      "    #[inline]\n    pub fn capture(&self, amount: u64) -> bool {\n        amount > 0",
      "    #[cold]\n    pub fn capture(&self, amount: u64) -> bool {\n        amount >= 10"
    );
    expect(baseSource).not.toBe(featureSource);
    writeRepoFile(repo, "Cargo.toml", "[package]\nname = \"payment\"\nversion = \"0.1.0\"\n");
    writeRepoFile(repo, "src/payment.rs", baseSource);
    writeRepoFile(repo, "src/payment_test.rs", fixture("payment_test.rs"));
    writeRepoFile(repo, "tests/payment.rs", fixture("integration_payment.rs"));
    commitAll(repo, "base");
    git(repo, ["checkout", "-b", "feature"]);
    writeRepoFile(repo, "src/payment.rs", featureSource);
    commitAll(repo, "change capture boundary");

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
    const plan = defaultPlan(dossier, lenses.enabledLenses(), "Rust structural fixture");
    const packets = await buildReviewPackets(plan, kept, facts, index, telemetry, {
      config: defaultConfig,
      enabledLenses: lenses.enabledLenses().map((lens) => lens.id)
    });

    expect(diff.files).toEqual([expect.objectContaining({ path: "src/payment.rs", language: "rust" })]);
    expect(facts).toEqual([expect.objectContaining({ path: "src/payment.rs", language: "rust", testStatus: "source" })]);
    expect(index.symbolFacts).toEqual([
      expect.objectContaining({
        path: "src/payment.rs",
        enclosingSymbol: "Payment.capture",
        symbolKind: "method",
        symbolNativeKind: "impl method",
        symbolRange: [60, 63],
        source: "tree-sitter",
        confidence: "syntactic"
      })
    ]);

    const adapter = new LanguageAdapterRegistry(new TreeSitterService()).forPath("src/payment.rs");
    const parsed = await adapter.parse({
      path: "src/payment.rs",
      language: "rust",
      content: featureSource,
      source: { kind: "head" }
    });
    expect(adapter.id).toBe("rust");
    expect(parsed).toMatchObject({ language: "rust", adapterId: "rust", hasErrors: false });
    expect(parsed.tree).toBeDefined();
    expect(adapter.getEnclosingSymbol(parsed, 60)).toMatchObject({ name: "capture", ownerType: "Payment" });
    expect(adapter.getEnclosingSymbol(parsed, 61)).toMatchObject({ name: "capture", ownerType: "Payment" });
    expect(adapter.getEnclosingSymbol(parsed, 62)).toMatchObject({ name: "capture", ownerType: "Payment" });

    const outline = await index.tools.readFileOutline("src/payment.rs");
    expect(outline.meta).toMatchObject({ backend: "tree-sitter", precision: "syntactic", degraded: false });
    expect(outline.outline).toMatchObject({
      path: "src/payment.rs",
      language: "rust",
      imports: ["std::{fmt::Debug as StdDebug, sync::*}", "anyhow::Result", "alloc"]
    });
    expect(outline.outline.topLevelSymbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Payment", kind: "type" }),
      expect.objectContaining({ name: "capture", kind: "method", ownerType: "Payment", lineRange: [60, 63] })
    ]));

    expect(packets).toHaveLength(1);
    const packet = packets[0]!;
    expect(packet).toMatchObject({
      path: "src/payment.rs",
      language: "rust",
      lenses: expect.arrayContaining(["lang/rust"]),
      context: {
        path: "src/payment.rs",
        enclosingMethod: expect.objectContaining({ name: "capture", ownerType: "Payment", lineRange: [60, 63] }),
        enclosingType: expect.objectContaining({ name: "Payment", kind: "type" })
      }
    });
    expect(packet.contextText).toContain("pub fn capture(&self, amount: u64) -> bool");
    expect(packet.packetSymbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "capture", ownerType: "Payment" })
    ]));
    expect(packet.relevantTests).toEqual([
      expect.objectContaining({ path: "src/payment_test.rs", name: "authorize_rejects_zero", nativeKind: "test case", lineRange: [3, 7] }),
      expect.objectContaining({ path: "src/payment_test.rs", name: "authorize_async", nativeKind: "test case", lineRange: [9, 13] }),
      expect.objectContaining({ path: "tests/payment.rs", name: "capture_integration", nativeKind: "test case", lineRange: [3, 7] })
    ]);
    const publicLikelyTests = await index.tools.findLikelyTests({ path: "src/payment.rs" });
    expect(publicLikelyTests.meta).toMatchObject({ backend: "tree-sitter", precision: "heuristic", degraded: false });
    expect(publicLikelyTests.tests).toEqual(packet.relevantTests);

    const compatibleSkills = skillsCompatibleWithLanguage(
      packet.lenses.flatMap((lensId) => lenses.skillsForLens(lensId)),
      packet.language
    );
    expect(compatibleSkills.map((skill) => skill.id)).toContain("lang/rust");
    const promptBuilder = createPromptBuilder(lenses);
    const stage7 = promptBuilder.buildPacketReviewPrompt({ packet, skills: compatibleSkills });
    expect(stage7.prompt).toContain("Reachable panic paths");
    expect(stage7.prompt).not.toContain("Floating promises");
    expect(stage7.prompt).not.toContain("Goroutine leaks");
    expect(stage7.projection?.perSkill.find((entry) => entry.skillId === "lang/rust")).toMatchObject({
      omitted: false,
      truncatedChars: 0
    });

    const candidate = fixtureCandidate(packet.id);
    const stage9 = promptBuilder.buildVerifierPrompt({
      candidate,
      originContext: packet.contextText,
      hunksText: packet.hunks.map((hunk) => hunk.contentWithLineNumbers).join("\n"),
      skills: compatibleSkills
    });
    expect(stage9.prompt).toContain("Exclude compiler-rejected lifetime");
    expect(stage9.prompt).toContain("Prefer `TryFrom`");
    expect(stage9.prompt).not.toContain("Promise.allSettled");
    expect(stage9.prompt).not.toContain("Passing caller context");
    expect(stage9.projection?.perSkill.find((entry) => entry.skillId === "lang/rust")).toMatchObject({
      omitted: false,
      truncatedChars: 0
    });
  });

  it("holds every Rust skill check to the owner failure/materiality/example/mitigation matrix", async () => {
    const { skills } = await loadSkills({
      repoRoot: process.cwd(),
      extraSkillPaths: [],
      logger: silentLogger(),
      telemetry: nullTelemetry()
    });
    const rust = skills.find((skill) => skill.id === "lang/rust");
    expect(rust).toMatchObject({
      languages: ["rust"],
      lenses: ["lang/rust"],
      enabledByDefault: true
    });
    for (const section of ["checks", "falsePositives", "safePatterns", "examples"] as const) {
      expect(rust?.sections[section]?.trim().length, section).toBeGreaterThan(0);
    }
    const checks = rust?.sections.checks?.split(/\n(?=\d+\. \*\*)/u) ?? [];
    expect(checks).toHaveLength(7);
    for (const check of checks) {
      expect(check).toMatch(/Failure:/u);
      expect(check).toMatch(/Materiality:/u);
      expect(check).toMatch(/Materiality:[^.]*severity/iu);
      expect(check).toMatch(/Unsafe:/u);
      expect(check).not.toContain("Safe/mitigation:");
      const unsafeStart = check.indexOf("Unsafe:");
      const safeStart = check.indexOf("Safe:");
      const mitigationStart = check.indexOf("Mitigation:");
      expect(unsafeStart, check).toBeGreaterThan(check.indexOf("Materiality:"));
      expect(safeStart, check).toBeGreaterThan(unsafeStart);
      expect(mitigationStart, check).toBeGreaterThan(safeStart);
      const unsafeExample = check.slice(unsafeStart, safeStart).trim();
      const safeCounterexample = check.slice(safeStart, mitigationStart).trim();
      const mitigation = check.slice(mitigationStart).trim();
      expect(unsafeExample, check).toMatch(/Unsafe: `[^`]+`/u);
      expect(safeCounterexample, check).toMatch(/Safe: `[^`]+`/u);
      expect(unsafeExample, check).not.toBe(safeCounterexample);
      expect(mitigation.length, check).toBeGreaterThan("Mitigation:".length + 20);
      expect(mitigation, check).not.toBe(safeCounterexample);
    }
    expect(rust?.sections.falsePositives).toContain("compiler-rejected lifetime");
    expect(rust?.sections.falsePositives).toContain("widening/nonnumeric/bounded casts");
    expect(rust?.sections.falsePositives).toContain("best-effort results");
    expect(rust?.sections.falsePositives).toContain("test-only");
    expect(rust?.sections.falsePositives).toContain("mere presence of `unsafe`");
  });
});

function fixture(fileName: string): string {
  return readFileSync(path.join(process.cwd(), "tests", "fixtures", "tree-sitter", "rust", fileName), "utf8");
}

function silentLogger(): Logger {
  const noop = () => undefined;
  return { debug: noop, info: noop, warn: noop, error: noop };
}

function fixtureCandidate(packetId: string): CandidateFinding {
  return {
    id: "rust-structural-candidate",
    title: "Capture accepts an unintended boundary",
    severity: "medium",
    confidence: "high",
    path: "src/payment.rs",
    changedLine: true,
    category: "correctness",
    evidence: { changedCode: "amount > 0" },
    failureMode: "The changed boundary accepts amounts previously rejected.",
    whyThisMatters: "The payment contract changes.",
    verification: "Compare the old and new capture predicates.",
    producedBy: {
      kind: "packet",
      stage: 7,
      packetId,
      lensId: "lang/rust",
      skillIds: ["lang/rust"]
    }
  };
}
