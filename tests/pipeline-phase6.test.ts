import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { validateToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../src/config/schema.js";
import type { PiAiAdapter, PiAssistantMessage, PiToolCall } from "../src/llm/llm-runner.js";
import { reviewCacheFingerprint, runReview } from "../src/pipeline/review-runner.js";
import type { CodegenieConfig, PlannerDossier, ResolvedReviewInput, ReviewPacket } from "../src/types.js";
import { commitAll, git, initRepo, writeRepoFile } from "./helpers/git.js";

describe("phase 6 live review path", () => {
  it("keeps review cache fingerprints stable across telemetry output directories", () => {
    const resolved: ResolvedReviewInput = {
      mode: "commit_range",
      repoRoot: "/repo",
      startCommit: "base",
      endCommit: "head",
      mergeBase: "base",
      commits: [{ sha: "head", title: "change", body: "" }],
      rawDiff: "diff --git a/app.ts b/app.ts\n"
    };
    const baseConfig = {
      ...defaultConfig,
      telemetry: { ...defaultConfig.telemetry, runDir: ".codegenie/runs-a", debugTrace: false },
      eval: { ...defaultConfig.eval, logsDir: "logs-a" },
      cache: { ...defaultConfig.cache, dir: ".codegenie/cache-a" }
    };
    const changedOutputDirs = {
      ...baseConfig,
      telemetry: { ...baseConfig.telemetry, runDir: ".codegenie/runs-b", debugTrace: true },
      eval: { ...baseConfig.eval, logsDir: "logs-b" },
      cache: { ...baseConfig.cache, dir: ".codegenie/cache-b" }
    };

    expect(reviewCacheFingerprint(baseConfig, "/repo", resolved, "registry")).toBe(
      reviewCacheFingerprint(changedOutputDirs, "/repo", resolved, "registry")
    );
    expect(
      reviewCacheFingerprint(baseConfig, "/repo", { ...resolved, rawDiff: `${resolved.rawDiff}+changed\n` }, "registry")
    ).not.toBe(reviewCacheFingerprint(baseConfig, "/repo", resolved, "registry"));
    expect(
      reviewCacheFingerprint({
        ...baseConfig,
        llm: { ...baseConfig.llm, model: "different-model" }
      }, "/repo", resolved, "registry")
    ).not.toBe(reviewCacheFingerprint(baseConfig, "/repo", resolved, "registry"));
  });

  it("uses the Pi runner end to end for branch reviews with repair, retry, and covered follow-up suppression", async () => {
    const repo = initRepo();
    writeRepoFile(repo, "app.ts", "export function divide(total: number, count: number) {\n  return total / Math.max(1, count);\n}\n");
    commitAll(repo, "base");
    git(repo, ["checkout", "-b", "feature"]);
    writeRepoFile(repo, "app.ts", "export function divide(total: number, count: number) {\n  return total / count;\n}\n");
    commitAll(repo, "remove zero guard", "Drops the fallback denominator for zero counts.");

    const runArtifactDir = path.join(mkdtempSync(path.join(tmpdir(), "codegenie-phase6-")), "live-review");
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
      expect(result.needsHumanAttention).toEqual([]);
      expect(output.join("\n")).toContain("Live review found one issue.");
      expect(output.join("\n")).not.toContain("## Needs Human Attention");
      expect(output.join("\n")).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz1234567890");
      expect(output.join("\n")).toContain("[redacted:");
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

      const events = readJsonl<{ stage: number; message: string; data?: Record<string, unknown> }>(path.join(runArtifactDir, "events.jsonl"));
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ stage: 1, message: "stage_started" }),
        expect.objectContaining({ stage: 1, message: "stage_completed" }),
        expect.objectContaining({ stage: 2, message: "stage_started" }),
        expect.objectContaining({ stage: 2, message: "stage_completed" }),
        expect.objectContaining({ stage: 3, message: "stage_started" }),
        expect.objectContaining({ stage: 3, message: "stage_completed" }),
        expect.objectContaining({ stage: 7, message: "follow_up_hint" })
      ]));
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ stage: 8, message: "stage_started" }),
        expect.objectContaining({ stage: 8, message: "system_review_skipped" }),
        expect.objectContaining({ stage: 8, message: "stage_completed" })
      ]));
      expect(deferredStage8Artifacts(runArtifactDir)).toEqual([]);
      expect(existsSync(path.join(runArtifactDir, "final-review.md"))).toBe(true);
      const finalReview = readFileSync(path.join(runArtifactDir, "final-review.md"), "utf8");
      expect(finalReview).toContain("Restoring the guard");
      expect(finalReview).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz1234567890");
      expect(finalReview).toContain("[redacted:");
      const runJson = JSON.parse(readFileSync(path.join(runArtifactDir, "run.json"), "utf8")) as {
        totals: { packets: number; candidates: number; verified: number; finalFindings: number };
      };
      expect(runJson.totals).toMatchObject({ packets: 1, candidates: 1, verified: 1, finalFindings: 1 });
      const telemetryJson = JSON.parse(readFileSync(path.join(runArtifactDir, "telemetry.json"), "utf8")) as {
        stages: Record<string, { startedAt?: string; completedAt?: string; runtimeMs: number }>;
        packets: { generated: number; reviewed: number };
        candidates: { generated: number; verificationScheduled: number };
        verdicts: { accept: number };
        finalSelection: { finalFindings: number };
      };
      expect(telemetryJson.stages["1"]).toMatchObject({ startedAt: expect.any(String), completedAt: expect.any(String) });
      expect(telemetryJson.stages["2"]).toMatchObject({ startedAt: expect.any(String), completedAt: expect.any(String) });
      expect(telemetryJson.stages["3"]).toMatchObject({ startedAt: expect.any(String), completedAt: expect.any(String) });
      expect(telemetryJson.stages["8"]).toMatchObject({ startedAt: expect.any(String), completedAt: expect.any(String) });
      expect(telemetryJson.packets).toMatchObject({ generated: 1, reviewed: 1 });
      expect(telemetryJson.candidates).toMatchObject({ generated: 1, verificationScheduled: 1 });
      expect(telemetryJson.verdicts).toMatchObject({ accept: 1 });
      expect(telemetryJson.finalSelection).toMatchObject({ finalFindings: 1 });
    } finally {
      random.mockRestore();
    }
  });

  it("marks budget-limited packet dispatch as a partial run with explicit artifacts", async () => {
    const repo = initRepo();
    for (const name of ["one", "two", "three", "four"]) {
      writeRepoFile(repo, `${name}.ts`, `export const ${name} = 1;\n`);
    }
    const base = commitAll(repo, "base");
    git(repo, ["checkout", "-b", "feature"]);
    for (const name of ["one", "two", "three", "four"]) {
      writeRepoFile(repo, `${name}.ts`, `export const ${name} = 2;\n`);
    }
    const head = commitAll(repo, "feature");
    const runArtifactDir = path.join(mkdtempSync(path.join(tmpdir(), "codegenie-partial-budget-")), "live-review");
    const adapter = partialBudgetAdapter();

    const result = await runReview(
      { mode: "commit_range", startCommit: base, endCommit: head },
      {
        ...liveConfig(runArtifactDir),
        review: { ...defaultConfig.review, concurrency: 1, maxModelCalls: 3 },
        llm: { provider: "scripted", model: "scripted-model", maxConcurrentCalls: 1 }
      },
      {
        repoRoot: repo,
        runArtifactDir,
        piAdapter: adapter
      }
    );

    expect(adapter.callsByPrompt).toMatchObject({ planner: 1, packetReview: 1, verifier: 0, composer: 1 });
    expect(result.coverage).toMatchObject({
      partial: true,
      budgetStopped: true,
      reviewedHunks: 1,
      failedHunks: 3,
      budgetStop: expect.objectContaining({ reason: "max_model_calls", stage: 7 })
    });
    expect(result.coverage.unreviewedHunksByPath).toHaveLength(3);

    const finalReview = readFileSync(path.join(runArtifactDir, "final-review.md"), "utf8");
    expect(finalReview).toContain("Partial review: 3 hunks were not reviewed because budget was exhausted before dispatch.");
    expect(finalReview).toContain("Unreviewed hunks by file:");
    expect(finalReview).toContain("budget stopped before dispatch");

    const coverageJson = JSON.parse(readFileSync(path.join(runArtifactDir, "coverage.json"), "utf8")) as {
      status: { budgetStop?: { reason?: string }; unreviewedHunksByPath?: unknown[] };
      records: Array<{ status: string; reason?: string }>;
    };
    expect(coverageJson.status.budgetStop).toMatchObject({ reason: "max_model_calls" });
    expect(coverageJson.status.unreviewedHunksByPath).toHaveLength(3);
    expect(coverageJson.records.filter((record) => record.reason === "budget_stopped before dispatch")).toHaveLength(3);

    const runJson = JSON.parse(readFileSync(path.join(runArtifactDir, "run.json"), "utf8")) as {
      outcome: { status: string; exitCode: number; budgetStop?: { reason?: string } };
      budgetStop?: { reason?: string };
    };
    expect(runJson.outcome).toMatchObject({ status: "completed_partial", exitCode: 0 });
    expect(runJson.outcome.budgetStop).toMatchObject({ reason: "max_model_calls" });
    expect(runJson.budgetStop).toMatchObject({ reason: "max_model_calls" });

    const telemetryJson = JSON.parse(readFileSync(path.join(runArtifactDir, "telemetry.json"), "utf8")) as {
      budgetStop?: { reason?: string };
    };
    expect(telemetryJson.budgetStop).toMatchObject({ reason: "max_model_calls" });

    const events = readJsonl<{ stage?: number; message: string; data?: { reason?: string } }>(path.join(runArtifactDir, "events.jsonl"));
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: "budget_stopped", data: expect.objectContaining({ reason: "max_model_calls" }) }),
      expect.objectContaining({ stage: 7, message: "packet_review_no_findings" })
    ]));
  });
});

