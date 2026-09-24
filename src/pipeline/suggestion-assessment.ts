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
  if (!supplied) return { status: "unverified", suggestionText: text, rationale: "Behavioral requirement compatibility was not assessed.", evidence: [] };
  if (supplied.suggestionText !== text) return { status: "unverified", suggestionText: text, rationale: "The suggestion changed after its assessment; compatibility must be checked again.", evidence: [] };
  if (supplied.status === "supported") {
    const reason = supplied.contractCheck?.status !== "established" ? "The behavioral requirement was not established."
      : !supplied.contractCheck.requirement.trim() ? "The assessment supplied no behavioral requirement."
      : !supplied.evidence.some(item => item.path.trim() && item.lines.trim() && item.whyRelevant.trim())
        ? "The assessment supplied no complete source evidence." : undefined;
    if (reason) return { ...supplied, status: "unverified", rationale: reason + " " + supplied.rationale };
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

// Exact proposal identity only. An incompatible source remains incompatible;
// another source cannot make the same proposal unconditionally supported.
export function conflictingSuggestions(findings: CandidateFinding[]): Set<string> {
  const statuses = new Map<string, Set<string>>();
  for (const finding of findings) for (const field of ["suggestedFix", "suggestedTest"] as const) {
    const assessment = suggestionAssessment(finding, field);
    if (!assessment) continue;
    const key = field + "\0" + assessment.suggestionText;
    const values = statuses.get(key) ?? new Set<string>();
    values.add(assessment.status);
    statuses.set(key, values);
  }
  return new Set([...statuses].filter(([, values]) => values.has("supported") && values.has("incompatible")).map(([key]) => key));
}
