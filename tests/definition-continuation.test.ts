import { describe, expect, it } from "vitest";
import { textRepository } from "./helpers/text-repository.js";

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
      expect(result.meta).toMatchObject({ truncated: true, lookupStatus: "ambiguous" });
      expect(result.text).toContain(`first unexamined text occurrence: ${path}@${source}:${line}`);
      expect(result.text).toContain("This occurrence is not a verified definition");
      expect(result.text).toContain(`read_range({"path":"${path}","startLine":${line},"endLine":${line},"source":{"kind":"${source}"}})`);
      const continuation = await fixture.call("read_range", { path, startLine: line, endLine: line, source: { kind: source } });
      expect(continuation.text).toContain(`${name} unexamined`);
      const uncut = await fixture.call("find_definition", { symbolName: name, pathGlob: "a/00.md", source: { kind: source } });
      expect(uncut.meta?.truncated).not.toBe(true);
      expect(uncut.text).not.toContain("first unexamined text occurrence");
    } finally { fixture.dispose(); }
  });
});
