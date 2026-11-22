import { describe, expect, it } from "vitest";
import { packFileListToolResult } from "../src/llm/search-result-packing.js";
import { textRepository } from "./helpers/text-repository.js";
import { writeRepoFile } from "./helpers/git.js";

describe("bounded file lists", () => {
  it("keeps whole paths, skips an oversized path, and distinguishes omitted paths from no matches", () => {
    const filePaths = ["long/".repeat(300), ...Array.from({ length: 30 }, (_, i) => `assets/${i}.svg`)];
    const input = { text: filePaths.join("\n"), filePaths };
    const result = packFileListToolResult(input, 400);
    const value = JSON.parse(result.text);
    expect(value.paths).toContain("assets/0.svg");
    expect(value.paths.every((path: string) => filePaths.includes(path))).toBe(true);
    expect(value.meta.degraded).toBe(false);
    expect(result.meta).toMatchObject({ degraded: false, deliveryStatus: "truncated", degradationReason: "tool_result_budget" });
    expect(value.meta.omittedCountIsLowerBound).toBeUndefined();
    expect(value.meta.omittedCount + value.paths.length).toBe(filePaths.length);
    expect(result.text.length).toBeLessThanOrEqual(400);
    expect(packFileListToolResult(input, 20)).toMatchObject({ isError: true, errorCode: "budget_exhausted" });
    expect(JSON.parse(packFileListToolResult({ text: "", filePaths: [] }, 400).text).paths).toEqual([]);
    expect(input.filePaths).toHaveLength(31);
  });

  it("keeps exact committed-head omission counts at both caps", async () => {
    const testRoot = "packages/coding-agent/test";
    const plantedPaths = Object.fromEntries(Array.from({ length: 505 }, (_, index) => [
      `${testRoot}/fixture-${index}.test.ts`, ""
    ]));
    const realPath = `${testRoot}/settings-manager.test.ts`;
    const fixture = await textRepository(plantedPaths, { [realPath]: "" });
    try {
      writeRepoFile(fixture.repo, `${testRoot}/untracked.test.ts`, "");
      const args = { glob: `${testRoot}/**` };
      const canonical = await fixture.call("list_files", args);
      expect(canonical.filePaths).toHaveLength(500);
      expect(canonical.meta?.omittedCount).toBe(6);
      const cap = packFileListToolResult(canonical, 60_000);
      expect(cap.meta).toMatchObject({ deliveryStatus: "truncated", degradationReason: "list_path_limit", omittedCount: 6,
        pathListDelivery: { deliveredCount: 500, backendOmittedCount: 6, budgetOmittedCount: 0 } });
      const tight = packFileListToolResult(canonical, 370);
      const { paths } = JSON.parse(tight.text);
      expect(paths.length).toBeGreaterThan(0);
      expect(tight.meta).toMatchObject({ deliveryStatus: "truncated", degradationReason: "tool_result_budget", omittedCount: 506 - paths.length,
        pathListDelivery: { deliveredCount: paths.length, backendOmittedCount: 6, budgetOmittedCount: 500 - paths.length } });
      expect(packFileListToolResult(canonical, 1)).toMatchObject({ isError: true, errorCode: "budget_exhausted",
        meta: { deliveryStatus: "budget_rejected", omittedCount: 506, pathListDelivery: { deliveredCount: 0 } } });

      const complete = packFileListToolResult(await fixture.call("list_files", { glob: realPath }), 4000);
      expect(complete.text).toBe(JSON.stringify({ paths: [realPath], meta: { backend: "text", precision: "exact", degraded: false } }));
      expect(complete.meta).toMatchObject({ deliveryStatus: "full", pathListDelivery: { deliveredCount: 1 } });
      const untracked = await fixture.call("list_files", { glob: `${testRoot}/untracked.test.ts` });
      expect(packFileListToolResult(untracked, 4000).meta).toMatchObject({ deliveryStatus: "empty", pathListDelivery: { deliveredCount: 0 } });
    } finally {
      fixture.dispose();
    }
  });
});
