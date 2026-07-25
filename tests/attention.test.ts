import { describe, expect, it } from "vitest";
import { aggregateAttentionEfficiency, buildAttentionRecords } from "../src/pipeline/attention.js";
import { scoreEvalRun } from "../src/evals/eval-scoring.js";
import type {
  AttentionRecord,
  CandidateFinding,
  FinalFinding,
  PacketReviewResult,
  ReviewPacket,
  VerificationVerdict
} from "../src/types.js";

function packet(id: string, coverage: ReviewPacket["coverage"], defaulted = false): ReviewPacket {
  return {
    id,
    path: `src/${id}.ts`,
    coverage,
    hunks: [{
      hunkId: "h1",
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      contentWithLineNumbers: "   1    1 +x",
      lines: [{ kind: "add", content: "x", newLine: 1 }],
      changedNewLineNumbers: [1],
      changedOldLineNumbers: [],
      ...(defaulted ? { plannerFallbackReason: "default_coverage: default review packet used" } : {})
    }]
  } as unknown as ReviewPacket;
}

function candidate(id: string, packetId: string, promoted = false): CandidateFinding {
  return {
    id,
    title: `Candidate ${id}`,
    severity: "medium",
    confidence: "medium",
    path: "src/a.ts",
    changedLine: false,
    category: "correctness",
    evidence: { changedCode: "+x" },
    failureMode: "A concrete failure mode for the attention fixture.",
    whyThisMatters: "matters",
    verification: "test",
    producedBy: { kind: "packet", stage: 7, packetId, lensId: "core/code-review", skillIds: [] },
    ...(promoted ? {
      provenance: {
        source: "uncertainty_promotion" as const,
        sourceKind: "uncertainty" as const,
        sourcePacketId: packetId,
        question: "q",
        files: [],
        symbols: [],
        reason: "r"
      }
    } : {})
  };
}

function packetResult(packetId: string, findings: CandidateFinding[], hints = 0, uncertainties = 0): PacketReviewResult {
  return {
    packetId,
    lenses: ["core/code-review"],
    findings,
    followUpHints: Array.from({ length: hints }, (_v, index) => ({
      question: `hint ${index} for ${packetId}`,
      files: ["src/a.ts"],
      symbols: [],
      suggestedLenses: [],
      reason: "r",
      confidence: "medium" as const,
      projectedSkillIds: []
    })),
    uncertainties: Array.from({ length: uncertainties }, (_v, index) => ({
      question: `uncertainty ${index} for ${packetId}`,
      files: ["src/a.ts"],
      symbols: [],
      projectedSkillIds: []
    })),
    status: "completed"
  };
}

describe("plan 92 layer 1: attention records", () => {
  it("joins allotment with production per packet", () => {
    const deep = packet("packet-deep", "deep");
    const defaulted = packet("packet-default", "normal", true);
    const directA = candidate("a-f1", "packet-deep");
    const directB = candidate("a-e2f1", "packet-deep");
    const promoted = candidate("b-u1-x", "packet-default", true);
    const verdicts: VerificationVerdict[] = [
      { candidateId: "a-f1", verdict: "keep", reason: "r", requiredEvidencePresent: true, falsePositiveRisk: "low" },
      { candidateId: "a-e2f1", verdict: "reject", reason: "r", requiredEvidencePresent: false, falsePositiveRisk: "high" },
      { candidateId: "b-u1-x", verdict: "revise", reason: "r", requiredEvidencePresent: true, falsePositiveRisk: "low" }
    ] as VerificationVerdict[];
    const published = [{
      ...candidate("a-f1", "packet-deep"),
      fingerprint: "fp",
      finalBody: "body",
      publication: "inline",
      mergedCandidateIds: ["a-f1", "b-u1-x"],
      mergedCategories: [],
      mergedSeverities: [],
      mergedPaths: [],
      mergedTitles: []
    }] as unknown as FinalFinding[];

    const records = buildAttentionRecords({
      packets: [deep, defaulted],
      plannedHunkIds: new Set(["h1"]),
      packetResults: [packetResult("packet-deep", [directA, directB], 1, 0), packetResult("packet-default", [], 2, 1)],
      candidateFindings: [directA, directB, promoted],
      verdicts,
      publishedFindings: published,
      ensemblePassesForPacket: (target) => (target.coverage === "deep" ? 3 : 1)
    });

    expect(records).toEqual([
      expect.objectContaining({
        packetId: "packet-deep",
        coverage: "deep",
        coverageSource: "planner",
        ensemblePasses: 3,
        directCandidates: 2,
        promotedCandidates: 0,
        hintsEmitted: 1,
        keptVerified: 1,
        published: 1
      }),
      expect.objectContaining({
        packetId: "packet-default",
        coverage: "normal",
        coverageSource: "deterministic_default",
        ensemblePasses: 1,
        directCandidates: 0,
        promotedCandidates: 1,
        uncertaintiesEmitted: 1,
        keptVerified: 1,
        // credited via mergedCandidateIds membership
        published: 1
      })
    ]);
  });

  it("aggregates attention efficiency by coverage", () => {
    const records: AttentionRecord[] = [
      { packetId: "p1", path: "a", coverage: "deep", coverageSource: "planner", ensemblePasses: 3, directCandidates: 0, promotedCandidates: 0, hintsEmitted: 0, uncertaintiesEmitted: 0, keptVerified: 0, published: 0 },
      { packetId: "p2", path: "b", coverage: "normal", coverageSource: "deterministic_default", ensemblePasses: 1, directCandidates: 1, promotedCandidates: 0, hintsEmitted: 1, uncertaintiesEmitted: 0, keptVerified: 1, published: 1 }
    ];
    expect(aggregateAttentionEfficiency(records)).toEqual({
      byCoverage: {
        deep: { packets: 1, ensembledPackets: 1, directCandidates: 0, hintsEmitted: 0, keptVerified: 0, published: 0 },
        normal: { packets: 1, ensembledPackets: 0, directCandidates: 1, hintsEmitted: 1, keptVerified: 1, published: 1 }
      },
      defaultCoveragePackets: 1
    });
  });

  it("surfaces attention efficiency in eval metrics", () => {
    const score = scoreEvalRun({
      name: "attention-metrics",
      artifacts: { path: "unused" }
    }, {
      candidates: [],
      verification: [],
      finalSelection: [],
      finalFindings: [],
      packets: [],
      hintEvents: [],
      metricsSources: {},
      attention: [
        { packetId: "p1", path: "a", coverage: "deep", coverageSource: "planner", ensemblePasses: 2, directCandidates: 1, promotedCandidates: 0, hintsEmitted: 0, uncertaintiesEmitted: 0, keptVerified: 1, published: 1 }
      ]
    }, "live");

    expect(score.metrics.attentionEfficiency).toEqual({
      byCoverage: {
        deep: { packets: 1, ensembledPackets: 1, directCandidates: 1, hintsEmitted: 0, keptVerified: 1, published: 1 }
      },
      defaultCoveragePackets: 0
    });
  });
});
