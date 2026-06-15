import type { ToolBudget } from "../types.js";

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
  return scaled;
}
