import type { SubmitComposition } from "../llm/schemas.js";
import { Type, type TSchema } from "typebox";
import type { SubmitCompositionSchema } from "../llm/schemas.js";
import type { FieldRepair } from "../llm/field-repair.js";
import { cleanupSubmitShape, focusedRepairDiagnostics, submissionIssues } from "../llm/submit-preservation.js";
import type { CandidateFinding, NeedsHumanAttentionNote, PacketReviewResult, ResolvedReviewInput, VerificationVerdict } from "../types.js";
import { compositionSources, safeReportProse, type CompositionSource } from "./composition-content.js";
import type { RawAttentionHint } from "./human-attention.js";
import { sourceEvidenceCovered, sourceEvidenceRelevance } from "./source-evidence.js";

export const MAX_ATTENTION_RECONCILIATION_CHARS = 16_000;
type Resolution = NonNullable<SubmitComposition["attentionResolutions"]>[number];
type Concern = {
  id: string;
  candidateId: string;
  assumptionIndex: number;
  question: string;
  essential: boolean;
  verdict: VerificationVerdict["verdict"] | "not_verified";
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
  verdict: VerificationVerdict["verdict"] | "not_verified";
  origin?: "repository_tool";
  symbols?: string[];
  lineRange?: [number, number];
  lookupStatus?: "found" | "ambiguous";
  source?: "head" | "base";
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
  concerns: Array<Pick<Concern, "id" | "question"> & { files: string[]; promotedEvidenceRefs?: string[] }>;
  // Published observations are already in the composition source components.
  // Register their IDs without duplicating their text in this bounded inventory.
  evidence: Array<Omit<Evidence, "text" | "verdict" | "proofStatus" | "assumptions"> & {
    text?: string;
    promotedFromConcern?: string;
  }>;
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
  selection: Array<{ concernId: string; suppliedRefs: string[]; omittedForSize: string[] }>;
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
  resolved: ResolvedReviewInput,
  packetHints: RawAttentionHint[] = []
): AttentionReconciliation {
  const groups = verdicts.flatMap(verdict => {
    const group = concernGroup(verdict);
    return group ? [group] : [];
  });
  for (const hint of packetHints) {
    if (hint.confidence === "low" || !hint.question.trim() || (!hint.files.length && !hint.symbols.length)) continue;
    const original: NeedsHumanAttentionNote = { question: hint.question, files: hint.files, symbols: hint.symbols,
      reason: hint.reason, confidence: hint.confidence, sourcePacketIds: [hint.packetId] };
    const candidateId = `packet:${hint.packetId}`;
    groups.push({ candidateId, original, concerns: [{ id: `packet/${hint.id}`, candidateId, assumptionIndex: 0,
      question: hint.question, essential: true, verdict: "not_verified", scope: original }] });
  }
  const candidates = new Map(packetResults.flatMap(result => result.findings).map(finding => [finding.id, finding]));
  const links = linkPromotedAttention(packetHints, [...candidates.values()], verdicts,
    new Set(publishedInputs.map(finding => finding.id)));
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
    const sources: Array<CompositionSource & { sourceField?: "suggestionAssessment" }> = candidateSources.filter(source => source.kind === "evidence"
      || (isPublished && source.id === `${verdict.candidateId}/verification`));
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
        : source.kind === "evidence" || source.id.endsWith("/verification") ? published.text === source.text
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
  // Source reads are independent evidence, not a packet's own conclusion.
  // Retain revision and tool provenance; failed/incomplete work cannot settle questions.
  const seenReads = new Set<string>();
  for (const packet of [...packetResults].sort((a, b) => a.packetId.localeCompare(b.packetId))) {
    for (const read of [...(packet.repositoryEvidence ?? [])].sort((a, b) => a.id.localeCompare(b.id))) {
      const key = JSON.stringify([read.source, read.path, read.text]);
      if (!read.text.trim() || seenReads.has(key)) continue;
      seenReads.add(key);
      allEvidence.push({ id: `repository/${packet.packetId}/${read.id}`, candidateId: `repository:${packet.packetId}`,
        kind: "excerpt", text: read.text, ...(read.path ? { path: read.path } : {}),
        explanation: `Successful ${read.tool} at ${read.source}; packet ${packet.packetId}`,
        ...(read.lineRange ? { lineRange: read.lineRange } : {}), ...(read.lookupStatus ? { lookupStatus: read.lookupStatus } : {}),
        origin: "repository_tool", ...(read.symbols ? { symbols: read.symbols } : {}), source: read.source, verdict: "not_verified" });
    }
  }
  return packAttentionReconciliation(groups, allEvidence, {
    ...(resolved.baseRef ? { base: resolved.baseRef } : {}),
    ...(resolved.headSha ?? resolved.headRef ? { head: resolved.headSha ?? resolved.headRef } : {})
  }, links);
}

