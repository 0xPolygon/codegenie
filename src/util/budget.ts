import type { ToolBudget } from "../types.js";

export const SCHEMA_REPAIR_TIMEOUT_MS = 180_000;

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
  if (budget.maxDiscoveryResultChars !== undefined) {
    scaled.maxDiscoveryResultChars = scaleBudgetValue(budget.maxDiscoveryResultChars, multiplier);
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

/**
 * Local investigation totals have one configured target and a fixed 2x ceiling.
 * Per-result limits and source targets are not multiplied. Legacy source
 * extensions are subsumed by this headroom, never added to the ceiling.
 */
export function hardToolBudget(soft: ToolBudget): ToolBudget {
  const { sourceExtension: _legacyExtension, ...limits } = soft;
  return {
    ...limits,
    maxToolCalls: scaleBudgetValue(soft.maxToolCalls, 2),
    maxInvestigationRounds: scaleBudgetValue(soft.maxInvestigationRounds, 2),
    maxResultChars: scaleBudgetValue(soft.maxResultChars, 2)
  };
}
