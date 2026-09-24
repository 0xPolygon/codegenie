import type { CandidateFinding } from "../../../src/types.js";
import { compositionSources, type CompositionSection } from "../../../src/pipeline/composition-content.js";

// Hand-authored, independent authorization example. These are supplied model
// decisions, not a claim that an offline replay performed semantic verification.
export function authorizationComposition() {
  const finding: CandidateFinding = {
    id: "authorization", title: "Revoked members can read a private document", severity: "high", confidence: "high",
    path: "documents.ts", category: "security", changedLine: true,
    producedBy: { packetId: "auth", lensId: "core/code-review", kind: "packet", stage: 7, skillIds: [] },
    failureMode: "The read path accepts a cached membership after revocation.",
    whyThisMatters: "A revoked member can retrieve a private document.",
    verification: "The active-membership check is absent from the complete read handler; the write handler still checks it.",
    proofAssessment: { status: "established", evidence: "The complete read handler returns the document using only cached membership.",
      assumptions: [{ question: "How long is a cached membership retained?", essential: false }] },
    suggestedFix: "Check active membership before returning the document.",
    suggestedTest: "Create a session, revoke membership, and assert the subsequent read is denied.",
    evidence: { changedCode: "return documents.get(id)", relatedCode: [
      { path: "access-policy.ts", lines: "return membership.active", whyRelevant: "Revocation removes read access, even for an existing session." }
    ] }
  };
  finding.suggestionAssessments = {
    suggestedFix: { status: "supported", suggestionText: finding.suggestedFix!, rationale: "Checks current access before disclosure.",
      contractCheck: { status: "established", requirement: "Only currently active members may read private documents." }, evidence: finding.evidence.relatedCode! },
    suggestedTest: { status: "supported", suggestionText: finding.suggestedTest!, rationale: "A valid session reaches authorization; denial detects stale membership, without relying on a malformed request.",
      contractCheck: { status: "established", requirement: "Revocation denies reads from an existing session." }, evidence: finding.evidence.relatedCode! }
  };
  const findings = [finding];
  const sources = compositionSources(findings);
  const sections: CompositionSection[] = (["impact", "verification", "fix", "test"] as const).map(kind => ({
    kind, sourceRefs: sources.filter(source => source.kind === kind).map(source => source.id),
    text: kind === "impact" ? finding.failureMode + " " + finding.whyThisMatters
      : kind === "verification" ? finding.verification + " Cache lifetime determines the exposure window."
      : kind === "fix" ? finding.suggestedFix! : finding.suggestedTest!
  }));
  return { findings, sections, evidenceRefs: sources.filter(source => source.kind === "evidence").map(source => source.id), presentation: {} };
}
