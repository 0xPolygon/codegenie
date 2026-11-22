import { execFileSync } from "node:child_process";
import { renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseDiff } from "../src/git/diff-parser.js";
import { packTextToolResult } from "../src/llm/search-result-packing.js";
import { buildRepositoryToolDefinitions } from "../src/llm/tool-definitions.js";
import { LanguageAdapterRegistry } from "../src/repo/language-adapter.js";
import { RepositoryToolsFacade } from "../src/repo/repository-index.js";
import { SourceResolver } from "../src/repo/source-resolver.js";
import { TreeSitterService } from "../src/repo/tree-sitter/tree-sitter-service.js";
import type { ReviewPacket, ToolCallRecord } from "../src/types.js";
import { commitAll, initRepo, nullTelemetry, writeRepoFile } from "./helpers/git.js";

async function diffFixture(before: Record<string, string>, change: (repo: string) => void) {
  const repo = initRepo();
  try {
    for (const [path, text] of Object.entries(before)) writeRepoFile(repo, path, text);
    const base = commitAll(repo, "base");
    change(repo);
    const head = commitAll(repo, "head");
    const rawDiff = execFileSync("git", ["diff", "--find-renames", base, head], { cwd: repo, encoding: "utf8" });
    const diff = parseDiff(rawDiff);
    const resolver = await SourceResolver.create({ mode: "commit_range", repoRoot: repo, startCommit: base,
      endCommit: head, mergeBase: base, headSha: head, commits: [], rawDiff });
    const calls: Array<Omit<ToolCallRecord, "runId" | "toolCallId" | "timestamp">> = [];
    const tools = new RepositoryToolsFacade({ diff, resolver, registry: new LanguageAdapterRegistry(new TreeSitterService()),
      telemetry: { ...nullTelemetry(), recordToolCall: call => { calls.push(call); return "recorded"; } } });
    const tool = buildRepositoryToolDefinitions(tools).find(entry => entry.name === "read_diff_blocks")!;
    return { diff, tools, calls, call: (args: { path: string } | { packetId: string }) =>
      tool.execute(args, new AbortController().signal), dispose: () => rmSync(repo, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(repo, { recursive: true, force: true });
    throw error;
  }
}

describe("positioned diff delivery", () => {
  it("windows the oversized system reviewer hunk and names the omitted hunk", async () => {
    // cg-07 used a large system-reviewer.ts hunk and lost the whole block.
    const path = "src/pipeline/system-reviewer.ts";
    const stable = Array.from({ length: 15 }, (_, i) => `// existing review step ${i}\n`).join("");
    const body = Array.from({ length: 250 }, (_, i) =>
      `  const candidate${i} = reviewPolicy.requirement("review candidate ${i} against the checked-in scope");\n`).join("");
    const fixture = await diffFixture({ [path]: `function buildReview() {\n  return basePrompt;\n}\n${stable}export const depth = 1;\n` },
      repo => writeRepoFile(repo, path, `function buildReview() {\n${body}  return nextPrompt;\n}\n${stable}export const depth = 2;\n`));
    try {
      const [hunk, later] = fixture.diff.files[0]!.hunks;
      expect(hunk?.lines.length).toBeGreaterThan(250);
      const result = await fixture.call({ path });
      expect(result.meta).toMatchObject({ lookupStatus: "found", deliveryStatus: "truncated", omittedCount: 1, degradationReason: "diff_result_limit" });
      expect(result.text).toContain(`${path}@base: 19 lines | ${path}@head: 269 lines`);
      expect(result.text).toContain("- 2 +   const candidate0");
      expect(result.text).toContain(`omitted hunks: ${path} @@ -${later!.oldStart},${later!.oldLines} +${later!.newStart},${later!.newLines} @@ ${later!.id}`);
      expect(result.text).toContain(`(hunk ${hunk!.id}); use read_range`);
      expect(result.text).toMatch(/last hunk delivered: base 1-2, head 1-\d+/);
      const small = packTextToolResult(result, 1800);
      expect(small.text.length).toBeLessThanOrEqual(1800);
      expect(small.meta).toMatchObject({ deliveryStatus: "truncated", omittedCount: 1, degradationReason: "tool_result_budget" });
      expect(small.text).toContain(`next: ${result.packable!.labels![small.packable!.records.length]}`);
      expect(small.text).toMatch(/last hunk delivered: base 1-2, head 1-\d+/);
      expect(small.text).toContain(`@@ ${later!.id}`);
      expect(packTextToolResult(result, 128)).toMatchObject({
        isError: true, errorCode: "budget_exhausted", meta: { deliveryStatus: "budget_rejected", omittedCount: 2 }
      });
    } finally {
      fixture.dispose();
    }
  });

  it("keeps original diff rows and shows both pinned paths for a renamed file", async () => {
    const oldPath = "internal/kvmgr/slots.go";
    const path = "internal/kvmgr/tier.go";
    const unchanged = Array.from({ length: 20 }, (_, i) => `// existing selection step ${i}\n`).join("");
    const fixture = await diffFixture({ [oldPath]: `package kvmgr\nconst floor = 2\n${unchanged}const threshold = 12\n` }, repo => {
      renameSync(join(repo, oldPath), join(repo, path));
      writeRepoFile(repo, path, `package kvmgr\nconst floor = 4\n${unchanged}const threshold = 16\n`);
    });
    try {
      const file = fixture.diff.files[0]!;
      expect(file.status).toBe("renamed");
      expect(file.hunks).toHaveLength(2);
      const packetId = "packet-from-frozen-plan";
      fixture.tools.bindPackets([{ id: packetId, hunks: file.hunks.map(hunk => ({ hunkId: hunk.id })) } as ReviewPacket]);
      const result = await fixture.call({ packetId });
      expect(result.meta?.deliveryStatus).toBe("full");
      expect(result.text.split(`${oldPath}@base: 23 lines | ${path}@head: 23 lines`)).toHaveLength(2);
      expect(result.text).toContain("2 - - const floor = 2\n- 2 + const floor = 4");
      expect(result.text).toContain("23 - - const threshold = 12\n- 23 + const threshold = 16");
      await fixture.tools.readDiffBlocks({ packetId });
      expect(fixture.calls).toContainEqual(expect.objectContaining({ tool: "read_diff_blocks", args: { packetId } }));
      expect(await fixture.call({ path: oldPath })).toEqual(result);
      const empty = await fixture.call({ packetId: "unknown" });
      expect(empty.text).toBe("\n\n[tool meta: lookup: not_found; delivery: empty; degraded: packet bindings are unavailable or packet id is unknown]");
    } finally {
      fixture.dispose();
    }
  });

  it("returns a typed refusal with the first position when the added line alone cannot fit", async () => {
    const path = "src/generated.ts";
    const fixture = await diffFixture({ "README.md": "base\n" }, repo =>
      writeRepoFile(repo, path, `export const data = "${"x".repeat(17_000)}";\n`));
    try {
      const result = await fixture.call({ path });
      expect(result).toMatchObject({ isError: true, errorCode: "budget_exhausted",
        meta: { deliveryStatus: "budget_rejected", degraded: false, omittedCount: 1 } });
      expect(result.text).toContain(`next: ${path}@head:1`);
      expect(result.text).not.toContain("export const data");
    } finally {
      fixture.dispose();
    }
  });
});
