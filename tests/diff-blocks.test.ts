import { execFileSync } from "node:child_process";
import { renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseDiff } from "../src/git/diff-parser.js";
import { packTextToolResult } from "../src/llm/search-result-packing.js";
import { buildRepositoryToolDefinitions, buildSixReadChangeTool } from "../src/llm/tool-definitions.js";
import { LanguageAdapterRegistry } from "../src/repo/language-adapter.js";
import { RepositoryToolsFacade } from "../src/repo/repository-index.js";
import { SourceResolver } from "../src/repo/source-resolver.js";
import { TreeSitterService } from "../src/repo/tree-sitter/tree-sitter-service.js";
import { packetDiffLine, renderNumberedDiffLine } from "../src/repo/numbered-diff.js";
import type { ReadChangeInput } from "../src/repo/read-change.js";
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
      tool.execute(args, new AbortController().signal),
      change: (args: ReadChangeInput, currentHunks?: readonly string[]) =>
        buildSixReadChangeTool(tools, currentHunks ? { currentHunks } : {}).execute(args, new AbortController().signal),
      dispose: () => rmSync(repo, { recursive: true, force: true }) };
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
      const current = await fixture.change({ path });
      expect(current.meta).toMatchObject({ deliveryStatus: "truncated", omittedCount: 1 });
      const rest = await fixture.change({ path, cursor: continuation(current.text) });
      const sourceRows = (page: Awaited<typeof current>) => page.packable!.records.filter((_, i) => !page.packable?.keepWithNext?.[i]);
      expect(rest.meta?.deliveryStatus).toBe("full");
      expect([...sourceRows(current), ...sourceRows(rest)])
        .toEqual(fixture.diff.files[0]!.hunks.flatMap(part => part.lines.map(packetDiffLine).map(renderNumberedDiffLine)));
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
      const change = await fixture.change({ path: oldPath });
      expect(change.text).toContain(`"${oldPath}"@base: 23 lines | "${path}"@head: 23 lines`);
      expect(change.text.split(`"${oldPath}"@base: 23 lines`)).toHaveLength(2);
      const hunkId = file.hunks[0]!.id;
      const hunk = await fixture.change({ hunkId });
      expect(await fixture.change({ hunkId, path: oldPath })).toEqual(hunk);
      expect(await fixture.change({ hunkId, path })).toEqual(hunk);
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

function continuation(text: string): string {
  const cursor = /(?:^|[ ,])cursor=([\w-]+)/u.exec(text)?.[1];
  expect(cursor).toBeDefined();
  return cursor!;
}

