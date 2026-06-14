import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../src/config/schema.js";
import type { LlmRunner, LlmStructuredRequest, PiAiAdapter, PiAssistantMessage, PiToolCall } from "../src/llm/llm-runner.js";
import { parseDiff } from "../src/git/diff-parser.js";
import { createPiRunner } from "../src/llm/pi-runner.js";
import { SubmitPacketReviewSchema } from "../src/llm/schemas.js";
import { buildReviewPackets, packetReviewContextFromDossier } from "../src/pipeline/packet-builder.js";
import { runLensPackets } from "../src/pipeline/lens-runner.js";
import { buildPlannerDossier, MAX_DOSSIER_PROMPT_CHARS, runPlanner } from "../src/pipeline/planner.js";
import { dedupeRankAndComposeReview } from "../src/pipeline/composer.js";
import { aggregateRunCoverage, BudgetLedger, runReview } from "../src/pipeline/review-runner.js";
import { verifyFindings } from "../src/pipeline/verifier.js";
import { createWorkerRunner } from "../src/pipeline/worker-runner.js";
import { renderMarkdownReview } from "../src/output/markdown-renderer.js";
import { renderPostingSummaryForStdout } from "../src/output/stdout-renderer.js";
import { createPromptBuilder } from "../src/skills/prompt-builder.js";
import { createRunTelemetry } from "../src/telemetry/run-artifacts.js";
import type {
  CandidateFinding,
  CodeninjaConfig,
  CoverageLevel,
  DiffFile,
  FileFacts,
  PlannerDossier,
  RepositoryIndex,
  RepositoryTools,
  RepositoryToolsHost,
  ReviewPacket,
  ReviewPlan,
  TelemetryEvent,
  UnifiedDiff
} from "../src/types.js";
import { CodeninjaError } from "../src/util/errors.js";
import { sha256Hex } from "../src/util/hashing.js";
import { commitAll, git, initRepo, nullTelemetry, writeRepoFile } from "./helpers/git.js";

