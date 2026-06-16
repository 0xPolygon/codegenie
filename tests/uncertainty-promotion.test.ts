import { describe, expect, it } from "vitest";
import { promoteUncertaintiesForVerification } from "../src/pipeline/uncertainty-promotion.js";
import type { PacketReviewResult, ReviewPacket } from "../src/types.js";
import type { TelemetryRecorder } from "../src/telemetry/telemetry-recorder.js";

describe("uncertainty promotion", () => {
  it("promotes concrete changed-test coverage uncertainty into a verifier candidate", async () => {
    const packet = fakePacket("packet-coverage", "tests/billing.test.ts", {
      symbol: "TestBillingRetries",
      line: "+ expect(fetchBalance()).toEqual(0)"
    });
    const telemetry = captureTelemetry();

    const result = await promoteUncertaintiesForVerification({
      packets: [packet],
      packetResults: [{
        packetId: packet.id,
        lenses: ["core/tests"],
        findings: [],
        followUpHints: [],
        uncertainties: [{
          question: "Verify deleted coverage still exercises BalanceReader through the production billing path",
          files: ["tests/billing.test.ts", "src/billing.ts"],
          symbols: ["BalanceReader"]
        }],
        status: "completed"
      }]
    }, telemetry.recorder);

    expect(result.summary).toMatchObject({
      considered: 1,
      promoted: 1,
      laneLimited: 0,
      promotedCandidateIds: [expect.stringMatching(/^packet-c-u1-/u)]
    });
    const promoted = result.packetResults[0]?.findings[0];
    expect(promoted).toMatchObject({
      category: "testing",
      confidence: "medium",
      changedLine: true,
      producedBy: { stage: 9, packetId: packet.id, lensId: "core/tests" },
      provenance: {
        source: "uncertainty_promotion",
        sourceKind: "uncertainty",
        sourcePacketId: packet.id,
        files: ["src/billing.ts", "tests/billing.test.ts"],
        symbols: ["BalanceReader"]
      }
    });
    expect(promoted?.evidence.changedCode).toContain("fetchBalance");
    expect(telemetry.artifacts.get("uncertainty-promotion.json")).toMatchObject({
      promoted: 1,
      decisions: [expect.objectContaining({ promoted: true, reason: "promoted_for_verification" })]
    });
    expect(telemetry.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stage: 9,
        message: "uncertainty_promotion",
        data: expect.objectContaining({ considered: 1, promoted: 1 })
      })
    ]));
  });

  it("keeps promotion bounded and explains dropped sources", async () => {
    const packets = Array.from({ length: 6 }, (_value, index) =>
      fakePacket(`packet-${index}`, `src/case-${index}.ts`, {
        symbol: `changed${index}`,
        line: `+ return fallback${index}(value)`
      })
    );
    const packetResults: PacketReviewResult[] = packets.map((packet, index) => ({
      packetId: packet.id,
      lenses: ["core/code-review"],
      findings: [],
      followUpHints: [{
        question: `Verify fallback behavior for changed${index} still preserves caller contract`,
        files: [packet.path],
        symbols: [`changed${index}`],
        suggestedLenses: ["core/code-review"],
        reason: "The changed fallback path may alter caller-visible behavior.",
        confidence: "high"
      }],
      uncertainties: index === 0
        ? [{ question: "Check this maybe", files: [], symbols: [] }]
        : [],
      status: "completed"
    }));
    const telemetry = captureTelemetry();

    const result = await promoteUncertaintiesForVerification({ packets, packetResults }, telemetry.recorder);

    expect(result.summary.considered).toBe(7);
    expect(result.summary.promoted).toBe(2);
    expect(result.summary.laneLimited).toBe(4);
    expect(result.summary.notPromoted).toMatchObject({ no_concrete_file_or_symbol: 1 });
    expect(result.packetResults.flatMap((item) => item.findings)).toHaveLength(2);
    expect(result.summary.decisions.filter((decision) => decision.reason === "promotion_lane_limited")).toHaveLength(4);
  });

  it("does not promote same-scope follow-ups when the packet already produced a finding", async () => {
    const packet = fakePacket("packet-existing", "src/divide.ts", {
      symbol: "divide",
      line: "+ return total / count"
    });
    const result = await promoteUncertaintiesForVerification({
      packets: [packet],
      packetResults: [{
        packetId: packet.id,
        lenses: ["core/code-review"],
        findings: [{
          id: "existing",
          title: "Division guard removed",
          severity: "high",
          confidence: "high",
          path: packet.path,
          anchor: { path: packet.path, line: 2, side: "RIGHT", hunkId: "h1" },
          changedLine: true,
          category: "correctness",
          evidence: { changedCode: "+ return total / count" },
          failureMode: "Calling divide with count zero now returns an invalid numeric result.",
          whyThisMatters: "Callers can propagate invalid values.",
          verification: "The changed hunk removes the guard.",
          producedBy: { kind: "packet", stage: 7, packetId: packet.id, lensId: "core/code-review", skillIds: [] }
        }],
        followUpHints: [{
          question: "Check whether callers can pass zero count.",
          files: ["src/divide.ts"],
          symbols: ["divide"],
          suggestedLenses: ["core/code-review"],
          reason: "The changed function now divides by count directly.",
          confidence: "medium"
        }],
        uncertainties: [],
        status: "completed"
      }]
    }, captureTelemetry().recorder);

    expect(result.packetResults[0]?.findings).toHaveLength(1);
    expect(result.summary).toMatchObject({
      considered: 1,
      promoted: 0,
      notPromoted: { covered_by_existing_candidate: 1 }
    });
  });

  it("does not promote broad follow-ups without a concrete failure predicate", async () => {
    const packet = fakePacket("packet-broad", "src/charge.ts", {
      symbol: "charge",
      line: "+ return calculateCharge(input)"
    });
    const result = await promoteUncertaintiesForVerification({
      packets: [packet],
      packetResults: [{
        packetId: packet.id,
        lenses: ["core/code-review"],
        findings: [],
        followUpHints: [{
          question: "Verify this looks safe overall.",
          files: [packet.path],
          symbols: ["charge"],
          suggestedLenses: ["core/code-review"],
          reason: "General safety concern without a concrete failure mode.",
          confidence: "high"
        }],
        uncertainties: [],
        status: "completed"
      }]
    }, captureTelemetry().recorder);

    expect(result.packetResults[0]?.findings).toEqual([]);
    expect(result.summary).toMatchObject({
      considered: 1,
      promoted: 0,
      notPromoted: { broad_follow_up_only: 1 }
    });
  });

  it("promotes low-confidence concrete behavior-delta hints for verifier adjudication", async () => {
    const packet = fakePacket("packet-refactor", "src/routing.ts", {
      symbol: "routeWithFallback",
      line: "+ return routeStrictFallback(request)"
    });
    packet.intentSignals = {
      refactorLike: true,
      behaviorChangeLike: false,
      explicitlyBehaviorPreserving: true,
      signals: [],
      summary: "refactor-like behavior-preserving change"
    };

    const result = await promoteUncertaintiesForVerification({
      packets: [packet],
      packetResults: [{
        packetId: packet.id,
        lenses: ["core/code-review"],
        findings: [],
        followUpHints: [{
          question: "Verify whether routeWithFallback now rejects explicit fallback requests that previously used the default provider.",
          files: ["src/routing.ts"],
          symbols: ["routeWithFallback"],
          suggestedLenses: ["core/code-review"],
          reason: "This behavior-preserving refactor changes a fallback contract boundary.",
          confidence: "low"
        }],
        uncertainties: [],
        status: "completed"
      }]
    }, captureTelemetry().recorder);

    expect(result.summary).toMatchObject({
      considered: 1,
      promoted: 1,
      notPromoted: {}
    });
    expect(result.packetResults[0]?.findings[0]).toMatchObject({
      category: "correctness",
      provenance: {
        sourceKind: "follow_up_hint",
        sourcePacketId: packet.id
      }
    });
  });

  it("still suppresses low-confidence broad hints that lack a behavior-delta predicate", async () => {
    const packet = fakePacket("packet-low-broad", "src/routing.ts", {
      symbol: "route",
      line: "+ return route(request)"
    });

    const result = await promoteUncertaintiesForVerification({
      packets: [packet],
      packetResults: [{
        packetId: packet.id,
        lenses: ["core/code-review"],
        findings: [],
        followUpHints: [{
          question: "Check whether this routing change is okay.",
          files: ["src/routing.ts"],
          symbols: ["route"],
          suggestedLenses: ["core/code-review"],
          reason: "General low-confidence concern.",
          confidence: "low"
        }],
        uncertainties: [],
        status: "completed"
      }]
    }, captureTelemetry().recorder);

    expect(result.packetResults[0]?.findings).toEqual([]);
    expect(result.summary).toMatchObject({
      considered: 1,
      promoted: 0,
      notPromoted: { low_confidence_hint: 1 }
    });
  });

  it("reserves a promotion lane for concrete behavior deltas", async () => {
    const packets = Array.from({ length: 6 }, (_value, index) =>
      fakePacket(`packet-lane-${index}`, `src/case-${index}.ts`, {
        symbol: `changed${index}`,
        line: `+ return changed${index}(value)`
      })
    );
    packets[5]!.intentSignals = {
      refactorLike: true,
      behaviorChangeLike: false,
      explicitlyBehaviorPreserving: true,
      signals: [],
      summary: "refactor-like behavior-preserving change"
    };
    const packetResults: PacketReviewResult[] = packets.map((packet, index) => ({
      packetId: packet.id,
      lenses: ["core/code-review"],
      findings: [],
      followUpHints: [{
        question: index === 5
          ? "Verify whether changed5 now rejects zero values that previously used the default fallback."
          : `Verify whether changed${index} allows tenant access when the token is missing.`,
        files: [packet.path],
        symbols: [`changed${index}`],
        suggestedLenses: ["core/code-review"],
        reason: index === 5
          ? "This behavior-preserving refactor changes a fallback boundary."
          : "The authorization path can affect production callers.",
        confidence: index === 5 ? "low" : "high"
      }],
      uncertainties: [],
      status: "completed"
    }));

    const result = await promoteUncertaintiesForVerification({ packets, packetResults }, captureTelemetry().recorder);

    expect(result.summary.promoted).toBe(2);
    expect(result.summary.laneLimited).toBe(4);
    expect(result.packetResults.find((item) => item.packetId === "packet-lane-5")?.findings).toHaveLength(1);
  });

  it("promotes concrete unresolved closeout questions from incomplete packet reviews", async () => {
    const packet = fakePacket("packet-unresolved", "src/fees.ts", {
      symbol: "AmountFromUSD",
      line: "+ return amount / decimals"
    });

    const result = await promoteUncertaintiesForVerification({
      packets: [packet],
      packetResults: [{
        packetId: packet.id,
        lenses: ["core/code-review"],
        findings: [],
        reviewStatus: "incomplete",
        noFindingReason: "Tool budget ended before this predicate was fully proven.",
        unresolvedQuestions: ["Whether AmountFromUSD handles zero decimals without divide-by-zero or incorrect rounding."],
        followUpHints: [],
        uncertainties: [],
        status: "incomplete"
      }]
    }, captureTelemetry().recorder);

    expect(result.summary).toMatchObject({
      considered: 1,
      promoted: 1
    });
    expect(result.packetResults[0]?.findings[0]).toMatchObject({
      category: "correctness",
      provenance: {
        sourceKind: "unresolved_question",
        question: "Whether AmountFromUSD handles zero decimals without divide-by-zero or incorrect rounding.",
        files: ["src/fees.ts"],
        symbols: ["AmountFromUSD"]
      }
    });
  });

  it("does not reject non-test correctness uncertainty through the test coverage lane", async () => {
    const packet = fakePacket("packet-routing", "src/routing.ts", {
      symbol: "SolveQuoteRoutingWithFallbacks",
      line: "+ return fallbackProvider(intent)"
    });

    const result = await promoteUncertaintiesForVerification({
      packets: [packet],
      packetResults: [{
        packetId: packet.id,
        lenses: ["core/code-review"],
        findings: [],
        followUpHints: [],
        uncertainties: [{
          question: "Verify whether this fallback contract still preserves caller behavior when the preferred provider fails in tests.",
          files: ["src/routing.ts"],
          symbols: ["SolveQuoteRoutingWithFallbacks"]
        }],
        status: "completed"
      }]
    }, captureTelemetry().recorder);

    expect(result.summary.decisions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        promoted: true,
        reason: "promoted_for_verification"
      })
    ]));
    expect(result.summary.notPromoted).not.toHaveProperty("test_risk_without_changed_test_or_deleted_coverage");
    expect(result.packetResults[0]?.findings[0]).toMatchObject({
      category: "correctness",
      provenance: { sourceKind: "uncertainty" }
    });
  });
});

