import type { BehaviorChangeAssessment, Severity } from "../types.js";

export function capSeverityForBehaviorChange(
  severity: Severity,
  behaviorChange: BehaviorChangeAssessment | undefined
): Severity {
  if (behaviorChange !== "intentional_needs_confirmation" && behaviorChange !== "unknown") {
    return severity;
  }
  return severity === "critical" || severity === "high" ? "medium" : severity;
}
