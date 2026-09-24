import { describe, expect, it } from "vitest";
import { submissionIssues } from "../src/llm/submit-preservation.js";
import { SubmitCompositionSchema } from "../src/llm/schemas.js";
import { buildAttentionReconciliation, MAX_ATTENTION_RECONCILIATION_CHARS, reconcileAttention } from "../src/pipeline/attention-reconciliation.js";
import { compositionSources, validateCompositionSubmission } from "../src/pipeline/composition-content.js";
import type { PacketReviewResult, VerificationVerdict } from "../src/types.js";
import { authorizationComposition } from "./fixtures/composition/authorization-review.js";

function fixture(questions = ["Does head include a revoked-session test?", "Is this endpoint deployed?"]) {
  const candidate = authorizationComposition().findings[0]!;
  const concern: VerificationVerdict = {
    candidateId: "question", verdict: "reject", requiredEvidencePresent: false, falsePositiveRisk: "high", reason: "Missing decisive context.",
    proofAssessment: { status: "unresolved", evidence: "Tests and deployment remain unconfirmed.", assumptions: questions.map(question => ({ question, essential: true })) },
    unresolvedConcern: { question: questions.join("; "), files: ["documents.test.ts"], symbols: ["readDocument"],
      confidence: "medium", reason: "Needs evidence.", sourcePacketIds: ["question-packet"] }
  };
  const observation: VerificationVerdict = {
    candidateId: candidate.id, verdict: "reject", requiredEvidencePresent: true, falsePositiveRisk: "low", reason: "The suspected missing test exists.",
    proofAssessment: { status: "refuted", evidence: "At head, documents.test.ts includes a revoked-session regression; deployment is not established.", assumptions: [] }
  };
  candidate.evidence.relatedCode = [{ path: "documents.test.ts", lines: "revoke(session); expect(readDocument(session)).toDeny();", whyRelevant: "Head test exercises the revoked-session case." }];
  const packet: PacketReviewResult = { packetId: "auth", lenses: [], findings: [candidate], followUpHints: [], uncertainties: [], status: "completed" };
  const verdicts = [concern, observation];
  const build = () => buildAttentionReconciliation(verdicts, [], [packet], { mode: "branch", repoRoot: "/repo", commits: [], rawDiff: "", baseRef: "base", headSha: "head" });
  const proposal = { concernId: "question/assumptions/0", disposition: "resolved" as const,
    supportingRefs: ["attention/authorization/evidence/relatedCode/0"], rationale: "The supplied head test answers test existence, not deployment." };
  return { candidate, concern, observation, verdicts, packet, build, proposal };
}