function fakePacket(
  id: string,
  filePath: string,
  opts: { symbol: string; line: string }
): ReviewPacket {
  return {
    id,
    kind: "hunk",
    prSummary: "test",
    path: filePath,
    fileStatus: "modified",
    isDeletedContent: false,
    language: "typescript",
    reviewPriority: "normal",
    coverage: "normal",
    reviewProfile: "standard",
    lenses: filePath.includes("test") ? ["core/tests"] : ["core/code-review"],
    hunks: [{
      hunkId: "h1",
      oldStart: 1,
      oldLines: 3,
      newStart: 1,
      newLines: 3,
      contentWithLineNumbers: `   1    1  export function ${opts.symbol}(value: number) {\n   2    2 ${opts.line}\n   3    3  }\n`,
      lines: [
        { kind: "context", content: `export function ${opts.symbol}(value: number) {`, oldLine: 1, newLine: 1 },
        { kind: "add", content: opts.line.replace(/^\+\s*/u, ""), newLine: 2 },
        { kind: "context", content: "}", oldLine: 3, newLine: 3 }
      ],
      changedNewLineNumbers: [2],
      changedOldLineNumbers: []
    }],
    symbolFacts: [{
      path: filePath,
      hunkId: "h1",
      enclosingSymbol: opts.symbol,
      symbolKind: "function",
      symbolRange: [1, 3],
      changedLines: [2],
      changedLinesSide: "new",
      signature: `function ${opts.symbol}(value: number)`,
      source: "tree-sitter",
      confidence: "syntactic"
    }],
    context: { path: filePath },
    contextText: "",
    relevantTests: [],
    surroundingContextHints: [],
    labels: [],
    riskNotes: [],
    toolBudget: { maxToolCalls: 1, maxInvestigationRounds: 1, maxResultChars: 4000 }
  };
}

function captureTelemetry(): {
  events: Array<Parameters<TelemetryRecorder["event"]>[0]>;
  artifacts: Map<string, unknown>;
  recorder: TelemetryRecorder;
} {
  const events: Array<Parameters<TelemetryRecorder["event"]>[0]> = [];
  const artifacts = new Map<string, unknown>();
  return {
    events,
    artifacts,
    recorder: {
      runId: "test-run",
      runDir: undefined,
      event: (event) => events.push(event),
      recordModelCall: () => undefined,
      recordToolCall: () => "tc-test",
      writeArtifact: async (name, value) => {
        artifacts.set(name, value);
      },
      writeDebug: async () => undefined,
      flush: async () => undefined
    }
  };
}
