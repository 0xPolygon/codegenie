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

const SUBMIT_REVIEW_SHAPE_LINES = [
  "Submit findings as an array of JSON objects, never JSON-encoded strings or comma-split fragments. Nested evidence and anchor values are objects too.",
  "Always include findings, followUpHints, and uncertainties as arrays; use [] for an empty array.",
  "Shape-only example (not evidence or a finding to copy; replace with your actual review, and add an anchor only from the reviewed diff):"
];

export const SUBMIT_REVIEW_SHAPE_GUIDANCE = [...SUBMIT_REVIEW_SHAPE_LINES, JSON.stringify(SUBMIT_REVIEW_EXAMPLE)].join("\n");

export const ASSIGNED_EFFECTS_GUIDANCE =
  'Include assignedEffects identifying what each assigned hunk removes, skips or stops guaranteeing, or which guard it relies on, with the source call or line supporting safety or the resulting finding or question, using none only with safe and reporting only evaluated hunks for reviewStatus "incomplete".';

export function assignedEffectsSubmitShape(hunkId?: string): string {
  return [...SUBMIT_REVIEW_SHAPE_LINES, JSON.stringify({ ...SUBMIT_REVIEW_EXAMPLE,
    assignedEffects: hunkId === undefined ? [] : [{
      hunkId, effect: "Empty requests no longer return an empty result.", kind: "skipped_path", disposition: "finding",
      basis: "The first finding describes the unchecked items[0] access."
    }]
  })].join("\n");
}