/** Join the original promotion origin to the exact question. Publication is checked after composition. */
export function linkPromotedAttention(
  hints: RawAttentionHint[],
  candidates: CandidateFinding[],
  verdicts: VerificationVerdict[],
  compositionCandidateIds: ReadonlySet<string>
): ReadonlyMap<string, string> {
  const verified = new Set(verdicts.filter(verdict => (verdict.verdict === "keep" || verdict.verdict === "revise")
    && verdict.requiredEvidencePresent && !verdict.verificationIncomplete).map(verdict => verdict.candidateId));
  const byOrigin = new Map<string, string>();
  for (const candidate of candidates) {
    const origin = candidate.provenance;
    if (origin?.source !== "uncertainty_promotion" || !verified.has(candidate.id) || !compositionCandidateIds.has(candidate.id)) continue;
    const key = JSON.stringify([origin.sourcePacketId, origin.sourceKind, origin.question.trim()]);
    // Ambiguous promotion origins do not get a preferred finding.
    byOrigin.set(key, byOrigin.has(key) ? "" : candidate.id);
  }
  const links = new Map<string, string>();
  for (const hint of hints) {
    const id = byOrigin.get(JSON.stringify([hint.packetId, hint.source, hint.question.trim()]));
    if (id) links.set(`packet/${hint.id}`, id);
  }
  return links;
}

