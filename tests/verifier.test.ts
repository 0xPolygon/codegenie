import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config/schema.js";
import { parseDiff } from "../src/git/diff-parser.js";
import type { LlmRunner } from "../src/llm/llm-runner.js";
import { verifyFindings } from "../src/pipeline/verifier.js";
import { createPromptBuilder } from "../src/skills/prompt-builder.js";
import type {
  CandidateFinding,
  CodeninjaConfig,
  EvalVerificationRecord,
  PacketReviewResult,
  RepositoryTools,
  RepositoryToolsHost,
  ReviewPacket,
  TelemetryEvent,
  UnifiedDiff
} from "../src/types.js";
import { scoreEvalRun } from "../src/evals/eval-scoring.js";
import { nullTelemetry } from "./helpers/git.js";

describe("stage 9 evidence-aware verification", () => {
  it("schedules evidence-backed low-confidence correctness candidates for verification", async () => {
    const fixture = reviewFixture(["src/app.ts"]);
    const finding = candidate("low-evidence", fixture.packets[0]!, {
      confidence: "low",
      severity: "medium",
      category: "correctness",
      evidence: {
        changedCode: "+ return route(provider)",
        relatedCode: [{
          path: "src/caller.ts",
          lines: "42: route(preferredProvider)",
          whyRelevant: "The caller supplies the preference affected by this behavior change."
        }]
      },
      failureMode: "The changed branch can skip the caller's explicit provider preference when fallback routing is needed."
    });
    const telemetry = captureTelemetry();
    let calls = 0;

    const result = await verifyFindings(
      { packetResults: [packetResult(fixture.packets[0]!.id, [finding])], packets: fixture.packets },
      fakeTools(),
      config(),
      telemetry.recorder,
      {
        runner: verifierRunner(() => {
          calls += 1;
          return {
            verdict: "keep",
            reason: "The related caller evidence confirms the changed branch is reachable.",
            requiredEvidencePresent: true,
            falsePositiveRisk: "low"
          };
        }),
        promptBuilder: createPromptBuilder(fakeLensRegistry()),
        lensRegistry: fakeLensRegistry(),
        diff: fixture.diff
      }
    );

    expect(calls).toBe(1);
    expect(result.verified).toHaveLength(1);
    expect(result.verified[0]?.id).toBe("low-evidence");
    expect(telemetry.artifacts.get("verification.json")).toEqual([
      expect.objectContaining({
        candidateId: "low-evidence",
        gate: "passed",
        gateDecision: "scheduled_for_evidence_resolution",
        gateReason: "low_confidence_evidence_backed",
        verificationLane: "evidence_resolution",
        verdict: expect.objectContaining({ verdict: "keep" })
      })
    ]);
    expect(telemetry.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stage: 9,
        message: "pipeline_metrics",
        data: expect.objectContaining({
          candidates: expect.objectContaining({
            lowConfidenceEvidenceEligible: 1,
            lowConfidenceEvidenceScheduled: 1,
            lowConfidenceEvidenceKept: 1
          })
        })
      })
    ]));
  });

  it("keeps weak low-confidence candidates suppressed before verification", async () => {
    const fixture = reviewFixture(["src/app.ts"]);
    const finding = candidate("low-weak", fixture.packets[0]!, {
      confidence: "low",
      severity: "medium",
      category: "correctness"
    });
    const telemetry = captureTelemetry();
    let calls = 0;

    const result = await verifyFindings(
      { packetResults: [packetResult(fixture.packets[0]!.id, [finding])], packets: fixture.packets },
      fakeTools(),
      config(),
      telemetry.recorder,
      {
        runner: verifierRunner(() => {
          calls += 1;
          return {
            verdict: "keep",
            reason: "should not run",
            requiredEvidencePresent: true,
            falsePositiveRisk: "low"
          };
        }),
        promptBuilder: createPromptBuilder(fakeLensRegistry()),
        lensRegistry: fakeLensRegistry(),
        diff: fixture.diff
      }
    );

    expect(calls).toBe(0);
    expect(result.verified).toEqual([]);
    expect(result.gateRejections).toBe(1);
    expect(telemetry.artifacts.get("verification.json")).toEqual([
      expect.objectContaining({
        candidateId: "low-weak",
        gate: "suppressed",
        gateDecision: "suppressed",
        gateReason: "low_confidence_no_related_evidence"
      })
    ]);
  });

  it("caps the evidence-resolution lane and records unscheduled candidates", async () => {
    const paths = Array.from({ length: 5 }, (_value, index) => `src/case-${index}.ts`);
    const fixture = reviewFixture(paths);
    const findings = fixture.packets.map((packet, index) => candidate(`low-evidence-${index}`, packet, {
      confidence: "low",
      severity: "medium",
      category: "logic_bug",
      evidence: {
        changedCode: `+ return route${index}(provider)`,
        relatedCode: [{
          path: `src/caller-${index}.ts`,
          lines: `${index + 10}: route${index}(preferredProvider)`,
          whyRelevant: "The caller reaches this changed behavior."
        }]
      },
      failureMode: `The changed branch for case ${index} can now skip required fallback handling for callers.`
    }));
    const telemetry = captureTelemetry();
    let calls = 0;

    await verifyFindings(
      { packetResults: findings.map((finding) => packetResult(finding.producedBy.packetId, [finding])), packets: fixture.packets },
      fakeTools(),
      config(),
      telemetry.recorder,
      {
        runner: verifierRunner(() => {
          calls += 1;
          return {
            verdict: "reject",
            reason: "Evidence predicate unresolved.",
            requiredEvidencePresent: false,
            falsePositiveRisk: "medium"
          };
        }),
        promptBuilder: createPromptBuilder(fakeLensRegistry()),
        lensRegistry: fakeLensRegistry(),
        diff: fixture.diff
      }
    );

    const records = telemetry.artifacts.get("verification.json") as EvalVerificationRecord[];
    expect(calls).toBe(4);
    expect(records.filter((record) => "verdict" in record)).toHaveLength(4);
    expect(records.filter((record) =>
      !("verdict" in record) &&
      record.gateDecision === "scheduled_for_evidence_resolution" &&
      record.gateReason === "low_confidence_evidence_resolution_lane_limit"
    )).toHaveLength(1);
    expect(telemetry.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stage: 9,
        message: "pipeline_metrics",
        data: expect.objectContaining({
          candidates: expect.objectContaining({
            lowConfidenceEvidenceEligible: 5,
            lowConfidenceEvidenceScheduled: 4,
            lowConfidenceEvidenceLaneLimited: 1,
            lowConfidenceEvidenceRejected: 4
          })
        })
      })
    ]));
  });

  it("keeps promoted uncertainty provenance in verification records and metrics", async () => {
    const fixture = reviewFixture(["src/app.ts"]);
    const finding = candidate("promoted-uncertainty", fixture.packets[0]!, {
      confidence: "low",
      evidence: {
        changedCode: "+ return route(provider)",
        relatedCode: [{
          path: "src/app.ts",
          lines: "function changed0(provider: string)",
          whyRelevant: "Changed symbol attached to the promoted uncertainty."
        }]
      },
      provenance: {
        source: "uncertainty_promotion",
        sourceKind: "uncertainty",
        sourcePacketId: fixture.packets[0]!.id,
        question: "Verify fallback behavior still preserves caller contract",
        files: ["src/app.ts"],
        symbols: ["changed0"],
        reason: "packet reviewer reported an unresolved uncertainty"
      }
    });
    const telemetry = captureTelemetry();

    await verifyFindings(
      { packetResults: [packetResult(fixture.packets[0]!.id, [finding])], packets: fixture.packets },
      fakeTools(),
      config(),
      telemetry.recorder,
      {
        runner: verifierRunner(() => ({
          verdict: "keep",
          reason: "The verifier confirmed the promoted predicate.",
          requiredEvidencePresent: true,
          falsePositiveRisk: "low"
        })),
        promptBuilder: createPromptBuilder(fakeLensRegistry()),
        lensRegistry: fakeLensRegistry(),
        diff: fixture.diff
      }
    );

    expect(telemetry.artifacts.get("verification.json")).toEqual([
      expect.objectContaining({
        candidateId: "promoted-uncertainty",
        candidateProvenance: expect.objectContaining({
          source: "uncertainty_promotion",
          sourceKind: "uncertainty",
          sourcePacketId: fixture.packets[0]!.id
        }),
        verdict: expect.objectContaining({ verdict: "keep" })
      })
    ]);
    expect(telemetry.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stage: 9,
        message: "pipeline_metrics",
        data: expect.objectContaining({
          candidates: expect.objectContaining({
            promotedCandidates: 1,
            promotedVerificationScheduled: 1,
            promotedVerificationKept: 1
          })
        })
      })
    ]));
  });

  it("rejects keep verdicts that report required evidence is missing", async () => {
    const fixture = reviewFixture(["src/app.ts"]);
    const finding = candidate("missing-evidence-keep", fixture.packets[0]!);
    const telemetry = captureTelemetry();

    const result = await verifyFindings(
      { packetResults: [packetResult(fixture.packets[0]!.id, [finding])], packets: fixture.packets },
      fakeTools(),
      config(),
      telemetry.recorder,
      {
        runner: verifierRunner(() => ({
          verdict: "keep",
          reason: "The helper source was unavailable, so this could not be confirmed.",
          requiredEvidencePresent: false,
          falsePositiveRisk: "medium"
        })),
        promptBuilder: createPromptBuilder(fakeLensRegistry()),
        lensRegistry: fakeLensRegistry(),
        diff: fixture.diff
      }
    );

    expect(result.verified).toEqual([]);
    expect(telemetry.artifacts.get("verification.json")).toEqual([
      expect.objectContaining({
        candidateId: "missing-evidence-keep",
        verdict: expect.objectContaining({
          verdict: "reject",
          requiredEvidencePresent: false,
          falsePositiveRisk: "high",
          reason: expect.stringContaining("required evidence missing")
        })
      })
    ]);
    expect(telemetry.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stage: 9,
        message: "verification_missing_evidence_normalized_to_reject",
        data: expect.objectContaining({
          candidateId: "missing-evidence-keep",
          originalVerdict: "keep"
        })
      })
    ]));
  });
});

