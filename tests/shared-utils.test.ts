import { describe, expect, it } from "vitest";
import { stableJson, prettyStableJson } from "../src/util/json.js";
import {
  isCompositionTestPath,
  isCoverageEscalationTestPath,
  isDocsPath,
  isPacketReviewTestPath,
  isPromotionTestPath,
  isRepositoryTestPath
} from "../src/util/path-roles.js";
import {
  normalizeFollowUpQuestion,
  normalizeLooseFollowUpQuestion,
  normalizedAttentionTerms,
  normalizedTerms,
  tokenJaccard
} from "../src/util/text-similarity.js";
import { BUNDLED_SKILL_WHY_LEDGER, PROMPT_TEMPLATE_VERSIONS, PROMPT_TEMPLATE_WHY_LEDGER, projectSkills } from "../src/skills/prompt-builder.js";
import { loadSkills } from "../src/skills/skill-loader.js";
import { nullTelemetry } from "./helpers/git.js";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

describe("shared utility helpers", () => {
  it("keeps compact and pretty stable JSON byte shapes distinct", () => {
    const input = { b: 1, a: { d: 4, c: 3 } };

    expect(stableJson(input)).toBe("{\"a\":{\"c\":3,\"d\":4},\"b\":1}");
    expect(prettyStableJson(input)).toBe([
      "{",
      "  \"a\": {",
      "    \"c\": 3,",
      "    \"d\": 4",
      "  },",
      "  \"b\": 1",
      "}"
    ].join("\n"));
  });

  it("names the path-role test classifiers by their historical dialects", () => {
    expect(isRepositoryTestPath("pkg/service_test.go")).toBe(true);
    expect(isRepositoryTestPath("src/widget.spec.ts")).toBe(true);
    expect(isRepositoryTestPath("src/specs/widget.ts")).toBe(false);
    for (const testPath of ["test_widget.py", "widget_test.py", "tests/widget.py", "tests/widget.rs", "widget_test.rs", "Vault.t.sol"]) {
      expect(isRepositoryTestPath(testPath), testPath).toBe(true);
    }
    expect(isRepositoryTestPath("src/widget.rs")).toBe(false);
    expect(isRepositoryTestPath("src/Vault.sol")).toBe(false);

    expect(isCompositionTestPath("src/widget.spec.ts")).toBe(true);
    expect(isCompositionTestPath("src/specs/widget.ts")).toBe(false);
    expect(isCompositionTestPath("pkg/service_test.go")).toBe(false);
    for (const testPath of ["test_widget.py", "widget_test.py", "tests/widget.rs", "widget_test.rs", "Vault.t.sol"]) {
      expect(isCompositionTestPath(testPath), testPath).toBe(true);
    }

    expect(isCoverageEscalationTestPath("pkg/service_test.go")).toBe(true);
    expect(isCoverageEscalationTestPath("src/widget.spec.ts")).toBe(true);
    expect(isCoverageEscalationTestPath("src/specs/widget.ts")).toBe(false);
    for (const testPath of ["test_widget.py", "widget_test.py", "tests/widget.rs", "widget_test.rs", "Vault.t.sol"]) {
      expect(isCoverageEscalationTestPath(testPath), testPath).toBe(true);
    }

    expect(isPacketReviewTestPath("src/specs/widget.ts")).toBe(true);
    expect(isPacketReviewTestPath("src/widget-test.py")).toBe(true);
    for (const testPath of ["test_widget.py", "widget_test.py", "tests/widget.rs", "widget_test.rs", "Vault.t.sol"]) {
      expect(isPacketReviewTestPath(testPath), testPath).toBe(true);
    }

    expect(isPromotionTestPath("src/widget_test.py")).toBe(true);
    expect(isPromotionTestPath("src/specs/widget.ts")).toBe(true);
    for (const testPath of ["test_widget.py", "widget_test.py", "tests/widget.rs", "widget_test.rs", "Vault.t.sol"]) {
      expect(isPromotionTestPath(testPath), testPath).toBe(true);
    }

    expect(isDocsPath("docs/ADR.md")).toBe(true);
    expect(isDocsPath("src/widget.ts")).toBe(false);
  });

  it("keeps root-cause and attention term normalization separate", () => {
    expect(normalizedTerms("Verify payment contract behavior")).toEqual(new Set(["verify", "payment", "contract", "behavior"]));
    expect(normalizedAttentionTerms("Verify payment contract behavior")).toEqual(new Set(["payment", "contract", "behavior"]));
    expect(tokenJaccard(new Set(["a", "b"]), new Set(["b", "c"]))).toBe(1 / 3);
  });

  it("shares follow-up question normalization without changing key ownership", () => {
    const normalized = normalizeFollowUpQuestion("Please check whether `Foo.Bar()` still works?");

    expect(normalized).toBe("please check whether foo.bar still works");
    expect(normalizeLooseFollowUpQuestion(normalized)).toBe("foo.bar still works");
  });

  it("keeps a why ledger beside every versioned prompt stage", () => {
    expect(Object.keys(PROMPT_TEMPLATE_WHY_LEDGER).sort()).toEqual(Object.keys(PROMPT_TEMPLATE_VERSIONS).sort());
    for (const entries of Object.values(PROMPT_TEMPLATE_WHY_LEDGER)) {
      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) {
        expect(entry.surface.trim()).not.toBe("");
        expect(entry.reason.trim()).not.toBe("");
        expect(entry.evidence.trim()).not.toBe("");
      }
    }
    expect(PROMPT_TEMPLATE_WHY_LEDGER[9]).toEqual(expect.arrayContaining([
      expect.objectContaining({ evidence: expect.stringContaining("run 57 empty revise") }),
      expect.objectContaining({ evidence: expect.stringContaining("run 55 secondary-budget cap") }),
      expect.objectContaining({ evidence: expect.stringContaining("run 56 low-to-high inconsistency") }),
      expect.objectContaining({
        surface: "bounded verifier repair candidate evidence",
        evidence: expect.stringContaining("runs 58-60")
      })
    ]));
  });
});