export function packAttentionReconciliation(
  groups: ConcernGroup[],
  allEvidence: Evidence[],
  reviewRevision: Inventory["reviewRevision"],
  links: ReadonlyMap<string, string> = new Map()
): AttentionReconciliation {
  const inventory: Inventory = { reviewRevision, concerns: [], evidence: [], evidenceContexts: [] };
  const omittedConcernIds: string[] = [];
  const omittedEvidenceIds: string[] = [];
  const excludedEvidenceIds: string[] = [];
  for (const group of groups) {
    if (!group.concerns.length) continue;
    const next = [...inventory.concerns, ...group.concerns.map(concern => ({ id: concern.id, question: concern.question, files: concern.scope.files }))];
    // Reserve half the existing allowance for supporting evidence.
    if (JSON.stringify({ ...inventory, concerns: next }).length > MAX_ATTENTION_RECONCILIATION_CHARS / 2) {
      omittedConcernIds.push(...group.concerns.map(concern => concern.id));
      continue;
    }
    inventory.concerns = next;
  }
  const eligible: Evidence[] = [];
  for (const evidence of allEvidence) {
    if (/\[tool result truncated by codegenie tool budget\]/i.test(evidence.text)) {
      excludedEvidenceIds.push(evidence.id);
      continue;
    }
    eligible.push(evidence);
  }
  const fairShare = Math.max(1, (MAX_ATTENTION_RECONCILIATION_CHARS - JSON.stringify(inventory).length)
    / Math.max(1, inventory.concerns.length));
  const fullConcerns = new Map(groups.flatMap(group => group.concerns).map(concern => [concern.id, concern]));
  const concerns = inventory.concerns.map(({ id }) => fullConcerns.get(id)!);
  const relevance = (evidence: Evidence, concern: Concern) => sourceEvidenceRelevance(evidence,
    { ...concern.scope, question: concern.question });
  const queues = concerns.map(concern => eligible.filter(evidence => relevance(evidence, concern) > 0)
    .map(evidence => ({ evidence, priority: evidencePriority(evidence, concern, fairShare) }))
    .sort((a, b) => b.priority - a.priority || a.evidence.text.length - b.evidence.text.length || a.evidence.id.localeCompare(b.evidence.id))
    .map(item => item.evidence));
  const observations = new Set<string>();
  const sizeRejected = new Set<string>();
  const admit = (evidence: Evidence, promotedFromConcern?: string): "added" | "covered" | "rejected" => {
    if (inventory.evidence.some(entry => entry.id === evidence.id)) return "covered";
    const { observation, context } = evidenceProjection(evidence);
    const contexts = inventory.evidenceContexts.some(entry => entry.candidateId === evidence.candidateId)
      ? inventory.evidenceContexts : [...inventory.evidenceContexts, context];
    const key = JSON.stringify([evidence.candidateId, evidence.kind, evidence.sourceField,
      evidence.path, evidence.source, evidence.text, evidence.explanation]);
    const covered = evidence.origin === "repository_tool" && sourceEvidenceCovered(
      { ...evidence, source: evidence.source! },
      inventory.evidence.filter(item => item.origin === "repository_tool" && item.text !== undefined && item.source !== undefined)
        .map(item => ({ ...(item.path ? { path: item.path } : {}), source: item.source!, text: item.text! })));
    if (covered || observations.has(key)) return "covered";
    const replaced = evidence.origin === "repository_tool" ? inventory.evidence.filter(item => item.origin === "repository_tool"
      && item.text !== undefined && item.source !== undefined && sourceEvidenceCovered({ ...item, source: item.source, text: item.text }, [{ ...evidence, source: evidence.source! }])) : [];
    const next = [...inventory.evidence.filter(item => !replaced.includes(item)),
      { ...observation, ...(promotedFromConcern ? { promotedFromConcern } : {}) }];
    if (JSON.stringify({ ...inventory, evidence: next, evidenceContexts: contexts }).length > MAX_ATTENTION_RECONCILIATION_CHARS) {
      sizeRejected.add(evidence.id);
      return "rejected";
    }
    inventory.evidence = next;
    inventory.evidenceContexts = contexts;
    observations.add(key);
    return "added";
  };
  // Reserve at most one proof and one source excerpt per linked concern.
  // Keep the remaining inventory available to the ordinary allocation.
  let linkedAllowance = MAX_ATTENTION_RECONCILIATION_CHARS / 4;
  for (const [position, concern] of concerns.entries()) {
    const candidateId = links.get(concern.id);
    if (!candidateId) continue;
    const suppliedConcern = inventory.concerns[position]!;
    const proofs = eligible.filter(evidence => evidence.candidateId === candidateId
      && (evidence.id.endsWith("/proofAssessment") || evidence.id.endsWith("/verification")))
      .sort((a, b) => Number(b.id.endsWith("/proofAssessment")) - Number(a.id.endsWith("/proofAssessment")));
    const excerpts = eligible.filter(evidence => evidence.candidateId === candidateId && evidence.kind === "excerpt")
      .sort((a, b) => Number(b.id.includes("/evidence/relatedCode/")) - Number(a.id.includes("/evidence/relatedCode/"))
        || evidencePriority(b, concern, fairShare) - evidencePriority(a, concern, fairShare)
        || a.id.localeCompare(b.id));
    for (const choices of [proofs, excerpts]) {
      for (const evidence of choices) {
        if (evidence.sourceRef) {
          // These observations are already in the finding components. Refer
          // to them directly so a duplicate row cannot crowd out other reads.
          const current = suppliedConcern.promotedEvidenceRefs;
          const next = [...(current ?? []), evidence.id];
          const size = JSON.stringify({ ...suppliedConcern, promotedEvidenceRefs: next }).length
            - JSON.stringify(suppliedConcern).length;
          if (size > linkedAllowance || JSON.stringify(inventory).length + size > MAX_ATTENTION_RECONCILIATION_CHARS) continue;
          suppliedConcern.promotedEvidenceRefs = next;
          linkedAllowance -= size;
          break;
        }
        const size = JSON.stringify(evidenceProjection(evidence)).length
          + JSON.stringify({ promotedFromConcern: concern.id }).length;
        if (size > linkedAllowance || admit(evidence, concern.id) !== "added") continue;
        linkedAllowance -= size;
        break;
      }
    }
  }
  // First give each question a complete relevant source. A refusal must not
  // reserve a path or consume an allocation; try its smaller alternatives.
  const sourceQueues = concerns.map(concern => {
    const priority = (evidence: Evidence) => relevance(evidence, concern)
      / Math.max(1, JSON.stringify(evidenceProjection(evidence)).length / fairShare);
    const sources = eligible.filter(evidence => evidence.origin === "repository_tool" && relevance(evidence, concern) > 0)
      .sort((a, b) => priority(b) - priority(a) || a.text.length - b.text.length || a.id.localeCompare(b.id));
    return { concern, sources, priority };
  }).sort((a, b) => (a.sources[0] ? JSON.stringify(evidenceProjection(a.sources[0])).length : Infinity)
    - (b.sources[0] ? JSON.stringify(evidenceProjection(b.sources[0])).length : Infinity) || a.concern.id.localeCompare(b.concern.id));
  for (const { sources, priority } of sourceQueues) {
    if (sources.some(source => priority(source) >= priority(sources[0]!)
      && inventory.evidence.some(entry => entry.id === source.id))) continue;
    for (const source of sources) {
      if (JSON.stringify(evidenceProjection(source)).length > Math.max(fairShare, MAX_ATTENTION_RECONCILIATION_CHARS / 4)) continue;
      if (admit(source) !== "rejected") break;
    }
  }
  // Allocate remaining space in rounds; empty/unrelated queues cannot crowd
  // out another question's evidence. Selected source may cover several questions.
  while (queues.some(queue => queue.length)) {
    for (const queue of queues) {
      while (queue.length) {
        if (admit(queue.shift()!) === "added") break;
      }
    }
  }
  // After each concern had its turn, spare capacity may retain secondary
  // assessments whose relevance is not expressible by source identifiers.
  for (const evidence of [...eligible].sort((a, b) => a.id.localeCompare(b.id))) admit(evidence);
  const supplied = new Map(inventory.evidence.map(evidence => [evidence.id, evidence]));
  const suppliedIds = new Set(supplied.keys());
  omittedEvidenceIds.push(...eligible.filter(evidence => !suppliedIds.has(evidence.id)).map(evidence => evidence.id));
  const selection = concerns.map((concern, index) => ({ concernId: concern.id,
    suppliedRefs: eligible.filter(evidence => inventory.concerns[index]?.promotedEvidenceRefs?.includes(evidence.id)
      || (suppliedIds.has(evidence.id) && (relevance(evidence, concern) > 0 || supplied.get(evidence.id)?.promotedFromConcern === concern.id)))
      .map(evidence => evidence.id),
    omittedForSize: eligible.filter(evidence => !suppliedIds.has(evidence.id) && sizeRejected.has(evidence.id) && relevance(evidence, concern) > 0).map(evidence => evidence.id)
  }));
  return { groups, inventory, allEvidence, omittedConcernIds, omittedEvidenceIds, excludedEvidenceIds, selection };
}

