import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { validateToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../src/config/schema.js";
import type { PiAiAdapter, PiAssistantMessage, PiToolCall } from "../src/llm/llm-runner.js";
import { runReview } from "../src/pipeline/review-runner.js";
import type { CodeninjaConfig, PlannerDossier, ReviewPacket } from "../src/types.js";
import { commitAll, git, initRepo, writeRepoFile } from "./helpers/git.js";

describe("phase 6 live review path", () => {
  it("uses the Pi runner end to end for branch reviews with repair, retry, and follow-up notes", async () => {
    const repo = initRepo();
    writeRepoFile(repo, "app.ts", "export function divide(total: number, count: number) {\n  return total / Math.max(1, count);\n}\n");
    commitAll(repo, "base");
    git(repo, ["checkout", "-b", "feature"]);
    writeRepoFile(repo, "app.ts", "export function divide(total: number, count: number) {\n  return total / count;\n}\n");
    commitAll(repo, "remove zero guard", "Drops the fallback denominator for zero counts.");

    const runArtifactDir = path.join(mkdtempSync(path.join(tmpdir(), "codeninja-phase6-")), "live-review");
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    const adapter = liveReviewAdapter();
    const output: string[] = [];

    try {
      const result = await runReview(
        { mode: "branch", branchName: "feature" },
        liveConfig(runArtifactDir),
        {
          repoRoot: repo,
          runArtifactDir,
          piAdapter: adapter,
          writeOutput: (text) => output.push(text)
        }
      );

      expect(result.summary).toBe("Live review found one issue.");
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]).toMatchObject({
        title: "Division by zero guard was removed",
        path: "app.ts",
        publication: "inline",
        finalBody: expect.stringContaining("Restoring the guard")
      });
      expect(result.needsHumanAttention).toEqual([
        {
          question: "Check whether callers can pass zero count.",
          files: ["app.ts"],
          symbols: ["divide"],
          reason: "The changed function now divides by count directly.",
          confidence: "medium"
        }
      ]);
      expect(output.join("\n")).toContain("Live review found one issue.");
      expect(output.join("\n")).toContain("## Needs Human Attention");
      expect(adapter.callsByPrompt).toMatchObject({
        planner: 1,
        packetReview: 2,
        verifier: 2,
        composer: 1
      });

      const modelCalls = readJsonl<{ stage: number; role: string; kind: string; status: string; attempt: number; errorCode?: string }>(
        path.join(runArtifactDir, "model-calls.jsonl")
      );
      expect(modelCalls.map((call) => call.stage)).toEqual(expect.arrayContaining([5, 7, 9, 10]));
      expect(modelCalls.some((call) => call.stage === 8)).toBe(false);
      expect(modelCalls).toEqual(expect.arrayContaining([
        expect.objectContaining({ stage: 7, role: "packetReview", status: "schema_invalid", errorCode: "llm_schema_invalid" }),
        expect.objectContaining({ stage: 7, role: "packetReview", kind: "repair", status: "ok" }),
        expect.objectContaining({ stage: 9, role: "verifier", status: "transient_error", attempt: 1 }),
        expect.objectContaining({ stage: 9, role: "verifier", status: "ok", attempt: 2 }),
        expect.objectContaining({ stage: 10, role: "composer", status: "ok" })
      ]));

      const events = readJsonl<{ stage: number; message: string }>(path.join(runArtifactDir, "events.jsonl"));
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ stage: 7, message: "follow_up_hint" })
      ]));
      expect(events.some((event) => event.stage === 8)).toBe(false);
      expect(deferredStage8Artifacts(runArtifactDir)).toEqual([]);
      expect(existsSync(path.join(runArtifactDir, "final-review.md"))).toBe(true);
      expect(readFileSync(path.join(runArtifactDir, "final-review.md"), "utf8")).toContain("Restoring the guard");
    } finally {
      random.mockRestore();
    }
  });
});

function liveConfig(runArtifactDir: string): CodeninjaConfig {
  return {
    ...defaultConfig,
    lenses: { enabled: ["core/code-review"], disabled: [], extraSkillPaths: [] },
    llm: { provider: "scripted", model: "scripted-model", maxConcurrentCalls: 1 },
    telemetry: { ...defaultConfig.telemetry, enabled: true, runDir: path.dirname(runArtifactDir) },
    review: { ...defaultConfig.review, concurrency: 1, maxModelCalls: 12 }
  };
}

