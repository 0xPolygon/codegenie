import { isDeepStrictEqual } from "node:util";
import { validateToolCall } from "@earendil-works/pi-ai";
import { FindingUpdatesSchema, SubmittedFindingSchema, type SubmitVerificationVerdict } from "./schemas.js";
import type { CandidateFinding } from "../types.js";
import type { ValidationIssue } from "./submit-preservation.js";

const PROMOTED_COMPLETION_FIELDS = ["title", "failureMode", "whyThisMatters", "verification", "category", "severity", "confidence"] as const;

function promotedCompletion(candidate: CandidateFinding, value: unknown) {
  if (candidate.provenance?.source !== "uncertainty_promotion" || !value || typeof value !== "object" || Array.isArray(value)) return;
  const verdict = value as Record<string, unknown>;
  if (verdict.verdict !== "keep" && verdict.verdict !== "revise") return;
  const field = verdict.finalFinding !== undefined ? "finalFinding" : "findingUpdates";
  const revision = verdict[field];
  // Schema validation owns malformed containers; never guess child paths in them.
  if (revision !== undefined && (!revision || typeof revision !== "object" || Array.isArray(revision))) return;
  const missing = PROMOTED_COMPLETION_FIELDS.filter(key => !revision ||
    !Object.hasOwn(revision, key) || (revision as Record<string, unknown>)[key] === undefined);
  return { field, missing, hasRevision: revision !== undefined };
}

/** Recomputed from the retained draft by the existing repair hook on every attempt. */
export function promotedCompletionIssues(candidate: CandidateFinding, value: unknown): ValidationIssue[] {
  const completion = promotedCompletion(candidate, value);
  if (!completion?.missing.length) return [];
  return (completion.hasRevision ? completion.missing.map(key => `${completion.field}.${key}`) : [completion.field])
    .map(path => ({ path, kind: "missing" }));
}

// Called on the trusted submission after sparse patches, before candidate
// defaults obscure which decisions the verifier actually supplied.
function requirePromotedCompletion(candidate: CandidateFinding, verdict: SubmitVerificationVerdict): void {
  const completion = promotedCompletion(candidate, verdict);
  if (completion?.missing.length) throw new Error("Promoted investigation requires explicit final decisions. Supply missing revision fields "
    + completion.missing.map(field => `${completion.field}.${field}`).join(", ")
    + " (or a complete finalFinding). Retained model-supplied fields need not be repeated; reason is not a revision.");
}

// Only an explicit, trusted effective verdict selects this branch. Callers must
// establish argument provenance before normalization; sparse patches are merged first.
export function canonicalizeVerifierRejection(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      (value as Record<string, unknown>).verdict !== "reject") return undefined;
  const input = value as Record<string, unknown>;
  const removedFields = ["findingUpdates", "finalFinding", "revisedAnchor"].filter(key => Object.hasOwn(input, key));
  if (!removedFields.length) return undefined;
  const effective = { ...input };
  for (const key of removedFields) delete effective[key];
  return { value: effective, removedFields, reason: "reject_revision_fields_inapplicable" };
}