function evidenceProjection(evidence: Evidence) {
  const { verdict, proofStatus, assumptions, ...observation } = evidence;
  const { text: _text, explanation: _explanation, ...reference } = observation;
  return { observation: evidence.sourceRef ? reference : observation,
    context: { candidateId: evidence.candidateId, verdict,
      ...(proofStatus ? { proofStatus } : {}), ...(assumptions ? { assumptions } : {}) } };
}

function evidencePriority(evidence: Evidence, concern: Concern, fairShare: number): number {
  const terms = new Set((concern.question + " " + concern.scope.symbols.join(" "))
    .replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().match(/[\p{L}\p{N}_]{4,}/gu) ?? []);
  const words = new Set((evidence.text + " " + (evidence.explanation ?? "") + " " + (evidence.path ?? ""))
    .replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().match(/[\p{L}\p{N}_]{4,}/gu) ?? []);
  const overlap = [...terms].filter(term => words.has(term)).length / Math.max(terms.size, 1);
  const relevance = (evidence.symbols?.filter(symbol => concern.scope.symbols.includes(symbol) || concern.question.includes(symbol)).length ?? 0) * 2
    + overlap * 4
    + (concern.scope.files.includes(evidence.path ?? "") ? 1 : 0)
    + (evidence.kind === "observation" ? 0.5 : 0)
    + (evidence.sourceRef ? 0.25 : 0)
    + (evidence.origin === "repository_tool"
      ? sourceEvidenceRelevance(evidence, { ...concern.scope, question: concern.question }) : 0);
  return (evidence.candidateId !== concern.candidateId ? 8 : 0)
    + relevance / Math.max(1, JSON.stringify(evidenceProjection(evidence)).length / fairShare);
}

function citableEvidence(input: AttentionReconciliation) {
  return new Map([...input.allEvidence.filter(source => source.sourceRef && !input.excludedEvidenceIds.includes(source.id)),
    ...input.inventory.evidence].map(source => [source.id, source]));
}

export type ReconcileAttentionOptions = {
  /** Candidate ids represented by a published (inline or summary-only) final finding. */
  publishedCandidateIds?: ReadonlySet<string>;
};