describe("bundled skills: provenance ledger and projection caps", () => {
  const bundledIds = ["core", "lang"].flatMap((dir) =>
    readdirSync(path.resolve("bundled-skills", dir)).map((file) => {
      const raw = readFileSync(path.resolve("bundled-skills", dir, file), "utf8");
      const match = raw.match(/^id:\s*(\S+)/mu);
      return match?.[1] ?? "";
    })
  );

  it("every bundled skill has non-empty WHY-ledger entries", () => {
    expect(bundledIds.length).toBeGreaterThanOrEqual(4);
    for (const id of bundledIds) {
      const entries = BUNDLED_SKILL_WHY_LEDGER[id];
      expect(entries, id).toBeDefined();
      expect(entries!.length, id).toBeGreaterThan(0);
      for (const entry of entries!) {
        expect(entry.reason.length, id).toBeGreaterThan(0);
        expect(entry.evidence.length, id).toBeGreaterThan(0);
      }
    }
  });

  it("every bundled skill projects at stages 7, 8, and 9 without truncation or omission", async () => {
    const noop = () => undefined;
    const loaded = await loadSkills({
      repoRoot: process.cwd(),
      extraSkillPaths: [],
      logger: { debug: noop, info: noop, warn: noop, error: noop } as never,
      telemetry: nullTelemetry()
    });
    for (const id of bundledIds) {
      const skill = loaded.skills.find((entry) => entry.id === id);
      expect(skill, id).toBeDefined();
      for (const stage of [7, 8, 9] as const) {
        const projection = projectSkills([skill!], stage);
        const per = projection.perSkill[0]!;
        expect(per.omitted, `${id} stage ${String(stage)}`).toBe(false);
        expect(per.truncatedChars, `${id} stage ${String(stage)}`).toBe(0);
      }
    }
  });

  it("keeps Examples optional and uses inline owner matrices for language skills", async () => {
    const noop = () => undefined;
    const loaded = await loadSkills({
      repoRoot: process.cwd(),
      extraSkillPaths: [],
      logger: { debug: noop, info: noop, warn: noop, error: noop } as never,
      telemetry: nullTelemetry()
    });
    const languages = loaded.skills.filter((skill) => skill.id.startsWith("lang/"));
    expect(languages).toHaveLength(6);
    for (const skill of languages) {
      expect(skill.sections.examples, skill.id).toBeUndefined();
      const checks = skill.sections.checks?.split(/\n(?=\d+\. \*\*)/u) ?? [];
      expect(checks.length, skill.id).toBeGreaterThan(0);
      for (const check of checks) {
        const matrix = /Failure: (?<failure>.*?) Materiality: (?<materiality>.*?) Unsafe: (?<unsafe>.*?) Safe: (?<safe>.*?) Mitigation: (?<mitigation>.*)$/u.exec(check)?.groups;
        expect(matrix, `${skill.id}: ${check}`).toBeDefined();
        expect(matrix!.failure!.length, check).toBeGreaterThan(15);
        expect(matrix?.materiality, check).toMatch(/severity/iu);
        expect(matrix?.unsafe, check).toMatch(/^`[^`]+`/u);
        expect(matrix?.safe, check).toMatch(/^`[^`]+`/u);
        expect(matrix?.safe, check).not.toBe(matrix?.unsafe);
        expect(matrix!.mitigation!.length, check).toBeGreaterThan(20);
      }
    }
    expect(loaded.skills.find((skill) => skill.id === "core/code-review")?.sections.examples).toBeDefined();
    expect(loaded.skills.find((skill) => skill.id === "core/tests")?.sections.examples).toBeDefined();
  });

  it("keeps Stage 9 sections standalone and canonical composite projections within caps", async () => {
    const noop = () => undefined;
    const loaded = await loadSkills({
      repoRoot: process.cwd(),
      extraSkillPaths: [],
      logger: { debug: noop, info: noop, warn: noop, error: noop } as never,
      telemetry: nullTelemetry()
    });
    const core = ["core/code-review", "core/tests"].map((id) => loaded.skills.find((skill) => skill.id === id)!);
    const dangling = /checks? above|matching concrete failure|stated materiality|this guard|as written/iu;
    for (const skill of loaded.skills) {
      const stage9 = projectSkills([skill], 9);
      expect(stage9.text, skill.id).not.toMatch(dangling);
      expect(stage9.text, skill.id).toContain("### False Positives");
      expect(stage9.text, skill.id).toContain("### Safe Patterns");
    }
    for (const language of loaded.skills.filter((skill) => skill.id.startsWith("lang/"))) {
      for (const stage of [7, 8, 9] as const) {
        const projection = projectSkills([language, ...core], stage);
        expect(projection.totalChars, `${language.id} stage ${String(stage)}`).toBeLessThanOrEqual(12_000);
        expect(projection.perSkill.every((entry) => !entry.omitted && entry.truncatedChars === 0), `${language.id} stage ${String(stage)}`).toBe(true);
      }
    }
    expect(projectSkills([loaded.skills.find((skill) => skill.id === "lang/solidity")!], 8).totalChars).toBeLessThanOrEqual(3_800);
  });
});
