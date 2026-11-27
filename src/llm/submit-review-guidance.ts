import type { SubmitPacketReview } from "./schemas.js";

// Shape-only example: deliberately unrelated to any review fixture.
export const SUBMIT_REVIEW_EXAMPLE = {
  reviewStatus: "findings",
  findings: [{
    title: "Empty input reaches an unchecked array access",
    severity: "medium",
    confidence: "high",
    path: "example.ts",
    category: "correctness",
    evidence: { changedCode: "return items[0].id;" },
    failureMode: "An empty items array causes a property access on undefined.",
    whyThisMatters: "Valid empty requests fail instead of returning an empty result.",
    verification: "Check whether the caller guarantees a nonempty array."
  }],
  followUpHints: [],
  uncertainties: []
} satisfies SubmitPacketReview;

export const SUBMIT_REVIEW_SHAPE_GUIDANCE = [
  "Submit findings as an array of JSON objects, never JSON-encoded strings or comma-split fragments. Nested evidence and anchor values are objects too.",
  "Always include findings, followUpHints, and uncertainties as arrays; use [] for an empty array.",
  "Shape-only example (not evidence or a finding to copy; replace with your actual review, and add an anchor only from the reviewed diff):",
  JSON.stringify(SUBMIT_REVIEW_EXAMPLE)
].join("\n");

export function submitReviewShapeGuidance(changeCheckHunkId?: string): string {
  if (changeCheckHunkId === undefined) return SUBMIT_REVIEW_SHAPE_GUIDANCE;
  const example = {
    ...SUBMIT_REVIEW_EXAMPLE,
    changeChecks: [{
      hunkId: changeCheckHunkId,
      changeKind: "acceptance",
      before: "An empty request returns an empty result.",
      after: "An empty request reaches the first item access.",
      breakAttempt: "Send an empty array; the request throws instead of returning an empty result.",
      result: "finding",
      ref: 0
    }]
  } satisfies SubmitPacketReview;
  const lines = SUBMIT_REVIEW_SHAPE_GUIDANCE.split("\n");
  lines.pop();
  return [...lines, JSON.stringify(example)].join("\n");
}
