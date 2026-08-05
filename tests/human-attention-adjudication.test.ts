import { describe, expect, it } from "vitest";
import {
  type AttentionHintGroup,
  buildHumanAttentionNotes,
  buildVerificationResolutionIndex,
  selectHumanAttentionForOutput,
  type VerificationResolution,
  suppressAttentionGroupsResolvedByVerification
} from "../src/pipeline/human-attention.js";
import type {
  CandidateFinding,
  FinalFinding,
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

describe("plan 110 publication-aware note fallback", () => {
  it("keeps unpublished keep/revise resolutions as fallbacks while published resolutions and rejects stay active", () => {
    const group = attentionGroup(1);
    const keep = fallbackResolution(group, "candidate-keep", "keep");

    const unpublished = selectHumanAttentionForOutput([group], [], new Map(), [keep]);
    expect(unpublished.notes).toHaveLength(1);
    expect(unpublished.suppressedByVerification).toEqual([]);
    expect(unpublished.publicationFallbacks).toEqual([
      { groupKey: group.key, candidateId: "candidate-keep", verdict: "keep" }
    ]);

    const published = selectHumanAttentionForOutput(
      [group],
      [publishedFinding("candidate-keep")],
      new Map(),
      [keep]
    );
    expect(published.notes).toEqual([]);
    expect(published.suppressedByVerification).toEqual([
      expect.objectContaining({ candidateId: "candidate-keep", verdict: "keep" })
    ]);

    const reject = selectHumanAttentionForOutput(
      [group],
      [],
      new Map(),
      [fallbackResolution(group, "candidate-reject", "reject")]
    );
    expect(reject.notes).toEqual([]);
    expect(reject.suppressedByVerification).toEqual([
      expect.objectContaining({ candidateId: "candidate-reject", verdict: "reject" })
    ]);
  });

  it("prioritizes a sixth-ranked publication fallback inside the unchanged five-note cap", () => {
    const groups = Array.from({ length: 6 }, (_, index) => attentionGroup(index + 1));
    const fallback = fallbackResolution(groups[5]!, "candidate-sixth", "keep");
    const events: Array<{ message: string; data?: Record<string, unknown> }> = [];

    const output = selectHumanAttentionForOutput(
      groups,
      [],
      new Map(),
      [fallback],
      { ...nullTelemetry(), event: (event) => events.push(event as never) }
    );

    expect(output.selectedGroups.map((group) => group.key)).toEqual([
      groups[5]!.key,
      groups[0]!.key,
      groups[1]!.key,
      groups[2]!.key,
      groups[3]!.key
    ]);
    expect(output.notes).toHaveLength(5);
    expect(output.omittedCount).toBe(1);
    expect(output.fallbackGroupCount).toBe(1);
    expect(output.omittedFallbackCount).toBe(0);
    expect(events).toContainEqual(expect.objectContaining({
      message: "human_attention_publication_fallback",
      data: expect.objectContaining({
        fallbackGroupCount: 1,
        fallbackGroupIds: [groups[5]!.key],
        omittedFallbackCount: 0,
        maxHumanAttentionNotes: 5
      })
    }));
  });

  it("renders the highest-ranked five when publication fallbacks overflow the cap", () => {
    const groups = Array.from({ length: 6 }, (_, index) => attentionGroup(index + 1));
    const output = selectHumanAttentionForOutput(
      groups,
      [],
      new Map(),
      groups.map((group, index) => fallbackResolution(group, `candidate-${String(index + 1)}`, "revise"))
    );

    expect(output.selectedGroups.map((group) => group.key)).toEqual(groups.slice(0, 5).map((group) => group.key));
    expect(output.fallbackGroupCount).toBe(6);
    expect(output.omittedFallbackCount).toBe(1);
    expect(output.publicationFallbacks).toHaveLength(6);
  });
});

function attentionGroup(index: number): AttentionHintGroup {
  const packetId = `packet-${String(index)}`;
  const question = `Does fallback predicate ${String(index)} remain valid?`;
  const file = `src/file-${String(index)}.ts`;
  const symbol = `predicate${String(index)}`;
  return {
    key: `group-${String(index)}`,
    representative: {
      id: `note-${String(index)}`,
      source: "follow_up_hint",
      question,
      files: [file],
      originalFiles: [file],
      droppedPaths: [],
      symbols: [symbol],
      suggestedLenses: [],
      reason: `Predicate ${String(index)} needs verification.`,
      confidence: "medium",
      packetId
    },
    files: [file],
    symbols: [symbol],
    reasons: [`Predicate ${String(index)} needs verification.`],
    rawNoteIds: new Set([`note-${String(index)}`]),
    droppedPaths: [],
    invalidPathCount: 0,
    packetIds: new Set([packetId]),
    sources: new Set(["follow_up_hint"]),
    count: 1
  };
}

function fallbackResolution(
  group: AttentionHintGroup,
  candidateId: string,
  verdict: VerificationResolution["verdict"]
): VerificationResolution {
  return {
    source: "stage9_verified_predicate",
    candidateId,
    verdict,
    reason: "The predicate was adjudicated.",
    files: group.files,
    symbols: group.symbols,
    terms: new Set(),
    questionKeys: new Set(),
    provenance: {
      source: "uncertainty_promotion",
      sourceKind: "follow_up_hint",
      sourcePacketId: group.representative.packetId,
      question: group.representative.question,
      files: group.files,
      symbols: group.symbols,
      reason: "promoted fallback predicate"
    }
  };
}

function publishedFinding(candidateId: string): FinalFinding {
  return {
    ...promotedCandidate(),
    id: "published-final",
    path: "src/unrelated.ts",
    producedBy: { kind: "packet", stage: 7, packetId: "unrelated", lensId: "core/code-review", skillIds: [] },
    fingerprint: "published-fingerprint",
    finalBody: "Published body.",
    publication: "summary-only",
    mergedCandidateIds: [candidateId],
    mergedCategories: ["correctness"],
    mergedSeverities: ["medium"],
    mergedPaths: ["src/unrelated.ts"],
    mergedTitles: ["Published final"]
  };
}
