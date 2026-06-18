import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config/schema.js";
import type { LlmRunner } from "../src/llm/llm-runner.js";
import { parseDiff } from "../src/git/diff-parser.js";
import { buildSystemReviewTasks, runTargetedSystemReviews, suppressResolvedFollowUpHints } from "../src/pipeline/system-reviewer.js";
import { verifyFindings } from "../src/pipeline/verifier.js";
import type {
  CandidateFinding,
  CodeninjaConfig,
  PacketReviewResult,
  RepositoryTools,
  RepositoryToolsHost,
  ReviewPacket,
  ReviewPlan,
  SystemReviewTask,
  TelemetryEvent
} from "../src/types.js";
import { nullTelemetry } from "./helpers/git.js";

describe("phase 8 targeted system review", () => {
  it("builds bounded tasks only from repeated follow-up hints", () => {
    const packets = [fakePacket("packet-1", "app.ts"), fakePacket("packet-2", "app.ts")];
    const packetResults = [
      packetResult("packet-1", [
        hint("Check whether callers can pass zero count.", ["app.ts"], ["divide"]),
        hint("Check whether auth state is cached safely.", ["auth.ts"], ["loadAuth"]),
        hint("Check whether retries leak workers.", ["worker.ts"], ["retryLoop"]),
        hint("Check whether transactions are committed twice.", ["db.ts"], ["commitTx"])
      ]),
      packetResult("packet-2", [
        hint("Verify if callers can pass zero count.", ["app.ts"], ["divide"]),
        hint("Verify if auth state is cached safely.", ["auth.ts"], ["loadAuth"]),
        hint("Verify if retries leak workers.", ["worker.ts"], ["retryLoop"]),
        hint("Verify if transactions are committed twice.", ["db.ts"], ["commitTx"])
      ])
    ];

    const tasks = buildSystemReviewTasks(packetResults, packets);

    expect(tasks).toHaveLength(3);
    expect(tasks.map((task) => task.question)).toEqual([
      "Check whether auth state is cached safely.",
      "Check whether callers can pass zero count.",
      "Check whether retries leak workers."
    ]);
    expect(tasks[0]).toMatchObject({
      packetIds: ["packet-1", "packet-2"],
      suggestedLenses: expect.arrayContaining(["core/code-review"])
    });
  });

  it("does not group identical follow-up questions from different scopes", () => {
    const packetResults = [
      packetResult("packet-1", [hint("Check whether this request needs tenant authorization.", ["auth/session.ts"], ["refreshSession"])]),
      packetResult("packet-2", [hint("Verify if this request needs tenant authorization.", ["billing/charge.ts"], ["chargeTenant"])])
    ];

    const tasks = buildSystemReviewTasks(packetResults, [
      fakePacket("packet-1", "auth/session.ts", "refreshSession"),
      fakePacket("packet-2", "billing/charge.ts", "chargeTenant")
    ]);

    expect(tasks).toEqual([]);
  });

  it("does not dispatch Stage 8 when hints are isolated", async () => {
    const events: Array<Omit<TelemetryEvent, "runId" | "eventId" | "timestamp">> = [];
    const result = await runTargetedSystemReviews(
      {
        packetResults: [packetResult("packet-1", [hint("Check one isolated thing.", ["app.ts"], ["handler"])])],
        packets: [fakePacket("packet-1", "app.ts")]
      },
      fakeTools(),
      config(),
      {
        ...nullTelemetry(),
        event: (event: Omit<TelemetryEvent, "runId" | "eventId" | "timestamp">) => {
          events.push(event);
        }
      },
      {
        runner: {
          runStructured: async () => {
            throw new Error("Stage 8 should not run for isolated hints");
          }
        },
        promptBuilder: fakePromptBuilder(),
        lensRegistry: fakeLensRegistry(),
        diff: fakeDiff()
      }
    );

    expect(result).toEqual({ tasks: [], packetResults: [], resolvedHints: [] });
    expect(events).toContainEqual(expect.objectContaining({
      stage: 8,
      level: "info",
      message: "system_review_skipped",
      data: { reason: "no repeated follow-up hints or unresolved review questions" }
    }));
  });

  it("builds one focused Stage 8 task from a partial attached review question", () => {
    const packet = {
      ...fakePacket("packet-1", "app.ts"),
      reviewQuestions: [{
        id: "q-value-contract",
        question: "Does the changed value still match the returned response?",
        whyItMatters: "Callers rely on the returned response matching the transformed value.",
        files: ["app.ts"],
        symbols: ["divide"],
        relevanceReason: "file overlap: app.ts"
      }]
    };
    const result: PacketReviewResult = {
      ...packetResult("packet-1", []),
      answeredQuestions: [{
        questionId: "q-value-contract",
        answer: "The packet shows the divisor changed, but the caller-side response trace is outside this packet.",
        confidence: "medium",
        outcome: "partial",
        evidence: [{ path: "app.ts", whyRelevant: "The changed hunk contains the local value transformation." }],
        evidenceTrace: "requested count -> changed divide helper -> caller response remains to be checked"
      }]
    };

    const tasks = buildSystemReviewTasks([result], [packet]);

    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      question: "Does the changed value still match the returned response?",
      packetIds: ["packet-1"],
      files: ["app.ts"],
      suggestedLenses: expect.arrayContaining(["core/code-review"])
    });
  });

  it("does not build a question-driven Stage 8 task when a candidate already covers the question", () => {
    const packet = {
      ...fakePacket("packet-1", "app.ts"),
      reviewQuestions: [{
        id: "q-value-contract",
        question: "Does the changed value still match the returned response?",
        whyItMatters: "Callers rely on the returned response matching the transformed value.",
        files: ["app.ts"],
        symbols: ["divide"],
        relevanceReason: "file overlap: app.ts"
      }]
    };
    const result: PacketReviewResult = {
      ...packetResult("packet-1", [], [{
        ...fakeCandidate("packet-1"),
        reviewQuestionIds: ["q-value-contract"]
      }]),
      answeredQuestions: [{
        questionId: "q-value-contract",
        answer: "The changed hunk exposes a concrete mismatch.",
        confidence: "medium",
        outcome: "candidate_finding",
        evidence: [{ path: "app.ts", whyRelevant: "The candidate covers this review question." }],
        evidenceTrace: "question answered by candidate finding"
      }]
    };

    expect(buildSystemReviewTasks([result], [packet])).toEqual([]);
  });

  it("suppresses duplicate human-attention hints when Stage 8 resolves the question", () => {
    const first = packetResult("packet-1", [hint("Check whether callers can pass zero count.", ["app.ts"], ["divide"])]);
    const second = packetResult("packet-2", [hint("Verify if callers can pass zero count.", ["app.ts"], ["divide"])]);

    const filtered = suppressResolvedFollowUpHints([first, second], [
      {
        taskId: "system-1",
        question: "Check whether callers can pass zero count.",
        files: ["app.ts"],
        symbols: ["divide"],
        resolution: "Callers clamp count before calling divide."
      }
    ]);

    expect(filtered.flatMap((result) => result.followUpHints)).toEqual([]);
  });

  it("keeps same-question human-attention hints when Stage 8 resolves a different scope", () => {
    const first = packetResult("packet-1", [hint("Check whether this request needs tenant authorization.", ["auth/session.ts"], ["refreshSession"])]);
    const second = packetResult("packet-2", [hint("Verify if this request needs tenant authorization.", ["billing/charge.ts"], ["chargeTenant"])]);

    const filtered = suppressResolvedFollowUpHints([first, second], [
      {
        taskId: "system-1",
        question: "Check whether this request needs tenant authorization.",
        files: ["auth/session.ts"],
        symbols: ["refreshSession"],
        resolution: "The session refresh path already checks tenant membership."
      }
    ]);

    expect(filtered.flatMap((result) => result.followUpHints).map((hint) => hint.files)).toEqual([["billing/charge.ts"]]);
  });

  it("passes Stage 8 candidate findings into normal verification", async () => {
    const systemReview = await runTargetedSystemReviews(
      {
        packetResults: [
          packetResult("packet-1", [hint("Check whether callers can pass zero count.", ["app.ts"], ["divide"])]),
          packetResult("packet-2", [hint("Verify if callers can pass zero count.", ["app.ts"], ["divide"])])
        ],
        packets: [fakePacket("packet-1", "app.ts"), fakePacket("packet-2", "app.ts")]
      },
      fakeTools(),
      config(),
      nullTelemetry(),
      {
        runner: {
          runStructured: async <T>() =>
            ({
              findings: [
                {
                  title: "Callers can now pass zero count",
                  severity: "high",
                  confidence: "high",
                  path: "app.ts",
                  anchor: { path: "app.ts", line: 2, side: "RIGHT", hunkId: "h1" },
                  category: "correctness",
                  evidence: { changedCode: "return total / count;" },
                  failureMode: "A zero count reaches the division path and produces Infinity.",
                  whyThisMatters: "Invalid numeric values can leak into caller state.",
                  suggestedFix: "Restore the zero-count guard.",
                  suggestedTest: "Add a test for divide(total, 0).",
                  verification: "Stage 8 inspected repeated caller concerns."
                }
              ],
              resolvedHints: []
            }) as T
        },
        promptBuilder: fakePromptBuilder(),
        lensRegistry: fakeLensRegistry(),
        diff: fakeDiff()
      }
    );
    const candidate = systemReview.packetResults[0]?.findings[0];
    expect(candidate).toMatchObject({
      producedBy: { stage: 8 },
      title: "Callers can now pass zero count"
    });

    const verified = await verifyFindings(
      { packetResults: systemReview.packetResults, packets: [fakePacket("packet-1", "app.ts"), fakePacket("packet-2", "app.ts")] },
      fakeTools(),
      config(),
      nullTelemetry(),
      {
        runner: {
          runStructured: async <T>() =>
            ({
              verdict: "keep",
              reason: "Stage 8 candidate verified",
              requiredEvidencePresent: true,
              falsePositiveRisk: "low"
            }) as T
        },
        promptBuilder: fakePromptBuilder(),
        lensRegistry: fakeLensRegistry(),
        diff: fakeDiff()
      }
    );

    expect(verified.verified).toHaveLength(1);
    expect(verified.verified[0]).toMatchObject({
      title: "Callers can now pass zero count",
      producedBy: { stage: 8 }
    });
  });
});

