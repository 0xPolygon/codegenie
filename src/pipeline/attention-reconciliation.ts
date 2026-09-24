import type { SubmitComposition } from "../llm/schemas.js";
import type { CandidateFinding, NeedsHumanAttentionNote, PacketReviewResult, ResolvedReviewInput, VerificationVerdict } from "../types.js";
import { compositionSources, safeReportProse, type CompositionSource } from "./composition-content.js";
import { MAX_HUMAN_ATTENTION_NOTES } from "./human-attention.js";

export const MAX_ATTENTION_RECONCILIATION_CHARS = 16_000;
type Resolution = NonNullable<SubmitComposition["attentionResolutions"]>[number];
type Concern = {
  id: string;
  candidateId: string;
  assumptionIndex: number;
  question: string;
  essential: boolean;
  verdict: VerificationVerdict["verdict"];
  scope: NeedsHumanAttentionNote;
};
type Evidence = {
  id: string;
  candidateId: string;
  sourceRef?: string;
  sourceField?: "suggestionAssessment";
  kind: "excerpt" | "observation";
  text: string;
  path?: string;
  explanation?: string;
  verdict: VerificationVerdict["verdict"];
  proofStatus?: NonNullable<VerificationVerdict["proofAssessment"]>["status"];
  assumptions?: NonNullable<VerificationVerdict["proofAssessment"]>["assumptions"];
};
type ConcernGroup = {
  candidateId: string;
  original: NeedsHumanAttentionNote;
  concerns: Concern[];
  ineligibleReason?: string;
};
type Inventory = {
  // This is review context, not a claim that each excerpt was read at head.
  // Individual excerpts/observations retain their original source wording.
  reviewRevision: { base?: string; head?: string };
  concerns: Concern[];
  // Published observations are already in the composition source components.
  // Register their IDs without duplicating their text in this bounded inventory.
  evidence: Array<Omit<Evidence, "text" | "verdict" | "proofStatus" | "assumptions"> & { text?: string }>;
  // Shared qualifications are retained once, keyed by each entry's candidateId.
  evidenceContexts: Array<Pick<Evidence, "candidateId" | "verdict" | "proofStatus" | "assumptions">>;
};
export type AttentionReconciliation = {
  groups: ConcernGroup[];
  inventory: Inventory;
  allEvidence: Evidence[];
  omittedConcernIds: string[];
  omittedEvidenceIds: string[];
  excludedEvidenceIds: string[];
};

/** Only exact host-assembled questions can be split; never infer identity from prose similarity. */
function concernGroup(verdict: VerificationVerdict): ConcernGroup | undefined {
  const original = verdict.unresolvedConcern;
  if (!original) return undefined;
  const group: ConcernGroup = { candidateId: verdict.candidateId, original, concerns: [] };
  if (verdict.verdict === "incomplete" || verdict.verificationIncomplete) {
    return { ...group, ineligibleReason: "incomplete_verification" };
  }
  const assumptions = verdict.proofAssessment?.assumptions ?? [];
  const indexed = assumptions.map((assumption, assumptionIndex) => ({ ...assumption, assumptionIndex }));
  const essential = indexed.filter(assumption => assumption.essential);
  const exact = indexed.filter(assumption => assumption.question === original.question);
  const selected = essential.length && essential.map(assumption => assumption.question).join("; ") === original.question
    ? essential : exact.length === 1 ? exact : [];
  if (!selected.length) return { ...group, ineligibleReason: "ambiguous_or_unstructured_concern" };
  group.concerns = selected.map(assumption => ({
    id: `${verdict.candidateId}/assumptions/${assumption.assumptionIndex}`,
    candidateId: verdict.candidateId,
    ...assumption,
    verdict: verdict.verdict,
    scope: original
  }));
  return group;
}

