import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { packTextToolResult } from "../src/llm/search-result-packing.js";
import { buildSixReadRangeTool } from "../src/llm/tool-definitions.js";
import { textRepository } from "./helpers/text-repository.js";

describe("six-tool read_range file maps", () => {
  let fixture: Awaited<ReturnType<typeof textRepository>>;
  beforeAll(async () => {
    fixture = await textRepository({
      "src/policy.ts": "// " + "existing context ".repeat(100) + "\nexport function authorize() { return true; }\n",
      "decoder/model.go": "package decoder\n" + Array.from({ length: 75 }, (_, i) =>
        `func DecodeLayer${i}(input int) int { return input + ${i} }\n`).join(""),
      "docs/raw.txt": "x".repeat(5000),
      "src/with-eof.ts": "export {};\n\n\t// keep indentation\n\n",
      "src/without-eof.ts": "export {};\n\n\t// keep indentation"
    }, { "src/policy.ts": "// " + "changed context ".repeat(100) + "\nexport function authorize() { return false; }\n" });
  });
  afterAll(() => fixture?.dispose());

  const read = (args: Record<string, unknown>) =>
    buildSixReadRangeTool(fixture.tools).execute(args, new AbortController().signal);

  it("delivers small pinned source and falls back to declarations for a tighter budget", async () => {
    const result = await read({ path: "src/policy.ts", source: { kind: "base" } });
    expect(result.text).toContain("src/policy.ts@base lines 1-2 of 2");
    expect(result.text).toContain("2\texport function authorize() { return true; }");
    expect(result.meta).toMatchObject({ deliveryStatus: "full", deliveredLineRange: [1, 2] });
    expect(result.sourceLineRange).toEqual([1, 2]);
    const map = packTextToolResult(result, 500);
    expect(map.text).toContain("src/policy.ts@base file map, 2 lines, 1 declarations");
    expect(map.text).toContain("authorize\tlines 2-2");
    expect(map.text).not.toContain("return true");
    expect(map.sourceLineRange).toBeUndefined();
    const range = await read({ path: "src/policy.ts", startLine: 2, endLine: 2 });
    expect(range.text).toContain("2\texport function authorize() { return false; }");
  });

  it("starts at the first map row omitted by the caller budget and binds its cursor to the file and revision", async () => {
    const args = { path: "decoder/model.go" };
    const planned = await read(args);
    expect(planned.text).toContain("decoder/model.go@head file map, 76 lines, 75 declarations");
    expect(planned.packable?.records).toHaveLength(60);
    const backendCursor = /next: declaration 61, cursor=([\w-]+)/u.exec(planned.text)![1]!;
    const tail = await read({ ...args, cursor: backendCursor });
    expect(tail.packable!.records[0]).toMatch(/^61\t.*DecodeLayer60\tlines 62-62$/u);
    expect(tail.packable!.records).toHaveLength(15);
    const first = packTextToolResult(planned, 650);
    const delivered = first.packable!.records.length;
    expect(delivered).toBeGreaterThan(0);
    expect(delivered).toBeLessThan(60);
    const cursor = /next: declaration \d+, cursor=([\w-]+)/u.exec(first.text)![1]!;
    const next = await read({ ...args, cursor });
    expect(next.packable!.records[0]).toBe(planned.packable!.records[delivered]);
    expect(await read({ ...args, cursor, source: { kind: "base" } })).toMatchObject({ isError: true, errorCode: "invalid_args" });
    expect(await read({ path: "src/policy.ts", cursor })).toMatchObject({ isError: true, errorCode: "invalid_args" });
    expect(await read({ ...args, cursor, startLine: 1, endLine: 8 })).toMatchObject({ isError: true, errorCode: "invalid_args" });
  });

  it("preserves blank lines, tabs, and EOF bytes when delivering complete source", async () => {
    for (const [path, source] of [
      ["src/with-eof.ts", "export {};\n\n\t// keep indentation\n\n"],
      ["src/without-eof.ts", "export {};\n\n\t// keep indentation"]
    ] as const) {
      const result = await read({ path });
      expect(result.meta?.deliveryStatus).toBe("full");
      const [body] = result.text.split("\n\n[tool meta:", 1);
      const numbered = body!.slice(body!.indexOf("\n") + 1);
      expect(numbered.replace(/^\d+\t/gmu, "")).toBe(source);
    }
  });

  it("distinguishes an unsupported map from a missing file and reports the pinned length", async () => {
    const unsupported = await read({ path: "docs/raw.txt" });
    expect(unsupported.meta).toMatchObject({ lookupStatus: "unavailable", totalLines: 1 });
    expect(unsupported.text).toContain("docs/raw.txt@head file map, 1 lines");
    expect(unsupported.text).toContain("Declaration parsing is unavailable.");
    const missing = await read({ path: "docs/missing.txt" });
    expect(missing.meta?.lookupStatus).toBe("file_missing");
  });
});