function hint(
  question: string,
  files: string[],
  symbols: string[],
  confidence: PacketReviewResult["followUpHints"][number]["confidence"] = "medium"
): PacketReviewResult["followUpHints"][number] {
  return {
    question,
    files,
    symbols,
    suggestedLenses: ["core/code-review"],
    reason: "Repeated question from packet review.",
    confidence
  };
}

function packetResult(packetId: string, followUpHints: PacketReviewResult["followUpHints"], findings: CandidateFinding[] = []): PacketReviewResult {
  return {
    packetId,
    lenses: ["core/code-review"],
    findings,
    followUpHints,
    uncertainties: [],
    status: "completed"
  };
}

function fakeCandidate(packetId: string): CandidateFinding {
  return {
    id: `${packetId}-f1`,
    title: "Changed value can mismatch the returned response",
    severity: "medium",
    confidence: "medium",
    path: "app.ts",
    anchor: { path: "app.ts", line: 2, side: "RIGHT", hunkId: "h1" },
    changedLine: true,
    category: "correctness",
    evidence: { changedCode: "return total / count;" },
    failureMode: "A caller-visible value can diverge from the transformed value.",
    whyThisMatters: "Callers rely on the response value.",
    verification: "Packet review produced a candidate for this question.",
    producedBy: { kind: "packet", stage: 7, packetId, lensId: "core/code-review", skillIds: [] }
  };
}

