import type { CandidateFinding, SuggestionAssessment, SuggestionAssessments } from "../types.js";

export type SuggestionField = "suggestedFix" | "suggestedTest";

// Support applies only to the exact text assessed, never a later revision.
// Missing/legacy assessments are not proof. A supported assessment without
// source evidence is conservatively unverified rather than losing the finding.
export function suggestionAssessment(
  finding: Pick<CandidateFinding, "suggestedFix" | "suggestedTest" | "suggestionAssessments">,
  field: SuggestionField
): SuggestionAssessment | undefined {
  const text = finding[field];
  if (!text) return undefined;
  const supplied = finding.suggestionAssessments?.[field];
  if (!supplied) return { status: "unverified", suggestionText: text, rationale: "Caller-contract compatibility was not assessed.", evidence: [] };
  if (supplied.suggestionText !== text) return { status: "unverified", suggestionText: text, rationale: "The suggestion changed after its assessment; compatibility must be checked again.", evidence: [] };
  if (supplied.status === "supported" && !supplied.evidence.length) {
    return { ...supplied, status: "unverified", rationale: "The assessment supplied no source evidence. " + supplied.rationale };
  }
  return supplied;
}

export function assessFinalSuggestions(
  finding: Pick<CandidateFinding, "suggestedFix" | "suggestedTest">,
  assessments?: SuggestionAssessments
): SuggestionAssessments {
  const result: SuggestionAssessments = {};
  for (const field of ["suggestedFix", "suggestedTest"] as const) {
    const assessment = suggestionAssessment({ ...finding, ...(assessments ? { suggestionAssessments: assessments } : {}) }, field);
    if (assessment) result[field] = assessment;
  }
  return result;
}
