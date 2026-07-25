import { describe, expect, it } from "vitest";
import {
  buildHumanAttentionNotes,
  buildVerificationResolutionIndex,
  suppressAttentionGroupsResolvedByVerification
} from "../src/pipeline/human-attention.js";
import type {
  CandidateFinding,
  PacketReviewResult,
  ReviewPacket,
  RunCoverageStatus,
  VerificationVerdict
} from "../src/types.js";
import { nullTelemetry } from "./helpers/git.js";

const QUESTION = "Does the changed LiFi parser still tolerate malformed provider numeric fields?";

function packet(): ReviewPacket {
  return {
    id: "packet-lifi",
    path: "lib/lifi/parser.go",
    coverage: "normal",
    reviewPriority: "normal",
    reviewProfile: "standard",
    lenses: ["core/code-review"],
    hunks: [{
      hunkId: "h1",
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      contentWithLineNumbers: "",
      lines: [{ kind: "add", content: "strictParse(value)", newLine: 1 }],
      changedNewLineNumbers: [1],
      changedOldLineNumbers: []
    }],
    symbolFacts: [],
    relevantTests: [],
    relatedChangedContext: [],
    surroundingContextHints: [],
    context: { path: "lib/lifi/parser.go" }
  } as unknown as ReviewPacket;
}

function packetResultWithHint(): PacketReviewResult {
  return {
    packetId: "packet-lifi",
    lenses: ["core/code-review"],
    findings: [],
    followUpHints: [{
      question: QUESTION,
      files: ["lib/lifi/parser.go"],
      symbols: ["strictParse"],
      suggestedLenses: [],
      reason: "The changed parser hard-fails on malformed numerics that were previously tolerated.",
      confidence: "medium",
      projectedSkillIds: ["core/code-review"]
    }],
    uncertainties: [],
    status: "completed"
  };
}

function promotedCandidate(): CandidateFinding {
  return {
    id: "packet-l-u1-abc",
    title: QUESTION,
    severity: "medium",
    confidence: "low",
    path: "lib/lifi/parser.go",
    changedLine: false,
    category: "correctness",
    evidence: { changedCode: "strictParse(value)" },
    failureMode: `${QUESTION} — if this predicate holds, callers see hard errors.`,
    whyThisMatters: "matters",
    verification: "Promoted from follow_up_hint; normal verifier must confirm.",
    producedBy: { kind: "packet", stage: 9, packetId: "packet-lifi", lensId: "core/code-review", skillIds: [] },
    provenance: {
      source: "uncertainty_promotion",
      sourceKind: "follow_up_hint",
      sourcePacketId: "packet-lifi",
      question: QUESTION,
      files: ["lib/lifi/parser.go"],
      symbols: ["strictParse"],
      reason: "promoted unresolved predicate"
    }
  };
}

function rejectVerdict(falsePositiveRisk: "high" | "medium"): VerificationVerdict {
  return {
    candidateId: "packet-l-u1-abc",
    verdict: "reject",
    reason: "Stricter parsing is documented hardening; the fallback path is preserved.",
    requiredEvidencePresent: false,
    falsePositiveRisk
  } as VerificationVerdict;
}

const coverage = { verificationSkipped: false } as unknown as RunCoverageStatus;

function groupsForHint() {
  const attention = buildHumanAttentionNotes([packetResultWithHint()], {
    packets: [packet()],
    telemetry: nullTelemetry()
  });
  expect(attention.groups.length).toBeGreaterThan(0);
  return attention.groups;
}

describe("plan 75 step 1: adjudicated-reject note suppression", () => {
  it("suppresses the exact source note when a promoted candidate is confidently rejected", () => {
    const resolutions = buildVerificationResolutionIndex(
      [rejectVerdict("high")],
      [{ ...packetResultWithHint(), findings: [promotedCandidate()] }],
      [],
      new Map([["packet-lifi", packet()]]),
      coverage
    );
    expect(resolutions).toHaveLength(1);
    expect(resolutions[0]?.source).toBe("stage9_adjudicated_reject");

    const { available, suppressed } = suppressAttentionGroupsResolvedByVerification(groupsForHint(), resolutions);
    expect(available).toHaveLength(0);
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0]?.reason).toBe("adjudicated by stage 9 reject verdict for packet-l-u1-abc");
    expect(suppressed[0]?.match.provenanceMatched).toBe(true);
  });

  it("leaves the note visible when the reject is uncertain (falsePositiveRisk not high)", () => {
    const resolutions = buildVerificationResolutionIndex(
      [rejectVerdict("medium")],
      [{ ...packetResultWithHint(), findings: [promotedCandidate()] }],
      [],
      new Map([["packet-lifi", packet()]]),
      coverage
    );
    // requiredEvidencePresent=false and risk below high: no resolution at all.
    expect(resolutions).toHaveLength(0);
    const { available, suppressed } = suppressAttentionGroupsResolvedByVerification(groupsForHint(), resolutions);
    expect(available).toHaveLength(1);
    expect(suppressed).toHaveLength(0);
  });

  it("never fuzzy-matches adjudicated rejects onto unrelated notes", () => {
    const unrelated = promotedCandidate();
    unrelated.provenance = {
      ...unrelated.provenance!,
      question: "Is the retry backoff in the unrelated queue path still bounded?",
      files: ["lib/queue/backoff.go"],
      symbols: ["nextBackoff"]
    };
    const resolutions = buildVerificationResolutionIndex(
      [rejectVerdict("high")],
      [{ ...packetResultWithHint(), findings: [unrelated] }],
      [],
      new Map([["packet-lifi", packet()]]),
      coverage
    );
    expect(resolutions).toHaveLength(1);
    expect(resolutions[0]?.source).toBe("stage9_adjudicated_reject");
    const { available, suppressed } = suppressAttentionGroupsResolvedByVerification(groupsForHint(), resolutions);
    // Provenance does not match the note group: no fuzzy fallthrough allowed.
    expect(available).toHaveLength(1);
    expect(suppressed).toHaveLength(0);
  });
});
