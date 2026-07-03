import type {
  AttentionEfficiency,
  AttentionRecord,
  CandidateFinding,
  FinalFinding,
  PacketReviewResult,
  ReviewPacket,
  VerificationVerdict
} from "../types.js";

// Plan 92 Layer 1: score the pipeline's attention-allocation decision.
// Coverage assignment is the only major pipeline decision with no outcome
// feedback — these records join what each packet was ALLOTTED (coverage,
// ensemble passes) with what it PRODUCED (candidates, hints, kept verdicts,
// published findings), making miscalibration (runs 47/49/50: losses on
// normal/default packets while deep ensembles ran empty) visible on every
// run instead of only in post-failure forensics.

export function buildAttentionRecords(input: {
  packets: ReviewPacket[];
  // Hunk ids the planner explicitly covered — a packet with none of its
  // hunks in the plan reviews under deterministic default coverage even
  // though nothing on the packet itself says so (found live in run
  // 0c4d5213/51: fee_calculator packets reported "planner" while absent
  // from the review plan).
  plannedHunkIds: Set<string>;
  packetResults: PacketReviewResult[];
  candidateFindings: CandidateFinding[];
  verdicts: VerificationVerdict[];
  publishedFindings: FinalFinding[];
  ensemblePassesForPacket: (packet: ReviewPacket) => number;
}): AttentionRecord[] {
  const resultByPacket = new Map(input.packetResults.map((result) => [result.packetId, result]));
  const packetByCandidateId = new Map(input.candidateFindings.map((candidate) => [candidate.id, candidate.producedBy.packetId]));

  const promotedByPacket = new Map<string, number>();
  for (const candidate of input.candidateFindings) {
    if (candidate.provenance?.source === "uncertainty_promotion") {
      const packetId = candidate.producedBy.packetId;
      promotedByPacket.set(packetId, (promotedByPacket.get(packetId) ?? 0) + 1);
    }
  }

  const keptByPacket = new Map<string, number>();
  for (const verdict of input.verdicts) {
    if (verdict.verdict !== "keep" && verdict.verdict !== "revise") {
      continue;
    }
    const packetId = packetByCandidateId.get(verdict.candidateId);
    if (packetId === undefined) {
      continue;
    }
    keptByPacket.set(packetId, (keptByPacket.get(packetId) ?? 0) + 1);
  }

  // A published finding credits every packet that contributed a merged
  // candidate (once per finding per packet).
  const publishedByPacket = new Map<string, number>();
  for (const finding of input.publishedFindings) {
    const candidateIds = new Set([finding.id, ...(finding.mergedCandidateIds ?? [])]);
    const packetIds = new Set(
      [...candidateIds]
        .map((candidateId) => packetByCandidateId.get(candidateId))
        .filter((packetId): packetId is string => packetId !== undefined)
    );
    for (const packetId of packetIds) {
      publishedByPacket.set(packetId, (publishedByPacket.get(packetId) ?? 0) + 1);
    }
  }

  return input.packets.map((packet) => {
    const result = resultByPacket.get(packet.id);
    return {
      packetId: packet.id,
      path: packet.path,
      coverage: packet.coverage,
      coverageSource: packet.hunks.some((hunk) => hunk.plannerFallbackReason !== undefined) ||
        packet.hunks.every((hunk) => input.plannedHunkIds.has(hunk.hunkId) === false)
        ? "deterministic_default"
        : "planner",
      ensemblePasses: input.ensemblePassesForPacket(packet),
      directCandidates: result?.findings.length ?? 0,
      promotedCandidates: promotedByPacket.get(packet.id) ?? 0,
      hintsEmitted: result?.followUpHints.length ?? 0,
      uncertaintiesEmitted: result?.uncertainties.length ?? 0,
      keptVerified: keptByPacket.get(packet.id) ?? 0,
      published: publishedByPacket.get(packet.id) ?? 0
    };
  });
}

export function aggregateAttentionEfficiency(records: AttentionRecord[]): AttentionEfficiency {
  const byCoverage: AttentionEfficiency["byCoverage"] = {};
  for (const record of records) {
    const bucket = byCoverage[record.coverage] ?? {
      packets: 0,
      ensembledPackets: 0,
      directCandidates: 0,
      hintsEmitted: 0,
      keptVerified: 0,
      published: 0
    };
    bucket.packets += 1;
    if (record.ensemblePasses > 1) {
      bucket.ensembledPackets += 1;
    }
    bucket.directCandidates += record.directCandidates;
    bucket.hintsEmitted += record.hintsEmitted;
    bucket.keptVerified += record.keptVerified;
    bucket.published += record.published;
    byCoverage[record.coverage] = bucket;
  }
  return {
    byCoverage,
    defaultCoveragePackets: records.filter((record) => record.coverageSource === "deterministic_default").length
  };
}
