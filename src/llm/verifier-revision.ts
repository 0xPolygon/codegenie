import { validateToolCall } from "@earendil-works/pi-ai";
import { FindingUpdatesSchema, SubmittedFindingSchema, type SubmitVerificationVerdict } from "./schemas.js";
import type { CandidateFinding } from "../types.js";

// Whitelist schema fields so internal identity/provenance can never be patched.
// Placement goes through the existing revisedAnchor validation instead.
export function expandVerifierRevision(
  candidate: CandidateFinding,
  verdict: SubmitVerificationVerdict
): SubmitVerificationVerdict {
  if (verdict.findingUpdates === undefined) return verdict;
  if (verdict.finalFinding !== undefined) throw new Error("findingUpdates and finalFinding are mutually exclusive");
  if (verdict.verdict === "reject") throw new Error("reject cannot carry findingUpdates");
  validateToolCall(
    [{ name: "updates", description: "", parameters: FindingUpdatesSchema }],
    { type: "toolCall", id: "updates", name: "updates", arguments: verdict.findingUpdates }
  );
  const original = Object.fromEntries(
    Object.keys(SubmittedFindingSchema.properties)
      .filter((key) => key !== "anchor" && candidate[key as keyof CandidateFinding] !== undefined)
      .map((key) => [key, candidate[key as keyof CandidateFinding]])
  );
  const merged = { ...original, ...verdict.findingUpdates };
  const finalFinding = validateToolCall(
    [{ name: "finding", description: "", parameters: SubmittedFindingSchema }],
    { type: "toolCall", id: "finding", name: "finding", arguments: merged }
  ) as NonNullable<SubmitVerificationVerdict["finalFinding"]>;
  const { findingUpdates: _updates, ...rest } = verdict;
  return { ...rest, finalFinding };
}
