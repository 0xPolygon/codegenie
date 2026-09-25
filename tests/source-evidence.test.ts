import { prettyStableJson } from "../src/util/json.js";
import { describe, expect, it } from "vitest";
import { MAX_VERIFIER_SOURCE_EVIDENCE_CHARS, selectVerifierSourceEvidence, sourceEvidenceRelevance, sourceEvidenceCovered } from "../src/pipeline/source-evidence.js";
import { authorizationComposition } from "./fixtures/composition/authorization-review.js";
import type { PacketReviewResult, RepositoryEvidence } from "../src/types.js";

describe("previously collected verifier source", () => {
  it("ranks a qualified method body above an unrelated header without assuming language syntax", () => {
    const scope = { question: "Does the method enforce the required document permission?", files: ["access.custom"], symbols: ["DocumentAccess.authorize"] };
    const body = { path: "access.custom", text: "method authorize on DocumentAccess { require permission; }" };
    const header = { path: "access.custom", text: "method authorize on OtherAccess;" };
    expect(sourceEvidenceRelevance(body, scope)).toBeGreaterThan(sourceEvidenceRelevance(header, scope));
    expect(sourceEvidenceRelevance({ text: "DocumentAccessExtra authorizeExtra", path: "unrelated.custom" }, scope)).toBe(0);
  });
  it("uses code identifiers in the finding to include a cross-file implementation without symbol metadata", () => {
    const candidate = authorizationComposition().findings[0]!;
    candidate.title = "ExportRequest constraint rejection is untested";
    candidate.failureMode = "Removing the ExportRequest check leaves current tests green.";
    candidate.path = "export-handler.ts";
    candidate.evidence.relatedCode = [{ path: "contracts/export.custom", lines: "ExportRequest limit = 80", whyRelevant: "Declared constraint." }];
    const declaration = "record ExportRequest { limit = 80 }\n";
    const full = declaration + "# unrelated declarations\n".repeat(80);
    const implementation = "function check(value: ExportRequest) { return value.limit <= 80; }";
    const packet: PacketReviewResult = { packetId: "contracts", findings: [], followUpHints: [], uncertainties: [], lenses: [], status: "completed",
      repositoryEvidence: [
        { id: "schema", tool: "read_range", source: "head", path: "contracts/export.custom", text: full },
        { id: "schema-overlap", tool: "read_range", source: "head", path: "contracts/export.custom", text: full + "# more declarations\n".repeat(80) },
        { id: "implementation", tool: "read_range", source: "head", path: "generated/checks.ts", text: implementation },
        { id: "similar-name", tool: "read_range", source: "head", path: "unrelated.ts", text: "ExportRequestExtra limit = 80" }
      ] };
    const before = structuredClone(packet);
    const selected = selectVerifierSourceEvidence(candidate, [packet]);
    expect(selected).toContainEqual(expect.objectContaining({ id: "implementation", text: implementation, packetId: "contracts", source: "head" }));
    expect(selected.some(read => read.id === "similar-name")).toBe(false);
    expect(selected.filter(read => read.path === "contracts/export.custom")).toHaveLength(1);
    expect(prettyStableJson(selected).length).toBeLessThanOrEqual(MAX_VERIFIER_SOURCE_EVIDENCE_CHARS);
    expect(packet).toEqual(before);
  });

  it("does not use prose overlap alone to admit unrelated files", () => {
    expect(sourceEvidenceRelevance({ path: "other.txt", text: "the constraint rejection remains untested" },
      { question: "Is the constraint rejection tested?", files: ["handler.txt"], symbols: [] })).toBe(0);
  });

  it("deduplicates contained source without dropping different revisions, files or unique overlapping content", () => {
    const read = { path: "policy.custom", source: "head" as const, text: "first\nsecond\nthird" };
    expect(sourceEvidenceCovered({ ...read, text: "second\nthird" }, [read])).toBe(true);
    expect(sourceEvidenceCovered({ ...read, source: "base" }, [read])).toBe(false);
    expect(sourceEvidenceCovered({ ...read, path: "other.custom" }, [read])).toBe(false);
    expect(sourceEvidenceCovered({ ...read, text: "third\nfourth" }, [read])).toBe(false);
    expect(sourceEvidenceCovered({ ...read, text: "allow()" }, [{ ...read, text: "disallow()" }])).toBe(false);
    expect(sourceEvidenceCovered({ ...read, text: "allow()" }, [{ ...read, text: "// allow()" }])).toBe(false);
    expect(sourceEvidenceCovered({ ...read, text: "allow()" }, [{ ...read, text: "allow() || bypass()" }])).toBe(false);
    expect(sourceEvidenceCovered({ ...read, text: "second\n" }, [read])).toBe(true);
  });

  it("selects the relevant complete branch from another packet and preserves provenance under the cap", () => {
    const candidate = authorizationComposition().findings[0]!;
    const body = "function readDocument(session) { return membership.active ? documents.get(id) : deny(); }";
    const read = (id: string, text: string, path = "documents.ts", source: "head" | "base" = "head"): RepositoryEvidence =>
      ({ id, tool: "read_range", source, path, text });
    const packet = (id: string, reads: RepositoryEvidence[], status: PacketReviewResult["status"] = "completed"): PacketReviewResult =>
      ({ packetId: id, findings: [], followUpHints: [], uncertainties: [], lenses: [], status, repositoryEvidence: reads });
    const selected = selectVerifierSourceEvidence(candidate, [
      packet("failed", [read("retained-from-failed-attempt", "Read handler active membership", "documents.ts")], "failed"),
      packet("other", [read("header", "function readDocument(session) {"), read("full", body),
        read("huge", body.repeat(1000)), read("unrelated", body, "elsewhere.ts"),
        read("truncated", body + "[tool result truncated by codegenie tool budget]")]),
      packet("duplicate", [read("duplicate-full", body), read("base", body, "documents.ts", "base")])
    ]);
    expect(selected[0]).toMatchObject({ id: "full", packetId: "other", path: "documents.ts", source: "head", text: body });
    expect(selected.map(item => item.id)).toEqual(["full", "base", "retained-from-failed-attempt", "header"]);
    expect(prettyStableJson(selected).length).toBeLessThanOrEqual(MAX_VERIFIER_SOURCE_EVIDENCE_CHARS);
  });
});

it("prioritizes a file explicitly named in the question over a general scope path", () => {
  const scope = { question: "Does generated/checks.custom recurse when InputRequest.check is called?", files: ["handler.custom", "generated/checks.custom"], symbols: [] };
  const text = "method check on InputRequest { return validate(children); }";
  expect(sourceEvidenceRelevance({ path: "generated/checks.custom", text }, scope))
    .toBeGreaterThan(sourceEvidenceRelevance({ path: "handler.custom", text }, scope));
});


it("compares source coverage independently of host delivery footers, without conflating revisions", () => {
  const short = { path: "rules.custom", source: "head" as const, text: "method check {\n  verify(input);\n\n[tool meta: source: requested head, used head; lookup: found; delivery: full]" };
  const full = { ...short, text: "method check {\n  verify(input);\n  return success;\n}\n\n[tool meta: source: requested head, used head; lookup: found; delivery: full]" };
  expect(sourceEvidenceCovered(short, [full])).toBe(true);
  expect(sourceEvidenceCovered(full, [short])).toBe(false);
  expect(sourceEvidenceCovered({ ...short, source: "base" }, [full])).toBe(false);
});