export function reconcileAttention(
  input: AttentionReconciliation,
  proposals: Resolution[] | undefined,
  enabled: boolean,
  opts?: ReconcileAttentionOptions
) {
  const supplied = new Set(input.inventory.concerns.map(concern => concern.id));
  const concerns = new Map(input.groups.flatMap(group => group.concerns).filter(concern => supplied.has(concern.id)).map(concern => [concern.id, concern]));
  // An unresolved decision retains the original concern. A narrowing identical
  // to that concern also answers nothing and is therefore unresolved.
  const canonicalizedConcernIds: string[] = [];
  const discardedRewordedConcernIds: string[] = [];
  const submitted = (proposals ?? []).map(proposal => {
    const concern = concerns.get(proposal.concernId);
    if (!concern || proposal.remainingQuestion === undefined ||
      (proposal.disposition !== "unresolved" && !(proposal.disposition === "narrowed" && proposal.remainingQuestion.trim() === concern.question.trim()))) return proposal;
    if (proposal.remainingQuestion.trim() === concern.question.trim()) canonicalizedConcernIds.push(proposal.concernId);
    else discardedRewordedConcernIds.push(proposal.concernId);
    const { remainingQuestion: _unchanged, ...decision } = proposal;
    return { ...decision, disposition: "unresolved" as const };
  });
  // sourceRef exists only when the full observation is already supplied in
  // published finding components. It remains usable when its duplicate registry
  // entry was omitted from the separate attention inventory's size cap.
  const evidence = citableEvidence(input);
  const verdictByRef = new Map(input.allEvidence.map(source => [source.id, source.verdict]));
  const verdictByCandidate = new Map(input.inventory.evidenceContexts.map(context => [context.candidateId, context.verdict]));
  const publishedCandidateIds = opts?.publishedCandidateIds;
  const isSuppressedFindingRef = (ref: string) => {
    if (publishedCandidateIds === undefined) return false;
    const entry = evidence.get(ref);
    if (!entry) return false;
    const verdict = verdictByRef.get(ref) ?? verdictByCandidate.get(entry.candidateId);
    return (verdict === "keep" || verdict === "revise") && !publishedCandidateIds.has(entry.candidateId);
  };
  const citesSuppressedFinding = (refs: string[]) => refs.some(isSuppressedFindingRef);
  const counts = new Map<string, number>();
  for (const proposal of submitted) counts.set(proposal.concernId, (counts.get(proposal.concernId) ?? 0) + 1);
  const accepted = new Map<string, Resolution>();
  let restoredForSuppressedFindingCount = 0;
  let restoredWithSurvivingRefCount = 0;
  const decisions = submitted.map(proposal => {
    const concern = concerns.get(proposal.concernId);
    const refs = proposal.supportingRefs;
    const reason = !enabled ? "composition_unavailable"
      : !concern ? "unknown_or_ineligible_concern"
      : counts.get(proposal.concernId)! > 1 ? "duplicate_resolution"
      : !proposal.rationale.trim() ? "empty_rationale"
      : (proposal.disposition !== "unresolved" && !refs.length) || refs.some(ref => !evidence.has(ref)) ? "unknown_or_omitted_evidence"
      : new Set(refs).size !== refs.length ? "duplicate_evidence"
      : refs.some(ref => evidence.get(ref)!.candidateId === concern.candidateId) ? "self_support"
      : proposal.disposition === "narrowed" && (!proposal.remainingQuestion?.trim() || proposal.remainingQuestion.trim() === concern.question.trim()) ? "missing_or_unchanged_remaining_question"
      : proposal.disposition !== "narrowed" && proposal.remainingQuestion !== undefined ? "conflicting_remaining_question"
      : proposal.disposition !== "unresolved" && citesSuppressedFinding(refs) ? "suppressed_finding_evidence"
      : undefined;
    if (!reason) accepted.set(proposal.concernId, proposal);
    else if (reason === "suppressed_finding_evidence") {
      restoredForSuppressedFindingCount += 1;
      if (refs.some(ref => !isSuppressedFindingRef(ref))) restoredWithSurvivingRefCount += 1;
    }
    return { ...proposal, accepted: !reason, ...(reason ? { rejectionReason: reason } : {}) };
  });
  const notes: NeedsHumanAttentionNote[] = [];
  const outcomes = input.groups.map(group => {
    const changed = group.concerns.some(concern => {
      const decision = accepted.get(concern.id);
      return decision && decision.disposition !== "unresolved";
    });
    const remaining = changed ? group.concerns.flatMap(concern => {
      const resolution = accepted.get(concern.id);
      if (resolution?.disposition === "resolved") return [];
      return [resolution?.disposition === "narrowed" ? safeReportProse(resolution.remainingQuestion!.trim()) : concern.question];
    }).join("; ") : group.original.question;
    if (remaining && !notes.some(note => note.question === remaining)) notes.push({ ...group.original, question: remaining });
    return { candidateId: group.candidateId, original: group.original, remainingQuestion: remaining,
      concernIds: group.concerns.map(concern => concern.id), ...(group.ineligibleReason ? { ineligibleReason: group.ineligibleReason } : {}) };
  });
  return { notes, decisions, outcomes, canonicalizedConcernIds, discardedRewordedConcernIds, restoredForSuppressedFindingCount, restoredWithSurvivingRefCount };
}