describe("phase 5 pipeline regressions", () => {
  it("rethrows fatal provider errors from Stage 7 workers", async () => {
    const packet = fakePacket();
    const runner: LlmRunner = {
      runStructured: async () => {
        throw new CodeninjaError("llm_call_failed", "auth unavailable", { recoverable: false });
      }
    };

    await expect(
      runLensPackets(fakePlan(), [packet], fakeTools(), config(), nullTelemetry(), {
        runner,
        promptBuilder: fakePromptBuilder(),
        lensRegistry: fakeLensRegistry(),
        diff: fakeDiff()
      })
    ).rejects.toMatchObject({ code: "llm_call_failed", recoverable: false });
  });

  it("demotes anchors whose path does not match the packet and diff", async () => {
    const runner: LlmRunner = {
      runStructured: async <T>() =>
        ({
          findings: [
            {
              title: "bad anchor",
              severity: "medium",
              confidence: "medium",
              path: "other.ts",
              anchor: { path: "other.ts", line: 1, side: "RIGHT", hunkId: "h1" },
              category: "correctness",
              evidence: { changedCode: "+bad" },
              failureMode: "bad path",
              whyThisMatters: "wrong file",
              verification: "test"
            }
          ],
          followUpHints: [],
          uncertainties: []
        }) as T
    };

    const [result] = await runLensPackets(fakePlan(), [fakePacket()], fakeTools(), config(), nullTelemetry(), {
      runner,
      promptBuilder: fakePromptBuilder(),
      lensRegistry: fakeLensRegistry(),
      diff: fakeDiff()
    });

    expect(result?.findings[0]).toMatchObject({
      changedLine: false
    });
    expect(result?.findings[0]?.anchor).toBeUndefined();
  });

  it("normalizes finding path from a valid Stage 7 anchor", async () => {
    const runner: LlmRunner = {
      runStructured: async <T>() =>
        ({
          findings: [
            {
              title: "mismatched path",
              severity: "medium",
              confidence: "medium",
              path: "other.ts",
              anchor: { path: "app.ts", line: 1, side: "RIGHT", hunkId: "h1" },
              category: "correctness",
              evidence: { changedCode: "+bad" },
              failureMode: "valid anchor wrong submitted path",
              whyThisMatters: "matters",
              verification: "test"
            }
          ],
          followUpHints: [],
          uncertainties: []
        }) as T
    };

    const [result] = await runLensPackets(fakePlan(), [fakePacket()], fakeTools(), config(), nullTelemetry(), {
      runner,
      promptBuilder: fakePromptBuilder(),
      lensRegistry: fakeLensRegistry(),
      diff: fakeDiff()
    });

    expect(result?.findings[0]).toMatchObject({
      path: "app.ts",
      changedLine: true,
      anchor: { path: "app.ts", line: 1, side: "RIGHT", hunkId: "h1" }
    });
  });

  it("keeps valid LEFT anchors on renamed files using the old path", async () => {
    const packet = fakePacket({
      path: "new.ts",
      oldPath: "old.ts",
      hunkLines: [{ kind: "delete", content: "old", oldLine: 1 }],
      changedOldLineNumbers: [1],
      changedNewLineNumbers: []
    });
    const runner: LlmRunner = {
      runStructured: async <T>() =>
        ({
          findings: [
            {
              title: "left anchor",
              severity: "medium",
              confidence: "medium",
              path: "new.ts",
              anchor: { path: "old.ts", line: 1, side: "LEFT", hunkId: "h1" },
              category: "correctness",
              evidence: { changedCode: "-old" },
              failureMode: "removed behavior",
              whyThisMatters: "matters",
              verification: "test"
            }
          ],
          followUpHints: [],
          uncertainties: []
        }) as T
    };

    const [result] = await runLensPackets(fakePlan("new.ts"), [packet], fakeTools(), config(), nullTelemetry(), {
      runner,
      promptBuilder: fakePromptBuilder(),
      lensRegistry: fakeLensRegistry(),
      diff: fakeRenameDiff()
    });

    expect(result?.findings[0]).toMatchObject({
      path: "old.ts",
      changedLine: true,
      anchor: { path: "old.ts", line: 1, side: "LEFT", hunkId: "h1" }
    });
  });

  it("drops blank follow-up questions as vague hints", async () => {
    const events: Array<Omit<TelemetryEvent, "runId" | "eventId" | "timestamp">> = [];
    const runner: LlmRunner = {
      runStructured: async <T>() =>
        ({
          findings: [],
          followUpHints: [
            {
              question: "   ",
              files: ["app.ts"],
              symbols: [],
              suggestedLenses: ["core/code-review"],
              reason: "blank",
              confidence: "medium"
            }
          ],
          uncertainties: []
        }) as T
    };
    const [result] = await runLensPackets(fakePlan(), [fakePacket()], fakeTools(), config(), {
      ...nullTelemetry(),
      event: (event: Omit<TelemetryEvent, "runId" | "eventId" | "timestamp">) => {
        events.push(event);
      }
    }, {
      runner,
      promptBuilder: fakePromptBuilder(),
      lensRegistry: fakeLensRegistry(),
      diff: fakeDiff()
    });

    expect(result?.followUpHints).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({
      stage: 7,
      level: "warn",
      message: "vague_hint",
      data: expect.objectContaining({ question: "" })
    }));
  });

  it("builds whole-file packets for configured whole-file files", async () => {
    const file: DiffFile = {
      path: "app.ts",
      status: "modified",
      language: "typescript",
      hunks: [
        {
          id: "h1",
          path: "app.ts",
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          header: "@@ -1 +1 @@",
          lines: [{ kind: "add", content: "export const value = 1;", newLineNumber: 1 }]
        }
      ]
    };
    const facts: FileFacts = {
      path: "app.ts",
      language: "typescript",
      processingMode: "whole-file",
      testStatus: "source",
      isGenerated: false,
      isVendored: false,
      isLockfile: false,
      isBinary: false,
      changedLines: 1,
      hunkCount: 1,
      labels: [],
      reviewPriority: "normal",
      reasons: [],
      provenance: []
    };
    const packets = await buildReviewPackets(
      {
        diffUnderstanding: { declaredIntent: "test intent", inferredBehavior: "test behavior" },
        riskAreas: [],
        coverage: [{ hunkId: "h1", path: "app.ts", coverage: "normal", lenses: ["core/code-review"], surroundingContextHints: [], reason: "test" }]
      },
      [file],
      [facts],
      fakeRepositoryIndex(fakeTools("export const value = 1;\n")),
      nullTelemetry(),
      { config: config(), enabledLenses: ["core/code-review"] }
    );

    const packet = packets[0];
    expect(packet).toMatchObject({
      kind: "whole-file",
      fileContext: { mode: "whole-file", reason: "configured whole-file review" }
    });
    if (!packet) {
      throw new Error("expected whole-file packet");
    }
    expect(packet.contextText).toContain("export const value = 1;");

    const prompt = createPromptBuilder(fakeLensRegistry()).buildPacketReviewPrompt({ packet, skills: [] }).prompt;
    expect(prompt).toContain('"kind": "whole-file"');
    expect(prompt).toContain('"fileContext"');
    expect(prompt).toContain("export const value = 1;");
  });

  it("uses base content for configured whole-file deleted files", async () => {
    const file: DiffFile = {
      path: "deleted.ts",
      status: "deleted",
      language: "typescript",
      hunks: [
        {
          id: "h1",
          path: "deleted.ts",
          oldStart: 1,
          oldLines: 1,
          newStart: 0,
          newLines: 0,
          header: "@@ -1 +0,0 @@",
          lines: [{ kind: "delete", content: "export const removed = true;", oldLineNumber: 1 }]
        }
      ]
    };
    const reads: Array<{ path: string; source: { kind: "head" } | { kind: "base" } | undefined }> = [];
    const meta = { backend: "text" as const, precision: "exact" as const, degraded: false };
    const tools = {
      ...fakeTools(),
      readRange: async (pathName: string, _startLine: number, _endLine: number, source?: { kind: "head" } | { kind: "base" }) => {
        reads.push({ path: pathName, source });
        return { text: "export const removed = true;\n", meta };
      }
    };
    const packets = await buildReviewPackets(
      fakePlan("deleted.ts"),
      [file],
      [fakeFacts("deleted.ts", "whole-file")],
      fakeRepositoryIndex(tools),
      nullTelemetry(),
      { config: config(), enabledLenses: ["core/code-review"] }
    );

    expect(reads).toEqual([{ path: "deleted.ts", source: { kind: "base" } }]);
    expect(packets[0]).toMatchObject({
      kind: "whole-file",
      fileContext: { mode: "whole-file", reason: "configured whole-file review" }
    });
    expect(packets[0]?.contextText).toContain("export const removed = true;");
    expect(packets[0]?.contextText).not.toContain("<empty file>");
  });

  it("downgrades configured deleted whole-file packets when base content is unavailable", async () => {
    const file: DiffFile = {
      path: "deleted.ts",
      status: "deleted",
      language: "typescript",
      hunks: [
        {
          id: "h1",
          path: "deleted.ts",
          oldStart: 1,
          oldLines: 1,
          newStart: 0,
          newLines: 0,
          header: "@@ -1 +0,0 @@",
          lines: [{ kind: "delete", content: "export const removed = true;", oldLineNumber: 1 }]
        }
      ]
    };
    const meta = { backend: "text" as const, precision: "exact" as const, degraded: true, degradationReason: "file missing at selected revision" };
    const tools = {
      ...fakeTools(),
      readRange: async () => ({ text: "", meta })
    };
    const packets = await buildReviewPackets(
      fakePlan("deleted.ts"),
      [file],
      [fakeFacts("deleted.ts", "whole-file")],
      fakeRepositoryIndex(tools),
      nullTelemetry(),
      { config: config(), enabledLenses: ["core/code-review"] }
    );

    expect(packets[0]).toMatchObject({
      kind: "file-diff",
      fileContext: { mode: "file-diff", reason: "whole-file downgraded: base content unavailable" }
    });
    expect(packets[0]?.contextText).not.toContain("<empty file>");
  });

  it("attributes whole-file content probes to Stage 6 harness tool context", async () => {
    type ToolContext = Parameters<RepositoryToolsHost["withToolCallContext"]>[0];
    const contexts: ToolContext[] = [];
    let activeContext: ToolContext | undefined;
    const meta = { backend: "text" as const, precision: "exact" as const, degraded: false };
    const baseTools = fakeTools("export const value = 1;\n") as RepositoryTools & Pick<RepositoryToolsHost, "bindPackets" | "buildPacketContext" | "withToolCallContext">;
    const tools: RepositoryTools & Pick<RepositoryToolsHost, "bindPackets" | "buildPacketContext" | "withToolCallContext"> = {
      ...baseTools,
      readRange: async () => {
        if (activeContext) {
          contexts.push(activeContext);
        }
        return { text: "export const value = 1;\n", meta };
      },
      withToolCallContext: async <T>(context: ToolContext, run: () => Promise<T>) => {
        activeContext = context;
        try {
          return await run();
        } finally {
          activeContext = undefined;
        }
      }
    };

    await buildReviewPackets(
      fakePlan(),
      [fakeDiffFile("app.ts")],
      [fakeFacts("app.ts", "whole-file")],
      fakeRepositoryIndex(tools),
      nullTelemetry(),
      { config: config(), enabledLenses: ["core/code-review"] }
    );

    expect(contexts).toContainEqual(expect.objectContaining({
      stage: 6,
      initiator: "harness"
    }));
  });

  it("downgrades whole-file packets when rendered whole-file content would be truncated", async () => {
    const nearCapContent = "x".repeat(7_990);
    const packets = await buildReviewPackets(
      fakePlan(),
      [fakeDiffFile("app.ts")],
      [fakeFacts("app.ts", "whole-file")],
      fakeRepositoryIndex(fakeTools(nearCapContent)),
      nullTelemetry(),
      { config: config(), enabledLenses: ["core/code-review"] }
    );

    expect(packets[0]).toMatchObject({
      kind: "file-diff",
      fileContext: { mode: "file-diff", reason: expect.stringContaining("rendered head content exceeds") }
    });
    expect(packets[0]?.contextText).not.toContain("content truncated");
  });

  it("resolves packet-context planner hints into context text and keeps tool-lookup hints for workers", async () => {
    const reads: Array<{ path: string; startLine: number; endLine: number }> = [];
    const meta = { backend: "text" as const, precision: "exact" as const, degraded: false };
    const tools = {
      ...fakeTools(),
      readRange: async (path: string, startLine: number, endLine: number) => {
        reads.push({ path, startLine, endLine });
        return { text: "resolved packet context", meta };
      }
    };
    const packets = await buildReviewPackets(
      {
        diffUnderstanding: { declaredIntent: "test intent", inferredBehavior: "test behavior" },
        riskAreas: [],
        coverage: [
          {
            hunkId: "h1",
            path: "app.ts",
            coverage: "normal",
            lenses: ["core/code-review"],
            surroundingContextHints: [
              {
                kind: "call_site",
                path: "app.ts",
                lineRange: [4, 6],
                reason: "include local caller",
                expectedUse: "packet_context"
              },
              {
                kind: "test",
                path: "app.test.ts",
                lineRange: [1, 3],
                reason: "worker can inspect test",
                expectedUse: "tool_lookup"
              },
              {
                kind: "config",
                path: "other.ts",
                lineRange: [1, 1],
                reason: "out of packet scope",
                expectedUse: "packet_context"
              }
            ],
            reason: "test"
          }
        ]
      },
      [fakeDiffFile("app.ts")],
      [fakeFacts("app.ts", "per-hunk")],
      fakeRepositoryIndex(tools),
      nullTelemetry(),
      { config: config(), enabledLenses: ["core/code-review"] }
    );

    expect(reads).toEqual([{ path: "app.ts", startLine: 4, endLine: 6 }]);
    expect(packets[0]?.contextText).toContain("Planner packet context (call_site) for app.ts:4-6");
    expect(packets[0]?.contextText).toContain("resolved packet context");
    expect(packets[0]?.surroundingContextHints).toEqual([
      expect.objectContaining({ reason: "worker can inspect test", expectedUse: "tool_lookup" }),
      expect.objectContaining({ reason: "out of packet scope", expectedUse: "tool_lookup" })
    ]);
  });

  it("includes bounded enclosing symbol source in packet context and discloses truncation", async () => {
    const events: TelemetryEvent[] = [];
    const telemetry = {
      ...nullTelemetry(),
      event: (event: TelemetryEvent) => {
        events.push(event);
      }
    };
    const meta = { backend: "tree-sitter" as const, precision: "syntactic" as const, degraded: false };
    const longSource = `export function changed() {\n${"  doWork();\n".repeat(400)}}`;
    const symbolReads: Array<{ path: string; selector: { symbolName?: string; line?: number } }> = [];
    const tools = {
      ...fakeTools(),
      readSymbol: async (pathName: string, selector: { symbolName?: string; line?: number }) => {
        symbolReads.push({ path: pathName, selector });
        return {
          text: longSource,
          symbol: { path: "app.ts", name: "changed", kind: "function" as const, lineRange: [10, 420] as [number, number] },
          meta
        };
      },
      buildPacketContext: async (file: DiffFile) => ({
        context: { path: file.path },
        outline: {
          path: file.path,
          language: "typescript",
          imports: ["dep"],
          topLevelSymbols: [{ path: file.path, name: "changed", kind: "function" as const, lineRange: [10, 420] as [number, number] }],
          testSymbols: [],
          notes: []
        },
        relevantTests: []
      })
    };
    const repoIndex: RepositoryIndex = {
      ...fakeRepositoryIndex(tools),
      symbolFacts: [
        {
          path: "app.ts",
          hunkId: "h1",
          enclosingSymbol: "changed",
          symbolKind: "function",
          symbolRange: [10, 420],
          changedLines: [12],
          changedLinesSide: "new",
          source: "tree-sitter",
          confidence: "syntactic"
        }
      ]
    };

    const packets = await buildReviewPackets(
      fakePlan(),
      [fakeDiffFile("app.ts")],
      [fakeFacts("app.ts", "per-hunk")],
      repoIndex,
      telemetry,
      { config: config(), enabledLenses: ["core/code-review"] }
    );

    const contextText = packets[0]?.contextText ?? "";
    expect(symbolReads).toEqual([{ path: "app.ts", selector: { line: 10 } }]);
    expect(contextText).toContain("Enclosing symbol source for app.ts:changed");
    expect(contextText).toContain("export function changed()");
    expect(contextText.indexOf("Enclosing symbol source")).toBeLessThan(contextText.indexOf("Outline for app.ts"));
    expect(contextText).toContain("content truncated to fit packet context budget");
    expect(packets[0]?.degraded?.reason).toContain("enclosing symbol source truncated");
    expect(events).toContainEqual(expect.objectContaining({
      stage: 6,
      level: "warn",
      message: "packet_symbol_source_truncated",
      file: "app.ts"
    }));
  });

  it("caps combined non-whole-file packet context and records degradation", async () => {
    const events: TelemetryEvent[] = [];
    const telemetry = {
      ...nullTelemetry(),
      event: (event: TelemetryEvent) => {
        events.push(event);
      }
    };
    const hugeSymbols = Array.from({ length: 700 }, (_, index) => ({
      path: "app.ts",
      name: `veryLongSymbolName${String(index).padStart(3, "0")}_${"x".repeat(20)}`,
      kind: "function" as const,
      lineRange: [index + 1, index + 1] as [number, number]
    }));
    const tools = {
      ...fakeTools(),
      buildPacketContext: async (file: DiffFile) => ({
        context: { path: file.path },
        outline: {
          path: file.path,
          language: "typescript",
          imports: [],
          topLevelSymbols: hugeSymbols,
          testSymbols: [],
          notes: []
        },
        relevantTests: []
      })
    };

    const packets = await buildReviewPackets(
      fakePlan(),
      [fakeDiffFile("app.ts")],
      [fakeFacts("app.ts", "per-hunk")],
      fakeRepositoryIndex(tools),
      telemetry,
      { config: config(), enabledLenses: ["core/code-review"] }
    );

    expect(packets[0]?.kind).toBe("hunk");
    expect((packets[0]?.contextText ?? "").length).toBeLessThanOrEqual(8000);
    expect(packets[0]?.contextText).toContain("content truncated to fit packet context budget");
    expect(packets[0]?.degraded?.reason).toContain("packet context truncated to 8000 chars");
    expect(events).toContainEqual(expect.objectContaining({
      stage: 6,
      level: "warn",
      message: "packet_context_truncated",
      file: "app.ts"
    }));
  });

  it("excludes skipped hunks from whole-file packet context and packet hunks", async () => {
    const file: DiffFile = {
      path: "app.ts",
      status: "modified",
      language: "typescript",
      hunks: [
        {
          id: "h1",
          path: "app.ts",
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          header: "@@ -1 +1 @@",
          lines: [{ kind: "add", content: "const skippedSecret = true;", newLineNumber: 1 }]
        },
        {
          id: "h2",
          path: "app.ts",
          oldStart: 20,
          oldLines: 1,
          newStart: 20,
          newLines: 1,
          header: "@@ -20 +20 @@",
          lines: [{ kind: "add", content: "const reviewedValue = true;", newLineNumber: 20 }]
        }
      ]
    };
    const packets = await buildReviewPackets(
      {
        diffUnderstanding: { declaredIntent: "test intent", inferredBehavior: "test behavior" },
        riskAreas: [],
        coverage: [
          { hunkId: "h1", path: "app.ts", coverage: "skip", lenses: [], surroundingContextHints: [], reason: "planner skip" },
          { hunkId: "h2", path: "app.ts", coverage: "normal", lenses: ["core/code-review"], surroundingContextHints: [], reason: "review" }
        ]
      },
      [file],
      [fakeFacts("app.ts", "whole-file")],
      fakeRepositoryIndex(fakeTools("const skippedSecret = true;\nconst reviewedValue = true;\n")),
      nullTelemetry(),
      { config: config(), enabledLenses: ["core/code-review"] }
    );

    expect(packets).toHaveLength(1);
    expect(packets[0]?.kind).toBe("hunk");
    expect(packets[0]?.hunks.map((hunk) => hunk.hunkId)).toEqual(["h2"]);
    expect(packets[0]?.hunks[0]?.contentWithLineNumbers).toContain("reviewedValue");
    expect(packets[0]?.hunks[0]?.contentWithLineNumbers).not.toContain("skippedSecret");
    expect(packets[0]?.contextText).not.toContain("skippedSecret");
    expect(packets[0]?.fileContext).toBeUndefined();
  });

  it("uses deterministic dossier text for packet PR summary instead of planner-authored behavior", async () => {
    const dossier = {
      ...fakeDossier(["app.ts"]),
      commits: [{ sha: "abc", title: "Deterministic commit title", body: "Commit body context" }],
      totals: {
        files: 1,
        keptFiles: 1,
        hunks: 1,
        addedLines: 1,
        deletedLines: 0
      }
    };
    const packets = await buildReviewPackets(
      {
        diffUnderstanding: {
          declaredIntent: "planner declared hallucination",
          inferredBehavior: "planner inferred hallucination"
        },
        riskAreas: [],
        coverage: [{ hunkId: "h1", path: "app.ts", coverage: "normal", lenses: ["core/code-review"], surroundingContextHints: [], reason: "test" }]
      },
      [fakeDiffFile("app.ts")],
      [fakeFacts("app.ts", "per-hunk")],
      fakeRepositoryIndex(),
      nullTelemetry(),
      {
        config: config(),
        enabledLenses: ["core/code-review"],
        reviewContext: packetReviewContextFromDossier(dossier)
      }
    );

    expect(packets[0]?.prSummary).toContain("Deterministic commit title");
    expect(packets[0]?.prSummary).not.toContain("planner");
    expect(packets[0]?.intentText).toContain("Commit body context");
    expect(packets[0]?.intentText).not.toContain("planner");
  });

  it("downgrades whole-file packets to file-diff when head content is too large", async () => {
    const file = fakeDiffFile("app.ts");
    const facts = fakeFacts("app.ts", "whole-file");
    const packets = await buildReviewPackets(
      fakePlan(),
      [file],
      [facts],
      fakeRepositoryIndex(fakeTools("x".repeat(9000))),
      nullTelemetry(),
      { config: config(), enabledLenses: ["core/code-review"] }
    );

    expect(packets[0]).toMatchObject({
      kind: "file-diff",
      fileContext: { mode: "file-diff", reason: expect.stringContaining("rendered head content exceeds") }
    });
  });

  it("falls back to per-hunk packets when whole-file patch size is too large", async () => {
    const file = fakeDiffFile("app.ts", "x".repeat(12_100));
    const facts = fakeFacts("app.ts", "whole-file");
    const packets = await buildReviewPackets(
      fakePlan(),
      [file],
      [facts],
      fakeRepositoryIndex(),
      nullTelemetry(),
      { config: config(), enabledLenses: ["core/code-review"] }
    );

    expect(packets[0]?.kind).toBe("hunk");
    expect(packets[0]?.degraded?.reason).toContain("whole-file downgraded: combined patch exceeds 12000 chars");
    const coverage = aggregateRunCoverage(
      fakePlan(),
      [],
      [{ packetId: packets[0]?.id ?? "missing", lenses: ["core/code-review"], findings: [], followUpHints: [], uncertainties: [], status: "completed" }],
      { incompleteCount: 0 },
      nullTelemetry(),
      { allFiles: [file], packets }
    );
    expect(coverage.reasons.some((reason) =>
      reason.includes("app.ts:") && reason.includes("whole-file downgraded: combined patch exceeds 12000 chars")
    )).toBe(false);
  });

  it("coalesces nearby hunk-first packets and leaves distant hunks separate", async () => {
    const file = fakeMultiHunkFile([
      { id: "h1", newStart: 1, content: "one" },
      { id: "h2", newStart: 10, content: "two" },
      { id: "h3", newStart: 100, content: "three" }
    ]);
    const packets = await buildReviewPackets(
      fakePlanForHunks(["h1", "h2", "h3"]),
      [file],
      [fakeFacts("app.ts", "per-hunk")],
      fakeRepositoryIndex(),
      nullTelemetry(),
      { config: config(), enabledLenses: ["core/code-review"] }
    );

    expect(packets).toHaveLength(2);
    expect(packets[0]).toMatchObject({
      kind: "coalesced-hunks",
      hunks: [{ hunkId: "h1" }, { hunkId: "h2" }]
    });
    expect(packets[1]).toMatchObject({
      kind: "hunk",
      hunks: [{ hunkId: "h3" }]
    });
  });

  it("does not coalesce add and deletion-only hunks by comparing new and old coordinates", async () => {
    const file: DiffFile = {
      path: "app.ts",
      status: "modified",
      language: "typescript",
      hunks: [
        {
          id: "h1",
          path: "app.ts",
          oldStart: 1,
          oldLines: 0,
          newStart: 1,
          newLines: 1,
          header: "@@ -1,0 +1 @@",
          lines: [{ kind: "add", content: "export const added = true;", newLineNumber: 1 }]
        },
        {
          id: "h2",
          path: "app.ts",
          oldStart: 20,
          oldLines: 1,
          newStart: 1,
          newLines: 0,
          header: "@@ -20 +1,0 @@",
          lines: [{ kind: "delete", content: "export const removed = true;", oldLineNumber: 20 }]
        }
      ]
    };

    const packets = await buildReviewPackets(
      fakePlanForHunks(["h1", "h2"]),
      [file],
      [fakeFacts("app.ts", "per-hunk")],
      fakeRepositoryIndex(),
      nullTelemetry(),
      { config: config(), enabledLenses: ["core/code-review"] }
    );

    expect(packets).toHaveLength(2);
    expect(packets.map((packet) => packet.kind)).toEqual(["hunk", "hunk"]);
  });

  it("caps packet lenses while preserving language then core lenses and records drops", async () => {
    const events: Array<Omit<TelemetryEvent, "runId" | "eventId" | "timestamp">> = [];
    const telemetry = {
      ...nullTelemetry(),
      event: (event: Omit<TelemetryEvent, "runId" | "eventId" | "timestamp">) => {
        events.push(event);
      }
    };
    const packets = await buildReviewPackets(
      {
        diffUnderstanding: { declaredIntent: "test intent", inferredBehavior: "test behavior" },
        riskAreas: [],
        coverage: [
          {
            hunkId: "h1",
            path: "app.ts",
            coverage: "normal",
            lenses: [
              "custom/z",
              "custom/y",
              "custom/x",
              "custom/w",
              "custom/v",
              "custom/u",
              "core/security",
              "lang/typescript",
              "core/code-review",
              "custom/y"
            ],
            surroundingContextHints: [],
            reason: "test"
          }
        ]
      },
      [fakeDiffFile("app.ts")],
      [fakeFacts("app.ts", "per-hunk")],
      fakeRepositoryIndex(),
      telemetry,
      {
        config: config(),
        enabledLenses: [
          "core/code-review",
          "core/security",
          "lang/typescript",
          "custom/u",
          "custom/v",
          "custom/w",
          "custom/x",
          "custom/y",
          "custom/z"
        ]
      }
    );

    expect(packets[0]?.lenses).toEqual([
      "lang/typescript",
      "core/code-review",
      "core/security",
      "custom/y",
      "custom/u",
      "custom/v"
    ]);
    expect(events).toContainEqual(expect.objectContaining({
      stage: 6,
      level: "warn",
      message: "packet_lenses_dropped",
      file: "app.ts",
      data: expect.objectContaining({
        dropped: ["custom/w", "custom/x", "custom/z"]
      })
    }));
  });

  it("scales packet tool budgets with light-depth floors and deep-depth ceilings", async () => {
    const budgetFor = async (coverage: Exclude<CoverageLevel, "skip">, depth: CodeninjaConfig["review"]["depth"]) => {
      const plan = {
        ...fakePlan(),
        coverage: [{ ...fakePlan().coverage[0]!, coverage }]
      };
      const packets = await buildReviewPackets(
        plan,
        [fakeDiffFile("app.ts")],
        [fakeFacts("app.ts", "per-hunk")],
        fakeRepositoryIndex(),
        nullTelemetry(),
        { config: { ...config(), review: { ...config().review, depth } }, enabledLenses: ["core/code-review"] }
      );
      return packets[0]?.toolBudget;
    };

    await expect(budgetFor("deep", "light")).resolves.toEqual({
      maxToolCalls: 7,
      maxInvestigationRounds: 2,
      maxResultChars: 16_000
    });
    await expect(budgetFor("light", "light")).resolves.toEqual({
      maxToolCalls: 1,
      maxInvestigationRounds: 1,
      maxResultChars: 4_000
    });
    await expect(budgetFor("normal", "deep")).resolves.toEqual({
      maxToolCalls: 12,
      maxInvestigationRounds: 5,
      maxResultChars: 24_000
    });
  });

  it("truncates oversized single hunks with omission markers", async () => {
    const packets = await buildReviewPackets(
      fakePlan(),
      [fakeDiffFile("app.ts", "x".repeat(20_000))],
      [fakeFacts("app.ts", "per-hunk")],
      fakeRepositoryIndex(),
      nullTelemetry(),
      { config: config(), enabledLenses: ["core/code-review"] }
    );

    const hunk = packets[0]?.hunks[0];
    expect(hunk).toMatchObject({ hunkId: "h1", truncated: true });
    expect(hunk?.contentWithLineNumbers).toContain("chars truncated");
    expect(hunk?.contentWithLineNumbers.length).toBeLessThanOrEqual(12_000);
    expect(packets[0]?.degraded?.reason).toContain("patch truncated");
  });

  it("applies verifier revisedAnchor when no finalFinding is returned", async () => {
    const runner: LlmRunner = {
      runStructured: async <T>() =>
        ({
          verdict: "revise",
          reason: "better anchor",
          requiredEvidencePresent: true,
          falsePositiveRisk: "low",
          revisedAnchor: { path: "app.ts", line: 1, side: "RIGHT", hunkId: "h1" }
        }) as T
    };
    const { anchor: _anchor, ...unanchoredFinding } = fakeFinding();
    const candidate = { ...unanchoredFinding, changedLine: false };
    const verified = await verifyFindings(
      {
        packetResults: [{ packetId: "packet-1", lenses: ["core/code-review"], findings: [candidate], followUpHints: [], uncertainties: [], status: "completed" }],
        packets: [fakePacket()]
      },
      fakeTools(),
      config(),
      nullTelemetry(),
      { runner, promptBuilder: fakePromptBuilder(), lensRegistry: fakeLensRegistry(), diff: fakeDiff() }
    );

    expect(verified.verified[0]).toMatchObject({
      id: "finding-1",
      changedLine: true,
      anchor: { path: "app.ts", line: 1, side: "RIGHT", hunkId: "h1" }
    });
  });

  it("applies verifier revisedAnchor when finalFinding is also returned", async () => {
    const runner: LlmRunner = {
      runStructured: async <T>() =>
        ({
          verdict: "revise",
          reason: "better wording and anchor",
          requiredEvidencePresent: true,
          falsePositiveRisk: "low",
          finalFinding: {
            title: "rewritten finding",
            severity: "medium",
            confidence: "medium",
            path: "app.ts",
            anchor: { path: "app.ts", line: 1, side: "RIGHT", hunkId: "h1" },
            category: "correctness",
            evidence: { changedCode: "bad" },
            failureMode: "rewritten failure",
            whyThisMatters: "matters",
            verification: "verified"
          },
          revisedAnchor: { path: "app.ts", line: 2, side: "RIGHT", hunkId: "h1" }
        }) as T
    };
    const packet = fakePacket({
      hunkLines: [
        { kind: "add", content: "bad", newLine: 1 },
        { kind: "add", content: "worse", newLine: 2 }
      ],
      changedNewLineNumbers: [1, 2]
    });
    const verified = await verifyFindings(
      {
        packetResults: [{ packetId: "packet-1", lenses: ["core/code-review"], findings: [fakeFinding()], followUpHints: [], uncertainties: [], status: "completed" }],
        packets: [packet]
      },
      fakeTools(),
      config(),
      nullTelemetry(),
      { runner, promptBuilder: fakePromptBuilder(), lensRegistry: fakeLensRegistry(), diff: fakeTwoLineDiff() }
    );

    expect(verified.verified[0]).toMatchObject({
      id: "finding-1",
      title: "rewritten finding",
      changedLine: true,
      anchor: { path: "app.ts", line: 2, side: "RIGHT", hunkId: "h1" }
    });
  });

  it("normalizes verifier revised LEFT anchor paths on renamed files", async () => {
    const runner: LlmRunner = {
      runStructured: async <T>() =>
        ({
          verdict: "revise",
          reason: "old-side anchor",
          requiredEvidencePresent: true,
          falsePositiveRisk: "low",
          revisedAnchor: { path: "old.ts", line: 1, side: "LEFT", hunkId: "h1" }
        }) as T
    };
    const packet = fakePacket({
      path: "new.ts",
      oldPath: "old.ts",
      hunkLines: [{ kind: "delete", content: "old", oldLine: 1 }],
      changedOldLineNumbers: [1],
      changedNewLineNumbers: []
    });
    const { anchor: _anchor, ...base } = fakeFinding();
    const candidate = {
      ...base,
      path: "new.ts",
      changedLine: false,
      producedBy: { ...base.producedBy, packetId: "packet-1" }
    };

    const verified = await verifyFindings(
      {
        packetResults: [{ packetId: "packet-1", lenses: ["core/code-review"], findings: [candidate], followUpHints: [], uncertainties: [], status: "completed" }],
        packets: [packet]
      },
      fakeTools(),
      config(),
      nullTelemetry(),
      { runner, promptBuilder: fakePromptBuilder(), lensRegistry: fakeLensRegistry(), diff: fakeRenameDiff() }
    );

    expect(verified.verified[0]).toMatchObject({
      path: "old.ts",
      changedLine: true,
      anchor: { path: "old.ts", line: 1, side: "LEFT", hunkId: "h1" }
    });
  });

  it("normalizes verifier finalFinding path from a valid revised anchor", async () => {
    const runner: LlmRunner = {
      runStructured: async <T>() =>
        ({
          verdict: "revise",
          reason: "better wording with stale path",
          requiredEvidencePresent: true,
          falsePositiveRisk: "low",
          finalFinding: {
            title: "rewritten finding",
            severity: "medium",
            confidence: "medium",
            path: "other.ts",
            anchor: { path: "app.ts", line: 1, side: "RIGHT", hunkId: "h1" },
            category: "correctness",
            evidence: { changedCode: "bad" },
            failureMode: "rewritten failure",
            whyThisMatters: "matters",
            verification: "verified"
          }
        }) as T
    };

    const verified = await verifyFindings(
      {
        packetResults: [{ packetId: "packet-1", lenses: ["core/code-review"], findings: [fakeFinding()], followUpHints: [], uncertainties: [], status: "completed" }],
        packets: [fakePacket()]
      },
      fakeTools(),
      config(),
      nullTelemetry(),
      { runner, promptBuilder: fakePromptBuilder(), lensRegistry: fakeLensRegistry(), diff: fakeDiff() }
    );

    expect(verified.verified[0]).toMatchObject({
      id: "finding-1",
      path: "app.ts",
      changedLine: true,
      anchor: { path: "app.ts", line: 1, side: "RIGHT", hunkId: "h1" }
    });
  });

  it("lets verifier finalFinding revisions remove stale suggested fix and test guidance", async () => {
    const runner: LlmRunner = {
      runStructured: async <T>() =>
        ({
          verdict: "revise",
          reason: "obsolete guidance removed",
          requiredEvidencePresent: true,
          falsePositiveRisk: "low",
          finalFinding: {
            title: "rewritten finding",
            severity: "medium",
            confidence: "medium",
            path: "app.ts",
            anchor: { path: "app.ts", line: 1, side: "RIGHT", hunkId: "h1" },
            category: "correctness",
            evidence: { changedCode: "bad" },
            failureMode: "rewritten failure",
            whyThisMatters: "matters",
            verification: "verified without old guidance"
          }
        }) as T
    };

    const original = {
      ...fakeFinding(),
      suggestedFix: "stale fix",
      suggestedTest: "stale test"
    };
    const verified = await verifyFindings(
      {
        packetResults: [{ packetId: "packet-1", lenses: ["core/code-review"], findings: [original], followUpHints: [], uncertainties: [], status: "completed" }],
        packets: [fakePacket()]
      },
      fakeTools(),
      config(),
      nullTelemetry(),
      { runner, promptBuilder: fakePromptBuilder(), lensRegistry: fakeLensRegistry(), diff: fakeDiff() }
    );

    expect(verified.verified[0]).toMatchObject({
      id: "finding-1",
      title: "rewritten finding",
      verification: "verified without old guidance"
    });
    expect(verified.verified[0]?.suggestedFix).toBeUndefined();
    expect(verified.verified[0]?.suggestedTest).toBeUndefined();
  });

  it("keeps unanchored verifier finalFinding revisions on the original path", async () => {
    const runner: LlmRunner = {
      runStructured: async <T>() =>
        ({
          verdict: "revise",
          reason: "wording only",
          requiredEvidencePresent: true,
          falsePositiveRisk: "low",
          finalFinding: {
            title: "rewritten summary finding",
            severity: "medium",
            confidence: "medium",
            path: "other.ts",
            category: "correctness",
            evidence: { changedCode: "bad" },
            failureMode: "rewritten failure",
            whyThisMatters: "matters",
            verification: "verified without anchor"
          }
        }) as T
    };
    const { anchor: _anchor, ...unanchoredOriginal } = fakeFinding();
    const original = {
      ...unanchoredOriginal,
      changedLine: false
    };

    const verified = await verifyFindings(
      {
        packetResults: [{ packetId: "packet-1", lenses: ["core/code-review"], findings: [original], followUpHints: [], uncertainties: [], status: "completed" }],
        packets: [fakePacket()]
      },
      fakeTools(),
      config(),
      nullTelemetry(),
      { runner, promptBuilder: fakePromptBuilder(), lensRegistry: fakeLensRegistry(), diff: fakeDiff() }
    );

    expect(verified.verified[0]).toMatchObject({
      id: "finding-1",
      path: "app.ts",
      changedLine: false
    });
    expect(verified.verified[0]?.anchor).toBeUndefined();
  });

  it("lets Stage 9 use reserved model-call budget after Stage 7 exhausts unreserved calls", () => {
    const budget = new BudgetLedger({ ...config(), review: { ...config().review, maxModelCalls: 2 } });
    budget.recordUsage({ stage: 7, providerCalls: 1 });

    expect(budget.checkpoint(7)).toBe("exhausted");
    expect(budget.checkpoint(9)).toBe("ok");
  });

  it("reserves in-flight model calls and tokens before provider dispatch", () => {
    const callBudget = new BudgetLedger({ ...config(), review: { ...config().review, maxModelCalls: 2 } });
    expect(callBudget.reserve(7, 1)).toBe("ok");
    expect(callBudget.checkpoint(7)).toBe("exhausted");
    callBudget.releaseReservation(7, 1);
    expect(callBudget.checkpoint(7)).toBe("ok");

    const tokenBudget = new BudgetLedger({ ...config(), review: { ...config().review, maxTotalTokens: 100 } });
    expect(tokenBudget.reserve(7, 85)).toBe("ok");
    expect(tokenBudget.checkpoint(7)).toBe("exhausted");
    tokenBudget.releaseReservation(7, 85);
    expect(tokenBudget.reserve(7, 86)).toBe("exhausted");
  });

  it("keeps usable Stage 1-7 runtime for short configured timeouts", () => {
    const clock = vi.spyOn(Date, "now");
    try {
      clock.mockReturnValue(1_000);
      const budget = new BudgetLedger({ ...config(), review: { ...config().review, timeoutMs: 10_000 } });
      clock.mockReturnValue(1_001);

      expect(budget.checkpoint(7)).toBe("ok");
    } finally {
      clock.mockRestore();
    }
  });

  it("charges failed provider attempts against the model-call budget", async () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    const budget = new BudgetLedger({ ...config(), review: { ...config().review, maxModelCalls: 3 } });
    const adapter: PiAiAdapter = {
      resolveModel: () => ({ provider: "scripted", id: "scripted-model", raw: { id: "scripted-model" } }),
      complete: vi.fn(async () => {
        const error = new Error("rate limited") as Error & { status: number; headers: Record<string, string> };
        error.status = 429;
        error.headers = { "retry-after": "0" };
        throw error;
      }),
      validateToolCall: (_tools, call) => call.arguments
    };
    const runner = createPiRunner({
      llmConfig: { provider: "scripted", model: "scripted-model", maxConcurrentCalls: 1 },
      telemetry: nullTelemetry(),
      logger: fakeLogger(),
      runSignal: new AbortController().signal,
      adapter,
      hooks: {
        checkpoint: (stage) => budget.checkpoint(stage),
        reserve: (stage, estimatedTokens) => budget.reserve(stage, estimatedTokens),
        releaseReservation: (stage, estimatedTokens) => budget.releaseReservation(stage, estimatedTokens),
        onUsage: (usage) => budget.recordUsage(usage)
      }
    });

    try {
      await expect(
        runner.runStructured({
          stage: 7,
          prompt: "review packet",
          schema: SubmitPacketReviewSchema,
          templateVersion: "test",
          timeoutMs: 10_000
        })
      ).rejects.toMatchObject({
        code: "llm_call_failed",
        context: { reason: "budget_exhausted" }
      });
      expect(adapter.complete).toHaveBeenCalledTimes(2);
    } finally {
      random.mockRestore();
    }
  });

  it("prevents concurrent Stage 7 workers from overshooting model-call budget", async () => {
    const budget = new BudgetLedger({ ...config(), review: { ...config().review, maxModelCalls: 2 } });
    const adapter = scriptedPiAdapter([
      assistantMessage([toolCall("submit-review-1", "submit_review", { findings: [], followUpHints: [], uncertainties: [] })]),
      assistantMessage([toolCall("submit-review-2", "submit_review", { findings: [], followUpHints: [], uncertainties: [] })])
    ]);
    const runner = createPiRunner({
      llmConfig: { provider: "scripted", model: "scripted-model", maxConcurrentCalls: 2 },
      telemetry: nullTelemetry(),
      logger: fakeLogger(),
      runSignal: new AbortController().signal,
      adapter,
      hooks: {
        checkpoint: (stage) => budget.checkpoint(stage),
        reserve: (stage, estimatedTokens) => budget.reserve(stage, estimatedTokens),
        releaseReservation: (stage, estimatedTokens) => budget.releaseReservation(stage, estimatedTokens),
        onUsage: (usage) => budget.recordUsage(usage)
      }
    });

    const results = await runLensPackets(
      fakePlan(),
      [fakePacket({ id: "packet-1" }), fakePacket({ id: "packet-2" })],
      fakeTools(),
      { ...config(), review: { ...config().review, concurrency: 2 } },
      nullTelemetry(),
      {
        runner,
        promptBuilder: fakePromptBuilder(),
        lensRegistry: fakeLensRegistry(),
        diff: fakeDiff()
      }
    );

    expect(adapter.calls).toBe(1);
    expect(results.map((result) => result.status).sort()).toEqual(["completed", "skipped"]);
    expect(budget.stopped).toBe(true);
  });

  it("records undispatched budget-stopped packets as failed coverage records", async () => {
    const repo = initRepo();
    writeRepoFile(repo, "a.ts", "export const a = 1;\n");
    writeRepoFile(repo, "b.ts", "export const b = 1;\n");
    commitAll(repo, "base");
    git(repo, ["checkout", "-b", "feature"]);
    writeRepoFile(repo, "a.ts", "export const a = 2;\n");
    writeRepoFile(repo, "b.ts", "export const b = 2;\n");
    commitAll(repo, "feature");
    const runArtifactDir = path.join(mkdtempSync(path.join(tmpdir(), "codeninja-runs-")), "run-budget-coverage");
    const adapter: PiAiAdapter = {
      resolveModel: () => ({ provider: "scripted", id: "scripted-model", raw: { id: "scripted-model", api: "faux" } }),
      complete: async (_model, context) => {
        const prompt = String((context.messages[0] as { content?: unknown }).content ?? "");
        if (prompt.includes("submit_plan")) {
          const dossier = extractPromptJson<PlannerDossier>(prompt, "planner-dossier");
          return assistantMessage([toolCall("submit-plan", "submit_plan", {
            diffUnderstanding: { declaredIntent: "budget test", inferredBehavior: "budget test" },
            riskAreas: [],
            coverage: (dossier?.files ?? []).flatMap((file) =>
              file.hunks.map((hunk) => ({
                hunkId: hunk.hunkId,
                path: file.path,
                coverage: "normal",
                lenses: ["core/code-review"],
                surroundingContextHints: [],
                reason: "review"
              }))
            )
          })]);
        }
        return assistantMessage([toolCall("submit-composition", "submit_composition", { summary: "No credible findings.", composedFindings: [] })]);
      },
      validateToolCall: (_tools, call) => call.arguments
    };

    await runReview(
      { mode: "branch", branchName: "feature" },
      {
        ...config(),
        review: { ...config().review, maxModelCalls: 2 },
        telemetry: { ...defaultConfig.telemetry, enabled: true, runDir: path.dirname(runArtifactDir) },
        llm: { provider: "scripted", model: "scripted-model", maxConcurrentCalls: 1 }
      },
      { repoRoot: repo, runArtifactDir, piAdapter: adapter }
    );

    const coverage = JSON.parse(readFileSync(path.join(runArtifactDir, "coverage.json"), "utf8")) as {
      status: { partial: boolean; budgetStopped: boolean };
      records: Array<{ status: string; reason?: string }>;
    };
    expect(coverage.status).toMatchObject({ partial: true, budgetStopped: true });
    expect(coverage.records).toHaveLength(2);
    expect(coverage.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "review_failed", reason: "budget_stopped before dispatch" }),
      expect.objectContaining({ status: "review_failed", reason: "budget_stopped before dispatch" })
    ]));
  });

  it("greedily packs small planner roots into budget-sized chunks", async () => {
    const promptRoots: string[] = [];
    const runner: LlmRunner = {
      runStructured: async <T>(request: LlmStructuredRequest<T>) => {
        const dossier = JSON.parse(request.prompt) as PlannerDossier;
        return {
          diffUnderstanding: { declaredIntent: "chunk intent", inferredBehavior: dossier.compaction.chunkRoot ?? "single" },
          riskAreas: [],
          coverage: dossier.files.flatMap((file) =>
            file.hunks.map((hunk) => ({
              hunkId: hunk.hunkId,
              path: file.path,
              coverage: "normal",
              lenses: [],
              surroundingContextHints: [],
              reason: "chunk test"
            }))
          )
        } as T;
      }
    };
    const promptBuilder = {
      ...fakePromptBuilder(),
      renderDossier: (dossier: PlannerDossier) => {
        if (dossier.compaction.level !== "chunked") {
          return "x".repeat(MAX_DOSSIER_PROMPT_CHARS + 1);
        }
        return dossier.compaction.chunkRoot === "pkg-a+pkg-b+pkg-c"
          ? "x".repeat(MAX_DOSSIER_PROMPT_CHARS + 1)
          : dossier.files.length <= 2
          ? "chunked"
          : "x".repeat(MAX_DOSSIER_PROMPT_CHARS + 1);
      },
      buildPlannerPrompt: ({ dossier }: { dossier: PlannerDossier }) => {
        promptRoots.push(dossier.compaction.chunkRoot ?? "single");
        return { prompt: JSON.stringify(dossier), templateVersion: "test", untrustedBlockCount: 0 };
      }
    };

    const result = await runPlanner(fakeDossier(["pkg-a/a.ts", "pkg-b/b.ts", "pkg-c/c.ts"]), config(), nullTelemetry(), {
      runner,
      promptBuilder,
      lenses: [],
      skills: []
    });

    expect(result.chunked).toBe(true);
    expect(promptRoots).toEqual(["pkg-a+pkg-b", "pkg-c"]);
    expect(result.plan.coverage.map((decision) => decision.hunkId).sort()).toEqual(["h1", "h2", "h3"]);
  });

  it("splits oversized planner roots by subdirectory and file before compaction", async () => {
    const promptRoots: string[] = [];
    const omittedCounts: number[] = [];
    const runner: LlmRunner = {
      runStructured: async <T>(request: LlmStructuredRequest<T>) => {
        const dossier = JSON.parse(request.prompt) as PlannerDossier;
        promptRoots.push(dossier.compaction.chunkRoot ?? "single");
        omittedCounts.push(dossier.compaction.omitted.length);
        return {
          diffUnderstanding: { declaredIntent: "chunk intent", inferredBehavior: dossier.compaction.chunkRoot ?? "single" },
          riskAreas: [],
          coverage: dossier.files.flatMap((file) =>
            file.hunks.map((hunk) => ({
              hunkId: hunk.hunkId,
              path: file.path,
              coverage: "normal",
              lenses: [],
              surroundingContextHints: [],
              reason: "chunk test"
            }))
          )
        } as T;
      }
    };
    const promptBuilder = {
      ...fakePromptBuilder(),
      renderDossier: (dossier: PlannerDossier) => {
        if (dossier.compaction.level !== "chunked") {
          return "x".repeat(MAX_DOSSIER_PROMPT_CHARS + 1);
        }
        const root = dossier.compaction.chunkRoot ?? "";
        return root === "pkg" || root === "pkg/a" || root.includes("+")
          ? "x".repeat(MAX_DOSSIER_PROMPT_CHARS + 1)
          : "fits full detail";
      },
      buildPlannerPrompt: ({ dossier }: { dossier: PlannerDossier }) => ({
        prompt: JSON.stringify(dossier),
        templateVersion: "test",
        untrustedBlockCount: 0
      })
    };

    const result = await runPlanner(fakeDossier(["pkg/a/one.ts", "pkg/a/two.ts", "pkg/b/three.ts"]), config(), nullTelemetry(), {
      runner,
      promptBuilder,
      lenses: [],
      skills: []
    });

    expect(result.chunked).toBe(true);
    expect(promptRoots).toEqual(["pkg/a/one.ts", "pkg/a/two.ts", "pkg/b"]);
    expect(omittedCounts).toEqual([0, 0, 0]);
    expect(result.plan.coverage.map((decision) => decision.hunkId).sort()).toEqual(["h1", "h2", "h3"]);
  });

  it("allows planner chunk artifacts when telemetry is enabled", async () => {
    const repoRoot = mkdtempSync(path.join(tmpdir(), "codeninja-runs-"));
    const telemetry = createRunTelemetry({
      telemetryConfig: { ...defaultConfig.telemetry, enabled: true, runDir: ".codeninja/runs" },
      idFactory: () => "chunk-artifact-test"
    });
    const attached = await telemetry.attachRunDirectory(repoRoot);

    await telemetry.recorder.writeArtifact("planner-dossier-chunks.json", []);

    expect(existsSync(path.join(attached.runDir, "planner-dossier-chunks.json"))).toBe(true);
  });

  it("omits run ids from planner prompts while keeping them in dossier artifacts", async () => {
    const promptBuilder = createPromptBuilder(fakeLensRegistry());
    const first = { ...fakeDossier(["app.ts"]), runId: "run-one-unique" };
    const second = { ...fakeDossier(["app.ts"]), runId: "run-two-unique" };

    expect(promptBuilder.renderDossier(first)).toEqual(promptBuilder.renderDossier(second));
    expect(promptBuilder.renderDossier(first)).not.toContain("run-one-unique");
    expect(promptBuilder.buildPlannerPrompt({ dossier: first, lenses: [], skills: [] }).prompt)
      .toEqual(promptBuilder.buildPlannerPrompt({ dossier: second, lenses: [], skills: [] }).prompt);

    const artifacts = new Map<string, unknown>();
    const telemetry = {
      ...nullTelemetry(),
      runId: "artifact-run-id",
      writeArtifact: async (name: string, data: unknown) => {
        artifacts.set(name, data);
      }
    };
    const dossier = await buildPlannerDossier(
      { mode: "branch", commits: [] },
      [fakeDiffFile("app.ts")],
      [fakeFacts("app.ts", "per-hunk")],
      [{ path: "app.ts", action: "keep", reason: "review", provenance: [] }],
      fakeRepositoryIndex(),
      config(),
      telemetry
    );

    expect(dossier.runId).toBe("artifact-run-id");
    expect(artifacts.get("planner-dossier.json")).toMatchObject({ runId: "artifact-run-id" });
  });

  it("planner fallback covers full hunks after dossier compaction clears prompt hunks", async () => {
    const runner: LlmRunner = {
      runStructured: async () => {
        throw new Error("planner unavailable");
      }
    };
    const promptBuilder = {
      ...fakePromptBuilder(),
      renderDossier: (dossier: PlannerDossier) =>
        dossier.files.some((file) => file.hunks.length > 0)
          ? "x".repeat(MAX_DOSSIER_PROMPT_CHARS + 1)
          : "fits"
    };

    const result = await runPlanner(fakeDossier(["pkg-a/a.ts", "pkg-a/b.ts"]), config(), nullTelemetry(), {
      runner,
      promptBuilder,
      lenses: [],
      skills: []
    });

    expect(result.degradedPlanning).toBe(true);
    expect(result.plan.coverage.map((decision) => decision.hunkId).sort()).toEqual(["h1", "h2"]);
  });

  it("chunk fallback covers full hunks when compacted chunks omit hunk detail", async () => {
    const runner: LlmRunner = {
      runStructured: async () => {
        throw new Error("chunk planner unavailable");
      }
    };
    const promptBuilder = {
      ...fakePromptBuilder(),
      renderDossier: (dossier: PlannerDossier) => {
        if (dossier.compaction.level !== "chunked") {
          return "x".repeat(MAX_DOSSIER_PROMPT_CHARS + 1);
        }
        return dossier.files.some((file) => file.hunks.length > 0)
          ? "x".repeat(MAX_DOSSIER_PROMPT_CHARS + 1)
          : "fits";
      },
      buildPlannerPrompt: ({ dossier }: { dossier: PlannerDossier }) => ({
        prompt: JSON.stringify(dossier),
        templateVersion: "test",
        untrustedBlockCount: 0
      })
    };

    const result = await runPlanner(fakeDossier(["pkg-a/a.ts", "pkg-b/b.ts"]), config(), nullTelemetry(), {
      runner,
      promptBuilder,
      lenses: [],
      skills: []
    });

    expect(result.chunked).toBe(true);
    expect(result.degradedPlanning).toBe(true);
    expect(result.plan.coverage.map((decision) => decision.hunkId).sort()).toEqual(["h1", "h2"]);
  });

  it("deduplicates conflicting planner coverage decisions before coverage aggregation", async () => {
    const events: Array<Omit<TelemetryEvent, "runId" | "eventId" | "timestamp">> = [];
    const telemetry = {
      ...nullTelemetry(),
      event: (event: Omit<TelemetryEvent, "runId" | "eventId" | "timestamp">) => {
        events.push(event);
      }
    };
    const runner: LlmRunner = {
      runStructured: async <T>() =>
        ({
          diffUnderstanding: { declaredIntent: "duplicate hunk", inferredBehavior: "duplicate hunk" },
          riskAreas: [],
          coverage: [
            { hunkId: "h1", path: "app.ts", coverage: "skip", lenses: [], surroundingContextHints: [], reason: "skip duplicate" },
            { hunkId: "h1", path: "app.ts", coverage: "normal", lenses: ["core/code-review"], surroundingContextHints: [], reason: "review duplicate" }
          ]
        }) as T
    };

    const result = await runPlanner(fakeDossier(["app.ts"]), config(), telemetry, {
      runner,
      promptBuilder: fakePromptBuilder(),
      lenses: [{
        id: "core/code-review",
        title: "Core",
        description: "core",
        skillIds: [],
        enabledByDefault: true,
        enabled: true,
        languages: []
      }],
      skills: []
    });
    const coverage = aggregateRunCoverage(
      result.plan,
      [],
      [{ packetId: "packet-1", lenses: ["core/code-review"], findings: [], followUpHints: [], uncertainties: [], status: "completed" }],
      { incompleteCount: 0 },
      nullTelemetry(),
      { allFiles: fakeDiff().files, packets: [fakePacket()] }
    );

    expect(result.plan.coverage).toHaveLength(1);
    expect(result.plan.coverage[0]).toMatchObject({
      hunkId: "h1",
      coverage: "normal",
      reason: expect.stringContaining("planner duplicate coverage decisions merged")
    });
    expect(coverage.reviewedHunks).toBe(1);
    expect(coverage.skippedHunks).toBe(0);
    expect(events.some((event) => event.message === "planner_conflicting_duplicate_hunk")).toBe(true);
  });

  it("preserves invalid planner skip as packet fallback and run coverage reason", async () => {
    const events: Array<Omit<TelemetryEvent, "runId" | "eventId" | "timestamp">> = [];
    const telemetry = {
      ...nullTelemetry(),
      event: (event: Omit<TelemetryEvent, "runId" | "eventId" | "timestamp">) => {
        events.push(event);
      }
    };
    const runner: LlmRunner = {
      runStructured: async <T>() =>
        ({
          diffUnderstanding: { declaredIntent: "invalid skip", inferredBehavior: "invalid skip" },
          riskAreas: [],
          coverage: [
            { hunkId: "h1", path: "app.ts", coverage: "skip", lenses: [], surroundingContextHints: [], reason: "   " }
          ]
        }) as T
    };

    const result = await runPlanner(fakeDossier(["app.ts"]), config(), telemetry, {
      runner,
      promptBuilder: fakePromptBuilder(),
      lenses: [{
        id: "core/code-review",
        title: "Core",
        description: "core",
        skillIds: [],
        enabledByDefault: true,
        enabled: true,
        languages: []
      }],
      skills: []
    });
    const packets = await buildReviewPackets(
      result.plan,
      [fakeDiffFile("app.ts")],
      [fakeFacts("app.ts", "per-hunk")],
      fakeRepositoryIndex(),
      nullTelemetry(),
      { config: config(), enabledLenses: ["core/code-review"] }
    );
    const coverage = aggregateRunCoverage(
      result.plan,
      [],
      [{ packetId: packets[0]?.id ?? "missing", lenses: ["core/code-review"], findings: [], followUpHints: [], uncertainties: [], status: "completed" }],
      { incompleteCount: 0 },
      nullTelemetry(),
      { allFiles: fakeDiff().files, packets }
    );

    expect(events.some((event) => event.message === "planner_invalid_skip")).toBe(true);
    expect(result.plan.coverage[0]).toMatchObject({
      hunkId: "h1",
      coverage: "normal",
      reason: "planner_invalid_skip"
    });
    expect(packets[0]?.hunks[0]?.plannerFallbackReason).toBe("planner_invalid_skip");
    expect(coverage.reasons).toContain("app.ts: planner_invalid_skip");
    expect(renderMarkdownReview({
      summary: "Review completed.",
      coverage,
      findings: [],
      summaryOnlyFindings: [],
      needsHumanAttention: [],
      noFindings: true
    })).toContain("- app.ts: planner_invalid_skip");
  });

  it("uses rollup hunk language when recovering invalid skip decisions for compacted hunks", async () => {
    const dossier = fakeDossier(["app.ts"]);
    const compacted: PlannerDossier = {
      ...dossier,
      files: dossier.files.map((file) => ({ ...file, hunks: [] })),
      directories: [
        {
          root: ".",
          fileCount: 1,
          hunkCount: 1,
          changedLines: 1,
          languages: ["typescript"],
          labels: [],
          maxReviewPriority: "normal",
          testFileCount: 0,
          representativePaths: ["app.ts"],
          hunkIds: ["h1"],
          hunkLanguages: { h1: "typescript" }
        }
      ],
      compaction: { level: "compacted", omitted: [{ what: "per-hunk detail", count: 1, reason: "test" }] }
    };
    const runner: LlmRunner = {
      runStructured: async <T>() =>
        ({
          diffUnderstanding: { declaredIntent: "invalid skip", inferredBehavior: "invalid skip" },
          riskAreas: [],
          coverage: [
            { hunkId: "h1", path: "app.ts", coverage: "skip", lenses: [], surroundingContextHints: [], reason: " " }
          ]
        }) as T
    };

    const result = await runPlanner(compacted, config(), nullTelemetry(), {
      runner,
      promptBuilder: fakePromptBuilder(),
      lenses: [
        { id: "core/code-review", title: "Core", description: "core", skillIds: [], enabledByDefault: true, enabled: true, languages: [] },
        { id: "lang/typescript", title: "TS", description: "ts", skillIds: [], enabledByDefault: true, enabled: true, languages: ["typescript"] }
      ],
      skills: []
    });

    expect(result.plan.coverage[0]).toMatchObject({
      hunkId: "h1",
      coverage: "normal",
      lenses: ["core/code-review", "lang/typescript"],
      reason: "planner_invalid_skip"
    });
  });

  it("carries planner partial-review reasons into coverage disclosure", async () => {
    const partialReason = "planner reviewed only the first dossier chunk";
    const partialPlan: ReviewPlan = {
      ...fakePlan(),
      partialReview: {
        isPartial: true,
        reason: partialReason,
        reviewedHunks: 1,
        totalHunks: 2
      }
    };
    const coverage = aggregateRunCoverage(
      partialPlan,
      [],
      [{ packetId: "packet-1", lenses: ["core/code-review"], findings: [], followUpHints: [], uncertainties: [], status: "completed" }],
      { incompleteCount: 0 },
      nullTelemetry(),
      { allFiles: fakeDiff().files, packets: [fakePacket()] }
    );

    expect(coverage.partial).toBe(true);
    expect(coverage.reasons).toContain(partialReason);

    const result = await dedupeRankAndComposeReview(
      { verified: [], verdicts: [] },
      partialPlan,
      {
        mode: "branch",
        repoRoot: "/tmp/repo",
        commits: [],
        rawDiff: ""
      },
      coverage,
      { ...config(), github: { ...config().github, summaryWhenNoFindings: true } },
      nullTelemetry(),
      {
        runner: {
          runStructured: async <T>() => ({ summary: "No credible findings.", composedFindings: [] }) as T
        },
        promptBuilder: fakePromptBuilder(),
        postGithubComments: true
      }
    );

    expect(result.postingPlan?.reviewBody).toContain("Coverage disclosure:");
    expect(result.postingPlan?.reviewBody).toContain(partialReason);
  });

  it("dedupes planner fallback hunk reasons into run coverage disclosure", () => {
    const fallbackReason = "planner_missing_coverage: default review packet used";
    const baseHunk = fakePacket().hunks[0];
    if (!baseHunk) {
      throw new Error("expected fake hunk");
    }
    const packet: ReviewPacket = {
      ...fakePacket(),
      hunks: [
        { ...baseHunk, hunkId: "h1", plannerFallbackReason: fallbackReason },
        { ...baseHunk, hunkId: "h2", newStart: 10, plannerFallbackReason: fallbackReason }
      ]
    };
    const coverage = aggregateRunCoverage(
      fakePlanForHunks(["h1", "h2"]),
      [],
      [{ packetId: packet.id, lenses: ["core/code-review"], findings: [], followUpHints: [], uncertainties: [], status: "completed" }],
      { incompleteCount: 0 },
      nullTelemetry(),
      { allFiles: [fakeMultiHunkFile([{ id: "h1", newStart: 1, content: "one" }, { id: "h2", newStart: 10, content: "two" }])], packets: [packet] }
    );

    const disclosedFallbacks = coverage.reasons.filter((reason) => reason.includes("planner_missing_coverage"));
    expect(disclosedFallbacks).toEqual([`app.ts: ${fallbackReason}`]);
    expect(renderMarkdownReview({
      summary: "Review completed.",
      coverage,
      findings: [],
      summaryOnlyFindings: [],
      needsHumanAttention: [],
      noFindings: true
    })).toContain(`- app.ts: ${fallbackReason}`);
  });

  it("counts incomplete packet results as failed partial coverage", () => {
    const coverage = aggregateRunCoverage(
      fakePlan(),
      [],
      [{ packetId: "packet-1", lenses: ["core/code-review"], findings: [], followUpHints: [], uncertainties: [], status: "incomplete" }],
      { incompleteCount: 0 },
      nullTelemetry(),
      { allFiles: fakeDiff().files, packets: [fakePacket()] }
    );

    expect(coverage.reviewedHunks).toBe(0);
    expect(coverage.failedHunks).toBe(1);
    expect(coverage.partial).toBe(true);
    expect(coverage.reasons).toContain("1 hunk(s) could not be reviewed");
    expect(renderMarkdownReview({
      summary: "Review completed.",
      coverage,
      findings: [],
      summaryOnlyFindings: [],
      needsHumanAttention: [],
      noFindings: true
    })).toContain("Reviewed 0/1 hunks.");
  });

  it("attaches left-side static signals to old-side dossier hunks", async () => {
    const file: DiffFile = {
      path: "app.test.ts",
      status: "deleted",
      language: "typescript",
      hunks: [
        {
          id: "h1",
          path: "app.test.ts",
          oldStart: 10,
          oldLines: 1,
          newStart: 0,
          newLines: 0,
          header: "@@ -10 +0,0 @@",
          lines: [{ kind: "delete", content: "expect(value).toBe(1);", oldLineNumber: 10 }]
        }
      ]
    };
    const dossier = await buildPlannerDossier(
      { mode: "branch", commits: [] },
      [file],
      [fakeFacts("app.test.ts", "per-hunk")],
      [{ path: "app.test.ts", action: "keep", reason: "test", provenance: [] }],
      {
        ...fakeRepositoryIndex(),
        staticSignals: [
          {
            ruleId: "core/deleted-test-file",
            path: "app.test.ts",
            line: 10,
            side: "LEFT",
            category: "testing",
            confidence: "high",
            explanation: "deleted test"
          }
        ]
      },
      config(),
      nullTelemetry()
    );

    expect(dossier.files[0]?.hunks[0]?.staticSignals).toEqual([
      expect.objectContaining({ ruleId: "core/deleted-test-file", side: "LEFT" })
    ]);
  });

  it("keeps renamed-file LEFT static signals emitted with the new path", async () => {
    const file: DiffFile = {
      path: "new.ts",
      oldPath: "old.ts",
      status: "renamed",
      language: "typescript",
      hunks: [
        {
          id: "h1",
          path: "new.ts",
          oldStart: 10,
          oldLines: 1,
          newStart: 20,
          newLines: 1,
          header: "@@ -10 +20 @@",
          lines: [
            { kind: "delete", content: "export const oldName = 1;", oldLineNumber: 10 },
            { kind: "add", content: "export const newName = 1;", newLineNumber: 20 }
          ]
        }
      ]
    };
    const dossier = await buildPlannerDossier(
      { mode: "branch", commits: [] },
      [file],
      [fakeFacts("new.ts", "per-hunk")],
      [{ path: "new.ts", action: "keep", reason: "test", provenance: [] }],
      {
        ...fakeRepositoryIndex(),
        staticSignals: [
          {
            ruleId: "core/deleted-exported-symbol",
            path: "new.ts",
            line: 10,
            side: "LEFT",
            category: "architecture",
            confidence: "high",
            explanation: "export disappeared during rename"
          }
        ]
      },
      config(),
      nullTelemetry()
    );

    expect(dossier.files[0]?.hunks[0]?.staticSignals).toEqual([
      expect.objectContaining({ ruleId: "core/deleted-exported-symbol", path: "new.ts", side: "LEFT" })
    ]);
  });

  it("records policy-file changes from old paths on renames", async () => {
    const file: DiffFile = {
      path: "src/review-note.md",
      oldPath: ".codeninja/skills/review-note.md",
      status: "renamed",
      language: "markdown",
      hunks: [
        {
          id: "h1",
          path: "src/review-note.md",
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          header: "@@ -1 +1 @@",
          lines: [
            { kind: "delete", content: "old skill text", oldLineNumber: 1 },
            { kind: "add", content: "new note text", newLineNumber: 1 }
          ]
        }
      ]
    };
    const dossier = await buildPlannerDossier(
      { mode: "branch", commits: [] },
      [file],
      [{ ...fakeFacts("src/review-note.md", "per-hunk"), language: "markdown" }],
      [{ path: "src/review-note.md", action: "keep", reason: "test", provenance: [] }],
      fakeRepositoryIndex(),
      config(),
      nullTelemetry()
    );

    expect(dossier.policyFilesChanged).toEqual([".codeninja/skills/review-note.md"]);
  });

  it("records policy-file old paths for filtered renamed files", async () => {
    const file: DiffFile = {
      path: "docs/review-note.md",
      oldPath: ".codeninja/skills/review-note.md",
      status: "renamed",
      language: "markdown",
      hunks: [
        {
          id: "h1",
          path: "docs/review-note.md",
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          header: "@@ -1 +1 @@",
          lines: [
            { kind: "delete", content: "old skill text", oldLineNumber: 1 },
            { kind: "add", content: "new docs text", newLineNumber: 1 }
          ]
        }
      ]
    };
    const dossier = await buildPlannerDossier(
      { mode: "branch", commits: [] },
      [],
      [],
      [{ path: "docs/review-note.md", action: "skip", reason: "filtered docs", provenance: [] }],
      fakeRepositoryIndex(),
      config(),
      nullTelemetry(),
      { allFiles: [file] }
    );

    expect(dossier.policyFilesChanged).toEqual([".codeninja/skills/review-note.md"]);
  });

  it("verifies only duplicate cluster representatives and preserves duplicate lineage", async () => {
    let verifierCalls = 0;
    const artifacts = new Map<string, unknown>();
    const duplicate = {
      ...fakeFinding(),
      id: "finding-2",
      evidence: { changedCode: "bad" }
    };
    const runner: LlmRunner = {
      runStructured: async <T>() => {
        verifierCalls += 1;
        return {
          verdict: "keep",
          reason: "cluster representative kept",
          requiredEvidencePresent: true,
          falsePositiveRisk: "low"
        } as T;
      }
    };

    const verified = await verifyFindings(
      {
        packetResults: [{ packetId: "packet-1", lenses: ["core/code-review"], findings: [fakeFinding(), duplicate], followUpHints: [], uncertainties: [], status: "completed" }],
        packets: [fakePacket()]
      },
      fakeTools(),
      config(),
      {
        ...nullTelemetry(),
        writeArtifact: async (name: string, data: unknown) => {
          artifacts.set(name, data);
        }
      },
      { runner, promptBuilder: fakePromptBuilder(), lensRegistry: fakeLensRegistry(), diff: fakeDiff() }
    );

    expect(verifierCalls).toBe(1);
    expect(verified.verified.map((finding) => finding.id).sort()).toEqual(["finding-1", "finding-2"]);
    expect(verified.verified.find((finding) => finding.id === "finding-2")).toMatchObject({
      clusterId: "finding-1",
      duplicateOf: "finding-1"
    });
    const records = artifacts.get("verification.json") as Array<{ candidateId: string; duplicateOf?: string; verdict: { candidateId: string; verdict: string } }>;
    expect(records.map((record) => record.candidateId).sort()).toEqual(["finding-1", "finding-2"]);
    expect(records.find((record) => record.candidateId === "finding-2")).toMatchObject({
      duplicateOf: "finding-1",
      verdict: { candidateId: "finding-2", verdict: "keep" }
    });
  });

  it("applies verifier keep finalFinding revisions to duplicate clusters", async () => {
    const artifacts = new Map<string, unknown>();
    const duplicate = {
      ...fakeFinding(),
      id: "finding-2",
      title: "stale duplicate",
      severity: "low" as const,
      evidence: { changedCode: "bad" }
    };
    const runner: LlmRunner = {
      runStructured: async <T>() =>
        ({
          verdict: "keep",
          reason: "kept with corrected wording",
          requiredEvidencePresent: true,
          falsePositiveRisk: "low",
          finalFinding: {
            title: "verified cluster finding",
            severity: "high",
            confidence: "high",
            path: "app.ts",
            anchor: { path: "app.ts", line: 1, side: "RIGHT", hunkId: "h1" },
            category: "security",
            evidence: { changedCode: "bad" },
            failureMode: "verified failure",
            whyThisMatters: "verified impact",
            verification: "verified by tools"
          }
        }) as T
    };

    const verified = await verifyFindings(
      {
        packetResults: [{ packetId: "packet-1", lenses: ["core/code-review"], findings: [fakeFinding(), duplicate], followUpHints: [], uncertainties: [], status: "completed" }],
        packets: [fakePacket()]
      },
      fakeTools(),
      config(),
      {
        ...nullTelemetry(),
        writeArtifact: async (name: string, data: unknown) => {
          artifacts.set(name, data);
        }
      },
      { runner, promptBuilder: fakePromptBuilder(), lensRegistry: fakeLensRegistry(), diff: fakeDiff() }
    );

    expect(verified.verified.map((finding) => finding.id).sort()).toEqual(["finding-1", "finding-2"]);
    expect(verified.verified).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "finding-1",
        title: "verified cluster finding",
        severity: "high",
        category: "security"
      }),
      expect.objectContaining({
        id: "finding-2",
        duplicateOf: "finding-1",
        clusterId: "finding-1",
        title: "verified cluster finding",
        severity: "high",
        category: "security"
      })
    ]));
    expect(verified.verified.find((finding) => finding.id === "finding-2")?.producedBy.packetId).toBe("packet-1");
    const records = artifacts.get("verification.json") as Array<{
      candidateId: string;
      duplicateOf?: string;
      verdict: { candidateId: string; finalFinding?: CandidateFinding };
    }>;
    expect(records.find((record) => record.candidateId === "finding-2")).toMatchObject({
      duplicateOf: "finding-1",
      verdict: {
        candidateId: "finding-2",
        finalFinding: {
          id: "finding-2",
          duplicateOf: "finding-1",
          clusterId: "finding-1",
          title: "verified cluster finding"
        }
      }
    });
  });

  it("records incomplete verifier duplicate clusters for every candidate", async () => {
    const artifacts = new Map<string, unknown>();
    const duplicate = {
      ...fakeFinding(),
      id: "finding-2",
      evidence: { changedCode: "bad" }
    };

    const verified = await verifyFindings(
      {
        packetResults: [{ packetId: "packet-1", lenses: ["core/code-review"], findings: [fakeFinding(), duplicate], followUpHints: [], uncertainties: [], status: "completed" }],
        packets: [fakePacket()]
      },
      fakeTools(),
      config(),
      {
        ...nullTelemetry(),
        writeArtifact: async (name: string, data: unknown) => {
          artifacts.set(name, data);
        }
      },
      {
        runner: {
          runStructured: async () => {
            throw new Error("verifier unavailable");
          }
        },
        promptBuilder: fakePromptBuilder(),
        lensRegistry: fakeLensRegistry(),
        diff: fakeDiff()
      }
    );

    const records = artifacts.get("verification.json") as Array<{ candidateId: string; duplicateOf?: string; verdict: { candidateId: string; verificationIncomplete?: boolean } }>;
    expect(verified.incompleteCount).toBe(2);
    expect(verified.verified).toEqual([]);
    expect(records.map((record) => record.candidateId).sort()).toEqual(["finding-1", "finding-2"]);
    expect(records.find((record) => record.candidateId === "finding-2")).toMatchObject({
      duplicateOf: "finding-1",
      verdict: { candidateId: "finding-2", verificationIncomplete: true }
    });
  });

  it("uses the verifier-specific tool budget instead of the originating packet budget", async () => {
    let verifierBudget: LlmStructuredRequest<unknown>["toolBudget"];
    const runner: LlmRunner = {
      runStructured: async <T>(request: LlmStructuredRequest<T>) => {
        verifierBudget = request.toolBudget;
        return {
          verdict: "keep",
          reason: "kept",
          requiredEvidencePresent: true,
          falsePositiveRisk: "low"
        } as T;
      }
    };

    await verifyFindings(
      {
        packetResults: [{ packetId: "packet-1", lenses: ["core/code-review"], findings: [fakeFinding()], followUpHints: [], uncertainties: [], status: "completed" }],
        packets: [fakePacket()]
      },
      fakeTools(),
      config(),
      nullTelemetry(),
      { runner, promptBuilder: fakePromptBuilder(), lensRegistry: fakeLensRegistry(), diff: fakeDiff() }
    );

    expect(verifierBudget).toEqual({ maxToolCalls: 6, maxInvestigationRounds: 2, maxResultChars: 12_000 });
  });

  it("allows verifier revisions to raise candidates above minSeverity", async () => {
    let verifierCalls = 0;
    const runner: LlmRunner = {
      runStructured: async <T>() => {
        verifierCalls += 1;
        return {
          verdict: "revise",
          reason: "severity raised after verification",
          requiredEvidencePresent: true,
          falsePositiveRisk: "low",
          finalFinding: {
            title: "verified high severity finding",
            severity: "high",
            confidence: "high",
            path: "app.ts",
            anchor: { path: "app.ts", line: 1, side: "RIGHT", hunkId: "h1" },
            category: "correctness",
            evidence: { changedCode: "bad" },
            failureMode: "verified high impact failure",
            whyThisMatters: "matters",
            verification: "verified"
          }
        } as T;
      }
    };

    const verified = await verifyFindings(
      {
        packetResults: [{ packetId: "packet-1", lenses: ["core/code-review"], findings: [{ ...fakeFinding(), severity: "medium" }], followUpHints: [], uncertainties: [], status: "completed" }],
        packets: [fakePacket()]
      },
      fakeTools(),
      { ...config(), review: { ...config().review, minSeverity: "high" } },
      nullTelemetry(),
      { runner, promptBuilder: fakePromptBuilder(), lensRegistry: fakeLensRegistry(), diff: fakeDiff() }
    );

    expect(verifierCalls).toBe(1);
    expect(verified.gateRejections).toBe(0);
    expect(verified.verified[0]).toMatchObject({ id: "finding-1", severity: "high", title: "verified high severity finding" });
  });

  it("uses configured minConfidence for verifier pre-gates", async () => {
    let verifierCalls = 0;
    const runner: LlmRunner = {
      runStructured: async <T>() => {
        verifierCalls += 1;
        return {
          verdict: "keep",
          reason: "kept",
          requiredEvidencePresent: true,
          falsePositiveRisk: "low"
        } as T;
      }
    };

    const suppressed = await verifyFindings(
      {
        packetResults: [{ packetId: "packet-1", lenses: ["core/code-review"], findings: [{ ...fakeFinding(), confidence: "medium" }], followUpHints: [], uncertainties: [], status: "completed" }],
        packets: [fakePacket()]
      },
      fakeTools(),
      { ...config(), review: { ...config().review, minConfidence: "high" } },
      nullTelemetry(),
      { runner, promptBuilder: fakePromptBuilder(), lensRegistry: fakeLensRegistry(), diff: fakeDiff() }
    );

    expect(verifierCalls).toBe(0);
    expect(suppressed.gateRejections).toBe(1);

    const allowed = await verifyFindings(
      {
        packetResults: [{ packetId: "packet-1", lenses: ["core/code-review"], findings: [{ ...fakeFinding(), confidence: "low" }], followUpHints: [], uncertainties: [], status: "completed" }],
        packets: [fakePacket()]
      },
      fakeTools(),
      { ...config(), review: { ...config().review, minConfidence: "low" } },
      nullTelemetry(),
      { runner, promptBuilder: fakePromptBuilder(), lensRegistry: fakeLensRegistry(), diff: fakeDiff() }
    );

    expect(verifierCalls).toBe(1);
    expect(allowed.gateRejections).toBe(0);
    expect(allowed.verified).toHaveLength(1);
  });

  it("strips invalid anchors before verifier scheduling and records the anchor gate", async () => {
    const artifacts = new Map<string, unknown>();
    const events: Array<Omit<TelemetryEvent, "runId" | "eventId" | "timestamp">> = [];
    let verifierCandidate: CandidateFinding | undefined;
    const runner: LlmRunner = {
      runStructured: async <T>() =>
        ({
          verdict: "keep",
          reason: "kept after anchor strip",
          requiredEvidencePresent: true,
          falsePositiveRisk: "low"
        }) as T
    };
    const invalidAnchor = {
      ...fakeFinding(),
      anchor: { path: "app.ts", line: 99, side: "RIGHT" as const, hunkId: "h1" }
    };

    const verified = await verifyFindings(
      {
        packetResults: [{ packetId: "packet-1", lenses: ["core/code-review"], findings: [invalidAnchor], followUpHints: [], uncertainties: [], status: "completed" }],
        packets: [fakePacket()]
      },
      fakeTools(),
      config(),
      {
        ...nullTelemetry(),
        event: (event: Omit<TelemetryEvent, "runId" | "eventId" | "timestamp">) => {
          events.push(event);
        },
        writeArtifact: async (name: string, data: unknown) => {
          artifacts.set(name, data);
        }
      },
      {
        runner,
        promptBuilder: {
          ...fakePromptBuilder(),
          buildVerifierPrompt: ({ candidate }: { candidate: CandidateFinding }) => {
            verifierCandidate = candidate;
            return { prompt: "", templateVersion: "test", untrustedBlockCount: 0 };
          }
        },
        lensRegistry: fakeLensRegistry(),
        diff: fakeDiff()
      }
    );

    const records = artifacts.get("verification.json") as Array<{ candidateId: string; gate: string; verdict?: { verdict: string } }>;
    expect(verifierCandidate).toMatchObject({ id: "finding-1", changedLine: false });
    expect(verifierCandidate?.anchor).toBeUndefined();
    expect(verified.verified[0]).toMatchObject({ id: "finding-1", changedLine: false });
    expect(verified.verified[0]?.anchor).toBeUndefined();
    expect(records).toEqual([
      expect.objectContaining({
        candidateId: "finding-1",
        gate: "gate_anchor_stripped",
        verdict: expect.objectContaining({ verdict: "keep" })
      })
    ]);
    expect(events).toContainEqual(expect.objectContaining({
      stage: 9,
      level: "warn",
      message: "gate_anchor_stripped",
      data: expect.objectContaining({ candidateId: "finding-1" })
    }));
  });

  it("discloses when verification is disabled in coverage", async () => {
    const packet = fakePacket();
    const verifyDisabled = await verifyFindings(
      {
        packetResults: [{ packetId: "packet-1", lenses: ["core/code-review"], findings: [fakeFinding()], followUpHints: [], uncertainties: [], status: "completed" }],
        packets: [packet]
      },
      fakeTools(),
      { ...config(), review: { ...config().review, verify: false } },
      nullTelemetry(),
      { runner: { runStructured: async <T>() => ({}) as T }, promptBuilder: fakePromptBuilder(), lensRegistry: fakeLensRegistry(), diff: fakeDiff() }
    );

    const coverage = aggregateRunCoverage(
      fakePlan(),
      [{ path: "app.ts", action: "keep", reason: "test", provenance: [] }],
      [{ packetId: "packet-1", lenses: ["core/code-review"], findings: [fakeFinding()], followUpHints: [], uncertainties: [], status: "completed" }],
      verifyDisabled,
      nullTelemetry(),
      { allFiles: fakeDiff().files, packets: [packet] }
    );

    expect(coverage.verificationSkipped).toBe(true);
    expect(coverage.reasons).toContain("verification disabled by config; candidates were not independently verified");
  });

  it("does not cluster unanchored findings from different symbols", async () => {
    let verifierCalls = 0;
    const { anchor: _anchor, ...baseFinding } = fakeFinding();
    const first = {
      ...baseFinding,
      changedLine: false,
      title: "same summary",
      evidence: { changedCode: "same snippet" }
    };
    const second = {
      ...first,
      id: "finding-2",
      producedBy: { ...first.producedBy, packetId: "packet-2" }
    };
    const runner: LlmRunner = {
      runStructured: async <T>() => {
        verifierCalls += 1;
        return {
          verdict: "keep",
          reason: "kept",
          requiredEvidencePresent: true,
          falsePositiveRisk: "low"
        } as T;
      }
    };

    await verifyFindings(
      {
        packetResults: [{ packetId: "packet-1", lenses: ["core/code-review"], findings: [first, second], followUpHints: [], uncertainties: [], status: "completed" }],
        packets: [
          packetWithSymbol("packet-1", "alpha"),
          packetWithSymbol("packet-2", "beta")
        ]
      },
      fakeTools(),
      config(),
      nullTelemetry(),
      { runner, promptBuilder: fakePromptBuilder(), lensRegistry: fakeLensRegistry(), diff: fakeDiff() }
    );

    expect(verifierCalls).toBe(2);
  });

  it("cancels in-flight workers when the root signal aborts", async () => {
    const controller = new AbortController();
    const workerRunner = createWorkerRunner({ concurrency: 1, signal: controller.signal });
    const scheduled = workerRunner.schedule([
      {
        workerId: "w7-001",
        stage: 7,
        priority: "normal",
        timeoutMs: 10_000,
        retryOnTransient: false,
        run: async () => new Promise<string>(() => undefined)
      }
    ]);

    controller.abort(new CodeninjaError("timeout", "review run exceeded hard timeout"));
    const [outcome] = await scheduled;

    expect(outcome).toMatchObject({
      outcome: "cancelled",
      error: { code: "timeout" }
    });
  });

  it("dispatches deep packets before normal packets with the same priority", async () => {
    const dispatched: string[] = [];
    let checkpoints = 0;
    const workerRunner = createWorkerRunner({
      concurrency: 1,
      checkpoint: () => {
        checkpoints += 1;
        return checkpoints === 1 ? "ok" : "exhausted";
      }
    });
    const outcomes = await workerRunner.schedule([
      {
        workerId: "w7-001",
        stage: 7,
        priority: "normal",
        coverage: "normal",
        packetId: "normal",
        timeoutMs: 10_000,
        retryOnTransient: false,
        run: async () => {
          dispatched.push("normal");
          return "normal";
        }
      },
      {
        workerId: "w7-002",
        stage: 7,
        priority: "normal",
        coverage: "deep",
        packetId: "deep",
        timeoutMs: 10_000,
        retryOnTransient: false,
        run: async () => {
          dispatched.push("deep");
          return "deep";
        }
      }
    ]);

    expect(dispatched).toEqual(["deep"]);
    expect(outcomes).toEqual([
      expect.objectContaining({ outcome: "completed", task: expect.objectContaining({ packetId: "deep" }) }),
      expect.objectContaining({ outcome: "not_dispatched", task: expect.objectContaining({ packetId: "normal" }) })
    ]);
  });

  it("schedules packets using configured review priority", async () => {
    const reviewedPacketIds: string[] = [];
    const reviewedWorkerIds: string[] = [];
    let checkpoints = 0;
    const runner: LlmRunner = {
      runStructured: async <T>(request: LlmStructuredRequest<T>) => {
        reviewedPacketIds.push(request.telemetryContext?.packetId ?? "");
        reviewedWorkerIds.push(request.telemetryContext?.workerId ?? "");
        return { findings: [], followUpHints: [], uncertainties: [] } as T;
      }
    };
    const results = await runLensPackets(
      fakePlan(),
      [
        fakePacket({ id: "normal-packet", reviewPriority: "normal" }),
        fakePacket({ id: "critical-packet", reviewPriority: "critical" })
      ],
      fakeTools(),
      { ...config(), review: { ...config().review, concurrency: 1 } },
      nullTelemetry(),
      {
        runner,
        promptBuilder: fakePromptBuilder(),
        lensRegistry: fakeLensRegistry(),
        diff: fakeDiff(),
        checkpoint: () => {
          checkpoints += 1;
          return checkpoints === 1 ? "ok" : "exhausted";
        }
      }
    );

    expect(reviewedPacketIds).toEqual(["critical-packet"]);
    expect(reviewedWorkerIds).toEqual(["w7-001"]);
    expect(results).toEqual([
      expect.objectContaining({ packetId: "critical-packet", status: "completed" }),
      expect.objectContaining({ packetId: "normal-packet", status: "skipped" })
    ]);
  });

  it("assigns Stage 9 worker ids in verifier dispatch order after priority sorting", async () => {
    const verifierCalls: string[] = [];
    const high = {
      ...fakeFinding(),
      id: "finding-2",
      severity: "high" as const,
      path: "other.ts",
      anchor: { path: "other.ts", line: 1, side: "RIGHT" as const, hunkId: "h2" },
      producedBy: { ...fakeFinding().producedBy, packetId: "packet-2" }
    };
    const runner: LlmRunner = {
      runStructured: async <T>(request: LlmStructuredRequest<T>) => {
        verifierCalls.push(`${request.telemetryContext?.candidateId}:${request.telemetryContext?.workerId}`);
        return {
          verdict: "keep",
          reason: "kept",
          requiredEvidencePresent: true,
          falsePositiveRisk: "low"
        } as T;
      }
    };

    await verifyFindings(
      {
        packetResults: [{ packetId: "packet-1", lenses: ["core/code-review"], findings: [fakeFinding(), high], followUpHints: [], uncertainties: [], status: "completed" }],
        packets: [
          fakePacket(),
          fakePacket({ id: "packet-2", path: "other.ts" })
        ]
      },
      fakeTools(),
      { ...config(), review: { ...config().review, concurrency: 1 } },
      nullTelemetry(),
      { runner, promptBuilder: fakePromptBuilder(), lensRegistry: fakeLensRegistry(), diff: fakeDiff() }
    );

    expect(verifierCalls).toEqual(["finding-2:w9-001", "finding-1:w9-002"]);
  });

  it("rethrows fatal provider errors from composition instead of falling back", async () => {
    const runner: LlmRunner = {
      runStructured: async () => {
        throw new CodeninjaError("llm_call_failed", "provider down", { recoverable: false });
      }
    };
    await expect(
      dedupeRankAndComposeReview(
        { verified: [fakeFinding()], verdicts: [] },
        fakePlan(),
        {
          mode: "branch",
          repoRoot: "/tmp/repo",
          commits: [],
          rawDiff: ""
        },
        {
          totalHunks: 1,
          reviewedHunks: 1,
          skippedHunks: 0,
          failedHunks: 0,
          coverageByLevel: { deep: 0, normal: 1, light: 0, skip: 0 },
          degradedPlanning: false,
          budgetStopped: false,
          verificationIncompleteCount: 0,
          partial: false,
          reasons: []
        },
        config(),
        nullTelemetry(),
        { runner, promptBuilder: fakePromptBuilder(), diff: fakeDiff() }
      )
    ).rejects.toMatchObject({ code: "llm_call_failed", recoverable: false });
  });

  it("fails the run on persistent provider-wide non-auth failures and writes failure logs", async () => {
    const repo = initRepo();
    writeRepoFile(repo, "app.ts", "export const value = 1;\n");
    commitAll(repo, "base");
    git(repo, ["checkout", "-b", "feature"]);
    writeRepoFile(repo, "app.ts", "export const value = 2;\n");
    commitAll(repo, "feature");
    const runArtifactDir = path.join(mkdtempSync(path.join(tmpdir(), "codeninja-run-")), "run-provider-failed");
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    let providerCalls = 0;
    const adapter: PiAiAdapter = {
      resolveModel: () => ({ provider: "scripted", id: "scripted-model", raw: { id: "scripted-model", api: "faux" } }),
      complete: async () => {
        providerCalls += 1;
        const error = new Error("provider unavailable") as Error & { status: number };
        error.status = 503;
        throw error;
      },
      validateToolCall: (_tools, call) => call.arguments
    };

    try {
      await expect(
        runReview(
          { mode: "branch", branchName: "feature" },
          {
            ...config(),
            telemetry: { ...defaultConfig.telemetry, enabled: true, logLevel: "debug", runDir: path.dirname(runArtifactDir) },
            llm: { provider: "scripted", model: "scripted-model", maxConcurrentCalls: 1 }
          },
          { repoRoot: repo, runArtifactDir, piAdapter: adapter }
        )
      ).rejects.toMatchObject({ code: "llm_call_failed", context: { reason: "transient_error" } });

      expect(providerCalls).toBe(4);
      const runJson = JSON.parse(readFileSync(path.join(runArtifactDir, "run.json"), "utf8")) as {
        outcome: { status: string; errorCode: string | null };
      };
      expect(runJson.outcome).toMatchObject({ status: "failed", errorCode: "llm_call_failed" });
      const errorJson = JSON.parse(readFileSync(path.join(runArtifactDir, "error.json"), "utf8")) as {
        errorCode: string;
        error: string;
        context: { reason: string };
      };
      expect(errorJson).toMatchObject({
        errorCode: "llm_call_failed",
        error: "LLM provider call failed",
        context: { reason: "transient_error" }
      });
      const runLog = readFileSync(path.join(runArtifactDir, "run.log"), "utf8");
      expect(runLog).toContain("model_call_started");
      expect(runLog).toContain("review_pipeline_failed");
    } finally {
      random.mockRestore();
    }
  });

  it("writes composer fallback coverage reasons to coverage artifact", async () => {
    const repo = initRepo();
    writeRepoFile(repo, "app.ts", "export const value = 1;\n");
    commitAll(repo, "base");
    git(repo, ["checkout", "-b", "feature"]);
    writeRepoFile(repo, "app.ts", "export const value = 'changed';\n");
    commitAll(repo, "feature");

    const runArtifactDir = path.join(mkdtempSync(path.join(tmpdir(), "codeninja-run-")), "run");
    const runner: LlmRunner = {
      runStructured: async <T>(request: LlmStructuredRequest<T>) => {
        if (request.stage === 5) {
          return {
            diffUnderstanding: { declaredIntent: "test intent", inferredBehavior: "test behavior" },
            riskAreas: [],
            coverage: [{ hunkId: "h1", path: "app.ts", coverage: "normal", lenses: ["core/code-review"], surroundingContextHints: [], reason: "test" }]
          } as T;
        }
        if (request.stage === 7) {
          return {
            findings: [
              {
                title: "finding",
                severity: "medium",
                confidence: "medium",
                path: "app.ts",
                anchor: { path: "app.ts", line: 1, side: "RIGHT", hunkId: "h1" },
                category: "correctness",
                evidence: { changedCode: "+changed" },
                failureMode: "bad",
                whyThisMatters: "matters",
                verification: "test"
              }
            ],
            followUpHints: [],
            uncertainties: []
          } as T;
        }
        if (request.stage === 9) {
          return {
            verdict: "keep",
            reason: "kept",
            requiredEvidencePresent: true,
            falsePositiveRisk: "low"
          } as T;
        }
        throw new Error("composer unavailable");
      }
    };

    await runReview(
      { mode: "branch", branchName: "feature" },
      { ...config(), telemetry: { ...defaultConfig.telemetry, enabled: true, runDir: path.dirname(runArtifactDir) } },
      { repoRoot: repo, runArtifactDir, runner }
    );

    const coverage = JSON.parse(readFileSync(path.join(runArtifactDir, "coverage.json"), "utf8")) as { status: { reasons: string[] } };
    expect(coverage.status.reasons).toContain("semantic composition skipped; deterministic fallback used");
  });

  it("writes run artifacts for explicit runArtifactDir even when telemetry config is disabled", async () => {
    const repo = initRepo();
    writeRepoFile(repo, "app.ts", "export const value = 1;\n");
    commitAll(repo, "base");
    git(repo, ["checkout", "-b", "feature"]);
    writeRepoFile(repo, "app.ts", "export const value = 2;\n");
    commitAll(repo, "feature");
    const runArtifactDir = path.join(mkdtempSync(path.join(tmpdir(), "codeninja-run-")), "forced-artifacts");

    await runReview(
      { mode: "branch", branchName: "feature" },
      config(),
      { repoRoot: repo, runArtifactDir }
    );

    expect(existsSync(path.join(runArtifactDir, "coverage.json"))).toBe(true);
    expect(existsSync(path.join(runArtifactDir, "final-review.md"))).toBe(true);
    expect(existsSync(path.join(runArtifactDir, "run.json"))).toBe(true);
  });

  it("discloses malformed skill loads in the final Markdown review", async () => {
    const repo = initRepo();
    writeRepoFile(repo, "app.ts", "export const value = 1;\n");
    commitAll(repo, "base");
    git(repo, ["checkout", "-b", "feature"]);
    writeRepoFile(repo, "app.ts", "export const value = 2;\n");
    commitAll(repo, "feature");
    writeRepoFile(repo, ".codeninja/skills/bad.md", "not frontmatter\n# Checks\n- invalid skill\n");
    const runArtifactDir = path.join(mkdtempSync(path.join(tmpdir(), "codeninja-run-")), "run-skill-disclosure");

    await runReview(
      { mode: "branch", branchName: "feature" },
      { ...config(), telemetry: { ...defaultConfig.telemetry, enabled: true, runDir: path.dirname(runArtifactDir) } },
      { repoRoot: repo, runArtifactDir }
    );

    const review = readFileSync(path.join(runArtifactDir, "final-review.md"), "utf8");
    expect(review).toContain("skill guidance skipped:");
    expect(review).toContain(".codeninja/skills/bad.md");
    expect(review).toContain("missing YAML frontmatter");
  });

  it("wires cache into the Pi runner and records composer budget exhaustion in coverage artifacts", async () => {
    const repo = initRepo();
    writeRepoFile(repo, "app.ts", "export const value = 1;\n");
    commitAll(repo, "initial");
    git(repo, ["checkout", "-b", "feature"]);
    writeRepoFile(repo, "app.ts", "export const value = 2;\n");
    commitAll(repo, "feature");
    const runArtifactDir = path.join(mkdtempSync(path.join(tmpdir(), "codeninja-runs-")), "run-budget-cache");
    const adapter = scriptedPiAdapter([
      assistantMessage([toolCall("submit-plan", "submit_plan", {
        diffUnderstanding: { declaredIntent: "test intent", inferredBehavior: "test behavior" },
        riskAreas: [],
        coverage: [{ hunkId: "h1", path: "app.ts", coverage: "normal", lenses: ["core/code-review"], surroundingContextHints: [], reason: "test" }]
      })]),
      assistantMessage([toolCall("submit-review", "submit_review", {
        findings: [
          {
            title: "finding",
            severity: "medium",
            confidence: "medium",
            path: "app.ts",
            category: "correctness",
            evidence: { changedCode: "+export const value = 2;" },
            failureMode: "bad",
            whyThisMatters: "matters",
            verification: "verified"
          }
        ],
        followUpHints: [],
        uncertainties: []
      })]),
      assistantMessage([toolCall("submit-verdict", "submit_verdict", {
        verdict: "keep",
        reason: "kept",
        requiredEvidencePresent: true,
        falsePositiveRisk: "low"
      })])
    ]);

    await runReview(
      { mode: "branch", branchName: "feature" },
      {
        ...config(),
        review: { ...config().review, maxModelCalls: 3 },
        cache: { ...defaultConfig.cache, enabled: true },
        telemetry: { ...defaultConfig.telemetry, enabled: true, runDir: path.dirname(runArtifactDir) },
        llm: { provider: "scripted", model: "scripted-model", maxConcurrentCalls: 1 }
      },
      { repoRoot: repo, runArtifactDir, piAdapter: adapter }
    );

    const coverage = JSON.parse(readFileSync(path.join(runArtifactDir, "coverage.json"), "utf8")) as {
      status: { budgetStopped: boolean; partial: boolean; reasons: string[] };
    };
    const modelCalls = JSON.parse(readFileSync(path.join(runArtifactDir, "model-calls-summary.json"), "utf8")) as {
      cache: { write: number; disabled: number };
    };
    expect(adapter.calls).toBe(3);
    expect(modelCalls.cache.write).toBeGreaterThan(0);
    expect(modelCalls.cache.disabled).toBe(0);
    expect(coverage.status).toMatchObject({ budgetStopped: true, partial: true });
    expect(coverage.status.reasons).toContain("budget exhausted before all review work completed");
    expect(coverage.status.reasons).toContain("semantic composition skipped; deterministic fallback used");
  });

  it("writes effective planner fallback reasons into reviewed coverage records", async () => {
    const repo = initRepo();
    writeRepoFile(repo, "a.ts", "export const a = 1;\n");
    writeRepoFile(repo, "b.ts", "export const b = 1;\n");
    commitAll(repo, "base");
    git(repo, ["checkout", "-b", "feature"]);
    writeRepoFile(repo, "a.ts", "export const a = 2;\n");
    writeRepoFile(repo, "b.ts", "export const b = 2;\n");
    commitAll(repo, "feature");
    const diff = parseDiff(git(repo, ["diff", "main...feature"]));
    const aHunk = diff.files.find((file) => file.path === "a.ts")?.hunks[0];
    const bHunk = diff.files.find((file) => file.path === "b.ts")?.hunks[0];
    if (!aHunk || !bHunk) {
      throw new Error("expected test hunks");
    }
    const runArtifactDir = path.join(mkdtempSync(path.join(tmpdir(), "codeninja-run-")), "run-planner-fallback-records");
    const runner: LlmRunner = {
      runStructured: async <T>(request: LlmStructuredRequest<T>) => {
        if (request.stage === 5) {
          return {
            diffUnderstanding: { declaredIntent: "test intent", inferredBehavior: "test behavior" },
            riskAreas: [],
            coverage: [
              {
                hunkId: bHunk.id,
                path: "b.ts",
                coverage: "normal",
                lenses: [],
                surroundingContextHints: [],
                reason: "planner selected no lenses"
              }
            ]
          } as T;
        }
        if (request.stage === 7) {
          return { findings: [], followUpHints: [], uncertainties: [] } as T;
        }
        if (request.stage === 10) {
          return { summary: "No credible findings.", composedFindings: [] } as T;
        }
        throw new Error(`unexpected stage ${String(request.stage)}`);
      }
    };

    await runReview(
      { mode: "branch", branchName: "feature" },
      { ...config(), telemetry: { ...defaultConfig.telemetry, enabled: true, runDir: path.dirname(runArtifactDir) } },
      { repoRoot: repo, runArtifactDir, runner }
    );

    const coverage = JSON.parse(readFileSync(path.join(runArtifactDir, "coverage.json"), "utf8")) as {
      records: Array<{ hunkId: string; path: string; status: string; reason?: string }>;
    };
    expect(coverage.records).toContainEqual(expect.objectContaining({
      hunkId: aHunk.id,
      path: "a.ts",
      status: "reviewed",
      reason: "planner_missing_coverage"
    }));
    expect(coverage.records).toContainEqual(expect.objectContaining({
      hunkId: bHunk.id,
      path: "b.ts",
      status: "reviewed",
      reason: expect.stringContaining("planner_empty_lenses")
    }));
  });

  it("uses stable fingerprints that exclude wording and exact anchor line shifts", async () => {
    const shifted = {
      ...fakeFinding(),
      id: "finding-2",
      title: "different wording",
      anchor: { path: "app.ts", line: 2, side: "RIGHT" as const, hunkId: "h1" },
      evidence: { changedCode: "different snippet" }
    };
    const runner: LlmRunner = {
      runStructured: async () => {
        throw new Error("force deterministic fallback");
      }
    };
    const result = await dedupeRankAndComposeReview(
      { verified: [fakeFinding(), shifted], verdicts: [] },
      fakePlan(),
      {
        mode: "branch",
        repoRoot: "/tmp/repo",
        commits: [],
        rawDiff: ""
      },
      {
        totalHunks: 1,
        reviewedHunks: 1,
        skippedHunks: 0,
        failedHunks: 0,
        coverageByLevel: { deep: 0, normal: 1, light: 0, skip: 0 },
        degradedPlanning: false,
        budgetStopped: false,
        verificationIncompleteCount: 0,
        partial: false,
        reasons: []
      },
      config(),
      nullTelemetry(),
      { runner, promptBuilder: fakePromptBuilder(), diff: fakeTwoLineDiff() }
    );

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.mergedCandidateIds.sort()).toEqual(["finding-1", "finding-2"]);
  });

  it("uses the earliest anchor line as proximity-group representative after severity and confidence ties", async () => {
    const diff: UnifiedDiff = {
      files: [
        {
          path: "app.ts",
          status: "modified",
          language: "typescript",
          hunks: [
            {
              id: "h1",
              path: "app.ts",
              oldStart: 10,
              oldLines: 1,
              newStart: 10,
              newLines: 1,
              header: "@@ -10 +10 @@",
              lines: [{ kind: "add", content: "early", newLineNumber: 10 }]
            },
            {
              id: "h2",
              path: "app.ts",
              oldStart: 12,
              oldLines: 1,
              newStart: 12,
              newLines: 1,
              header: "@@ -12 +12 @@",
              lines: [{ kind: "add", content: "late", newLineNumber: 12 }]
            }
          ]
        }
      ]
    };
    const laterSortingId = {
      ...fakeFinding(),
      id: "finding-0",
      anchor: { path: "app.ts", line: 12, side: "RIGHT" as const, hunkId: "h2" },
      evidence: { changedCode: "late" }
    };
    const earliestLine = {
      ...fakeFinding(),
      id: "finding-9",
      anchor: { path: "app.ts", line: 10, side: "RIGHT" as const, hunkId: "h1" },
      evidence: { changedCode: "early" }
    };

    const result = await dedupeRankAndComposeReview(
      { verified: [laterSortingId, earliestLine], verdicts: [] },
      fakePlan(),
      {
        mode: "branch",
        repoRoot: "/tmp/repo",
        commits: [],
        rawDiff: ""
      },
      {
        totalHunks: 2,
        reviewedHunks: 2,
        skippedHunks: 0,
        failedHunks: 0,
        coverageByLevel: { deep: 0, normal: 2, light: 0, skip: 0 },
        degradedPlanning: false,
        budgetStopped: false,
        verificationIncompleteCount: 0,
        partial: false,
        reasons: []
      },
      config(),
      nullTelemetry(),
      {
        runner: {
          runStructured: async () => {
            throw new Error("force deterministic fallback");
          }
        },
        promptBuilder: fakePromptBuilder(),
        diff
      }
    );

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      id: "finding-9",
      anchor: { line: 10, hunkId: "h1" },
      mergedCandidateIds: expect.arrayContaining(["finding-0", "finding-9"])
    });
  });

  it("merges chained nearby findings into one proximity group", async () => {
    const diff: UnifiedDiff = {
      files: [
        {
          path: "app.ts",
          status: "modified",
          language: "typescript",
          hunks: [
            {
              id: "h1",
              path: "app.ts",
              oldStart: 10,
              oldLines: 1,
              newStart: 10,
              newLines: 1,
              header: "@@ -10 +10 @@",
              lines: [{ kind: "add", content: "line ten", newLineNumber: 10 }]
            },
            {
              id: "h2",
              path: "app.ts",
              oldStart: 15,
              oldLines: 1,
              newStart: 15,
              newLines: 1,
              header: "@@ -15 +15 @@",
              lines: [{ kind: "add", content: "line fifteen", newLineNumber: 15 }]
            },
            {
              id: "h3",
              path: "app.ts",
              oldStart: 20,
              oldLines: 1,
              newStart: 20,
              newLines: 1,
              header: "@@ -20 +20 @@",
              lines: [{ kind: "add", content: "line twenty", newLineNumber: 20 }]
            }
          ]
        }
      ]
    };
    const findings = [
      { id: "finding-1", line: 10, hunkId: "h1", text: "line ten" },
      { id: "finding-2", line: 15, hunkId: "h2", text: "line fifteen" },
      { id: "finding-3", line: 20, hunkId: "h3", text: "line twenty" }
    ].map(({ id, line, hunkId, text }) => ({
      ...fakeFinding(),
      id,
      anchor: { path: "app.ts", line, side: "RIGHT" as const, hunkId },
      evidence: { changedCode: text }
    }));

    const result = await dedupeRankAndComposeReview(
      { verified: findings, verdicts: [] },
      fakePlan(),
      {
        mode: "branch",
        repoRoot: "/tmp/repo",
        commits: [],
        rawDiff: ""
      },
      {
        totalHunks: 3,
        reviewedHunks: 3,
        skippedHunks: 0,
        failedHunks: 0,
        coverageByLevel: { deep: 0, normal: 3, light: 0, skip: 0 },
        degradedPlanning: false,
        budgetStopped: false,
        verificationIncompleteCount: 0,
        partial: false,
        reasons: []
      },
      config(),
      nullTelemetry(),
      {
        runner: {
          runStructured: async () => {
            throw new Error("force deterministic fallback");
          }
        },
        promptBuilder: fakePromptBuilder(),
        diff
      }
    );

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.mergedCandidateIds.sort()).toEqual(["finding-1", "finding-2", "finding-3"]);
  });

  it("uses the canonical normalized delimiter-based final fingerprint", async () => {
    const finding: CandidateFinding = {
      ...fakeFinding(),
      path: "APP.ts",
      anchor: { path: "APP.ts", line: 1, side: "RIGHT", hunkId: "h1" },
      producedBy: { ...fakeFinding().producedBy, lensId: "CORE/Code-Review" }
    };
    const result = await dedupeRankAndComposeReview(
      { verified: [finding], verdicts: [] },
      fakePlan(),
      {
        mode: "branch",
        repoRoot: "/tmp/repo",
        commits: [],
        rawDiff: ""
      },
      {
        totalHunks: 1,
        reviewedHunks: 1,
        skippedHunks: 0,
        failedHunks: 0,
        coverageByLevel: { deep: 0, normal: 1, light: 0, skip: 0 },
        degradedPlanning: false,
        budgetStopped: false,
        verificationIncompleteCount: 0,
        partial: false,
        reasons: []
      },
      config(),
      nullTelemetry(),
      {
        runner: {
          runStructured: async () => {
            throw new Error("force deterministic fallback");
          }
        },
        promptBuilder: fakePromptBuilder(),
        packets: [packetWithSymbol("packet-1", " Checkout Flow ")]
      }
    );

    const expected = sha256Hex(["app.ts", "checkout flow", "correctness", "core/code-review"].join("\0"));
    const [final] = [...result.findings, ...result.summaryOnlyFindings];
    expect(final?.fingerprint).toBe(expected);
  });

  it("keeps unanchored packet fallback fingerprints stable across candidate ids", async () => {
    const ambiguousPacket: ReviewPacket = {
      ...fakePacket({ id: "packet-wide" }),
      kind: "coalesced-hunks",
      hunks: [
        {
          hunkId: "h1",
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          contentWithLineNumbers: "   1    1 +alpha",
          lines: [{ kind: "add", content: "alpha", newLine: 1 }],
          changedNewLineNumbers: [1],
          changedOldLineNumbers: []
        },
        {
          hunkId: "h2",
          oldStart: 20,
          oldLines: 1,
          newStart: 20,
          newLines: 1,
          contentWithLineNumbers: "  20   20 +beta",
          lines: [{ kind: "add", content: "beta", newLine: 20 }],
          changedNewLineNumbers: [20],
          changedOldLineNumbers: []
        }
      ]
    };
    const makeFinding = (id: string): CandidateFinding => {
      const { anchor: _anchor, ...base } = fakeFinding();
      return {
        ...base,
        id,
        changedLine: false,
        evidence: { changedCode: "not present in packet text" },
        producedBy: { ...base.producedBy, packetId: "packet-wide" }
      };
    };
    const compose = async (finding: CandidateFinding) => dedupeRankAndComposeReview(
      { verified: [finding], verdicts: [] },
      fakePlanForHunks(["h1", "h2"]),
      {
        mode: "branch",
        repoRoot: "/tmp/repo",
        commits: [],
        rawDiff: ""
      },
      {
        totalHunks: 2,
        reviewedHunks: 2,
        skippedHunks: 0,
        failedHunks: 0,
        coverageByLevel: { deep: 0, normal: 2, light: 0, skip: 0 },
        degradedPlanning: false,
        budgetStopped: false,
        verificationIncompleteCount: 0,
        partial: false,
        reasons: []
      },
      config(),
      nullTelemetry(),
      {
        runner: {
          runStructured: async () => {
            throw new Error("force deterministic fallback");
          }
        },
        promptBuilder: fakePromptBuilder(),
        packets: [ambiguousPacket]
      }
    );

    const first = await compose(makeFinding("finding-1"));
    const second = await compose(makeFinding("finding-99"));
    const expected = sha256Hex(["app.ts", "packet-wide", "correctness", "core/code-review"].join("\0"));
    const [firstFinal] = [...first.findings, ...first.summaryOnlyFindings];
    const [secondFinal] = [...second.findings, ...second.summaryOnlyFindings];
    expect(firstFinal?.fingerprint).toBe(expected);
    expect(secondFinal?.fingerprint).toBe(expected);
  });

  it("does not merge unanchored findings from different hunks in one coalesced packet", async () => {
    const coalescedPacket: ReviewPacket = {
      ...fakePacket(),
      kind: "coalesced-hunks",
      hunks: [
        {
          hunkId: "h1",
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          contentWithLineNumbers: "   1    1 +alpha bug",
          lines: [{ kind: "add", content: "alpha bug", newLine: 1 }],
          changedNewLineNumbers: [1],
          changedOldLineNumbers: []
        },
        {
          hunkId: "h2",
          oldStart: 20,
          oldLines: 1,
          newStart: 20,
          newLines: 1,
          contentWithLineNumbers: "  20   20 +beta bug",
          lines: [{ kind: "add", content: "beta bug", newLine: 20 }],
          changedNewLineNumbers: [20],
          changedOldLineNumbers: []
        }
      ]
    };
    const { anchor: _firstAnchor, ...firstBase } = fakeFinding();
    const first = {
      ...firstBase,
      changedLine: false,
      evidence: { changedCode: "alpha bug" }
    };
    const second = {
      ...first,
      id: "finding-2",
      title: "second unanchored",
      evidence: { changedCode: "beta bug" }
    };
    const result = await dedupeRankAndComposeReview(
      { verified: [first, second], verdicts: [] },
      fakePlanForHunks(["h1", "h2"]),
      {
        mode: "branch",
        repoRoot: "/tmp/repo",
        commits: [],
        rawDiff: ""
      },
      {
        totalHunks: 2,
        reviewedHunks: 2,
        skippedHunks: 0,
        failedHunks: 0,
        coverageByLevel: { deep: 0, normal: 2, light: 0, skip: 0 },
        degradedPlanning: false,
        budgetStopped: false,
        verificationIncompleteCount: 0,
        partial: false,
        reasons: []
      },
      { ...config(), review: { ...config().review, maxFindings: 100, softCommentCap: 100 } },
      nullTelemetry(),
      {
        runner: {
          runStructured: async () => {
            throw new Error("force deterministic fallback");
          }
        },
        promptBuilder: fakePromptBuilder(),
        packets: [coalescedPacket]
      }
    );

    expect(result.findings).toHaveLength(0);
    expect(result.summaryOnlyFindings).toHaveLength(2);
    expect(result.summaryOnlyFindings.map((finding) => finding.mergedCandidateIds)).toEqual([["finding-1"], ["finding-2"]]);
  });

  it("drops composed groups when any referenced finding id is unknown", async () => {
    const events: Array<Omit<TelemetryEvent, "runId" | "eventId" | "timestamp">> = [];
    const result = await dedupeRankAndComposeReview(
      { verified: [fakeFinding()], verdicts: [] },
      fakePlan(),
      {
        mode: "branch",
        repoRoot: "/tmp/repo",
        commits: [],
        rawDiff: ""
      },
      {
        totalHunks: 1,
        reviewedHunks: 1,
        skippedHunks: 0,
        failedHunks: 0,
        coverageByLevel: { deep: 0, normal: 1, light: 0, skip: 0 },
        degradedPlanning: false,
        budgetStopped: false,
        verificationIncompleteCount: 0,
        partial: false,
        reasons: []
      },
      { ...config(), review: { ...config().review, maxFindings: 100, softCommentCap: 100 } },
      {
        ...nullTelemetry(),
        event: (event: Omit<TelemetryEvent, "runId" | "eventId" | "timestamp">) => {
          events.push(event);
        }
      },
      {
        runner: {
          runStructured: async <T>() =>
            ({
              summary: "composer summary",
              composedFindings: [{ findingIds: ["finding-1", "invented-id"], finalBody: "invented wording", publication: "inline" }]
            }) as T
        },
        promptBuilder: fakePromptBuilder(),
        diff: fakeDiff()
      }
    );

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.mergedCandidateIds).toEqual(["finding-1"]);
    expect(result.findings[0]?.finalBody).toContain("Evidence: bad");
    expect(result.findings[0]?.finalBody).not.toContain("invented wording");
    expect(events).toContainEqual(expect.objectContaining({
      stage: 10,
      level: "warn",
      message: "composer_invented_finding",
      data: expect.objectContaining({ unknownIds: ["invented-id"] })
    }));
  });

  it("drops overlapping composed groups before publishing duplicate final findings", async () => {
    const artifacts = new Map<string, unknown>();
    const events: Array<Omit<TelemetryEvent, "runId" | "eventId" | "timestamp">> = [];
    const second = {
      ...fakeFinding(),
      id: "finding-2",
      path: "other.ts",
      anchor: { path: "other.ts", line: 1, side: "RIGHT" as const, hunkId: "h2" },
      producedBy: { ...fakeFinding().producedBy, packetId: "packet-2" }
    };

    const result = await dedupeRankAndComposeReview(
      { verified: [fakeFinding(), second], verdicts: [] },
      fakePlan(),
      {
        mode: "branch",
        repoRoot: "/tmp/repo",
        commits: [],
        rawDiff: ""
      },
      {
        totalHunks: 2,
        reviewedHunks: 2,
        skippedHunks: 0,
        failedHunks: 0,
        coverageByLevel: { deep: 0, normal: 2, light: 0, skip: 0 },
        degradedPlanning: false,
        budgetStopped: false,
        verificationIncompleteCount: 0,
        partial: false,
        reasons: []
      },
      { ...config(), review: { ...config().review, maxFindings: 100, softCommentCap: 100 } },
      {
        ...nullTelemetry(),
        event: (event: Omit<TelemetryEvent, "runId" | "eventId" | "timestamp">) => {
          events.push(event);
        },
        writeArtifact: async (name: string, data: unknown) => {
          artifacts.set(name, data);
        }
      },
      {
        runner: {
          runStructured: async <T>() =>
            ({
              summary: "composer summary",
              composedFindings: [
                { findingIds: ["finding-1"], finalBody: "first body", publication: "inline" },
                { findingIds: ["finding-1"], finalBody: "overlapping body", publication: "inline" },
                { findingIds: ["finding-2"], finalBody: "second body", publication: "inline" }
              ]
            }) as T
        },
        promptBuilder: fakePromptBuilder()
      }
    );

    const allFindings = [...result.findings, ...result.summaryOnlyFindings];
    expect(allFindings).toHaveLength(2);
    expect(allFindings.filter((finding) => finding.mergedCandidateIds.includes("finding-1"))).toHaveLength(1);
    expect(allFindings.map((finding) => finding.finalBody)).not.toContain("overlapping body");
    const selection = artifacts.get("final-selection.json") as { records: Array<{ findingId: string }> };
    expect(selection.records.map((record) => record.findingId).sort()).toEqual(["finding-1", "finding-2"]);
    expect(events).toContainEqual(expect.objectContaining({
      stage: 10,
      level: "warn",
      message: "composer_overlapping_finding_group",
      data: expect.objectContaining({ overlappingIds: ["finding-1"] })
    }));
  });

  it("merges nearby same-path category anchors before composition", async () => {
    const nearby = {
      ...fakeFinding(),
      id: "finding-2",
      title: "nearby duplicate",
      anchor: { path: "app.ts", line: 4, side: "RIGHT" as const, hunkId: "h2" },
      producedBy: { ...fakeFinding().producedBy, packetId: "packet-2" }
    };
    const result = await dedupeRankAndComposeReview(
      { verified: [fakeFinding(), nearby], verdicts: [] },
      fakePlan(),
      {
        mode: "branch",
        repoRoot: "/tmp/repo",
        commits: [],
        rawDiff: ""
      },
      {
        totalHunks: 2,
        reviewedHunks: 2,
        skippedHunks: 0,
        failedHunks: 0,
        coverageByLevel: { deep: 0, normal: 2, light: 0, skip: 0 },
        degradedPlanning: false,
        budgetStopped: false,
        verificationIncompleteCount: 0,
        partial: false,
        reasons: []
      },
      { ...config(), review: { ...config().review, maxFindings: 100, softCommentCap: 100 } },
      nullTelemetry(),
      {
        runner: {
          runStructured: async () => {
            throw new Error("force deterministic fallback");
          }
        },
        promptBuilder: fakePromptBuilder()
      }
    );

    expect([...result.findings, ...result.summaryOnlyFindings]).toHaveLength(1);
    expect([...result.findings, ...result.summaryOnlyFindings][0]?.mergedCandidateIds.sort()).toEqual(["finding-1", "finding-2"]);
  });

  it("pre-trims composer input over forty findings and records suppressed selections", async () => {
    let composerGroupCount = 0;
    const artifacts = new Map<string, unknown>();
    const events: Array<Omit<TelemetryEvent, "runId" | "eventId" | "timestamp">> = [];
    const telemetry = {
      ...nullTelemetry(),
      event: (event: Omit<TelemetryEvent, "runId" | "eventId" | "timestamp">) => {
        events.push(event);
      },
      writeArtifact: async (name: string, data: unknown) => {
        artifacts.set(name, data);
      }
    };
    const coverage = {
      totalHunks: 45,
      reviewedHunks: 45,
      skippedHunks: 0,
      failedHunks: 0,
      coverageByLevel: { deep: 0, normal: 45, light: 0, skip: 0 },
      degradedPlanning: false,
      budgetStopped: false,
      verificationIncompleteCount: 0,
      partial: false,
      reasons: []
    };

    await dedupeRankAndComposeReview(
      { verified: manyFindings(45), verdicts: [] },
      fakePlan(),
      {
        mode: "branch",
        repoRoot: "/tmp/repo",
        commits: [],
        rawDiff: ""
      },
      coverage,
      { ...config(), review: { ...config().review, maxFindings: 100, softCommentCap: 100 } },
      telemetry,
      {
        runner: {
          runStructured: async <T>() => ({ summary: "test", composedFindings: [] }) as T
        },
        promptBuilder: {
          ...fakePromptBuilder(),
          buildComposerPrompt: ({ groupedFindingsJson }: { groupedFindingsJson: string }) => {
            composerGroupCount = (JSON.parse(groupedFindingsJson) as unknown[]).length;
            return { prompt: "", templateVersion: "test", untrustedBlockCount: 0 };
          }
        }
      }
    );

    const selection = artifacts.get("final-selection.json") as { records: Array<{ findingId: string; decision: string; reason: string }> };
    expect(composerGroupCount).toBe(40);
    expect(selection.records).toHaveLength(45);
    expect(selection.records.filter((record) => record.reason === "composer-pre-trim")).toHaveLength(5);
    expect(coverage.reasons).toContain("composer pre-trim suppressed 5 verified findings above the 40-finding composer input cap");
    expect(events).toContainEqual(expect.objectContaining({
      stage: 10,
      level: "warn",
      message: "composer_pretrim_suppressed_findings",
      data: expect.objectContaining({ suppressedFindings: 5, maxComposerFindings: 40 })
    }));
  });

  it("folds Stage 9 duplicate lineage when composer selects only the representative", async () => {
    const duplicate = {
      ...fakeFinding(),
      id: "finding-2",
      clusterId: "finding-1",
      duplicateOf: "finding-1"
    };
    const result = await dedupeRankAndComposeReview(
      { verified: [{ ...fakeFinding(), clusterId: "finding-1" }, duplicate], verdicts: [] },
      fakePlan(),
      {
        mode: "branch",
        repoRoot: "/tmp/repo",
        commits: [],
        rawDiff: ""
      },
      {
        totalHunks: 1,
        reviewedHunks: 1,
        skippedHunks: 0,
        failedHunks: 0,
        coverageByLevel: { deep: 0, normal: 1, light: 0, skip: 0 },
        degradedPlanning: false,
        budgetStopped: false,
        verificationIncompleteCount: 0,
        partial: false,
        reasons: []
      },
      { ...config(), review: { ...config().review, maxFindings: 100, softCommentCap: 100 } },
      nullTelemetry(),
      {
        runner: {
          runStructured: async <T>() =>
            ({
              summary: "one issue",
              composedFindings: [{ findingIds: ["finding-1"], finalBody: "body", publication: "inline" }]
            }) as T
        },
        promptBuilder: fakePromptBuilder()
      }
    );

    expect([...result.findings, ...result.summaryOnlyFindings]).toHaveLength(1);
    expect([...result.findings, ...result.summaryOnlyFindings][0]?.mergedCandidateIds.sort()).toEqual(["finding-1", "finding-2"]);
  });

  it("records unanchorable downgrade reasons for inline findings with invalid anchors", async () => {
    const artifacts = new Map<string, unknown>();
    const telemetry = {
      ...nullTelemetry(),
      writeArtifact: async (name: string, data: unknown) => {
        artifacts.set(name, data);
      }
    };
    const invalidAnchor = {
      ...fakeFinding(),
      anchor: { path: "app.ts", line: 99, side: "RIGHT" as const, hunkId: "h1" }
    };

    const result = await dedupeRankAndComposeReview(
      { verified: [invalidAnchor], verdicts: [] },
      fakePlan(),
      {
        mode: "branch",
        repoRoot: "/tmp/repo",
        commits: [],
        rawDiff: ""
      },
      {
        totalHunks: 1,
        reviewedHunks: 1,
        skippedHunks: 0,
        failedHunks: 0,
        coverageByLevel: { deep: 0, normal: 1, light: 0, skip: 0 },
        degradedPlanning: false,
        budgetStopped: false,
        verificationIncompleteCount: 0,
        partial: false,
        reasons: []
      },
      { ...config(), review: { ...config().review, maxFindings: 100, softCommentCap: 100 } },
      telemetry,
      {
        runner: {
          runStructured: async <T>() =>
            ({
              summary: "one issue",
              composedFindings: [{ findingIds: ["finding-1"], finalBody: "body", publication: "inline" }]
            }) as T
        },
        promptBuilder: fakePromptBuilder(),
        diff: fakeDiff()
      }
    );

    const selection = artifacts.get("final-selection.json") as { records: Array<{ findingId: string; decision: string; reason: string }> };
    expect(result.findings).toHaveLength(0);
    expect(result.summaryOnlyFindings).toHaveLength(1);
    expect(selection.records).toEqual([
      expect.objectContaining({ findingId: "finding-1", decision: "published", reason: "unanchorable" })
    ]);
  });

  it("suppresses final findings below minSeverity after verification revisions", async () => {
    const artifacts = new Map<string, unknown>();
    const telemetry = {
      ...nullTelemetry(),
      writeArtifact: async (name: string, data: unknown) => {
        artifacts.set(name, data);
      }
    };

    const result = await dedupeRankAndComposeReview(
      { verified: [{ ...fakeFinding(), severity: "medium" }], verdicts: [] },
      fakePlan(),
      {
        mode: "branch",
        repoRoot: "/tmp/repo",
        commits: [],
        rawDiff: ""
      },
      {
        totalHunks: 1,
        reviewedHunks: 1,
        skippedHunks: 0,
        failedHunks: 0,
        coverageByLevel: { deep: 0, normal: 1, light: 0, skip: 0 },
        degradedPlanning: false,
        budgetStopped: false,
        verificationIncompleteCount: 0,
        partial: false,
        reasons: []
      },
      { ...config(), review: { ...config().review, minSeverity: "high" } },
      telemetry,
      {
        runner: {
          runStructured: async () => {
            throw new Error("force deterministic fallback");
          }
        },
        promptBuilder: fakePromptBuilder()
      }
    );

    const selection = artifacts.get("final-selection.json") as { records: Array<{ findingId: string; decision: string; reason: string }> };
    expect(result.noFindings).toBe(true);
    expect(result.summary).toBe("No credible findings.");
    expect(selection.records).toEqual([
      expect.objectContaining({ findingId: "finding-1", decision: "suppressed", reason: "severity-threshold" })
    ]);
  });

  it("normalizes successful composer summaries after caps suppress every finding", async () => {
    const result = await dedupeRankAndComposeReview(
      { verified: [{ ...fakeFinding(), severity: "medium" }], verdicts: [] },
      fakePlan(),
      {
        mode: "branch",
        repoRoot: "/tmp/repo",
        commits: [],
        rawDiff: ""
      },
      {
        totalHunks: 1,
        reviewedHunks: 1,
        skippedHunks: 0,
        failedHunks: 0,
        coverageByLevel: { deep: 0, normal: 1, light: 0, skip: 0 },
        degradedPlanning: false,
        budgetStopped: false,
        verificationIncompleteCount: 0,
        partial: false,
        reasons: []
      },
      { ...config(), review: { ...config().review, minSeverity: "high" } },
      nullTelemetry(),
      {
        runner: {
          runStructured: async <T>() =>
            ({
              summary: "Found 1 verified issue.",
              composedFindings: [{ findingIds: ["finding-1"], finalBody: "body", publication: "inline" }]
            }) as T
        },
        promptBuilder: fakePromptBuilder(),
        diff: fakeDiff()
      }
    );

    expect(result.noFindings).toBe(true);
    expect(result.summary).toBe("No credible findings.");
    expect(result.findings).toEqual([]);
    expect(result.summaryOnlyFindings).toEqual([]);
  });

  it("normalizes no-finding composer summaries when omitted verified findings are reinserted", async () => {
    const result = await dedupeRankAndComposeReview(
      { verified: [fakeFinding()], verdicts: [] },
      fakePlan(),
      {
        mode: "branch",
        repoRoot: "/tmp/repo",
        commits: [],
        rawDiff: ""
      },
      {
        totalHunks: 1,
        reviewedHunks: 1,
        skippedHunks: 0,
        failedHunks: 0,
        coverageByLevel: { deep: 0, normal: 1, light: 0, skip: 0 },
        degradedPlanning: false,
        budgetStopped: false,
        verificationIncompleteCount: 0,
        partial: false,
        reasons: []
      },
      config(),
      nullTelemetry(),
      {
        runner: {
          runStructured: async <T>() =>
            ({
              summary: "No credible findings.",
              composedFindings: []
            }) as T
        },
        promptBuilder: fakePromptBuilder(),
        diff: fakeDiff()
      }
    );

    expect(result.noFindings).toBe(false);
    expect(result.summary).toBe("Found 1 verified issue.");
    expect([...result.findings, ...result.summaryOnlyFindings]).toHaveLength(1);
  });

  it("keeps contrastive composer summaries that mention remaining issues", async () => {
    const finding = fakeFinding();
    const result = await dedupeRankAndComposeReview(
      { verified: [finding], verdicts: [] },
      fakePlan(),
      {
        mode: "branch",
        repoRoot: "/tmp/repo",
        commits: [],
        rawDiff: ""
      },
      {
        totalHunks: 1,
        reviewedHunks: 1,
        skippedHunks: 0,
        failedHunks: 0,
        coverageByLevel: { deep: 0, normal: 1, light: 0, skip: 0 },
        degradedPlanning: false,
        budgetStopped: false,
        verificationIncompleteCount: 0,
        partial: false,
        reasons: []
      },
      config(),
      nullTelemetry(),
      {
        runner: {
          runStructured: async <T>() =>
            ({
              summary: "No security issues, but one correctness bug remains.",
              composedFindings: [{ findingIds: [finding.id], finalBody: "Grouped body", publication: "inline" }]
            }) as T
        },
        promptBuilder: fakePromptBuilder(),
        packetResults: [{ packetId: "packet-1", lenses: ["core/code-review"], findings: [finding], followUpHints: [], uncertainties: [], status: "completed" }],
        packets: [fakePacket()],
        diff: fakeDiff()
      }
    );

    expect(result.summary).toBe("No security issues, but one correctness bug remains.");
    expect([...result.findings, ...result.summaryOnlyFindings]).toHaveLength(1);
  });

  it("does not create no-findings posting plans unless summaryWhenNoFindings is enabled", async () => {
    const baseCoverage = {
      totalHunks: 1,
      reviewedHunks: 1,
      skippedHunks: 0,
      failedHunks: 0,
      coverageByLevel: { deep: 0, normal: 1, light: 0, skip: 0 },
      degradedPlanning: false,
      budgetStopped: false,
      verificationIncompleteCount: 0,
      partial: false,
      reasons: []
    };
    const baseOpts = {
      runner: {
        runStructured: async <T>() => ({ summary: "No credible findings.", composedFindings: [] }) as T
      },
      promptBuilder: fakePromptBuilder(),
      postGithubComments: true
    };

    const disabled = await dedupeRankAndComposeReview(
      { verified: [], verdicts: [] },
      fakePlan(),
      {
        mode: "branch",
        repoRoot: "/tmp/repo",
        commits: [],
        rawDiff: ""
      },
      baseCoverage,
      config(),
      nullTelemetry(),
      baseOpts
    );
    const enabled = await dedupeRankAndComposeReview(
      { verified: [], verdicts: [] },
      fakePlan(),
      {
        mode: "branch",
        repoRoot: "/tmp/repo",
        commits: [],
        rawDiff: ""
      },
      { ...baseCoverage },
      { ...config(), github: { ...config().github, summaryWhenNoFindings: true } },
      nullTelemetry(),
      baseOpts
    );

    expect(disabled.noFindings).toBe(true);
    expect(disabled.postingPlan).toBeUndefined();
    expect(renderPostingSummaryForStdout(disabled, "markdown", { postRequested: true }))
      .toContain("Posting was requested, but no review body or inline comments were created.");
    expect(renderPostingSummaryForStdout(disabled, "markdown")).toContain("Posting was not requested.");
    expect(enabled.noFindings).toBe(true);
    expect(enabled.postingPlan?.reviewBody).toContain("No credible findings.");
  });

  it("renders summary-only findings with their full body in GitHub posting plans", async () => {
    const { anchor: _anchor, ...summaryFinding } = fakeFinding();
    const result = await dedupeRankAndComposeReview(
      { verified: [{ ...summaryFinding, changedLine: false }], verdicts: [] },
      fakePlan(),
      {
        mode: "branch",
        repoRoot: "/tmp/repo",
        commits: [],
        rawDiff: ""
      },
      {
        totalHunks: 1,
        reviewedHunks: 1,
        skippedHunks: 0,
        failedHunks: 0,
        coverageByLevel: { deep: 0, normal: 1, light: 0, skip: 0 },
        degradedPlanning: false,
        budgetStopped: false,
        verificationIncompleteCount: 0,
        partial: false,
        reasons: []
      },
      config(),
      nullTelemetry(),
      {
        runner: {
          runStructured: async <T>() =>
            ({
              summary: "one broad issue",
              composedFindings: [{
                findingIds: ["finding-1"],
                finalBody: "Full failure mode and concrete fix details.",
                publication: "summary-only"
              }]
            }) as T
        },
        promptBuilder: fakePromptBuilder(),
        postGithubComments: true
      }
    );

    expect(result.summaryOnlyFindings).toHaveLength(1);
    expect(result.postingPlan?.reviewBody).toContain("- finding (app.ts)");
    expect(result.postingPlan?.reviewBody).toContain("  Full failure mode and concrete fix details.");
  });

  it("includes partial coverage disclosure in GitHub posting review body", async () => {
    const result = await dedupeRankAndComposeReview(
      { verified: [], verdicts: [] },
      fakePlan(),
      {
        mode: "branch",
        repoRoot: "/tmp/repo",
        commits: [],
        rawDiff: ""
      },
      {
        totalHunks: 3,
        reviewedHunks: 1,
        skippedHunks: 0,
        failedHunks: 2,
        coverageByLevel: { deep: 0, normal: 1, light: 0, skip: 0 },
        degradedPlanning: false,
        budgetStopped: true,
        verificationIncompleteCount: 2,
        partial: true,
        reasons: ["budget exhausted before all review work completed", "semantic composition skipped; deterministic fallback used"]
      },
      { ...config(), github: { ...config().github, summaryWhenNoFindings: true } },
      nullTelemetry(),
      {
        runner: {
          runStructured: async <T>() => ({ summary: "No credible findings.", composedFindings: [] }) as T
        },
        promptBuilder: fakePromptBuilder(),
        postGithubComments: true
      }
    );

    expect(result.postingPlan?.reviewBody).toContain("Reviewed 1/3 hunks.");
    expect(result.postingPlan?.reviewBody).toContain("Coverage disclosure:");
    expect(result.postingPlan?.reviewBody).toContain("Review is partial.");
    expect(result.postingPlan?.reviewBody).toContain("Budget exhausted before all review work completed.");
    expect(result.postingPlan?.reviewBody).toContain("Verification incomplete for 2 candidates.");
    expect(result.postingPlan?.reviewBody).toContain("semantic composition skipped; deterministic fallback used");
  });

  it("records summary-only downgrade reasons in final selection", async () => {
    const artifacts = new Map<string, unknown>();
    const telemetry = {
      ...nullTelemetry(),
      writeArtifact: async (name: string, data: unknown) => {
        artifacts.set(name, data);
      }
    };
    const first = { ...fakeFinding(), id: "finding-1", confidence: "medium" as const };
    const second = { ...fakeFinding(), id: "finding-2", confidence: "high" as const };
    const third = { ...fakeFinding(), id: "finding-3", confidence: "high" as const };

    await dedupeRankAndComposeReview(
      { verified: [first, second, third], verdicts: [] },
      fakePlan(),
      {
        mode: "branch",
        repoRoot: "/tmp/repo",
        commits: [],
        rawDiff: ""
      },
      {
        totalHunks: 1,
        reviewedHunks: 1,
        skippedHunks: 0,
        failedHunks: 0,
        coverageByLevel: { deep: 0, normal: 1, light: 0, skip: 0 },
        degradedPlanning: false,
        budgetStopped: false,
        verificationIncompleteCount: 0,
        partial: false,
        reasons: []
      },
      {
        ...config(),
        review: {
          ...config().review,
          minConfidence: "low",
          minInlineConfidence: "high",
          softCommentCap: 1,
          maxFindings: 100
        }
      },
      telemetry,
      {
        runner: {
          runStructured: async <T>() =>
            ({
              summary: "three issues",
              composedFindings: [
                { findingIds: ["finding-1"], finalBody: "body 1", publication: "inline" },
                { findingIds: ["finding-2"], finalBody: "body 2", publication: "inline" },
                { findingIds: ["finding-3"], finalBody: "body 3", publication: "inline" }
              ]
            }) as T
        },
        promptBuilder: fakePromptBuilder(),
        diff: fakeDiff()
      }
    );

    const selection = artifacts.get("final-selection.json") as { records: Array<{ findingId: string; decision: string; reason: string }> };
    expect(selection.records).toContainEqual(expect.objectContaining({
      findingId: "finding-1",
      decision: "published",
      reason: "min-inline-confidence"
    }));
    expect(selection.records).toContainEqual(expect.objectContaining({
      findingId: "finding-3",
      decision: "published",
      reason: "soft-comment-cap"
    }));
  });

  it("records one final selection decision per verified finding after caps", async () => {
    const artifacts = new Map<string, unknown>();
    const telemetry = {
      ...nullTelemetry(),
      writeArtifact: async (name: string, data: unknown) => {
        artifacts.set(name, data);
      }
    };
    const second = {
      ...fakeFinding(),
      id: "finding-2",
      path: "other.ts",
      anchor: { path: "other.ts", line: 2, side: "RIGHT" as const, hunkId: "h2" },
      producedBy: { ...fakeFinding().producedBy, packetId: "packet-2" }
    };

    await dedupeRankAndComposeReview(
      { verified: [fakeFinding(), second], verdicts: [] },
      fakePlan(),
      {
        mode: "branch",
        repoRoot: "/tmp/repo",
        commits: [],
        rawDiff: ""
      },
      {
        totalHunks: 2,
        reviewedHunks: 2,
        skippedHunks: 0,
        failedHunks: 0,
        coverageByLevel: { deep: 0, normal: 2, light: 0, skip: 0 },
        degradedPlanning: false,
        budgetStopped: false,
        verificationIncompleteCount: 0,
        partial: false,
        reasons: []
      },
      { ...config(), review: { ...config().review, maxFindings: 1 } },
      telemetry,
      {
        runner: {
          runStructured: async () => {
            throw new Error("force deterministic fallback");
          }
        },
        promptBuilder: fakePromptBuilder()
      }
    );

    const selection = artifacts.get("final-selection.json") as { records: Array<{ findingId: string; decision: string }> };
    expect(selection.records.map((record) => record.findingId).sort()).toEqual(["finding-1", "finding-2"]);
    expect(new Set(selection.records.map((record) => record.findingId)).size).toBe(selection.records.length);
    expect(selection.records.some((record) => record.decision === "suppressed")).toBe(true);
  });

  it("merges duplicate follow-up questions across files and keeps strongest confidence", async () => {
    const result = await dedupeRankAndComposeReview(
      { verified: [], verdicts: [] },
      fakePlan(),
      {
        mode: "branch",
        repoRoot: "/tmp/repo",
        commits: [],
        rawDiff: ""
      },
      {
        totalHunks: 1,
        reviewedHunks: 1,
        skippedHunks: 0,
        failedHunks: 0,
        coverageByLevel: { deep: 0, normal: 1, light: 0, skip: 0 },
        degradedPlanning: false,
        budgetStopped: false,
        verificationIncompleteCount: 0,
        partial: false,
        reasons: []
      },
      config(),
      nullTelemetry(),
      {
        runner: {
          runStructured: async <T>() => ({ summary: "no findings", composedFindings: [] }) as T
        },
        promptBuilder: fakePromptBuilder(),
        packetResults: [
          {
            packetId: "packet-1",
            lenses: ["core/code-review"],
            findings: [],
            followUpHints: [
              {
                question: "Should this be migrated?",
                files: ["a.ts"],
                symbols: ["alpha"],
                suggestedLenses: [],
                reason: "first hint",
                confidence: "medium"
              }
            ],
            uncertainties: [],
            status: "completed"
          },
          {
            packetId: "packet-2",
            lenses: ["core/code-review"],
            findings: [],
            followUpHints: [
              {
                question: "  Should this be migrated?  ",
                files: ["b.ts", "a.ts"],
                symbols: ["beta"],
                suggestedLenses: [],
                reason: "stronger hint",
                confidence: "high"
              }
            ],
            uncertainties: [],
            status: "completed"
          }
        ]
      }
    );

    expect(result.needsHumanAttention).toEqual([
      {
        question: "Should this be migrated?",
        files: ["a.ts", "b.ts"],
        symbols: ["alpha", "beta"],
        reason: "stronger hint",
        confidence: "high"
      }
    ]);
  });
});

