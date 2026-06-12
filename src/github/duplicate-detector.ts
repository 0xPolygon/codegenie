import type {
  ExistingReviewThread,
  FinalFinding,
  FindingDuplicateDecision,
  ReviewPacket
} from "../types.js";
import { sha256Hex } from "../util/hashing.js";

export const CODENINJA_MARKER_PATTERN =
  /<!--\s*codeninja:fingerprint=([0-9a-f]{64});run=([A-Za-z0-9._-]+)\s*-->/u;

export type CodeninjaMarker = {
  fingerprint: string;
  runId: string;
};

export function parseCodeninjaMarker(body: string): CodeninjaMarker | undefined {
  const match = CODENINJA_MARKER_PATTERN.exec(body);
  if (!match) {
    return undefined;
  }
  return {
    fingerprint: match[1] ?? "",
    runId: match[2] ?? ""
  };
}

export function formatCodeninjaMarker(fingerprint: string, runId: string): string {
  return `<!-- codeninja:fingerprint=${fingerprint};run=${runId} -->`;
}

export function fingerprintFindingForGitHub(
  finding: Pick<FinalFinding, "path" | "category" | "producedBy" | "anchor">,
  packetsById: Map<string, ReviewPacket> = new Map()
): string {
  const packet = packetsById.get(finding.producedBy.packetId);
  const hunkId = finding.anchor?.hunkId;
  const symbol = hunkId !== undefined
    ? packet?.symbolFacts.find((fact) => fact.hunkId === hunkId)?.enclosingSymbol
    : undefined;
  return sha256Hex([
    normalize(finding.path),
    normalize(symbol ?? hunkId ?? finding.path),
    normalize(finding.category),
    normalize(finding.producedBy.lensId)
  ].join("\0"));
}

export function detectDuplicateFindings(
  findings: FinalFinding[],
  comments: ExistingReviewThread[]
): FindingDuplicateDecision[] {
  const codeninjaComments = comments.filter((comment) => comment.isCodeninja);
  const fingerprints = new Map(
    codeninjaComments
      .filter((comment) => comment.fingerprint !== undefined)
      .map((comment) => [comment.fingerprint as string, comment])
  );
  return findings.map((finding): FindingDuplicateDecision => {
    const exact = fingerprints.get(finding.fingerprint);
    if (exact !== undefined) {
      return {
        findingId: finding.id,
        action: "skip_exact_fingerprint",
        matchedCommentId: exact.id,
        reason: "matching codeninja fingerprint already exists on the PR"
      };
    }

    const fuzzy = codeninjaComments.find((comment) =>
      finding.anchor !== undefined &&
      comment.path === finding.anchor.path &&
      comment.side === finding.anchor.side &&
      typeof comment.line === "number" &&
      Math.abs(comment.line - finding.anchor.line) <= 5
    );
    if (fuzzy !== undefined) {
      return {
        findingId: finding.id,
        action: "skip_fuzzy_proximity",
        matchedCommentId: fuzzy.id,
        reason: "nearby codeninja comment already exists on the PR"
      };
    }

    return {
      findingId: finding.id,
      action: "post",
      reason: "no prior codeninja duplicate detected"
    };
  });
}

function normalize(value: string): string {
  return value.toLowerCase().trim().replace(/\s+/gu, " ");
}
