import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config/schema.js";
import { buildLensRegistry, skillsCompatibleWithLanguage } from "../src/skills/lens-registry.js";
import { createPromptBuilder } from "../src/skills/prompt-builder.js";
import { loadSkills } from "../src/skills/skill-loader.js";
import type { CandidateFinding, Logger, ReviewPacket } from "../src/types.js";
import { nullTelemetry } from "./helpers/git.js";

describe("Plan 98 cross-language release gate", () => {
  it("keeps Go, TypeScript, and JavaScript Stage 7/9 prompts isolated at the release boundary", async () => {
    const telemetry = nullTelemetry();
    const logger = silentLogger();
    const { skills, failures } = await loadSkills({
      repoRoot: mkdtempSync(path.join(tmpdir(), "codegenie-language-release-")),
      extraSkillPaths: [],
      logger,
      telemetry
    });
    expect(failures).toEqual([]);
    expect(skills.filter((skill) => skill.source === "bundled").map((skill) => skill.id)).toEqual([
      "core/code-review",
      "core/tests",
      "lang/go",
      "lang/javascript",
      "lang/python",
      "lang/rust",
      "lang/solidity",
      "lang/typescript"
    ]);

    const registry = buildLensRegistry(skills, defaultConfig.lenses, logger, telemetry);
    const promptBuilder = createPromptBuilder(registry);
    for (const fixture of [
      {
        language: "go",
        path: "service.go",
        lensId: "lang/go",
        stage7Marker: "Goroutine leaks",
        stage9Marker: "Passing caller context through unchanged",
        stage7ExcludedMarkers: ["Module interop mismatch", "Reachable panic paths", "Mutable defaults", "Repeated full `msg.value`"],
        stage9ExcludedMarkers: ["dual-package exports", "compiler-rejected lifetime", "integer minor units", "documented compatible delegatecall layouts"]
      },
      {
        language: "typescript",
        path: "service.ts",
        lensId: "lang/typescript",
        stage7Marker: "Floating promises",
        stage9Marker: "Promise.allSettled",
        stage7ExcludedMarkers: ["Module interop mismatch", "Reachable panic paths", "Mutable defaults", "Repeated full `msg.value`"],
        stage9ExcludedMarkers: ["dual-package exports", "compiler-rejected lifetime", "integer minor units", "documented compatible delegatecall layouts"]
      },
      {
        language: "javascript",
        path: "service.js",
        lensId: "lang/javascript",
        stage7Marker: "Module interop mismatch",
        stage9Marker: "dual-package exports",
        stage7ExcludedMarkers: ["Non-null assertions", "Reachable panic paths", "Mutable defaults", "Repeated full `msg.value`"],
        stage9ExcludedMarkers: ["Exhaustive `never` checks", "compiler-rejected lifetime", "integer minor units", "documented compatible delegatecall layouts"]
      }
    ]) {
      const packet = releasePacket(fixture.path, fixture.language, fixture.lensId);
      const selectedSkills = skillsCompatibleWithLanguage(
        packet.lenses.flatMap((lensId) => registry.skillsForLens(lensId)),
        packet.language
      );
      expect(selectedSkills.map((skill) => skill.id)).toEqual([
        "core/code-review",
        "core/tests",
        fixture.lensId
      ]);

      const stage7 = promptBuilder.buildPacketReviewPrompt({ packet, skills: selectedSkills });
      const stage9 = promptBuilder.buildVerifierPrompt({
        candidate: releaseCandidate(packet, fixture.lensId),
        originContext: packet.contextText,
        hunksText: packet.hunks[0]!.contentWithLineNumbers,
        skills: selectedSkills
      });
      for (const [prompt, expectedMarker, excludedMarkers] of [
        [stage7, fixture.stage7Marker, fixture.stage7ExcludedMarkers],
        [stage9, fixture.stage9Marker, fixture.stage9ExcludedMarkers]
      ] as const) {
        expect(prompt.prompt).toContain(expectedMarker);
        for (const marker of excludedMarkers) {
          expect(prompt.prompt).not.toContain(marker);
        }
        expect(prompt.projection?.perSkill.map((entry) => entry.skillId)).toEqual([
          "core/code-review",
          "core/tests",
          fixture.lensId
        ]);
        expect(prompt.projection?.perSkill.every((entry) => !entry.omitted && entry.truncatedChars === 0)).toBe(true);
        expect(prompt.projection?.totalChars).toBeLessThanOrEqual(12_000);
      }
    }
  });
});

function releasePacket(pathname: string, language: string, lensId: string): ReviewPacket {
  return {
    id: `${language}-release-packet`,
    dispatchRank: [0, -1],
    kind: "hunk",
    prSummary: "Plan 98 release projection fixture",
    path: pathname,
    fileStatus: "modified",
    isDeletedContent: false,
    language,
    reviewPriority: "normal",
    coverage: "normal",
    reviewProfile: "simple",
    lenses: ["core/code-review", "core/tests", lensId],
    hunks: [{
      hunkId: `${language}-hunk`,
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      contentWithLineNumbers: "RIGHT 1: return changedValue",
      lines: [{ kind: "add", newLine: 1, content: "return changedValue" }],
      changedNewLineNumbers: [1],
      changedOldLineNumbers: []
    }],
    symbolFacts: [],
    context: { path: pathname },
    contextText: "return changedValue",
    relevantTests: [],
    surroundingContextHints: [],
    labels: [],
    attentionNotes: [],
    relatedChangedContext: [],
    toolBudget: { maxToolCalls: 0, maxInvestigationRounds: 0, maxResultChars: 0 }
  };
}

function releaseCandidate(packet: ReviewPacket, lensId: string): CandidateFinding {
  return {
    id: `${packet.language}-release-candidate`,
    title: "Changed value violates the fixture contract",
    severity: "medium",
    confidence: "high",
    path: packet.path,
    changedLine: true,
    category: "correctness",
    evidence: { changedCode: "return changedValue" },
    failureMode: "The changed value violates the caller-visible fixture contract.",
    whyThisMatters: "The release fixture models a real output boundary.",
    verification: "Inspect the changed return value.",
    producedBy: {
      kind: "packet",
      stage: 7,
      packetId: packet.id,
      lensId,
      skillIds: [lensId]
    }
  };
}

function silentLogger(): Logger {
  const noop = () => undefined;
  return { debug: noop, info: noop, warn: noop, error: noop };
}