describe("stage 9 eval diagnostics and prompts", () => {
  it("separates low-confidence pre-gate suppression from evidence lane limits", () => {
    const suppressed = candidate("low-suppressed", fakePacket("packet-1", "src/app.ts"), {
      confidence: "low"
    });
    const laneLimited = candidate("lane-limited", fakePacket("packet-2", "src/other.ts"), {
      confidence: "low",
      evidence: {
        changedCode: "+ return other()",
        relatedCode: [{ path: "src/caller.ts", lines: "10: other()", whyRelevant: "Caller reaches this code." }]
      }
    });

    const score = scoreEvalRun({
      name: "loss-labels",
      artifacts: { path: "unused" },
      should_find: [
        { id: "suppressed", path: "src/app.ts" },
        { id: "lane", path: "src/other.ts" }
      ]
    }, {
      candidates: [suppressed, laneLimited],
      verification: [
        { candidateId: "low-suppressed", gate: "suppressed", gateReason: "low_confidence_no_related_evidence" },
        { candidateId: "lane-limited", gate: "suppressed", gateReason: "low_confidence_evidence_resolution_lane_limit", verificationLane: "evidence_resolution" }
      ],
      finalSelection: [],
      finalFindings: [],
      packets: [],
      hintEvents: [],
      metricsSources: {}
    }, "live");

    expect(score.expectationResults.map((result) => result.loss?.subReason)).toEqual([
      "low-confidence-pre-gate-suppressed",
      "evidence-resolution-lane-limit"
    ]);
  });

  it("includes confidence calibration and same-PR-test guidance in prompts", () => {
    const packet = fakePacket("packet-1", "src/app.ts");
    const finding = candidate("candidate-1", packet);
    const promptBuilder = createPromptBuilder(fakeLensRegistry());

    const packetPrompt = promptBuilder.buildPacketReviewPrompt({ packet, skills: [] }).prompt;
    const verifierPrompt = promptBuilder.buildVerifierPrompt({
      candidate: finding,
      originContext: "",
      hunksText: packet.hunks[0]!.contentWithLineNumbers,
      skills: []
    }).prompt;

    expect(packetPrompt).toContain("do not mark a changed-line correctness/security finding low confidence solely");
    expect(packetPrompt).toContain("verifier-resolvable predicate remains");
    expect(verifierPrompt).toContain("Same-PR tests that assert new behavior prove the behavior changed");
    expect(verifierPrompt).toContain("refactor, cleanup, consolidation, behavior-preserving");
    expect(verifierPrompt).toContain("cite the exact helper/callee branch that proves the failure mode");
    expect(verifierPrompt).toContain("For category:\"testing\" candidates, production code does not need to change");
    expect(verifierPrompt).toContain("old/base tests covered a named behavior boundary");
    expect(verifierPrompt).toContain("reject generic add-more-tests comments");
    expect(verifierPrompt).toContain("verify the concrete predicate preserved in provenance");
    expect(verifierPrompt).toContain("Commit titles, PR text, and intent signals are context, not proof");
  });
});

