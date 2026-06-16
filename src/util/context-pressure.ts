export const LOCAL_TOOL_BUDGET_REJECTION_REASONS = new Set([
  "tool_result_budget_exhausted",
  "tool_call_budget_exhausted",
  "investigation_round_budget_exhausted"
]);

export function isLocalToolBudgetRejectionReason(reason: unknown): reason is string {
  return typeof reason === "string" && LOCAL_TOOL_BUDGET_REJECTION_REASONS.has(reason);
}
