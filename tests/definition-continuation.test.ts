import { describe, expect, it } from "vitest";
import { textRepository } from "./helpers/text-repository.js";
import { buildReadDefinitionTool } from "../src/llm/definition-tool.js";
import { packDefinitionToolResult } from "../src/llm/definition-result-packing.js";

describe("bounded definition discovery", () => {
  it.each([
    { caseName: "go-06 tc-000095", name: "Reading", path: "docs/completed/deltanet-residency-plan.md", line: 135, source: "head" },
    { caseName: "cg-n5 tc-000074", name: "Anchor", path: "evals/public/pi/pi-10/oracle.md", line: 24, source: "head" },
    { caseName: "generic head", name: "Needle", path: "docs/target.md", line: 2, source: "head" },
    { caseName: "generic base", name: "Needle", path: "docs/target.md", line: 2, source: "base" }
  ] as const)("offers the first unexamined text occurrence for $caseName", async ({ name, path, line, source }) => {
    const files: Record<string, string> = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [
      `a/${String(i).padStart(2, "0")}.md`, `Preface\n${name} mention ${i}\n`
    ]));
    files[path] = `${"Preface\n".repeat(line - 1)}${name} unexamined\n`;
    const fixture = await textRepository(files);
    try {
      const result = await fixture.call("find_definition", { symbolName: name, source: { kind: source } });
      expect(result.definitions).toEqual([]);
      expect(result.meta).toMatchObject({ truncated: true, lookupStatus: "incomplete" });
      expect(result.text).toContain(`first unexamined text occurrence: ${path}@${source}:${line}`);
      expect(result.text).toContain("This occurrence is not a verified definition");
      expect(result.text).toContain(`read_range({"path":"${path}","startLine":${line},"endLine":${line},"source":{"kind":"${source}"}})`);
      const continuation = await fixture.call("read_range", { path, startLine: line, endLine: line, source: { kind: source } });
      expect(continuation.text).toContain(`${name} unexamined`);
      const six = await buildReadDefinitionTool(fixture.tools).execute({ name, source: { kind: source } }, new AbortController().signal);
      expect(six.meta).toMatchObject({ truncated: true, lookupStatus: "incomplete", deliveryStatus: "empty" });
      expect(six.text).toContain("No declaration locations were verified");
      expect(six.text).toContain(`first unexamined text occurrence: ${path}@${source}:${line}`);
      expect(six.text).toContain(`read_range({"path":"${path}","startLine":${line},"endLine":${line},"source":{"kind":"${source}"}})`);
      expect(packDefinitionToolResult(six, 9)).toMatchObject({ isError: true, errorCode: "budget_exhausted", meta: { lookupStatus: "incomplete" } });
      const uncut = await fixture.call("find_definition", { symbolName: name, pathGlob: "a/00.md", source: { kind: source } });
      expect(uncut.meta?.truncated).not.toBe(true);
      expect(uncut.text).not.toContain("first unexamined text occurrence");
    } finally { fixture.dispose(); }
  });

  it("keeps a bounded head scan incomplete when auto finds no definition on base", async () => {
    const changes: Record<string, string> = Object.fromEntries(Array.from({ length: 31 }, (_, i) => [
      `docs/${String(i).padStart(2, "0")}.md`, "Needle mention\n"
    ]));
    const fixture = await textRepository({ "src/base.ts": "export const other = 1;\n" }, changes);
    try {
      const result = await fixture.call("find_definition", { symbolName: "Needle", source: { kind: "auto" } });
      expect(result.meta).toMatchObject({ lookupStatus: "incomplete", sourceUsed: "head", truncated: true });
      expect(result.text).toContain("first unexamined text occurrence:");
      const six = await buildReadDefinitionTool(fixture.tools).execute({ name: "Needle", source: { kind: "auto" } }, new AbortController().signal);
      expect(six.meta).toMatchObject({ lookupStatus: "incomplete", sourceUsed: "head", truncated: true });
      expect(six.text).toContain("first unexamined text occurrence:");
      const absent = await fixture.call("find_definition", { symbolName: "MissingEntirely", source: { kind: "head" } });
      expect(absent.meta).toMatchObject({ lookupStatus: "not_found", deliveryStatus: "empty" });
    } finally { fixture.dispose(); }
  });

  it("keeps text-only leads unverified when the remaining candidate scan is bounded", async () => {
    const files: Record<string, string> = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [
      `docs/${String(i).padStart(2, "0")}.md`, "Needle mention\n"
    ]));
    files["a/declaration.custom"] = "function Needle() {}\n";
    const fixture = await textRepository(files);
    try {
      const result = await fixture.call("find_definition", { symbolName: "Needle", source: { kind: "head" } });
      expect(result.meta).toMatchObject({ lookupStatus: "incomplete", truncated: true });
      expect(result.definitions).toHaveLength(1);
      const six = await buildReadDefinitionTool(fixture.tools).execute({ name: "Needle" }, new AbortController().signal);
      expect(six.meta).toMatchObject({ lookupStatus: "incomplete", truncated: true });
      expect(six.text).toContain("Unverified text leads:");
      expect(six.text).not.toContain("Verified declarations:");
    } finally { fixture.dispose(); }
  });
});