describe("read_change", () => {
  it("locates the cg-01 sibling deletion, marks current hunks, and pages the pinned directory", async () => {
    const file = "src/llm/pi-runner.ts";
    const provider = "src/provider/provider-services.ts";
    const others = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`src/section-${i}/affected-source.ts`, "export const v = 1;\n"]));
    const fixture = await diffFixture({ [file]: 'export function register(result: Response) {\n  for (const value of Object.values(result.headers)) remember(value);\n}\n',
      [provider]: "export const enabled = false;\n", ...others }, repo => {
      writeRepoFile(repo, file, "export function register(result: Response) {\n}\n");
      writeRepoFile(repo, provider, "export const enabled = true;\n");
      for (const name of Object.keys(others)) writeRepoFile(repo, name, "export const v = 2;\n");
    });
    try {
      const sibling = fixture.diff.files.find(entry => entry.path === file)!.hunks[0]!;
      const assigned = fixture.diff.files.find(entry => entry.path === provider)!.hunks[0]!;
      const first = await fixture.change({}, [assigned.id]);
      expect(first.text).toContain(sibling.id);
      const cut = packTextToolResult(first, 800);
      expect(cut.meta?.deliveryStatus).toBe("truncated");
      const next = continuation(cut.text);
      expect(await fixture.change({ cursor: next }, [sibling.id])).toMatchObject({ errorCode: "invalid_args" });
      const second = await fixture.change({ cursor: next }, [assigned.id]);
      expect(second.packable?.records[0]).toBe(first.packable?.records[cut.packable!.records.length]);
      const prompt = fixture.tools.readChangePromptDirectory([assigned.id], true);
      expect(prompt).toContain(`${assigned.id} base 1-1 head 1-1 [current packet]`);
      expect(prompt.indexOf(assigned.id)).toBeLessThan(prompt.indexOf(sibling.id));
      expect(prompt.length).toBeLessThanOrEqual(2400);
      expect(prompt).toContain("use read_change without a selector");
      const scope = "Entries marked [current packet] are this review's hunks; other entries are optional context from the same change.";
      expect(prompt.split("\n")[1]).toBe(scope);
      expect(first.text).not.toContain(scope);
      expect(fixture.tools.readChangePromptDirectory([assigned.id], false)).not.toContain("use read_change");
      const diff = await fixture.change({ hunkId: sibling.id });
      expect(diff.meta?.deliveryStatus).toBe("full");
      expect(diff.text).toContain(sibling.lines.map(packetDiffLine).map(renderNumberedDiffLine).join("\n"));
      expect(diff.text).toContain('pi-runner.ts"@base: 3 lines');
      expect(await fixture.change({ path: file, hunkId: sibling.id })).toMatchObject({ text: diff.text, meta: diff.meta });
      const mismatch = await fixture.change({ path: provider, hunkId: sibling.id });
      expect(mismatch.errorCode).toBe("invalid_args");
      expect(mismatch.text).toContain(file);
      expect(mismatch.text).toContain(provider);
      expect(await fixture.change({ path: file, hunkId: "unknown" })).toMatchObject({ meta: { lookupStatus: "not_found" } });
      expect(await fixture.change({ hunkId: "unknown" })).toMatchObject({ meta: { lookupStatus: "not_found" } });
    } finally {
      fixture.dispose();
    }
  });

  it("extends the cg-10 hunk to intervening writes, aligns unchanged lines once, and resumes a caller cut", async () => {
    const path = "src/pipeline/composer.ts";
    const gap = Array.from({ length: 18 }, (_, i) => `  audit(${i});\n`).join("");
    const writes = "  await writeArtifact('findings');\n  await writeArtifact('usage');\n  await writeArtifact('coverage');\n  await writeArtifact('review');\n";
    const base = `export async function composer(error: Error) {\n  throw error;\n${gap}${writes}  done();\n}\n`;
    const head = `export async function composer(error: Error) {\n  warn(error);\n${gap}${writes}  done();\n  throw error;\n}\n`;
    const fixture = await diffFixture({ [path]: base }, repo => writeRepoFile(repo, path, head));
    try {
      const hunkId = fixture.diff.files[0]!.hunks[0]!.id;
      expect((await fixture.change({ hunkId })).text).not.toContain("writeArtifact('review')");
      const args = { path, hunkId, context: "function" as const };
      const result = await fixture.change(args);
      expect(result.text).toContain("Function intervals: base composer 1-26 | head composer 1-27.");
      expect(result.text).not.toContain("Alignment unavailable");
      for (const row of writes.trimEnd().split("\n")) expect(result.text.split(row)).toHaveLength(2);
      const cut = packTextToolResult(result, 850);
      expect(cut.meta?.deliveryStatus).toBe("truncated");
      const cursor = continuation(cut.text);
      const changedSelector = await fixture.change({ hunkId, cursor });
      expect(changedSelector).toMatchObject({ errorCode: "invalid_args" });
      expect(changedSelector.text).toContain("reuse the original arguments and revision");
      const incomplete = await fixture.change({ ...args, cursor: cursor.slice(0, -3) });
      expect(incomplete).toMatchObject({ errorCode: "invalid_args" });
      expect(incomplete.text).toContain("copy the entire cursor verbatim");
      expect(await fixture.change({ ...args, path: "src/unrelated.ts", cursor })).toMatchObject({ errorCode: "invalid_args" });
      const resumed = await fixture.change({ ...args, cursor });
      expect(resumed.packable?.records[1]).toBe(result.packable?.records[cut.packable!.records.length]);
      expect(await fixture.change({ hunkId, context: "function", cursor })).toEqual(resumed);
      const byId = await fixture.change({ hunkId, context: "function" });
      expect(continuation(packTextToolResult(byId, 850).text)).toBe(cursor);
      expect(packTextToolResult(result, 80)).toMatchObject({ isError: true, meta: { deliveryStatus: "budget_rejected" } });
      const grouped = await fixture.change({ path, context: "function" });
      const hunks = fixture.diff.files[0]!.hunks;
      expect(hunks.length).toBeGreaterThan(1);
      for (const hunk of hunks) expect(grouped.text).toContain(`hunk ${hunk.id} |`);
      expect(grouped.packable?.keepWithNext?.filter(Boolean)).toHaveLength(1);
      for (const row of writes.trimEnd().split("\n")) expect(grouped.text.split(row)).toHaveLength(2);
    } finally {
      fixture.dispose();
    }
  });

  it("uses Go receiver bodies and distinguishes added, deleted, and unsupported sides", async () => {
    const go = "decoder/kv.go";
    const added = "decoder/guard.go";
    const removed = "decoder/old.go";
    const other = "schema.ridl";
    const base = "package decoder\n\nfunc (s *State) Commit() {\n  s.Record()\n  s.Flush()\n}\n";
    const head = base.replace("  s.Record()\n", "  s.Record()\n  s.Validate()\n");
    const fixture = await diffFixture({ [go]: base, [removed]: "package obsolete\nfunc retired() { panic(\"no longer available\") }\n", [other]: "struct Old\n" }, repo => {
      writeRepoFile(repo, go, head);
      writeRepoFile(repo, added, "package decoder\nfunc guard() {}\n");
      writeRepoFile(repo, other, "struct New\n");
      rmSync(join(repo, removed));
    });
    try {
      const result = await fixture.change({ path: go, context: "function" });
      expect(result.text).toContain("Function intervals: base Commit 3-6 | head Commit 3-7.");
      expect(result.text).toContain("   5    6    s.Flush()");
      expect((await fixture.change({ path: added, context: "function" })).text).toContain("base absent");
      expect((await fixture.change({ path: removed, context: "function" })).text).toContain("head absent");
      const fallback = await fixture.change({ path: other, context: "function" });
      expect(fallback.text).toContain("syntax could not be verified");
      expect(fallback.text).toContain("-struct Old");
      expect(fallback.text).toContain("+struct New");
    } finally {
      fixture.dispose();
    }
  });

  it("identifies the comparison group when a caller cut reaches the second hunk", async () => {
    const path = "src/pipeline/composer.ts";
    const body = Array.from({ length: 80 }, (_, i) => `  await writeArtifact("step-${i}.json");`);
    const base = ["export async function compose() {", ...body, "}"].join("\n") + "\n";
    body[3] = '  await writeArtifact("first-change.json");';
    body[35] = '  await writeArtifact("second-change.json");';
    const head = ["export async function compose() {", ...body, "}"].join("\n") + "\n";
    const fixture = await diffFixture({ [path]: base }, repo => writeRepoFile(repo, path, head));
    try {
      const [first, second] = fixture.diff.files[0]!.hunks;
      expect(fixture.diff.files[0]!.hunks).toHaveLength(2);
      const args = { path, context: "function" as const };
      const result = await fixture.change(args);
      const secondEdit = second!.lines.find(line => line.kind === "add")!;
      const target = result.packable!.records.indexOf(renderNumberedDiffLine(packetDiffLine(secondEdit)));
      expect(target).toBeGreaterThan(0);
      let lower = 0;
      let upper = result.text.length;
      while (lower < upper) {
        const cap = Math.floor((lower + upper) / 2);
        const count = packTextToolResult(result, cap).packable?.records.length ?? 0;
        if (count < target) lower = cap + 1;
        else upper = cap;
      }
      const cut = packTextToolResult(result, lower);
      expect(cut.packable?.records.length).toBe(target);
      const group = `(function comparison for hunks ${first!.id}, ${second!.id})`;
      expect(cut.text).toContain(`last delivered: "${path}"@base:${secondEdit.newLineNumber} ${group}`);
      expect(cut.text).toContain(`next: "${path}"@head:${secondEdit.newLineNumber} ${group}, cursor=`);
      const resumed = await fixture.change({ ...args, cursor: continuation(cut.text) });
      expect(resumed.text).toContain(`Continued from "${path}"@head:${secondEdit.newLineNumber} ${group}`);
      expect(resumed.packable?.records[1]).toBe(result.packable?.records[target]);
    } finally {
      fixture.dispose();
    }
  });

  it("keeps disjoint function bodies independent when no source row aligns", async () => {
    const path = "src/provider/adapter.ts";
    const fixture = await diffFixture({ [path]: "export function existing() { return acquire(); }\n" }, repo =>
      writeRepoFile(repo, path, "export function replacement() { return allocate(); }\n"));
    try {
      const result = await fixture.change({ path, context: "function" });
      expect(result.text).toContain("Alignment unavailable; base and head are shown independently.");
      expect(result.text).toContain("   1       export function existing()");
      expect(result.text).toContain("        1  export function replacement()");
      expect(result.text).not.toMatch(/[+-]export function/u);
    } finally {
      fixture.dispose();
    }
  });
});