function fakePacket(id: string, path: string, symbol = "divide"): ReviewPacket {
  return {
    id,
    kind: "hunk",
    prSummary: "test",
    path,
    fileStatus: "modified",
    isDeletedContent: false,
    language: "typescript",
    reviewPriority: "normal",
    coverage: "normal",
    reviewProfile: "standard",
    lenses: ["core/code-review"],
    hunks: [
      {
        hunkId: "h1",
        oldStart: 1,
        oldLines: 2,
        newStart: 1,
        newLines: 2,
        contentWithLineNumbers: "   1    1  export function divide(total: number, count: number) {\n   2    2 +  return total / count;\n",
        lines: [
          { kind: "context", content: "export function divide(total: number, count: number) {", oldLine: 1, newLine: 1 },
          { kind: "add", content: "return total / count;", newLine: 2 }
        ],
        changedNewLineNumbers: [2],
        changedOldLineNumbers: []
      }
    ],
    symbolFacts: [
      {
        path,
        hunkId: "h1",
        enclosingSymbol: symbol,
        symbolKind: "function",
        symbolRange: [1, 3],
        changedLines: [2],
        changedLinesSide: "new",
        signature: `function ${symbol}(total: number, count: number)`,
        source: "tree-sitter",
        confidence: "syntactic"
      }
    ],
    context: { path },
    contextText: "",
    relevantTests: [],
    surroundingContextHints: [],
    labels: [],
    riskNotes: [],
    toolBudget: { maxToolCalls: 1, maxInvestigationRounds: 1, maxResultChars: 4000 }
  };
}

function fakeDiff() {
  return parseDiff(`diff --git a/app.ts b/app.ts
index 1111111..2222222 100644
--- a/app.ts
+++ b/app.ts
@@ -1,2 +1,2 @@
 export function divide(total: number, count: number) {
-  return total / Math.max(1, count);
+  return total / count;
`);
}

function fakeTools(): RepositoryTools {
  const meta = { backend: "text" as const, precision: "exact" as const, degraded: false };
  const tools: RepositoryTools & Pick<RepositoryToolsHost, "bindPackets" | "buildPacketContext" | "withToolCallContext"> = {
    readRange: async () => ({ text: "", meta }),
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
    buildSystemReviewPrompt: ({ task }: { task: SystemReviewTask }) => ({ prompt: JSON.stringify(task), templateVersion: "test", untrustedBlockCount: 0 }),
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

function config(): CodeninjaConfig {
  return {
    ...defaultConfig,
    lenses: { enabled: ["core/code-review"], disabled: [], extraSkillPaths: [] },
    telemetry: { ...defaultConfig.telemetry, enabled: false },
    llm: { provider: "fake", model: "fake-model", maxConcurrentCalls: 1 }
  };
}
