import type { BehaviorChangeAssessment, Severity } from "../types.js";

// Only an explicit intentional_needs_confirmation caps severity. "unknown" is
// an honest absence of evidence and is treated identically to an omitted
// field (plan 82) — punishing it taught models to omit the field instead.
export function capSeverityForBehaviorChange(
  severity: Severity,
  behaviorChange: BehaviorChangeAssessment | undefined
): Severity {
  if (behaviorChange !== "intentional_needs_confirmation") {
    return severity;
  }
  return severity === "critical" || severity === "high" ? "medium" : severity;
}

// Applies the cap and preserves the pre-cap severity when it fired, so
// composition guarantees can consult the original ranking.
export function applySeverityPolicy(
  severity: Severity,
  behaviorChange: BehaviorChangeAssessment | undefined
): { severity: Severity; severityBeforeCap?: Severity } {
  const capped = capSeverityForBehaviorChange(severity, behaviorChange);
  return capped === severity ? { severity: capped } : { severity: capped, severityBeforeCap: severity };
}

const GUARANTEE_RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2, critical: 3 };

export function guaranteeSeverity(finding: { severity: Severity; severityBeforeCap?: Severity }): Severity {
  const before = finding.severityBeforeCap;
  return before !== undefined && GUARANTEE_RANK[before] > GUARANTEE_RANK[finding.severity]
    ? before
    : finding.severity;
}

export function hasCriticalOrHighGuarantee(finding: { severity: Severity; severityBeforeCap?: Severity }): boolean {
  const severity = guaranteeSeverity(finding);
  return severity === "critical" || severity === "high";
}