function liveConfig(runArtifactDir: string): CodegenieConfig {
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
              finalBody:
                "Restoring the guard preserves the previous behavior when count is zero. Diagnostic token: ghp_abcdefghijklmnopqrstuvwxyz1234567890.",
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

function partialBudgetAdapter(): PiAiAdapter & { callsByPrompt: Record<"planner" | "packetReview" | "verifier" | "composer", number> } {
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
        return assistant([toolCall("submit-plan-partial", "submit_plan", planFromDossier(dossier))]);
      }
      if (prompt.includes("packet review")) {
        callsByPrompt.packetReview += 1;
        return assistant([toolCall("submit-review-empty", "submit_review", {
          reviewStatus: "no_findings",
          findings: [],
          followUpHints: [],
          uncertainties: [],
          noFindingReason: "Reviewed the packet and found no concrete failure mode."
        })]);
      }
      if (prompt.includes("composition")) {
        callsByPrompt.composer += 1;
        return assistant([toolCall("submit-composition-empty", "submit_composition", {
          summary: "No credible findings.",
          composedFindings: []
        })]);
      }
      if (prompt.includes("verification")) {
        callsByPrompt.verifier += 1;
        return assistant([toolCall("submit-verdict-unused", "submit_verdict", {
          verdict: "reject",
          reason: "No candidates should be verified in this test.",
          requiredEvidencePresent: false,
          falsePositiveRisk: "high"
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
    coverage: dossier.files.flatMap((file) =>
      file.hunks.map((hunk) => ({
        hunkId: hunk.hunkId,
        path: file.path,
        coverage: "normal",
        lenses: ["core/code-review"],
        surroundingContextHints: [],
        reason: "The hunk changes divisor behavior.",
        focusNotes: ["The changed code removes a guard around a divisor."],
        relatedSymbols: ["divide"]
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