export function buildAttentionReconciliation(
  verdicts: VerificationVerdict[],
  publishedInputs: CandidateFinding[],
  packetResults: PacketReviewResult[],
  resolved: ResolvedReviewInput
): AttentionReconciliation {
  const groups = verdicts.flatMap(verdict => {
    const group = concernGroup(verdict);
    return group ? [group] : [];
  });
  const candidates = new Map(packetResults.flatMap(result => result.findings).map(finding => [finding.id, finding]));
  for (const verdict of verdicts) if (verdict.finalFinding) candidates.set(verdict.candidateId, verdict.finalFinding);
  for (const finding of publishedInputs) candidates.set(finding.id, finding);
  const publishedSources = new Map(compositionSources(publishedInputs).map(source => [source.id, source]));
  const allEvidence: Evidence[] = [];
  for (const verdict of verdicts) {
    // Incomplete verification is not a source of conclusive evidence.
    if (verdict.verdict === "incomplete" || verdict.verificationIncomplete) continue;
    const retainedCandidate = candidates.get(verdict.candidateId);
    const isPublished = publishedInputs.some(finding => finding.id === verdict.candidateId);
    const candidate = retainedCandidate && !isPublished ? {
      ...retainedCandidate,
      ...(verdict.suggestionAssessments ? { suggestionAssessments: verdict.suggestionAssessments } : {}),
      ...(verdict.originalSuggestions ? { originalSuggestions: verdict.originalSuggestions } : {})
    } : retainedCandidate;
    const candidateSources = candidate ? compositionSources([candidate], isPublished ? publishedInputs : [candidate]) : [];
    const sources: Array<CompositionSource & { sourceField?: "suggestionAssessment" }> = candidateSources.filter(source => source.kind === "evidence");
    for (const source of candidateSources) {
      // Register the observation together with its assessment qualifications,
      // never a proposed remedy or a supported label alone as evidence.
      if (!source.suggestionAssessment?.evidence.some(evidence => evidence.lines.trim())) continue;
      sources.push({ ...source, kind: "verification", sourceField: "suggestionAssessment",
        text: JSON.stringify(source.suggestionAssessment) });
    }
    if (verdict.proofAssessment?.evidence.trim()) sources.push({
      id: `${verdict.candidateId}/proofAssessment`, findingId: verdict.candidateId,
      kind: "verification", text: verdict.proofAssessment.evidence,
      ...(candidate ? { path: candidate.path } : {})
    });
    for (const source of sources) {
      if (!source.text.trim()) continue;
      // Only reference a published source when the actual observation is retained there.
      const published = publishedSources.get(source.id);
      const sourceRef = published && (source.sourceField ? JSON.stringify(published.suggestionAssessment) === source.text
        : source.kind === "evidence" ? published.text === source.text
        : candidate?.proofAssessment?.evidence === source.text) ? source.id : undefined;
      allEvidence.push({
        id: sourceRef ?? `attention/${source.id}`,
        candidateId: verdict.candidateId,
        ...(sourceRef ? { sourceRef } : {}),
        ...(source.sourceField ? { sourceField: source.sourceField } : {}),
        kind: source.kind === "evidence" ? "excerpt" : "observation",
        text: source.text,
        ...(source.path ? { path: source.path } : {}),
        ...(source.explanation ? { explanation: source.explanation } : {}),
        verdict: verdict.verdict,
        ...(verdict.proofAssessment ? { proofStatus: verdict.proofAssessment.status, assumptions: verdict.proofAssessment.assumptions } : {})
      });
    }
  }
  const inventory: Inventory = {
    reviewRevision: {
      ...(resolved.baseRef ? { base: resolved.baseRef } : {}),
      ...(resolved.headSha ?? resolved.headRef ? { head: resolved.headSha ?? resolved.headRef } : {})
    }, concerns: [], evidence: [], evidenceContexts: []
  };
  const omittedConcernIds: string[] = [];
  const omittedEvidenceIds: string[] = [];
  const excludedEvidenceIds: string[] = [];
  let admittedGroups = 0;
  for (const group of groups) {
    if (!group.concerns.length) continue;
    const next = [...inventory.concerns, ...group.concerns];
    if (admittedGroups >= MAX_HUMAN_ATTENTION_NOTES || JSON.stringify({ ...inventory, concerns: next }).length > MAX_ATTENTION_RECONCILIATION_CHARS) {
      omittedConcernIds.push(...group.concerns.map(concern => concern.id));
      continue;
    }
    inventory.concerns = next;
    admittedGroups++;
  }
  const eligible: Evidence[] = [];
  for (const evidence of allEvidence) {
    if (/\[tool result truncated by codegenie tool budget\]/i.test(evidence.text)) {
      excludedEvidenceIds.push(evidence.id);
      continue;
    }
    eligible.push(evidence);
  }
  // Give each question a turn instead of allowing the first candidate's excerpts
  // to consume the inventory. Ranking only allocates context; it proves nothing.
  const queues = inventory.concerns.map(concern => [...eligible].sort((a, b) =>
    evidencePriority(b, concern) - evidencePriority(a, concern)));
  const considered = new Set<string>();
  const observations = new Set<string>();
  while (queues.some(queue => queue.length)) {
    for (const queue of queues) {
      while (queue.length && considered.has(queue[0]!.id)) queue.shift();
      const evidence = queue.shift();
      if (!evidence) continue;
      considered.add(evidence.id);
      const { verdict, proofStatus, assumptions, ...observation } = evidence;
      const { text: _text, explanation: _explanation, ...reference } = observation;
      const context = { candidateId: evidence.candidateId, verdict,
        ...(proofStatus ? { proofStatus } : {}), ...(assumptions ? { assumptions } : {}) };
      const contexts = inventory.evidenceContexts.some(entry => entry.candidateId === evidence.candidateId)
        ? inventory.evidenceContexts : [...inventory.evidenceContexts, context];
      // Deduplicate only identical observations from the same candidate. Distinct
      // origins/qualifications must remain distinct for independent support.
      const key = JSON.stringify([evidence.candidateId, evidence.kind, evidence.sourceField,
        evidence.path, evidence.text, evidence.explanation]);
      const next = [...inventory.evidence, evidence.sourceRef ? reference : observation];
      if (observations.has(key) || JSON.stringify({ ...inventory, evidence: next, evidenceContexts: contexts }).length > MAX_ATTENTION_RECONCILIATION_CHARS) {
        omittedEvidenceIds.push(evidence.id);
        continue;
      }
      inventory.evidence = next;
      inventory.evidenceContexts = contexts;
      observations.add(key);
    }
  }
  for (const evidence of eligible) {
    if (!considered.has(evidence.id)) {
      omittedEvidenceIds.push(evidence.id);
    }
  }
  return { groups, inventory, allEvidence, omittedConcernIds, omittedEvidenceIds, excludedEvidenceIds };
}

