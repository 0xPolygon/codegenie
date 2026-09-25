import { describe, expect, it } from "vitest";
import { submissionIssues } from "../src/llm/submit-preservation.js";
import { SubmitCompositionSchema } from "../src/llm/schemas.js";
import { attentionResolutionErrors, buildAttentionReconciliation, createAttentionResolutionRepair, MAX_ATTENTION_RECONCILIATION_CHARS, reconcileAttention } from "../src/pipeline/attention-reconciliation.js";
import { composerSubmissionSchema } from "../src/pipeline/composer.js";
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
  it("accepts evidence already delivered in finding components when its duplicate inventory entry was omitted", () => {
    const f = fixture();
    const input = buildAttentionReconciliation(f.verdicts, [f.candidate], [f.packet], { mode: "branch", repoRoot: "/repo", commits: [], rawDiff: "" });
    const id = "authorization/evidence/relatedCode/0";
    input.inventory.evidence = input.inventory.evidence.filter(source => source.id !== id);
    input.omittedEvidenceIds.push(id);
    const proposal = { ...f.proposal, supportingRefs: [id] };
    expect(reconcileAttention(input, [proposal], true).decisions[0]!.accepted).toBe(true);
    expect(reconcileAttention(input, [{ ...proposal, supportingRefs: ["not-delivered"] }], true).decisions[0]!.accepted).toBe(false);
    input.groups[0]!.concerns[0]!.candidateId = f.candidate.id;
    expect(reconcileAttention(input, [proposal], true).decisions[0]!.rejectionReason).toBe("self_support");
    input.groups[0]!.concerns[0]!.candidateId = "question";
    delete input.allEvidence.find(source => source.id === id)!.sourceRef;
    expect(reconcileAttention(input, [proposal], true).decisions[0]!.rejectionReason).toBe("unknown_or_omitted_evidence");
  });

  it("retains a complete explicitly referenced source before repeated compact assessments fill the cap", () => {
    const f = fixture(["Does readDocument have its required permission declaration?"]);
    f.concern.unresolvedConcern!.files = ["config/access.custom"];
    const text = 'permission = "readDocument"\n' + "# Complete source context\n".repeat(100);
    f.packet.repositoryEvidence = [
      // Cheap excerpts from the same file must not outrank the relevant full read
      // merely because each question's fair share is smaller than that read.
      ...Array.from({ length: 10 }, (_, i) => ({ id: `unrelated-${i}`, tool: "read_range", source: "head" as const,
        path: "config/access.custom", text: `# Unrelated section ${i}\nlogging = true` })),
      { id: "config-read", tool: "read_range", source: "head", path: "config/access.custom", text }
    ];
    for (let i = 0; i < 35; i++) f.verdicts.push({ ...structuredClone(f.observation), candidateId: `other-${i}`,
      proofAssessment: { status: "unresolved", evidence: "readDocument permission declaration remains unconfirmed. ".repeat(12), assumptions: [] } });
    const input = f.build();
    const source = input.inventory.evidence.find(item => item.origin === "repository_tool")!;
    expect(source).toMatchObject({ path: "config/access.custom", text, source: "head" });
    expect(input.omittedEvidenceIds.length).toBeGreaterThan(0);
    expect(JSON.stringify(input.inventory).length).toBeLessThanOrEqual(MAX_ATTENTION_RECONCILIATION_CHARS);
    // Selection never resolves the question by itself.
    expect(reconcileAttention(input, undefined, true).notes).toEqual([f.concern.unresolvedConcern]);
  });

  it("prioritizes the referenced implementation over its header under a crowded evidence cap", () => {
    const f = fixture(["Does the route drift guard compare RouteCatalog.entries() with expectedRoutes?"]);
    f.concern.unresolvedConcern!.files = ["routing/guard.custom"];
    f.concern.unresolvedConcern!.symbols = [];
    const header = "# route drift guard maintains an expectedRoutes table\n" + "# introductory notes\n".repeat(50);
    const body = "check route_drift_guard { actual = RouteCatalog.entries(); assert_equal(actual, expectedRoutes); }\n"
      + "# complete implementation context\n".repeat(40);
    f.packet.repositoryEvidence = [
      { id: "header", tool: "read_range", source: "head", path: "routing/guard.custom", text: header },
      { id: "body", tool: "read_range", source: "head", path: "routing/guard.custom", text: body },
      { id: "contained", tool: "read_range", source: "head", path: "routing/guard.custom", text: body.split("\n")[0]! }
    ];
    for (let i = 0; i < 35; i++) f.verdicts.push({ ...structuredClone(f.observation), candidateId: `other-${i}`,
      proofAssessment: { status: "unresolved", evidence: "Route drift guard and expectedRoutes remain unconfirmed. ".repeat(12), assumptions: [] } });
    const input = f.build();
    expect(input.inventory.evidence.some(item => item.id === "repository/auth/body")).toBe(true);
    expect(input.inventory.evidence.some(item => item.id === "repository/auth/contained")).toBe(false);
    expect(input.allEvidence.some(item => item.id === "repository/auth/contained")).toBe(true);
    expect(input.omittedEvidenceIds).toContain("repository/auth/contained");
    expect(JSON.stringify(input.inventory).length).toBeLessThanOrEqual(MAX_ATTENTION_RECONCILIATION_CHARS);
    expect(reconcileAttention(input, undefined, true).notes).toEqual([f.concern.unresolvedConcern]);
  });

  it("repairs every delivered concern even when more than thirty fit in the inventory", () => {
    const f = fixture(Array.from({ length: 31 }, (_, i) => `Is condition ${i} established?`));
    const input = f.build();
    expect(input.inventory.concerns).toHaveLength(31);
    const schema = composerSubmissionSchema([], input);
    const original = { summary: "Review completed with questions.", composedFindings: [] };
    const repair = createAttentionResolutionRepair(schema, original, input)!;
    const values = { attentionResolutions: input.inventory.concerns.map(concern => ({ concernId: concern.id,
      disposition: "unresolved" as const, supportingRefs: [], rationale: "The supplied evidence does not establish this condition." })) };
    expect(submissionIssues(repair.schema, values)).toEqual([]);
    expect(submissionIssues(schema, repair.merge(values))).toEqual([]);
    expect(attentionResolutionErrors(input, values.attentionResolutions)).toEqual([]);
    expect(() => repair.merge({ attentionResolutions: values.attentionResolutions.slice(0, 30) })).toThrow();
    // An all-unresolved decision list preserves the original authored wording.
    input.groups[0]!.original.question = "Original combined question wording.";
    expect(reconcileAttention(input, values.attentionResolutions, true).notes[0]!.question).toBe("Original combined question wording.");
  });

  it("requires an explicit decision for every supplied concern, while allowing honest uncertainty", () => {
    const f = fixture();
    const input = f.build();
    const schema = composerSubmissionSchema([], input);
    const original = { summary: "Retain current findings.", composedFindings: [] };
    expect(submissionIssues(schema, original)).toContainEqual({ path: "attentionResolutions", kind: "missing" });
    expect(attentionResolutionErrors(input, undefined)).toHaveLength(2);
    const unresolved = { concernId: input.inventory.concerns[1]!.id, disposition: "unresolved" as const,
      supportingRefs: [], rationale: "No deployment evidence was supplied." };
    expect(attentionResolutionErrors(input, [f.proposal, unresolved])).toEqual([]);
    expect(submissionIssues(schema, { ...original, attentionResolutions: [f.proposal, unresolved] })).toEqual([]);
    expect(reconcileAttention(input, [f.proposal, unresolved], true).notes[0]!.question).toBe("Is this endpoint deployed?");
    expect(attentionResolutionErrors(input, [{ ...f.proposal, supportingRefs: [] }, unresolved])).toContainEqual(expect.stringContaining("unknown_or_omitted_evidence"));
    expect(attentionResolutionErrors(input, [f.proposal, { ...unresolved, remainingQuestion: "Silently rewritten" }])).toContainEqual(expect.stringContaining("conflicting_remaining_question"));
    expect(reconcileAttention(input, [f.proposal, unresolved], false).notes).toEqual([f.concern.unresolvedConcern]);
  });

  it("repairs missing or duplicate decisions without rewriting finding content", () => {
    const f = fixture();
    const input = f.build();
    const original = { summary: "Keep the finding.", composedFindings: [], attentionResolutions: [f.proposal, f.proposal] };
    const repair = createAttentionResolutionRepair(composerSubmissionSchema([], input), original, input)!;
    expect(repair.prompt).toContain("duplicate_resolution");
    expect(repair.prompt).toContain(input.inventory.concerns[1]!.id);
    const values = { attentionResolutions: [f.proposal, { concernId: input.inventory.concerns[1]!.id,
      disposition: "unresolved" as const, supportingRefs: [], rationale: "Deployment cannot be established." }] };
    const merged = repair.merge(values);
    expect(merged).toEqual({ ...original, ...values });
    expect(original.attentionResolutions).toHaveLength(2);
    expect(merged.summary).toBe(original.summary);
    expect(repair.merge({ ...values, summary: "Erase the retained diagnosis", composedFindings: [] })).toEqual(merged);
    expect(attentionResolutionErrors(input, values.attentionResolutions)).toEqual([]);
    expect(attentionResolutionErrors(input, [f.proposal, f.proposal])).toContainEqual(expect.stringContaining("duplicate_resolution"));
    const omitted = { ...input, inventory: { ...input.inventory, concerns: input.inventory.concerns.slice(0, 1) }, omittedConcernIds: [input.inventory.concerns[1]!.id] };
    expect(attentionResolutionErrors(omitted, [f.proposal])).toEqual([]);
    expect(attentionResolutionErrors({ ...omitted, inventory: { ...omitted.inventory, concerns: [] } }, undefined)).toEqual([]);
  });

  it("retains verifier answers before large matching tables consume the inventory", () => {
    const f = fixture(["Does readDocument reject revoked sessions?", "Does restoreArchive preserve archived records?"]);
    f.concern.unresolvedConcern!.files = ["permissions.ts", "archives.ts"];
    f.concern.unresolvedConcern!.symbols = ["readDocument", "restoreArchive"];
    f.observation.proofAssessment = { status: "refuted",
      evidence: "readDocument rejects revoked sessions: its current guard checks revokedAt before returning the document.",
      assumptions: [{ question: "Deployment is not established.", essential: false }] };
    f.verdicts.push({ ...structuredClone(f.observation), candidateId: "archive-answer",
      proofAssessment: { status: "established", evidence: "restoreArchive preserves archived records; the rollback branch restores both payload and metadata.", assumptions: [] } });
    f.packet.repositoryEvidence = Array.from({ length: 3 }, (_, i) => ({ id: `table-${i}`, tool: "read_range", source: "head" as const,
      path: "permissions.ts", symbols: ["readDocument", "restoreArchive"],
      text: `// readDocument rejects revoked sessions; restoreArchive preserves archived records\n${"permissionName: permissionValue,\n".repeat(200)}// table ${i}` }));
    const original = structuredClone(f.verdicts);
    const input = f.build();
    for (const id of ["attention/authorization/proofAssessment", "attention/archive-answer/proofAssessment"]) {
      const supplied = input.inventory.evidence.find(item => item.id === id);
      expect(supplied?.text).toBe(input.allEvidence.find(item => item.id === id)!.text);
    }
    expect(input.inventory.evidenceContexts.find(item => item.candidateId === "authorization")?.assumptions)
      .toEqual(f.observation.proofAssessment.assumptions);
    expect(input.omittedEvidenceIds.some(id => id.includes("table-"))).toBe(true);
    expect(JSON.stringify(input.inventory).length).toBeLessThanOrEqual(MAX_ATTENTION_RECONCILIATION_CHARS);
    expect(reconcileAttention(input, [], true).notes).toEqual([f.concern.unresolvedConcern]);
    expect(f.verdicts).toEqual(original);
  });

  it("keeps identical text from base and head as distinct revision evidence", () => {
    const f = fixture();
    f.packet.repositoryEvidence = (["base", "head"] as const).map(source => ({ id: source, tool: "read_range", source,
      path: "documents.test.ts", text: "readDocument denies revoked sessions" }));
    expect(f.build().inventory.evidence.filter(item => item.origin === "repository_tool").map(item => item.source).sort()).toEqual(["base", "head"]);
  });

  it("uses successful source reads independently of the packet submission outcome", () => {
    const f = fixture();
    f.packet.findings = [];
    f.packet.noFindingReason = "Everything is safe.";
    f.packet.repositoryEvidence = [{ id: "read-1", tool: "read_range", path: "documents.test.ts", source: "base", text: "test('revoked session', () => expect(access(revoked)).toBe(false));" }];
    f.verdicts.splice(1);
    const input = f.build();
    const source = input.inventory.evidence.find(item => item.origin === "repository_tool")!;
    expect(source).toMatchObject({ source: "base", text: f.packet.repositoryEvidence[0]!.text });
    expect(JSON.stringify(input.inventory)).not.toContain("Everything is safe");
    expect(reconcileAttention(input, [], true).notes).toEqual([f.concern.unresolvedConcern]);
    expect(reconcileAttention(input, [{ ...f.proposal, supportingRefs: [source.id] }], true).decisions[0]!.accepted).toBe(true);
    f.packet.status = "incomplete";
    expect(f.build().inventory.evidence.some(item => item.origin === "repository_tool")).toBe(true);
  });

  it("admits a deferred complete source when space remains after compact observations", () => {
    const f = fixture(Array.from({ length: 12 }, (_, i) => `Does readDocument enforce access condition ${i}?`));
    f.packet.findings = [];
    f.verdicts.splice(1);
    const text = "function readDocument() { enforceAllAccessConditions(); }\n".repeat(90);
    f.packet.repositoryEvidence = [{ id: "large-source", tool: "read_range", source: "head", path: "documents.ts", text }];
    const input = f.build();
    expect(input.inventory.evidence.find(e => e.origin === "repository_tool")?.text).toBe(text);
    expect(JSON.stringify(input.inventory).length).toBeLessThanOrEqual(MAX_ATTENTION_RECONCILIATION_CHARS);
    expect(reconcileAttention(input, [], true).notes).toEqual([f.concern.unresolvedConcern]);
  });

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

  it("admits more concerns than the display cap without removing unanswered siblings", () => {
    const f = fixture(["Does a test exist?"]);
    for (let i = 1; i < 15; i++) f.verdicts.push({ ...structuredClone(f.concern), candidateId: "question-" + i });
    const input = f.build();
    expect(input.inventory.concerns).toHaveLength(15);
    expect(input.omittedConcernIds).toHaveLength(0);
    const result = reconcileAttention(input, [f.proposal], true);
    expect(result.notes).toEqual([f.concern.unresolvedConcern]);
    expect(result.outcomes.filter(outcome => outcome.remainingQuestion)).toHaveLength(14);
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
    input.groups[0]!.concerns[0]!.candidateId = f.candidate.id;
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

describe("plan 124 question coverage", () => {
  it("supplies distinct method bodies despite crowded assessments and oversized reads, with stable provenance", () => {
    const f = fixture(["Does InputRule.checkRequest invoke NestedRule.checkItems?", "Does WritePolicy.authorize deny expiredSession?"]);
    f.concern.unresolvedConcern!.files = ["rules.custom", "policy.custom"];
    f.concern.unresolvedConcern!.symbols = [];
    const source = (id: string, path: string, text: string) => ({ id, path, text, source: "head" as const, tool: "read_range" });
    const nested = "method checkRequest on InputRule { return NestedRule.checkItems(input); }";
    const policy = "method authorize on WritePolicy { if expiredSession { deny; } }";
    f.packet.repositoryEvidence = [source("too-large", "rules.custom", nested + "\n# irrelevant extra context".repeat(1000)),
      source("nested", "rules.custom", nested), source("policy", "policy.custom", policy),
      source("duplicate", "rules.custom", nested)];
    for (let i = 0; i < 40; i++) f.verdicts.push({ ...structuredClone(f.observation), candidateId: `assessment-${i}`,
      proofAssessment: { status: "unresolved", evidence: "InputRule checkRequest and WritePolicy authorize remain unconfirmed. ".repeat(10), assumptions: [] } });
    const input = f.build();
    expect(input.inventory.evidence.filter(e => e.origin === "repository_tool").map(e => e.text)).toEqual(expect.arrayContaining([nested, policy]));
    expect(input.selection.every(selection => selection.suppliedRefs.length > 0)).toBe(true);
    expect(input.selection[0]!.omittedForSize).toContain("repository/auth/too-large");
    expect(JSON.stringify(input.inventory).length).toBeLessThanOrEqual(MAX_ATTENTION_RECONCILIATION_CHARS);
    const excludedDuplicate = input.omittedEvidenceIds.find(id => id === "repository/auth/nested" || id === "repository/auth/duplicate")!;
    expect(reconcileAttention(input, [{ ...f.proposal, supportingRefs: [excludedDuplicate] }], true).decisions[0]!.rejectionReason).toBe("unknown_or_omitted_evidence");
    f.packet.repositoryEvidence.reverse();
    expect(f.build().inventory).toEqual(input.inventory);
    expect(reconcileAttention(input, undefined, true).notes).toEqual([f.concern.unresolvedConcern]);
  });
});

it("gives a late question's compact source a turn before several large unrelated method reads", () => {
  const questions = Array.from({ length: 7 }, (_, i) => `Does Early${i}.check enforce its declared caller requirement in early${i}.custom?`);
  questions.push("Does generated/dispatch.custom implement BatchRequest.check by invoking NestedItems.check?");
  const f = fixture(questions);
  f.concern.unresolvedConcern!.files = [...Array.from({ length: 7 }, (_, i) => `early${i}.custom`), "generated/dispatch.custom", "handler.custom"];
  f.concern.unresolvedConcern!.symbols = [];
  const nested = "method check on BatchRequest { return NestedItems.check(items); }\n" + "# complete method context\n".repeat(20);
  f.packet.repositoryEvidence = [
    ...Array.from({ length: 7 }, (_, i) => ({ id: `early-${i}`, tool: "read_range", source: "head" as const, path: `early${i}.custom`,
      text: `method check on Early${i} { enforce declared caller requirement; }\n` + "# whole surrounding context\n".repeat(95) })),
    { id: "nested", tool: "read_range", source: "head", path: "generated/dispatch.custom", text: nested },
    { id: "caller-only", tool: "read_range", source: "head", path: "handler.custom", text: "handler(BatchRequest) { request.check(); NestedItems; }\n" + "# handler context\n".repeat(60) }
  ];
  const input = f.build();
  expect(input.inventory.evidence).toContainEqual(expect.objectContaining({ id: "repository/auth/nested", text: nested }));
  expect(input.omittedEvidenceIds.some(id => id.includes("early-"))).toBe(true);
  expect(JSON.stringify(input.inventory).length).toBeLessThanOrEqual(MAX_ATTENTION_RECONCILIATION_CHARS);
  expect(reconcileAttention(input, undefined, true).notes).toEqual([f.concern.unresolvedConcern]);
});


it("permits published verification references without promoting incomplete or self-supported claims", () => {
  const f = fixture(["Does head reject a revoked session?"]);
  f.candidate.verification = "The head test calls revoke(session) and asserts that readDocument denies access.";
  const build = () => buildAttentionReconciliation(f.verdicts, [f.candidate], [f.packet], { mode: "branch", repoRoot: "/repo", commits: [], rawDiff: "" });
  const input = build();
  const id = `${f.candidate.id}/verification`;
  expect(input.allEvidence).toContainEqual(expect.objectContaining({ id, sourceRef: id, text: f.candidate.verification }));
  input.inventory.evidence = input.inventory.evidence.filter(item => item.id !== id);
  expect(attentionResolutionErrors(input, [{ ...f.proposal, supportingRefs: [id] }])).toEqual([]);
  input.groups[0]!.concerns[0]!.candidateId = f.candidate.id;
  expect(attentionResolutionErrors(input, [{ ...f.proposal, supportingRefs: [id] }])[0]).toContain("self_support");
  f.observation.verificationIncomplete = true;
  expect(build().allEvidence.some(item => item.id === id)).toBe(false);
});

it("names rejected references and bounded permitted alternatives in semantic repair feedback", () => {
  const f = fixture(["Does head include a revoked-session test?"]);
  const input = f.build();
  const original = { summary: "Keep findings.", composedFindings: [], attentionResolutions: [{ ...f.proposal, supportingRefs: ["invented/source"] }] };
  const repair = createAttentionResolutionRepair(composerSubmissionSchema([], input), original, input)!;
  expect(repair.prompt).toContain('"rejectedRefs":["invented/source"]');
  expect(repair.prompt).toContain('"permittedRefs":[');
  expect(repair.prompt).toContain(f.proposal.supportingRefs[0]!);
  expect(repair.prompt).toContain("otherwise retain the unanswered question");
});

it("cleans attention-only repairs without accepting missing decisions or invalid values", () => {
  const f = fixture(["Does head include a revoked-session test?"]);
  const input = f.build();
  const original = { summary: "Keep findings.", composedFindings: [], attentionResolutions: [] };
  const repair = createAttentionResolutionRepair(composerSubmissionSchema([], input), original, input)!;
  const patch = { summary: "Discard this", composedFindings: [{ invented: true }], attentionResolutions: [{ ...f.proposal, extra: true }] };
  expect(repair.merge(patch)).toEqual({ ...original, attentionResolutions: [f.proposal] });
  expect(patch.attentionResolutions[0]!.extra).toBe(true);
  expect(() => repair.merge({ attentionResolution: [f.proposal] })).toThrow();
  expect(() => repair.merge({ attentionResolutions: [{ ...f.proposal, disposition: "probably" }] })).toThrow();
  expect(() => repair.merge({ attentionResolutions: [{ concernId: f.proposal.concernId }] })).toThrow();
});

it("selects context around a cited line instead of a cheaper window ending at its declaration", () => {
  const f = fixture(["Does generated/validation.custom:81 recurse from BatchRequest.check into EntryFilter.check?"]);
  f.concern.unresolvedConcern!.files = ["generated/validation.custom"];
  f.concern.unresolvedConcern!.symbols = ["BatchRequest.check", "EntryFilter.check"];
  const prefix = "method check on EntryFilter { acceptItems(items); }\nmethod check on BatchRequest {";
  f.packet.repositoryEvidence = [
    { id: "header", tool: "read_range", path: "generated/validation.custom", source: "head", lineRange: [58, 82], text: prefix },
    { id: "body", tool: "read_range", path: "generated/validation.custom", source: "head", lineRange: [60, 110],
      text: prefix + "\n  return EntryFilter.check(items);\n}\n" + "# surrounding context\n".repeat(25) }
  ];
  for (let i = 0; i < 40; i++) f.verdicts.push({ ...structuredClone(f.observation), candidateId: `other-${i}`,
    proofAssessment: { status: "unresolved", evidence: "BatchRequest and EntryFilter check remain unconfirmed. ".repeat(20), assumptions: [] } });
  const input = f.build();
  expect(input.inventory.evidence).toContainEqual(expect.objectContaining({ id: "repository/auth/body" }));
  expect(JSON.stringify(input.inventory).length).toBeLessThanOrEqual(MAX_ATTENTION_RECONCILIATION_CHARS);
  expect(reconcileAttention(input, undefined, true).notes).toEqual([f.concern.unresolvedConcern]);
});
