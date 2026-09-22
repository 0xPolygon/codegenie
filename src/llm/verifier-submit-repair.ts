import type { LlmSchemaInvalidSubmitRecoveryInput } from "./llm-runner.js";
import type { SubmitVerificationVerdict } from "./schemas.js";
import { SUBMIT_REVIEW_EXAMPLE } from "./submit-review-guidance.js";

// Decode only a complete object at the known object-valued field. The runner
// revalidates the entire verdict and its semantic constraints before accepting it.
export function recoverStringWrappedVerifierFinding(input: LlmSchemaInvalidSubmitRecoveryInput): Record<string, unknown> | undefined {
  if (input.submitCalls.length !== 1) return undefined;
  const args = input.submitCalls[0]!.arguments;
  if (typeof args.finalFinding !== "string") return undefined;
  try {
    const finding: unknown = JSON.parse(args.finalFinding);
    if (finding === null || typeof finding !== "object" || Array.isArray(finding)) return undefined;
    return { ...args, finalFinding: finding };
  } catch {
    return undefined;
  }
}

export const VERIFIER_SUBMIT_EXAMPLE = {
  verdict: "revise",
  reason: "The empty-input failure is confirmed; clarify the trigger in the finding.",
  requiredEvidencePresent: true,
  falsePositiveRisk: "low",
  finalFinding: SUBMIT_REVIEW_EXAMPLE.findings[0]!
} satisfies SubmitVerificationVerdict;

export const VERIFIER_SUBMIT_SHAPE_GUIDANCE = [
  "Prefer findingUpdates: a small JSON object with only changed fields. Omitted fields are preserved from the candidate. Never JSON-encode the object. Replace evidence only when it changed, supplying changedCode and any relatedCode to retain. Keep evidence concise.",
  "Shape-only example (replace with actual verified values; do not copy this example as evidence):",
  JSON.stringify({ verdict: "revise", reason: "The empty-input trigger is confirmed; clarify the title.", requiredEvidencePresent: true, falsePositiveRisk: "low", findingUpdates: { title: "Empty input causes an out-of-bounds access" } } satisfies SubmitVerificationVerdict),
  "For an anchor-only revision, use revisedAnchor as an object containing the verified path, line, side, and hunkId instead of rewriting the finding. Do not combine findingUpdates with finalFinding."
].join("\n");
