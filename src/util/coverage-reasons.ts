// Also serialized into the Stage 10 prompt. The coverage renderer replaces it
// with a reader-facing disclosure without changing the input or run artifacts.
export const PLANNER_DEGRADED_REASON = "planner degraded; deterministic default plan used";

const NON_DISCLOSABLE_COVERAGE_PREFIXES = [
  "planner_missing_coverage",
  "default_coverage"
] as const;

export function isDisclosableCoverageReason(reason: string): boolean {
  const trimmed = reason.trim();
  if (trimmed.length === 0) {
    return false;
  }
  return !NON_DISCLOSABLE_COVERAGE_PREFIXES.some((prefix) =>
    trimmed.startsWith(prefix) || trimmed.includes(`: ${prefix}`)
  );
}

export function uniqueDisclosableCoverageReasons(reasons: string[]): string[] {
  return [...new Set(reasons.filter(isDisclosableCoverageReason))];
}