function scriptedPiAdapter(messages: PiAssistantMessage[]): PiAiAdapter & { readonly calls: number } {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    resolveModel: () => ({ provider: "scripted", id: "scripted-model", raw: { id: "scripted-model", api: "faux" } }),
    complete: async () => {
      calls += 1;
      const next = messages.shift();
      if (!next) {
        throw new Error("no scripted model response");
      }
      return next;
    },
    validateToolCall: (_tools, call) => call.arguments
  };
}

function assistantMessage(content: PiAssistantMessage["content"]): PiAssistantMessage {
  return {
    role: "assistant",
    provider: "scripted",
    model: "scripted-model",
    content,
    usage: {
      input: 10,
      output: 5,
      totalTokens: 15,
      cost: { total: 0.01 }
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

function fakeLogger() {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  };
}

function config(): CodeninjaConfig {
  return {
    ...defaultConfig,
    lenses: { enabled: ["core/code-review"], disabled: [], extraSkillPaths: [] },
    telemetry: { ...defaultConfig.telemetry, enabled: false },
    llm: { provider: "fake", model: "fake-model", maxConcurrentCalls: 1 }
  };
}

function fakePlan(path = "app.ts"): ReviewPlan {
  return {
    diffUnderstanding: { declaredIntent: "test intent", inferredBehavior: "test behavior" },
    riskAreas: [],
    coverage: [{ hunkId: "h1", path, coverage: "normal", lenses: ["core/code-review"], surroundingContextHints: [], reason: "test" }]
  };
}

function fakePlanForHunks(hunkIds: string[], path = "app.ts"): ReviewPlan {
  return {
    diffUnderstanding: { declaredIntent: "test intent", inferredBehavior: "test behavior" },
    riskAreas: [],
    coverage: hunkIds.map((hunkId) => ({
      hunkId,
      path,
      coverage: "normal",
      lenses: ["core/code-review"],
      surroundingContextHints: [],
      reason: "test"
    }))
  };
}

function fakePacket(opts: {
  id?: string;
  path?: string;
  oldPath?: string;
  reviewPriority?: ReviewPacket["reviewPriority"];
  hunkLines?: ReviewPacket["hunks"][number]["lines"];
  changedNewLineNumbers?: number[];
  changedOldLineNumbers?: number[];
} = {}): ReviewPacket {
  const packetPath = opts.path ?? "app.ts";
  return {
    id: opts.id ?? "packet-1",
    kind: "hunk",
    prSummary: "test",
    path: packetPath,
    ...(opts.oldPath !== undefined ? { oldPath: opts.oldPath } : {}),
    fileStatus: "modified",
    isDeletedContent: false,
    language: "typescript",
    reviewPriority: opts.reviewPriority ?? "normal",
    coverage: "normal",
    lenses: ["core/code-review"],
    hunks: [
      {
        hunkId: "h1",
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        contentWithLineNumbers: "   1    1 +bad",
        lines: opts.hunkLines ?? [{ kind: "add", content: "bad", newLine: 1 }],
        changedNewLineNumbers: opts.changedNewLineNumbers ?? [1],
        changedOldLineNumbers: opts.changedOldLineNumbers ?? []
      }
    ],
    symbolFacts: [],
    context: { path: packetPath },
    contextText: "",
    relevantTests: [],
    surroundingContextHints: [],
    labels: [],
    riskNotes: [],
    toolBudget: { maxToolCalls: 1, maxInvestigationRounds: 1, maxResultChars: 4000 }
  };
}

function packetWithSymbol(id: string, enclosingSymbol: string): ReviewPacket {
  return {
    ...fakePacket(),
    id,
    symbolFacts: [
      {
        path: "app.ts",
        hunkId: "h1",
        enclosingSymbol,
        changedLines: [1],
        changedLinesSide: "new",
        source: "fallback",
        confidence: "heuristic"
      }
    ]
  };
}

function fakeDiffFile(path: string, content = "export const value = 1;"): DiffFile {
  return {
    path,
    status: "modified",
    language: "typescript",
    hunks: [
      {
        id: "h1",
        path,
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        header: "@@ -1 +1 @@",
        lines: [{ kind: "add", content, newLineNumber: 1 }]
      }
    ]
  };
}

function fakeMultiHunkFile(hunks: Array<{ id: string; newStart: number; content: string }>): DiffFile {
  return {
    path: "app.ts",
    status: "modified",
    language: "typescript",
    hunks: hunks.map((hunk) => ({
      id: hunk.id,
      path: "app.ts",
      oldStart: hunk.newStart,
      oldLines: 1,
      newStart: hunk.newStart,
      newLines: 1,
      header: `@@ -${hunk.newStart} +${hunk.newStart} @@`,
      lines: [{ kind: "add", content: hunk.content, newLineNumber: hunk.newStart }]
    }))
  };
}

function fakeFacts(path: string, processingMode: FileFacts["processingMode"]): FileFacts {
  return {
    path,
    language: "typescript",
    processingMode,
    testStatus: "source",
    isGenerated: false,
    isVendored: false,
    isLockfile: false,
    isBinary: false,
    changedLines: 1,
    hunkCount: 1,
    labels: [],
    reviewPriority: "normal",
    reasons: [],
    provenance: []
  };
}

function fakeDiff(): UnifiedDiff {
  return {
    files: [
      {
        path: "app.ts",
        status: "modified",
        language: "typescript",
        hunks: [
          {
            id: "h1",
            path: "app.ts",
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            header: "@@ -1 +1 @@",
            lines: [{ kind: "add", content: "bad", newLineNumber: 1 }]
          }
        ]
      }
    ]
  };
}

function fakeRenameDiff(): UnifiedDiff {
  return {
    files: [
      {
        path: "new.ts",
        oldPath: "old.ts",
        status: "renamed",
        language: "typescript",
        hunks: [
          {
            id: "h1",
            path: "new.ts",
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 0,
            header: "@@ -1 +0,0 @@",
            lines: [{ kind: "delete", content: "old", oldLineNumber: 1 }]
          }
        ]
      }
    ]
  };
}

function fakeTwoLineDiff(): UnifiedDiff {
  return {
    files: [
      {
        path: "app.ts",
        status: "modified",
        language: "typescript",
        hunks: [
          {
            id: "h1",
            path: "app.ts",
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 2,
            header: "@@ -1 +1,2 @@",
            lines: [
              { kind: "add", content: "bad", newLineNumber: 1 },
              { kind: "add", content: "worse", newLineNumber: 2 }
            ]
          }
        ]
      }
    ]
  };
}

function fakeFinding(): CandidateFinding {
  return {
    id: "finding-1",
    title: "finding",
    severity: "medium",
    confidence: "medium",
    path: "app.ts",
    anchor: { path: "app.ts", line: 1, side: "RIGHT", hunkId: "h1" },
    changedLine: true,
    category: "correctness",
    evidence: { changedCode: "bad" },
    failureMode: "bad",
    whyThisMatters: "matters",
    verification: "verified",
    producedBy: { kind: "packet", stage: 7, packetId: "packet-1", lensId: "core/code-review", skillIds: [] }
  };
}

function manyFindings(count: number): CandidateFinding[] {
  return Array.from({ length: count }, (_, index) => {
    const id = `finding-${String(index + 1)}`;
    const pathName = `file-${String(index + 1)}.ts`;
    const hunkId = `h${String(index + 1)}`;
    return {
      ...fakeFinding(),
      id,
      title: `finding ${String(index + 1)}`,
      path: pathName,
      anchor: { path: pathName, line: 1, side: "RIGHT", hunkId },
      evidence: { changedCode: `bad ${String(index + 1)}` },
      producedBy: {
        ...fakeFinding().producedBy,
        packetId: `packet-${String(index + 1)}`
      }
    };
  });
}

function fakeDossier(paths: string[]): PlannerDossier {
  return {
    runId: "test-run",
    mode: "branch",
    depth: "normal",
    target: {},
    commits: [],
    policyFilesChanged: [],
    files: paths.map((filePath, index) => ({
      path: filePath,
      status: "modified",
      language: "typescript",
      processingMode: "per-hunk",
      testStatus: "source",
      labels: [],
      reviewPriority: "normal",
      changedLines: 1,
      hunkCount: 1,
      hunks: [
        {
          hunkId: `h${String(index + 1)}`,
          header: "@@ -1 +1 @@",
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          changedNewLineNumbers: [1],
          changedOldLineNumbers: [],
          staticSignals: [],
          omittedSignalCount: 0,
          excerpt: "+changed"
        }
      ]
    })),
    directories: [],
    filterSummary: { keptFiles: paths.length, skippedFiles: 0, skipped: [] },
    lenses: [],
    totals: {
      files: paths.length,
      keptFiles: paths.length,
      hunks: paths.length,
      addedLines: paths.length,
      deletedLines: 0
    },
    compaction: { level: "full", omitted: [] }
  };
}

function fakeRepositoryIndex(tools = fakeTools()): RepositoryIndex {
  return { facts: [], symbolFacts: [], staticSignals: [], tools };
}

function fakeTools(readText = ""): RepositoryTools {
  const meta = { backend: "text" as const, precision: "exact" as const, degraded: false };
  const tools: RepositoryTools & Pick<RepositoryToolsHost, "bindPackets" | "buildPacketContext" | "withToolCallContext"> = {
    readRange: async () => ({ text: readText, meta }),
    readFileOutline: async (path) => ({ outline: { path, language: "typescript", imports: [], topLevelSymbols: [], testSymbols: [], notes: [] }, meta }),
    readSymbol: async () => ({ meta }),
    readDiffBlocks: async () => ({ blocks: [], meta }),
    findDefinition: async () => ({ definitions: [], meta }),
    searchFiles: async () => ({ results: [], meta }),
    findSymbolMentions: async () => ({ results: [], meta }),
    findLikelyTests: async () => ({ tests: [], meta }),
    listFiles: async () => ({ paths: [], meta }),
    bindPackets: () => undefined,
    buildPacketContext: async (file) => ({ context: { path: file.path }, relevantTests: [] }),
    withToolCallContext: async <T>(_context: Parameters<RepositoryToolsHost["withToolCallContext"]>[0], run: () => Promise<T>) => run()
  };
  return tools;
}

function fakePromptBuilder() {
  return {
    renderDossier: () => "",
    buildPlannerPrompt: () => ({ prompt: "", templateVersion: "test", untrustedBlockCount: 0 }),
    buildPacketReviewPrompt: () => ({ prompt: "", templateVersion: "test", untrustedBlockCount: 0 }),
    buildVerifierPrompt: () => ({ prompt: "", templateVersion: "test", untrustedBlockCount: 0 }),
    buildComposerPrompt: () => ({ prompt: "", templateVersion: "test", untrustedBlockCount: 0 })
  };
}

function fakeLensRegistry() {
  return {
    allLenses: () => [],
    enabledLenses: () => [],
    lens: () => undefined,
    skillsForLens: () => [],
    skillsById: () => [],
    registryHash: () => "fake"
  };
}