function liveReviewAdapter(): PiAiAdapter & { callsByPrompt: Record<"planner" | "packetReview" | "verifier" | "composer", number> } {
  const callsByPrompt = {
    planner: 0,
    packetReview: 0,
    verifier: 0,
    composer: 0
  };

  return {
    callsByPrompt,
    resolveModel: () => ({ provider: "scripted", id: "scripted-model", raw: { id: "scripted-model", api: "faux" } }),
    complete: async (_model, context) => {
      const prompt = firstPrompt(context);
      if (prompt.includes("planning")) {
        callsByPrompt.planner += 1;
        const dossier = extractPromptJson<PlannerDossier>(prompt, "planner-dossier");
        if (!dossier) {
          throw new Error("planner prompt did not include dossier");
        }
        return assistant([toolCall("submit-plan-live", "submit_plan", planFromDossier(dossier))]);
      }
      if (prompt.includes("packet review")) {
        callsByPrompt.packetReview += 1;
        if (callsByPrompt.packetReview === 1) {
          return assistant([toolCall("submit-review-invalid", "submit_review", { packetId: "model-owned-field" })]);
        }
        const packet = extractPromptJson<ReviewPacket>(prompt, "review-packet");
        if (!packet) {
          throw new Error("packet review prompt did not include packet");
        }
        return assistant([toolCall("submit-review-live", "submit_review", packetReviewFromPacket(packet))]);
      }
      if (prompt.includes("composition")) {
        callsByPrompt.composer += 1;
        const groups = extractPromptJson<Array<{ representative?: { id?: string } }>>(prompt, "grouped-findings") ?? [];
        const findingId = groups[0]?.representative?.id;
        if (!findingId) {
          throw new Error("composer prompt did not include a finding id");
        }
        return assistant([toolCall("submit-composition-live", "submit_composition", {
          summary: "Live review found one issue.",
          composedFindings: [
            {
              findingIds: [findingId],
              finalBody: "Restoring the guard preserves the previous behavior when count is zero.",
              publication: "inline"
            }
          ]
        })]);
      }
      if (prompt.includes("verification")) {
        callsByPrompt.verifier += 1;
        if (callsByPrompt.verifier === 1) {
          const error = new Error("rate limited") as Error & { status: number; headers: Record<string, string> };
          error.status = 429;
          error.headers = { "retry-after": "0" };
          throw error;
        }
        return assistant([toolCall("submit-verdict-live", "submit_verdict", {
          verdict: "keep",
          reason: "The changed code divides by an unguarded parameter.",
          requiredEvidencePresent: true,
          falsePositiveRisk: "low"
        })]);
      }
      throw new Error("unknown live review prompt");
    },
    validateToolCall: (tools, call) => validateToolCall(tools, call)
  };
}

function planFromDossier(dossier: PlannerDossier): Record<string, unknown> {
  return {
    diffUnderstanding: {
      declaredIntent: "Remove divide guard.",
      inferredBehavior: "The divide helper now uses count directly."
    },
    riskAreas: [
      {
        area: "numeric safety",
        reason: "The changed code removes a guard around a divisor.",
        files: ["app.ts"],
        suggestedLenses: ["core/code-review"]
      }
    ],
    coverage: dossier.files.flatMap((file) =>
      file.hunks.map((hunk) => ({
        hunkId: hunk.hunkId,
        path: file.path,
        coverage: "normal",
        lenses: ["core/code-review"],
        surroundingContextHints: [],
        reason: "The hunk changes divisor behavior."
      }))
    )
  };
}

function packetReviewFromPacket(packet: ReviewPacket): Record<string, unknown> {
  const hunk = packet.hunks[0];
  if (!hunk) {
    throw new Error("expected packet hunk");
  }
  const line = hunk.changedNewLineNumbers[0] ?? hunk.newStart;
  return {
    findings: [
      {
        title: "Division by zero guard was removed",
        severity: "high",
        confidence: "high",
        path: packet.path,
        anchor: { path: packet.path, line, side: "RIGHT", hunkId: hunk.hunkId },
        category: "correctness",
        evidence: { changedCode: "return total / count;" },
        failureMode: "Calling divide with count equal to zero now returns Infinity instead of using the previous fallback denominator.",
        whyThisMatters: "Callers that rely on a finite result can now propagate invalid numeric values.",
        suggestedFix: "Restore the guard or reject zero counts before division.",
        suggestedTest: "Add a test for divide(total, 0).",
        verification: "The changed hunk replaces Math.max(1, count) with count."
      }
    ],
    followUpHints: [
      {
        question: "Check whether callers can pass zero count.",
        files: ["app.ts"],
        symbols: ["divide"],
        suggestedLenses: ["core/code-review"],
        reason: "The changed function now divides by count directly.",
        confidence: "medium"
      }
    ],
    uncertainties: []
  };
}

function firstPrompt(context: { messages: unknown[] }): string {
  const first = context.messages[0];
  if (first && typeof first === "object" && "content" in first) {
    return String((first as { content?: unknown }).content ?? "");
  }
  return "";
}

function assistant(content: PiAssistantMessage["content"]): PiAssistantMessage {
  return {
    role: "assistant",
    provider: "scripted",
    model: "scripted-model",
    content,
    usage: {
      input: 100,
      output: 40,
      totalTokens: 140,
      cost: { total: 0.02 }
    },
    stopReason: "toolUse",
    timestamp: 0
  };
}

function toolCall(id: string, name: string, args: Record<string, unknown>): PiToolCall {
  return {
    type: "toolCall",
    id,
    name,
    arguments: args
  };
}

function extractPromptJson<T>(prompt: string, label: string): T | undefined {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(`untrusted-data label=${escaped}\\n([\\s\\S]*?)\\n\`{4,}`, "u").exec(prompt);
  if (!match?.[1]) {
    return undefined;
  }
  return JSON.parse(match[1]) as T;
}

function readJsonl<T>(filePath: string): T[] {
  return readFileSync(filePath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
}

function deferredStage8Artifacts(runArtifactDir: string): string[] {
  return readdirSync(runArtifactDir).filter((entry) =>
    /(^|[-_])stage[-_]?8($|[-_.])|system[-_]?follow[-_]?up|system[-_]?review|review[-_]?signals/iu.test(entry)
  );
}