/** Require coverage only for concerns actually delivered within the inventory cap. */
export function attentionResolutionErrors(input: AttentionReconciliation, proposals: Resolution[] | undefined): string[] {
  const decisions = reconcileAttention(input, proposals, true).decisions;
  const covered = new Set(decisions.map(decision => decision.concernId));
  return [
    ...input.inventory.concerns.filter(concern => !covered.has(concern.id)).map(concern => `Missing attentionResolutions decision for ${concern.id}`),
    ...decisions.filter(decision => !decision.accepted).map(decision => {
      const message = `Invalid attentionResolutions decision for ${decision.concernId}: ${decision.rejectionReason}`;
      if (decision.rejectionReason !== "unknown_or_omitted_evidence" && decision.rejectionReason !== "self_support") return message;
      const concern = input.groups.flatMap(group => group.concerns).find(item => item.id === decision.concernId);
      const evidence = citableEvidence(input);
      const permitted = [...evidence.values()].filter(item => item.candidateId !== concern?.candidateId);
      const ranked = permitted.map(item => ({ id: item.id, relevance: concern ? sourceEvidenceRelevance(
        { ...item, text: item.text ?? input.allEvidence.find(source => source.id === item.id)?.text ?? "" },
        { ...concern.scope, question: concern.question }) : 0 }))
        .sort((a, b) => b.relevance - a.relevance || a.id.localeCompare(b.id));
      const rejectedRefs = decision.supportingRefs.filter(ref => !evidence.has(ref) || evidence.get(ref)!.candidateId === concern?.candidateId);
      return `${message}. Reference diagnostics: ${JSON.stringify({ rejectedRefs,
        permittedRefs: ranked.slice(0, 8).map(item => item.id), omittedPermittedRefCount: Math.max(0, ranked.length - 8) })}. Cite only references whose content supports the decision; otherwise retain the unanswered question.`;
    })
  ];
}

// Replace this small decision list atomically, keeping all finding prose and
// source accounting untouched. Index merging cannot remove duplicate decisions.
export function createAttentionResolutionRepair(schema: TSchema, original: SubmitComposition, input: AttentionReconciliation): FieldRepair | undefined {
  const errors = attentionResolutionErrors(input, original.attentionResolutions);
  // Unexpected keys are dropped by shape cleanup; they must not divert an
  // attention-only failure to index-merging field repair, whose partial lists
  // cannot meet the pinned decision count.
  const cleaned = cleanupSubmitShape(schema, original);
  if (!errors.length || cleaned.unusablePaths.length || submissionIssues(schema, cleaned.arguments).some(issue => !issue.path.startsWith("attentionResolutions"))) return;
  const patchSchema = Type.Object({ attentionResolutions: structuredClone((schema as typeof SubmitCompositionSchema).properties.attentionResolutions) }, { additionalProperties: false, required: ["attentionResolutions"] });
  const baseline = structuredClone(cleaned.arguments) as Record<string, unknown>;
  return {
    schema: patchSchema, baseline, paths: ["attentionResolutions"], diagnostics: focusedRepairDiagnostics(schema, cleaned.arguments),
    prompt: `Repair only attentionResolutions; return the complete replacement list. Assess every supplied concern exactly once. Compare with supplied evidence and published findings; use unresolved with a reason and empty supportingRefs when evidence cannot answer it. Resolved/narrowed decisions require independent supporting references. Preserve unanswered parts in narrowed remainingQuestion. All findings and their sources are retained unchanged.\n${errors.join("\n")}`,
    merge(values) {
      const cleaned = cleanupSubmitShape(patchSchema, values);
      const issues = submissionIssues(patchSchema, cleaned.arguments);
      if (cleaned.unusablePaths.length || issues.length) throw new Error(`Invalid attentionResolutions repair: ${JSON.stringify(issues)}`);
      return { ...structuredClone(baseline), attentionResolutions: structuredClone((cleaned.arguments as Record<string, unknown>).attentionResolutions) };
    }
  };
}
