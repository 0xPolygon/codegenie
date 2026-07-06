import type { ToolBudget } from "../types.js";

// Grace window appended to a per-pass soft deadline so a pass whose
// investigation is complete can finish its finalize/submit call instead of
// being killed at the boundary (plan 85). Floor of 120s covers slow-provider
// finalize calls; proportional for small (test-sized) budgets; capped at 240s.
export function finalizeGraceMs(timeoutMs: number): number {
  return Math.min(240_000, Math.max(Math.ceil(timeoutMs / 4), Math.min(120_000, timeoutMs)));
}

export function scaleBudgetValue(value: number, multiplier: number): number {
  if (value <= 0) {
    return 0;
  }
  return Math.max(1, Math.ceil(value * multiplier));
}

export function scaleOptionalBudgetValue(value: number | undefined, multiplier: number): number | undefined {
  return value === undefined ? undefined : scaleBudgetValue(value, multiplier);
}

export function scaleToolBudget(budget: ToolBudget, multiplier: number): ToolBudget {
  const scaled: ToolBudget = {
    maxToolCalls: scaleBudgetValue(budget.maxToolCalls, multiplier),
    maxInvestigationRounds: scaleBudgetValue(budget.maxInvestigationRounds, multiplier),
    maxResultChars: scaleBudgetValue(budget.maxResultChars, multiplier)
  };
  if (budget.maxSingleToolResultChars !== undefined) {
    scaled.maxSingleToolResultChars = scaleBudgetValue(budget.maxSingleToolResultChars, multiplier);
  }
  if (budget.reservedSourceResultChars !== undefined) {
    scaled.reservedSourceResultChars = scaleBudgetValue(budget.reservedSourceResultChars, multiplier);
  }
  if (budget.sourceExtension !== undefined) {
    scaled.sourceExtension = {
      maxToolCalls: scaleBudgetValue(budget.sourceExtension.maxToolCalls, multiplier),
      maxResultChars: scaleBudgetValue(budget.sourceExtension.maxResultChars, multiplier)
    };
  }
  return scaled;
}