describe("evidence-backed attention reconciliation", () => {
  it("stores repeated evidence qualifications once without dropping their uncertainty", () => {
    const f = fixture();
    f.observation.proofAssessment!.assumptions = [{ question: "Deployment is unconfirmed. ".repeat(50), essential: true }];
    f.candidate.evidence.relatedCode = Array.from({ length: 16 }, (_, i) => ({
      path: "documents.test.ts", lines: `expect(revokedSession${i}).toBeDenied();`, whyRelevant: "Head regression test." }));
    const input = f.build();
    expect(input.inventory.evidence.filter(e => e.candidateId === f.candidate.id)).toHaveLength(
      input.allEvidence.filter(e => e.candidateId === f.candidate.id).length);
    expect(input.inventory.evidenceContexts.filter(e => e.candidateId === f.candidate.id)).toEqual([{
      candidateId: f.candidate.id, verdict: "reject", proofStatus: "refuted", assumptions: f.observation.proofAssessment!.assumptions
    }]);
    expect(input.inventory.evidence.every(e => !("assumptions" in e))).toBe(true);
    expect(JSON.stringify(input.inventory).length).toBeLessThanOrEqual(MAX_ATTENTION_RECONCILIATION_CHARS);
  });

  it("allocates independent evidence to each question before a prolific candidate fills the cap", () => {
    const f = fixture(["Does revocation invalidate cached sessions?", "Does rollback preserve archived records?"]);
    f.concern.unresolvedConcern!.files = ["sessions.ts", "archives.ts"];
    f.concern.unresolvedConcern!.symbols = [];
    f.candidate.path = "sessions.ts";
    f.candidate.evidence.relatedCode = Array.from({ length: 25 }, (_, i) => ({ path: "sessions.ts",
      lines: `revocation invalidates cached sessions ${i}. ` + "complete source excerpt; ".repeat(50), whyRelevant: "Revocation behavior." }));
    const archived = structuredClone(f.candidate);
    archived.id = "archive";
    archived.path = "archives.ts";
    archived.evidence = { changedCode: "rollback preserves archived records: restore(archive);", relatedCode: [] };
    delete archived.suggestionAssessments;
    f.packet.findings.push(archived);
    f.verdicts.push({ ...structuredClone(f.observation), candidateId: archived.id,
      proofAssessment: { status: "established", evidence: "rollback preserves archived records", assumptions: [] } });
    const input = f.build();
    expect(input.inventory.evidence.some(e => e.id.startsWith("attention/authorization/evidence/relatedCode/"))).toBe(true);
    expect(input.inventory.evidence.some(e => e.id === "attention/archive/evidence/changedCode")).toBe(true);
    expect(input.omittedEvidenceIds.length).toBeGreaterThan(0);
    expect(JSON.stringify(input.inventory).length).toBeLessThanOrEqual(MAX_ATTENTION_RECONCILIATION_CHARS);
    // Ranking is allocation only: even highly overlapping prose cannot resolve a question.
    expect(reconcileAttention(input, [], true).notes).toEqual([f.concern.unresolvedConcern]);
  });

  it("deduplicates identical observations only within an origin, retaining full audit evidence", () => {
    const f = fixture();
    f.candidate.evidence.relatedCode!.push(structuredClone(f.candidate.evidence.relatedCode![0]!));
    const input = f.build();
    expect(input.inventory.evidence.filter(e => e.id.includes("/evidence/relatedCode/"))).toHaveLength(1);
    expect(input.allEvidence.filter(e => e.id.includes("/evidence/relatedCode/"))).toHaveLength(2);
    expect(input.omittedEvidenceIds).toContain("attention/authorization/evidence/relatedCode/1");
    expect(reconcileAttention(input, [f.proposal], true).decisions[0]!.accepted).toBe(true);
  });

  it("resolves only the identified assumption from rejected-candidate evidence, retaining siblings and provenance", () => {
    const { verdicts, build, proposal } = fixture();
    const before = structuredClone(verdicts);
    const input = build();
    expect(input.inventory.reviewRevision).toEqual({ base: "base", head: "head" });
    const result = reconcileAttention(input, [proposal], true);
    expect(result.notes).toEqual([{ ...verdicts[0]!.unresolvedConcern, question: "Is this endpoint deployed?" }]);
    expect(result.decisions[0]).toMatchObject({ accepted: true, supportingRefs: proposal.supportingRefs });
    expect(result.outcomes[0]!.original.question).toContain("revoked-session test");
    expect(result.outcomes[0]!.concernIds).toHaveLength(2);
    expect(verdicts).toEqual(before);
  });

  it("narrows a compound assumption without changing its scope or losing the original", () => {
    const f = fixture(["Does the revoked-session test exist and is this endpoint deployed?"]);
    const result = reconcileAttention(f.build(), [{ ...f.proposal, disposition: "narrowed", remainingQuestion: "Is this endpoint deployed?" }], true);
    expect(result.notes).toEqual([{ ...f.concern.unresolvedConcern, question: "Is this endpoint deployed?" }]);
    expect(result.outcomes[0]!.original.question).toContain("test exist");
    expect(result.decisions[0]!.accepted).toBe(true);
  });

  it("removes a fully answered concern while preserving its original and supporting evidence in the outcome", () => {
    const f = fixture(["Does head include a revoked-session test?"]);
    const result = reconcileAttention(f.build(), [f.proposal], true);
    expect(result.notes).toEqual([]);
    expect(result.outcomes[0]).toMatchObject({ original: f.concern.unresolvedConcern, remainingQuestion: "" });
    expect(result.decisions[0]).toMatchObject({ accepted: true, supportingRefs: f.proposal.supportingRefs });
  });

  it.each(["unknown-concern", "unknown-evidence", "self-support", "blank-rationale", "duplicate", "empty-narrowing", "unchanged-narrowing", "conflicting-question"])("rejects %s without dropping the concern", mode => {
    const f = fixture();
    const input = f.build();
    let proposal: NonNullable<Parameters<typeof reconcileAttention>[1]>[number] = { ...f.proposal };
    if (mode === "unknown-concern") proposal.concernId = "missing";
    if (mode === "unknown-evidence") proposal.supportingRefs = ["missing"];
    if (mode === "self-support") proposal.supportingRefs = ["attention/question/proofAssessment"];
    if (mode === "blank-rationale") proposal.rationale = " ";
    if (mode === "empty-narrowing") proposal.disposition = "narrowed";
    if (mode === "unchanged-narrowing") proposal = { ...proposal, disposition: "narrowed", remainingQuestion: input.inventory.concerns[0]!.question };
    if (mode === "conflicting-question") proposal.remainingQuestion = "Still open?";
    const result = reconcileAttention(input, mode === "duplicate" ? [proposal, proposal] : [proposal], true);
    expect(result.notes).toEqual([f.concern.unresolvedConcern]);
    expect(result.decisions.every(decision => !decision.accepted)).toBe(true);
  });

  it.each(["incomplete", "ambiguous", "fallback", "legacy"])("preserves %s concerns", mode => {
    const f = fixture();
    if (mode === "incomplete") f.concern.verificationIncomplete = true;
    if (mode === "ambiguous") f.concern.unresolvedConcern!.question = "A reworded question with no exact association?";
    const result = reconcileAttention(f.build(), mode === "legacy" ? undefined : [f.proposal], mode !== "fallback");
    expect(result.notes).toEqual([f.concern.unresolvedConcern]);
    expect(result.decisions.some(decision => decision.accepted)).toBe(false);
  });

  it("does not resolve by shared file, rejected verdict, or similar prose alone", () => {
    const f = fixture();
    f.observation.proofAssessment = { status: "refuted", evidence: "", assumptions: [] };
    f.packet.findings = [];
    const input = f.build();
    expect(input.inventory.evidence.some(source => source.candidateId === f.observation.candidateId)).toBe(false);
    expect(reconcileAttention(input, [f.proposal], true).notes).toEqual([f.concern.unresolvedConcern]);
  });

  it("admits complete records within the cap and retains originals when evidence is omitted or truncated", () => {
    const f = fixture();
    f.candidate.evidence.relatedCode![0]!.lines = "large observation ".repeat(2000);
    f.candidate.evidence.changedCode = "[tool result truncated by codegenie tool budget]";
    const input = f.build();
    expect(JSON.stringify(input.inventory).length).toBeLessThanOrEqual(MAX_ATTENTION_RECONCILIATION_CHARS);
    expect(input.allEvidence.find(source => source.id === f.proposal.supportingRefs[0])!.text).toBe(f.candidate.evidence.relatedCode![0]!.lines);
    expect(input.omittedEvidenceIds).toContain(f.proposal.supportingRefs[0]);
    expect(input.excludedEvidenceIds).toContain("attention/authorization/evidence/changedCode");
    expect(reconcileAttention(input, [f.proposal], true).notes).toEqual([f.concern.unresolvedConcern]);
  });

  it("caps selected concern groups and does not remove an omitted sibling or same-text concern", () => {
    const f = fixture(["Does a test exist?"]);
    for (let i = 1; i < 7; i++) f.verdicts.push({ ...structuredClone(f.concern), candidateId: "question-" + i });
    const input = f.build();
    expect(input.inventory.concerns).toHaveLength(5);
    expect(input.omittedConcernIds).toHaveLength(2);
    const result = reconcileAttention(input, [f.proposal], true);
    expect(result.notes).toEqual([f.concern.unresolvedConcern]);
    expect(result.outcomes.filter(outcome => outcome.remainingQuestion)).toHaveLength(6);
  });

  it("reuses published source IDs but never permits attention-only evidence to account for finding content", () => {
    const f = fixture();
    const input = buildAttentionReconciliation(f.verdicts, [f.candidate], [f.packet], { mode: "branch", repoRoot: "/repo", commits: [], rawDiff: "" });
    expect(input.inventory.evidence).toContainEqual(expect.objectContaining({ id: "authorization/evidence/relatedCode/0", sourceRef: "authorization/evidence/relatedCode/0" }));
    const composed = authorizationComposition();
    expect(() => validateCompositionSubmission({ composedFindings: [{ findingIds: ["authorization"], sections: composed.sections,
      evidenceRefs: [...composed.evidenceRefs, "attention/question/proofAssessment"] }] }, composed.findings)).toThrow();
  });

  it.each(["supported", "unverified", "incompatible"] as const)("makes existing %s assessment observations referenceable without duplicating them", status => {
    const f = fixture();
    const assessment = f.candidate.suggestionAssessments!.suggestedTest!;
    assessment.status = status;
    assessment.evidence = [{ path: "documents.test.ts", lines: "expect(readDocument(revokedSession)).toDeny();",
      whyRelevant: "The head test checks revoked access; this does not establish deployment." }];
    const before = structuredClone(f.candidate);
    const input = buildAttentionReconciliation(f.verdicts, [f.candidate], [f.packet], { mode: "branch", repoRoot: "/repo", commits: [], rawDiff: "" });
    const id = "authorization/suggestedTest";
    const reference = input.inventory.evidence.find(source => source.id === id)!;
    expect(reference).toMatchObject({ sourceRef: id, sourceField: "suggestionAssessment", candidateId: "authorization" });
    expect(reference).not.toHaveProperty("text");
    const supplied = compositionSources([f.candidate]).find(source => source.id === reference.sourceRef)!;
    expect(supplied.suggestionAssessment).toMatchObject({ status, evidence: assessment.evidence });
    expect(JSON.parse(input.allEvidence.find(source => source.id === id)!.text)).toMatchObject({ status, evidence: assessment.evidence });
    // A scripted evidence-backed resolution exercises transport and validation,
    // not the model's ability to infer this semantic conclusion.
    const result = reconcileAttention(input, [{ ...f.proposal, supportingRefs: [id] }], true);
    expect(result.decisions[0]!.accepted).toBe(true);
    expect(result.notes[0]!.question).toBe("Is this endpoint deployed?");
    expect(reconcileAttention(input, [], true).notes).toEqual([f.concern.unresolvedConcern]);
    expect(f.candidate).toEqual(before);
  });

  it("carries unpublished verifier assessment evidence inline with its qualifications", () => {
    const f = fixture();
    const assessment = structuredClone(f.candidate.suggestionAssessments!.suggestedTest!);
    assessment.status = "unverified";
    assessment.rationale = "The test exists, but its assertion does not establish the proposed fix's contract.";
    f.observation.suggestionAssessments = { suggestedTest: assessment };
    delete f.candidate.suggestionAssessments;
    const input = f.build();
    const evidence = input.inventory.evidence.find(source => source.id === "attention/authorization/suggestedTest")!;
    expect(evidence.sourceRef).toBeUndefined();
    expect(JSON.parse(evidence.text!)).toEqual(assessment);
    expect(reconcileAttention(input, [{ ...f.proposal, supportingRefs: [evidence.id] }], true).notes[0]!.question).toBe("Is this endpoint deployed?");
  });

  it("references the same conflict-qualified assessment as composition and still rejects self-support", () => {
    const f = fixture();
    const opposing = structuredClone(f.candidate);
    opposing.id = "opposing";
    opposing.suggestionAssessments!.suggestedTest!.status = "incompatible";
    const findings = [f.candidate, opposing];
    const input = buildAttentionReconciliation(f.verdicts, findings, [f.packet], { mode: "branch", repoRoot: "/repo", commits: [], rawDiff: "" });
    const id = "authorization/suggestedTest";
    const original = input.allEvidence.find(source => source.id === id)!;
    const supplied = compositionSources(findings).find(source => source.id === id)!;
    expect(JSON.parse(original.text)).toEqual(supplied.suggestionAssessment);
    expect(supplied.suggestionAssessment).toMatchObject({ status: "unverified", rationale: expect.stringContaining("Conflicting compatibility assessments") });
    expect(input.inventory.evidence.find(source => source.id === id)).toMatchObject({ sourceRef: id });
    // Reuse this valid registered reference against its own candidate's concern.
    input.inventory.concerns[0]!.candidateId = f.candidate.id;
    const result = reconcileAttention(input, [{ ...f.proposal, supportingRefs: [id] }], true);
    expect(result.decisions[0]).toMatchObject({ accepted: false, rejectionReason: "self_support" });
    expect(result.notes).toEqual([f.concern.unresolvedConcern]);
  });

  it("does not spend the inventory budget repeating large observations already in the composition input", () => {
    const f = fixture();
    f.candidate.evidence.relatedCode![0]!.lines = "complete test source\n".repeat(2000);
    const input = buildAttentionReconciliation(f.verdicts, [f.candidate], [f.packet], { mode: "branch", repoRoot: "/repo", commits: [], rawDiff: "" });
    const id = "authorization/evidence/relatedCode/0";
    expect(input.inventory.evidence.find(source => source.id === id)).toMatchObject({ sourceRef: id });
    expect(input.inventory.evidence.find(source => source.id === id)).not.toHaveProperty("text");
    expect(input.allEvidence.find(source => source.id === id)!.text).toBe(f.candidate.evidence.relatedCode![0]!.lines);
    expect(JSON.stringify(input.inventory).length).toBeLessThanOrEqual(MAX_ATTENTION_RECONCILIATION_CHARS);
    expect(reconcileAttention(input, [{ ...f.proposal, supportingRefs: [id] }], true).decisions[0]!.accepted).toBe(true);
  });

  it.each(["empty", "truncated", "incomplete"])("cannot use %s recommendation evidence even when its source is published", mode => {
    const f = fixture();
    const assessment = f.candidate.suggestionAssessments!.suggestedTest!;
    if (mode === "empty") assessment.evidence = [];
    if (mode === "truncated") assessment.evidence[0]!.lines = "[tool result truncated by codegenie tool budget]";
    if (mode === "incomplete") f.observation.verificationIncomplete = true;
    const input = buildAttentionReconciliation(f.verdicts, [f.candidate], [f.packet], { mode: "branch", repoRoot: "/repo", commits: [], rawDiff: "" });
    const result = reconcileAttention(input, [{ ...f.proposal, supportingRefs: ["authorization/suggestedTest"] }], true);
    expect(result.decisions[0]!.accepted).toBe(false);
    expect(result.notes).toEqual([f.concern.unresolvedConcern]);
  });

  it("keeps optional resolution schema strict while allowing local rejection of invalid references", () => {
    const payload = { summary: "Review", composedFindings: [], attentionResolutions: [{ ...fixture().proposal, supportingRefs: ["unknown"] }] };
    expect(submissionIssues(SubmitCompositionSchema, payload)).toEqual([]);
    expect(submissionIssues(SubmitCompositionSchema, { ...payload, attentionResolutions: [{ ...payload.attentionResolutions[0], rationale: 42 }] })).not.toEqual([]);
    expect(submissionIssues(SubmitCompositionSchema, { summary: "Legacy", composedFindings: [] })).toEqual([]);
  });
});
