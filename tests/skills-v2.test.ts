import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { defaultConfig } from "../src/config/schema.js";
import { buildLensRegistry } from "../src/skills/lens-registry.js";
import { createPromptBuilder, projectSkills } from "../src/skills/prompt-builder.js";
import { loadSkills } from "../src/skills/skill-loader.js";
import type { CandidateFinding, PlannerDossier } from "../src/types.js";
import { nullTelemetry } from "./helpers/git.js";

it("loads every v2 skill and preserves the Stage 5 summaries and Stage 9 proof requirements", async () => {
  const telemetry = nullTelemetry();
  const logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  };
  const options = { repoRoot: "/unused-skill-fixture", extraSkillPaths: [], logger, telemetry };
  const v1 = await loadSkills(options);
  const v2 = await loadSkills({ ...options, instructionSet: "v2" });
  expect(v1.failures).toEqual([]);
  expect(v2.failures).toEqual([]);
  expect(v2.skills).toHaveLength(8);
  expect(v2.skills.map(skill => skill.id)).toEqual(v1.skills.map(skill => skill.id));
  expect(new Set(v2.skills.map(skill => skill.id)).size).toBe(v2.skills.length);

  const registry1 = buildLensRegistry(v1.skills, defaultConfig.lenses, logger, telemetry);
  const registry2 = buildLensRegistry(v2.skills, defaultConfig.lenses, logger, telemetry);
  const builder1 = createPromptBuilder(registry1);
  const builder2 = createPromptBuilder(registry2, { stage7Instructions: "v2" });
  const dossier: PlannerDossier = {
    runId: "skills-test", mode: "branch", depth: "normal", target: {}, commits: [],
    policyFilesChanged: [], hunkIndex: [], files: [], directories: [], lenses: [],
    filterSummary: { keptFiles: 0, skippedFiles: 0, skipped: [] },
    totals: { files: 0, keptFiles: 0, hunks: 0, addedLines: 0, deletedLines: 0 },
    compaction: { level: "full", omitted: [] }
  };
  expect(builder2.buildPlannerPrompt({ dossier, skills: v2.skills, lenses: registry2.enabledLenses() }))
    .toEqual(builder1.buildPlannerPrompt({ dossier, skills: v1.skills, lenses: registry1.enabledLenses() }));

  for (const skill of v2.skills) {
    const projected = projectSkills([skill], 7, { stage7Instructions: "v2" });
    expect(projected.perSkill[0]?.includedSections).not.toContain("falsePositives");
    expect(projected.text).not.toMatch(/Materiality:|Mitigation:/u);
  }

  const directionAdditions: Record<string, string> = {
    "lang/go/1": "work blocks or runs after its owner exits, or the owner closes, cancels or releases a resource while that work still uses it.",
    "lang/typescript/4": "a new variant reaches wrong or missing behavior, or a retired variant or an old persisted or API value is still accepted at a runtime boundary after the change."
  };
  for (const [index, oldSkill] of v1.skills.entries()) {
    const skill = v2.skills[index]!;
    const oldText = readFileSync(oldSkill.filePath, "utf8");
    const newText = readFileSync(skill.filePath, "utf8");
    expect(newText.split("# Checks")[0]).toBe(oldText.split("# Checks")[0]);
    expect(newText).not.toContain("Mitigation:");
    if (skill.id === "core/code-review") {
      expect(skill.sections.checks?.split("\n")).toHaveLength(10);
      expect(skill.sections.checks).toContain("a retired or invalid value still accepted");
      expect(skill.sections.checks).toContain("applied twice");
      expect(skill.sections.checks).toContain("still satisfiable from the transformed value");
      expect(skill.sections.falsePositives).toBe(oldSkill.sections.falsePositives);
      continue;
    }
    if (skill.id === "core/tests") {
      expect(skill.sections.checks).not.toContain("Regression focus");
      expect(skill.sections.checks).not.toContain("A new branch or edge case alone");
      expect(skill.sections.falsePositives).toContain("A new branch or edge case alone does not justify a finding.");
      expect(skill.sections.falsePositives).toContain("Proposed tests must exercise a reachable boundary");
      continue;
    }

    expect(skill.sections.examples).toBe(oldSkill.sections.examples);
    expect(skill.sections.safePatterns).toBe(oldSkill.sections.safePatterns);
    const oldRows = oldSkill.sections.checks!.split("\n");
    const newRows = skill.sections.checks!.split("\n");
    expect(newRows).toHaveLength(oldRows.length);
    const candidate: CandidateFinding = {
      id: "candidate", title: "Example regression", severity: "medium", confidence: "medium",
      category: "correctness", path: "example", changedLine: true,
      evidence: { changedCode: "+change" }, failureMode: "The new behavior fails at the boundary.",
      whyThisMatters: "A required caller loses the result.", verification: "Inspect the changed line.",
      producedBy: { kind: "packet", stage: 7, packetId: "packet", lensId: skill.id, skillIds: [skill.id, "core/code-review"] }
    };
    const { prompt } = builder2.buildVerifierPrompt({
      candidate, originContext: "packet", hunksText: "+change",
      skills: [skill, v2.skills.find(entry => entry.id === "core/code-review")!]
    });
    for (const [row, oldLine] of oldRows.entries()) {
      const parts = /^(\d+\. \*\*.+?\*\*) Failure: (.+?) Materiality: (.+?) (Unsafe: .+?) Mitigation: /u.exec(oldLine);
      expect(parts, oldLine).not.toBeNull();
      const [, label, failure, materiality, examples] = parts!;
      expect(newRows[row]).toBe(`${label} Look for: ${directionAdditions[`${skill.id}/${row + 1}`] ?? failure} ${examples}`);
      expect(skill.sections.falsePositives).toContain(materiality);
      expect(prompt).toContain(materiality);
    }
    expect(skill.sections.falsePositives?.endsWith(oldSkill.sections.falsePositives!)).toBe(true);
  }
});
