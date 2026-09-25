import { describe, expect, it } from "vitest";
import { packFileListToolResult } from "../src/llm/search-result-packing.js";

describe("bounded file lists", () => {
  it("keeps whole paths, skips an oversized path, and distinguishes omitted paths from no matches", () => {
    const filePaths = ["long/".repeat(300), ...Array.from({ length: 30 }, (_, i) => `assets/${i}.svg`)];
    const input = { text: filePaths.join("\n"), filePaths };
    const result = packFileListToolResult(input, 400);
    const value = JSON.parse(result.text);
    expect(value.paths).toContain("assets/0.svg");
    expect(value.paths.every((path: string) => filePaths.includes(path))).toBe(true);
    expect(value.meta.degraded).toBe(true);
    expect(result.meta?.degraded).toBe(true);
    expect(value.meta.omittedCount + value.paths.length).toBe(filePaths.length);
    expect(result.text.length).toBeLessThanOrEqual(400);
    expect(packFileListToolResult(input, 20)).toMatchObject({ isError: true, errorCode: "budget_exhausted" });
    expect(JSON.parse(packFileListToolResult({ text: "", filePaths: [] }, 400).text).paths).toEqual([]);
    expect(input.filePaths).toHaveLength(31);
  });
});