function evidencePriority(evidence: Evidence, concern: Concern): number {
  const terms = new Set((concern.question + " " + concern.scope.symbols.join(" "))
    .replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().match(/[\p{L}\p{N}_]{4,}/gu) ?? []);
  const words = new Set((evidence.text + " " + (evidence.explanation ?? "") + " " + (evidence.path ?? ""))
    .replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().match(/[\p{L}\p{N}_]{4,}/gu) ?? []);
  const overlap = [...terms].filter(term => words.has(term)).length / Math.max(terms.size, 1);
  return (evidence.candidateId !== concern.candidateId ? 8 : 0)
    + overlap * 4
    + (concern.scope.files.includes(evidence.path ?? "") ? 1 : 0)
    + (evidence.kind === "observation" ? 0.5 : 0)
    + (evidence.sourceRef ? 0.25 : 0);
}

export function reconcileAttention(
  input: AttentionReconciliation,
  proposals: Resolution[] | undefined,
  enabled: boolean
) {
  const concerns = new Map(input.inventory.concerns.map(concern => [concern.id, concern]));
  const evidence = new Map(input.inventory.evidence.map(source => [source.id, source]));
  const counts = new Map<string, number>();
  for (const proposal of proposals ?? []) counts.set(proposal.concernId, (counts.get(proposal.concernId) ?? 0) + 1);
  const accepted = new Map<string, Resolution>();
  const decisions = (proposals ?? []).map(proposal => {
    const concern = concerns.get(proposal.concernId);
    const refs = proposal.supportingRefs;
    const reason = !enabled ? "composition_unavailable"
      : !concern ? "unknown_or_ineligible_concern"
      : counts.get(proposal.concernId)! > 1 ? "duplicate_resolution"
      : !proposal.rationale.trim() ? "empty_rationale"
      : !refs.length || refs.some(ref => !evidence.has(ref)) ? "unknown_or_omitted_evidence"
      : new Set(refs).size !== refs.length ? "duplicate_evidence"
      : refs.some(ref => evidence.get(ref)!.candidateId === concern.candidateId) ? "self_support"
      : proposal.disposition === "narrowed" && (!proposal.remainingQuestion?.trim() || proposal.remainingQuestion.trim() === concern.question.trim()) ? "missing_or_unchanged_remaining_question"
      : proposal.disposition === "resolved" && proposal.remainingQuestion !== undefined ? "conflicting_remaining_question"
      : undefined;
    if (!reason) accepted.set(proposal.concernId, proposal);
    return { ...proposal, accepted: !reason, ...(reason ? { rejectionReason: reason } : {}) };
  });
  const notes: NeedsHumanAttentionNote[] = [];
  const outcomes = input.groups.map(group => {
    const changed = group.concerns.some(concern => accepted.has(concern.id));
    const remaining = changed ? group.concerns.flatMap(concern => {
      const resolution = accepted.get(concern.id);
      if (resolution?.disposition === "resolved") return [];
      return [resolution?.disposition === "narrowed" ? safeReportProse(resolution.remainingQuestion!.trim()) : concern.question];
    }).join("; ") : group.original.question;
    if (remaining && !notes.some(note => note.question === remaining)) notes.push({ ...group.original, question: remaining });
    return { candidateId: group.candidateId, original: group.original, remainingQuestion: remaining,
      concernIds: group.concerns.map(concern => concern.id), ...(group.ineligibleReason ? { ineligibleReason: group.ineligibleReason } : {}) };
  });
  return { notes, decisions, outcomes };
}
