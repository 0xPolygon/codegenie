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