function reviewFixture(paths: string[]): { diff: UnifiedDiff; packets: ReviewPacket[] } {
  const rawDiff = paths.map((filePath, index) => `diff --git a/${filePath} b/${filePath}
index 1111111..2222222 100644
--- a/${filePath}
+++ b/${filePath}
@@ -1,3 +1,3 @@
 export function changed${index}(provider: string) {
-  return previous(provider);
+  return route${index}(provider);
 }
`).join("");
  const diff = parseDiff(rawDiff);
  return {
    diff,
    packets: diff.files.map((file, index) => {
      const hunk = file.hunks[0];
      if (!hunk) {
        throw new Error(`missing hunk for ${file.path}`);
      }
      return fakePacket(`packet-${index}`, file.path, hunk.id, `changed${index}`);
    })
  };
}

function fakePacket(packetId: string, filePath: string, hunkId = "h1", symbol = "changed"): ReviewPacket {
  return {
    id: packetId,
    kind: "hunk",
    prSummary: "test",
    path: filePath,
    fileStatus: "modified",
    isDeletedContent: false,
    language: "typescript",
    reviewPriority: "normal",
    coverage: "normal",
    reviewProfile: "standard",
    lenses: ["core/code-review"],
    hunks: [
      {
        hunkId,
        oldStart: 1,
        oldLines: 3,
        newStart: 1,
        newLines: 3,
        contentWithLineNumbers: `   1    1  export function ${symbol}(provider: string) {\n   2    2 +  return route(provider);\n   3    3  }\n`,
        lines: [
          { kind: "context", content: `export function ${symbol}(provider: string) {`, oldLine: 1, newLine: 1 },
          { kind: "add", content: "return route(provider);", newLine: 2 },
          { kind: "context", content: "}", oldLine: 3, newLine: 3 }
        ],
        changedNewLineNumbers: [2],
        changedOldLineNumbers: []
      }
    ],
    symbolFacts: [
      {
        path: filePath,
        hunkId,
        enclosingSymbol: symbol,
        symbolKind: "function",
        symbolRange: [1, 3],
        changedLines: [2],
        changedLinesSide: "new",
        signature: `function ${symbol}(provider: string)`,
        source: "tree-sitter",
        confidence: "syntactic"
      }
    ],
    context: { path: filePath },
    contextText: "",
    relevantTests: [],
    surroundingContextHints: [],
    labels: [],
    attentionNotes: [],
    relatedChangedContext: [],
    toolBudget: { maxToolCalls: 1, maxInvestigationRounds: 1, maxResultChars: 4000 }
  };
}

