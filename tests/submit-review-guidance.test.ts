import { validateToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { SubmitPacketReviewSchema } from "../src/llm/schemas.js";
import { SUBMIT_REVIEW_EXAMPLE } from "../src/llm/submit-review-guidance.js";

const tool = { name: "submit_review", description: "submit", parameters: SubmitPacketReviewSchema };
const call = (args: Parameters<typeof validateToolCall>[1]["arguments"]) =>
  validateToolCall([tool], { type: "toolCall", id: "submit", name: tool.name, arguments: args });

describe("review submission guidance and schema", () => {
  it("provides a valid object-valued example", () => {
    expect(() => call(SUBMIT_REVIEW_EXAMPLE)).not.toThrow();
  });

  it("rejects the string-fragment shape observed in run 68", () => {
    // Synthetic content reproduces the captured shape without private repo data.
    const fragments = JSON.stringify(SUBMIT_REVIEW_EXAMPLE.findings).split(",");
    expect(() => call({ reviewStatus: "findings", findings: fragments })).toThrow();
    expect(() => call({ ...SUBMIT_REVIEW_EXAMPLE, findings: fragments })).toThrow();
    expect(() => call({
      ...SUBMIT_REVIEW_EXAMPLE,
      findings: [JSON.stringify(SUBMIT_REVIEW_EXAMPLE.findings[0])]
    })).toThrow();
  });

  it("retains enum, required-field, and additional-property validation", () => {
    for (const severity of ["critical", "high", "medium", "low"]) {
      expect(() => call({ ...SUBMIT_REVIEW_EXAMPLE, findings: [{ ...SUBMIT_REVIEW_EXAMPLE.findings[0], severity }] })).not.toThrow();
    }
    expect(() => call({ ...SUBMIT_REVIEW_EXAMPLE, findings: [{ ...SUBMIT_REVIEW_EXAMPLE.findings[0], severity: "urgent" }] })).toThrow();
    expect(() => call({ findings: SUBMIT_REVIEW_EXAMPLE.findings, uncertainties: [] })).toThrow();
    expect(() => call({ ...SUBMIT_REVIEW_EXAMPLE, invented: true })).toThrow();
  });
});