// Bind omitted assessment text while the trusted draft is first normalized,
// before retaining it for repair. A later patch changing only the suggestion
// must not silently transfer an old assessment to the new text.
export function normalizeVerifierSubmission(candidate: CandidateFinding, value: unknown) {
  const rejection = canonicalizeVerifierRejection(value);
  const effective = rejection?.value ?? value;
  if (!effective || typeof effective !== "object" || Array.isArray(effective)) return rejection;
  const input = effective as Record<string, unknown>;
  const revisions = [input.findingUpdates, input.finalFinding].filter(revision => revision !== undefined);
  const supplied = input.suggestionAssessments;
  if (!supplied || typeof supplied !== "object" || Array.isArray(supplied)) return rejection;
  const assessments = { ...supplied } as Record<string, unknown>;
  const addedFields: string[] = [];
  let ambiguous = false;
  for (const field of ["suggestedFix", "suggestedTest"] as const) {
    const assessment = assessments[field];
    if (!assessment || typeof assessment !== "object" || Array.isArray(assessment)
      || Object.hasOwn(assessment, "suggestionText")) continue;
    const texts = revisions.length ? revisions.map(revision => {
      if (!revision || typeof revision !== "object" || Array.isArray(revision)) return undefined;
      return Object.hasOwn(revision, field) ? (revision as Record<string, unknown>)[field] : candidate[field];
    }) : [candidate[field]];
    const text = texts[0];
    if (typeof text === "string" && text && texts.every(value => value === text)) {
      assessments[field] = { ...assessment, suggestionText: text };
      addedFields.push(`suggestionAssessments.${field}.suggestionText`);
    } else if ((assessment as Record<string, unknown>).status === "supported") {
      // Conflicting/malformed representations do not identify the assessed
      // text. Preserve the draft but do not let a later repair choose a target
      // for old support. A newly supplied assessment can establish it again.
      const rationale = (assessment as Record<string, unknown>).rationale;
      const explanation = "The original assessment did not identify one unambiguous suggestion; reassessment is required. ";
      assessments[field] = { ...assessment, status: "unverified",
        ...(typeof rationale === "string" && rationale.length > 0
          ? { rationale: explanation + rationale.slice(0, 2000 - explanation.length) } : {}) };
      ambiguous = true;
    }
  }
  return addedFields.length || ambiguous ? { value: { ...input, suggestionAssessments: assessments },
    removedFields: rejection?.removedFields ?? [], addedFields,
    reason: ambiguous ? "verifier_assessment_target_ambiguous" : "verifier_assessment_text_bound" } : rejection;
}

// Whitelist schema fields so internal identity/provenance can never be patched.
// Placement goes through the existing revisedAnchor validation instead.
export function expandVerifierRevision(
  candidate: CandidateFinding,
  verdict: SubmitVerificationVerdict
): SubmitVerificationVerdict {
  verdict = (canonicalizeVerifierRejection(verdict)?.value ?? verdict) as SubmitVerificationVerdict;
  requirePromotedCompletion(candidate, verdict);
  if (verdict.findingUpdates === undefined) return verdict;
  validateToolCall(
    [{ name: "updates", description: "", parameters: FindingUpdatesSchema }],
    { type: "toolCall", id: "updates", name: "updates", arguments: verdict.findingUpdates }
  );
  if (verdict.finalFinding !== undefined) {
    const full = validateToolCall(
      [{ name: "finding", description: "", parameters: SubmittedFindingSchema }],
      { type: "toolCall", id: "finding", name: "finding", arguments: verdict.finalFinding }
    ) as NonNullable<SubmitVerificationVerdict["finalFinding"]>;
    const conflicts = Object.keys(verdict.findingUpdates).filter(key =>
      !isDeepStrictEqual(verdict.findingUpdates![key as keyof typeof verdict.findingUpdates], full[key as keyof typeof full]));
    if (conflicts.length) throw new Error(`findingUpdates and finalFinding are mutually exclusive when conflicting: ${conflicts.join(", ")}. Return exactly one revision representation.`);
    const { findingUpdates: _updates, ...rest } = verdict;
    return { ...rest, finalFinding: full };
  }
  const original = Object.fromEntries(
    Object.keys(SubmittedFindingSchema.properties)
      .filter((key) => key !== "anchor" && candidate[key as keyof CandidateFinding] !== undefined)
      .map((key) => [key, candidate[key as keyof CandidateFinding]])
  );
  const merged = { ...original, ...verdict.findingUpdates };
  const finalFinding = validateToolCall(
    [{ name: "finding", description: "", parameters: SubmittedFindingSchema }],
    { type: "toolCall", id: "finding", name: "finding", arguments: merged }
  ) as NonNullable<SubmitVerificationVerdict["finalFinding"]>;
  const { findingUpdates: _updates, ...rest } = verdict;
  return { ...rest, finalFinding };
}