function packetResult(packetId: string, findings: CandidateFinding[]): PacketReviewResult {
  return {
    packetId,
    lenses: ["core/code-review"],
    findings,
    followUpHints: [],
    uncertainties: [],
    status: "completed"
  };
}

function candidate(id: string, packet: ReviewPacket, overrides: Partial<CandidateFinding> = {}): CandidateFinding {
  const hunk = packet.hunks[0];
  if (!hunk) {
    throw new Error("expected packet hunk");
  }
  return {
    id,
    title: `Candidate ${id}`,
    severity: "medium",
    confidence: "high",
    path: packet.path,
    anchor: { path: packet.path, line: 2, side: "RIGHT", hunkId: hunk.hunkId },
    changedLine: true,
    category: "correctness",
    evidence: { changedCode: "+ return route(provider);" },
    failureMode: "The changed branch can return a different route for an existing caller-visible condition.",
    whyThisMatters: "Callers can receive a route that violates the previous contract.",
    verification: "The candidate is based on the changed line.",
    producedBy: { kind: "packet", stage: 7, packetId: packet.id, lensId: "core/code-review", skillIds: [] },
    ...overrides
  };
}

function verifierRunner(result: () => Record<string, unknown>): LlmRunner {
  return {
    runStructured: async <T>() => result() as T
  };
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
    llm: { provider: "fake", model: "fake-model", maxConcurrentCalls: 1 },
    review: { ...defaultConfig.review, concurrency: 1 }
  };
}

function captureTelemetry(): {
  events: Array<Omit<TelemetryEvent, "runId" | "eventId" | "timestamp">>;
  artifacts: Map<string, unknown>;
  recorder: ReturnType<typeof nullTelemetry>;
} {
  const events: Array<Omit<TelemetryEvent, "runId" | "eventId" | "timestamp">> = [];
  const artifacts = new Map<string, unknown>();
  return {
    events,
    artifacts,
    recorder: {
      ...nullTelemetry(),
      event: (event) => {
        events.push(event);
      },
      writeArtifact: async (relPath, data) => {
        artifacts.set(relPath, data);
      }
    }
  };
}
