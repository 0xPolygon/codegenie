import { describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../src/config/schema.js";
import { parseDiff } from "../src/git/diff-parser.js";
import { buildReviewPackets } from "../src/pipeline/packet-builder.js";
import { selectPacketDependents, traceDependents } from "../src/repo/dependents.js";
import { LanguageAdapterRegistry } from "../src/repo/language-adapter.js";
import { buildRepositoryIndex } from "../src/repo/repository-index.js";
import { TreeSitterService } from "../src/repo/tree-sitter/tree-sitter-service.js";
import type { CodegenieConfig, DiffFile, ResolvedReviewInput } from "../src/types.js";
import { git, nullTelemetry } from "./helpers/git.js";
import { textRepository } from "./helpers/text-repository.js";

const stageFixture = {
  "types.ts": "export type ReviewStage = 1 | 2 | 3;\n",
  "runtime.ts": [
    "export function isReviewStage(value: number): value is ReviewStage {",
    "  return Number.isInteger(value) && value >= 1 && value <= 3;",
    "}",
    "export function checkBudget(value: number) {",
    "  if (value < 1 || value > 3) throw new Error('range');",
    "}",
    "export function checkLength(length: number) { return length >= 1 && length <= 3; }",
    "export function unrelated() { return false; }"
  ].join("\n") + "\n",
  "tests/range.test.ts": "function testGuard(x: number) { return x >= 1 && x <= 3; }\n",
  "docs/range.md": "The example says x >= 1 && x <= 3.\n",
  "skip/runtime.ts": "function hidden(x: number) { return x >= 1 && x <= 3; }\n"
};
const head = { "types.ts": "export type ReviewStage = 1 | 3;\n" };
const tracedConfig: CodegenieConfig = { ...defaultConfig, review: { ...defaultConfig.review, traceDependents: "leads" } };

async function fixture(baseFiles: Record<string, string>, headFiles: Record<string, string | null>) {
  const repo = await textRepository(baseFiles, headFiles);
  const { baseCommit, headCommit } = repo.resolver.binding;
  const rawDiff = git(repo.repo, ["diff", baseCommit, headCommit]);
  const files = parseDiff(rawDiff).files;
  const resolved: ResolvedReviewInput = { mode: "commit_range", repoRoot: repo.repo, startCommit: baseCommit,
    endCommit: headCommit, mergeBase: baseCommit, headSha: headCommit, commits: [], rawDiff };
  return { ...repo, files, resolved };
}

async function trace(repo: Awaited<ReturnType<typeof fixture>>, files = repo.files, signal?: AbortSignal) {
  return traceDependents({ resolver: repo.resolver, registry: new LanguageAdapterRegistry(new TreeSitterService()),
    tools: repo.tools, files, changedFiles: repo.files, skipsPath: path => path.startsWith("skip/"), ...(signal ? { signal } : {}) });
}

function allHunks(files: DiffFile[]): string[] {
  return files.flatMap(file => file.hunks.map(hunk => hunk.id));
}

describe("Stage 6 dependent leads", () => {
  it("finds stale guard bodies and keeps unrelated bounds lexical", async () => {
    const repo = await fixture(stageFixture, head);
    try {
      const result = await trace(repo);
      const { candidates, counts } = selectPacketDependents(result, allHunks(repo.files));
      expect(candidates).toEqual([
        expect.objectContaining({ relation: "value_set", enclosing: "isReviewStage", match: "lexical",
          lineRange: [1, 3], text: expect.stringContaining("value >= 1 && value <= 3") }),
        expect.objectContaining({ relation: "value_set", enclosing: "checkBudget", match: "lexical",
          lineRange: [4, 6], text: expect.stringContaining("value < 1 || value > 3") }),
        expect.objectContaining({ relation: "value_set", enclosing: "checkLength", match: "lexical" })
      ]);
      expect(counts).toEqual({ preCap: { "value_set:lexical": 3 },
        attached: { "value_set:lexical": 3 }, omitted: {} });
      expect(result.telemetry.failures).toBe(0);
    } finally { repo.dispose(); }
  });

  it("does not attach a lead for a name-only match to a changed contract", async () => {
    const repo = await fixture({
      "types.ts": stageFixture["types.ts"],
      "consumer.ts": "export function isReviewStageLabel(label: string) { return label === 'ready'; }\n"
    }, head);
    try {
      const result = await trace(repo);
      expect(selectPacketDependents(result, allHunks(repo.files))).toEqual({
        candidates: [], counts: { preCap: {}, attached: {}, omitted: {} }
      });
      expect(result.telemetry.contracts).toEqual({ value_set: 1 });
    } finally { repo.dispose(); }
  });

  it("finds the old closed switch after adding an enum member and tracks only linked callers and stale names", async () => {
    const repo = await fixture({
      "contracts.ts": "export enum StatusCode { Ready, Done }\nexport function runJob() { return 1; }\nexport function oldEntry() { return 1; }\n",
      "usage.ts": "import { StatusCode, runJob, oldEntry } from './contracts';\n" +
        "function decode(s: StatusCode) {\n  switch (s) {\n    case StatusCode.Ready: return 1;\n    case StatusCode.Done: return 2;\n  }\n}\n" +
        "function caller() { return runJob(); }\nfunction stillCallsOld() { return oldEntry(); }\n",
      "preexisting.ts": "export function unrelated() { return 1 / 0; }\n"
    }, { "contracts.ts": "export enum StatusCode { Ready, Done, Error }\nexport function runJob() { return 2; }\nexport function newEntry() { return 1; }\n" });
    try {
      const result = await trace(repo);
      const { candidates } = selectPacketDependents(result, allHunks(repo.files));
      expect(candidates).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: "usage.ts", relation: "value_set", enclosing: "decode", match: "lexical",
          text: expect.stringContaining("case StatusCode.Done") }),
        expect.objectContaining({ path: "usage.ts", relation: "caller", enclosing: "caller", match: "syntactic_use" }),
        expect.objectContaining({ path: "usage.ts", relation: "stale_reference", contract: "oldEntry", enclosing: "stillCallsOld" })
      ]));
      expect(candidates.every(candidate => candidate.path === "usage.ts")).toBe(true);
      expect(result.telemetry.failures).toBe(0);
    } finally { repo.dispose(); }
  });

  it("matches named Go const sets and syntactic caller leads", async () => {
    const repo = await fixture({
      "contract.go": "package sample\ntype Mode int\nconst (\n  Open Mode = 1\n  Half Mode = 2\n  Closed Mode = 3\n)\nfunc changeMode() Mode { return Open }\n",
      "usage.go": "package sample\nfunc modeOK(v Mode) bool { return v >= 1 && v <= 3 }\nfunc call() Mode { return changeMode() }\n"
    }, { "contract.go": "package sample\ntype Mode int\nconst (\n  Open Mode = 1\n  Closed Mode = 3\n)\nfunc changeMode() Mode { return Closed }\n" });
    try {
      const result = await trace(repo);
      const { candidates } = selectPacketDependents(result, allHunks(repo.files));
      expect(candidates).toEqual(expect.arrayContaining([
        expect.objectContaining({ relation: "value_set", contract: "Mode", enclosing: "modeOK" }),
        expect.objectContaining({ relation: "caller", contract: "changeMode", enclosing: "call" })
      ]));
    } finally { repo.dispose(); }
  });

  it("records unsupported value-set coverage for a changed Rust enum packet", async () => {
    const repo = await fixture({
      "mode.rs": "pub enum Mode { Open, Closed, Removed }\n",
      "consumer.rs": "use crate::mode::Mode;\nfn code(m: Mode) -> u8 { match m { Mode::Open => 1, Mode::Closed => 2, Mode::Removed => 3 } }\n"
    }, { "mode.rs": "pub enum Mode { Open, Closed }\n" });
    try {
      const emit = vi.fn();
      const telemetry = { ...nullTelemetry(), event: emit };
      const index = await buildRepositoryIndex(repo.resolved, repo.files, [], tracedConfig, telemetry);
      const options = { config: tracedConfig, enabledLenses: ["core/code-review"] };
      const [file] = repo.files;
      const plan = { diffUnderstanding: { declaredIntent: "", inferredBehavior: "" },
        coverage: file!.hunks.map(hunk => ({ hunkId: hunk.id, path: file!.path, coverage: "normal" as const,
          lenses: ["core/code-review"], surroundingContextHints: [], reason: "fixture" })) };
      const [packet] = await buildReviewPackets(plan, repo.files, [], index, telemetry, options);
      expect(packet?.candidateDependents ?? []).not.toContainEqual(expect.objectContaining({ relation: "value_set" }));
      expect(emit).toHaveBeenCalledWith(expect.objectContaining({ message: "dependents_traced",
        data: expect.objectContaining({ perPacket: [
          expect.objectContaining({ packetId: packet?.id, language: "rust", valueSetCoverage: "unsupported_language",
            preCap: {}, attached: {} })
        ] }) }));
    } finally { repo.dispose(); }
  });

  it("omits a failed contract and continues after a grep error", async () => {
    const repo = await fixture(stageFixture, head);
    try {
      vi.spyOn(repo.resolver, "grep").mockRejectedValueOnce(new Error("offline grep failure"));
      const result = await trace(repo);
      expect(result.byHunk.size).toBe(0);
      expect(result.telemetry).toMatchObject({ failures: 1, queries: 1 });
    } finally { repo.dispose(); }
  });

  it("omits the whole contract when a matching consumer cannot be parsed", async () => {
    const repo = await fixture({
      ...stageFixture,
      "broken.ts": "export function broken(value: number) { return value >= 1 && value <= 3;\n"
    }, head);
    try {
      const result = await trace(repo);
      expect(result.byHunk.size).toBe(0);
      expect(result.telemetry).toMatchObject({ failures: 1, failureReasons: { parse_failed: 1 }, contractsOmitted: 1 });
    } finally { repo.dispose(); }
  });

  it("uses a sound guard body when the parse error is elsewhere in its file", async () => {
    const repo = await fixture({
      ...stageFixture,
      "runtime.ts": stageFixture["runtime.ts"] + "\nexport function broken( {\n"
    }, head);
    try {
      const result = await trace(repo);
      expect(selectPacketDependents(result, allHunks(repo.files)).candidates).toContainEqual(
        expect.objectContaining({ lineRange: [1, 3], enclosing: "isReviewStage", relation: "value_set" })
      );
      expect(result.telemetry.failures).toBe(0);
    } finally { repo.dispose(); }
  });

  it("keeps a literal-object consumer, excluding changed-hunk context and clipped declaration bodies", async () => {
    const repo = await fixture({
      "contracts.ts": 'export const AllowedStates = { open: "open", done: "done" } as const;\n',
      "consumer.ts": 'export function accepts(state: string) {\n' + '// comment\n'.repeat(12)
        + '  return state === "open" || state === "done";\n}\n',
      "changed.ts": 'export function changed(state: string) { return state === "open"; }\n'
    }, {
      "contracts.ts": 'export const AllowedStates = { done: "done" } as const;\n',
      "changed.ts": 'export function changed(state: string) { return state === "open" && true; }\n'
    });
    try {
      const result = await trace(repo);
      const { candidates } = selectPacketDependents(result, allHunks(repo.files));
      expect(candidates).toEqual([expect.objectContaining({ path: "consumer.ts", lineRange: [14, 14],
        text: '  return state === "open" || state === "done";', relation: "value_set" })]);
    } finally { repo.dispose(); }
  });

  it("bounds contracts, queries, parsed files and the packet's serialized bytes", async () => {
    const names = Array.from({ length: 23 }, (_, index) => `StatusName${index}`);
    const input = (values: string[]) => names.map(name => `export type ${name} = ${values.join(" | ")};`).join("\n") + "\n";
    const repo = await fixture({ "contracts.ts": input(['"a"', '"b"', '"c"']) },
      { "contracts.ts": input(['"a"', '"b"', '"d"']) });
    try {
      const result = await trace(repo);
      expect(result.telemetry).toMatchObject({ queries: 40, contractsOmitted: expect.any(Number) });
      expect(result.telemetry.caps).toEqual(expect.arrayContaining(["contracts", "queries"]));
      expect(result.telemetry.contractsOmitted).toBeGreaterThanOrEqual(3);
    } finally { repo.dispose(); }

    const files = Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`f-${index}.ts`, "// first\n"]));
    const updatedFiles = Object.fromEntries(Object.keys(files).map(path => [path, "// second\n"]));
    const large = await fixture(files, updatedFiles);
    try {
      // Isolate the file cap from the wall-clock cap on a loaded test host.
      vi.spyOn(large.resolver, "readFile").mockImplementation(async (path, source = { kind: "head" }) => {
        const commit = large.resolver.resolveSource(source);
        const content = (source.kind === "base" ? files : updatedFiles)[path]!;
        return { path, source, commit, content, contentSha: commit };
      });
      const result = await trace(large);
      expect(result.telemetry.filesParsed).toBe(200);
      expect(result.telemetry.caps).toContain("files");
    } finally { large.dispose(); }

    const wide = await fixture({
      ...stageFixture,
      ...Object.fromEntries(Array.from({ length: 6 }, (_, index) => [
        `wide/guards${index}.ts`, `export function guard${index}(x: number) {\n`
          + `  // ${"x".repeat(220)}\n`.repeat(7) + "  return x >= 1 && x <= 3;\n}\n"
      ]))
    }, head);
    try {
      const { candidates, counts } = selectPacketDependents(await trace(wide), allHunks(wide.files));
      expect(candidates.length).toBeLessThan(6);
      expect(JSON.stringify(candidates).length).toBeLessThanOrEqual(3_000);
      expect(candidates.every(candidate => candidate.text.split("\n").every(line => line.length <= 200))).toBe(true);
      expect(counts.omitted["value_set:lexical"]).toBeGreaterThan(0);
    } finally { wide.dispose(); }
  }, 15_000);

  it("stops a delayed lookup at the trace deadline without starting another query", async () => {
    const repo = await fixture(stageFixture, head);
    const start = performance.now();
    const clock = vi.spyOn(performance, "now");
    const lookup = vi.spyOn(repo.resolver, "grep").mockImplementation(async () => {
      clock.mockReturnValue(start + 6_000);
      return [];
    });
    try {
      const result = await trace(repo);
      expect(result.telemetry).toMatchObject({ caps: ["time"], queries: 1, failures: 0 });
      expect(lookup).toHaveBeenCalledTimes(1);
    } finally {
      clock.mockRestore();
      repo.dispose();
    }
  });

  it("attaches leads to their own packets, reports the count cap and keeps the off packet shape", async () => {
    const extras = Object.fromEntries(Array.from({ length: 10 }, (_, index) =>
      [`extra/span${index}.ts`, `export function span${index}(value: number) { return value >= 1 && value <= 3; }\n`]));
    const repo = await fixture({
      ...stageFixture, ...extras, "mode.ts": "export function newMode() { return 1; }\n",
      "caller.ts": "export function callMode() { return newMode(); }\n"
    }, { ...head, "mode.ts": "export function newMode() { return 2; }\n" });
    try {
      const emit = vi.fn();
      const telemetry = { ...nullTelemetry(), event: emit };
      const config = { ...tracedConfig, classification: { pathRules: [{ pattern: "skip/**", processingMode: "skip" as const, reason: "fixture scope" }] } };
      const index = await buildRepositoryIndex(repo.resolved, repo.files, [], config, telemetry);
      const options = { config, enabledLenses: ["core/code-review"] };
      const plan = { diffUnderstanding: { declaredIntent: "", inferredBehavior: "" },
        coverage: repo.files.flatMap(file => file.hunks.map(hunk => ({ hunkId: hunk.id, path: file.path, coverage: "normal" as const,
          lenses: ["core/code-review"], surroundingContextHints: [], reason: "fixture" }))) };
      const packets = await buildReviewPackets(plan, repo.files, [], index, telemetry, options);
      const stage = packets.find(packet => packet.path === "types.ts")!;
      const fn = packets.find(packet => packet.path === "mode.ts")!;
      expect(stage.candidateDependents).toHaveLength(6);
      expect(stage.candidateDependents!.every(lead => lead.contractPath === "types.ts")).toBe(true);
      expect(fn.candidateDependents).toEqual([expect.objectContaining({ path: "caller.ts", contractPath: "mode.ts", relation: "caller" })]);
      expect(emit).toHaveBeenCalledWith(expect.objectContaining({ message: "dependents_traced",
        data: expect.objectContaining({ preCap: expect.objectContaining({ "value_set:lexical": 13 }),
          attached: expect.any(Object), omitted: expect.any(Object),
          perPacket: expect.arrayContaining([expect.objectContaining({ packetId: stage.id,
            language: "typescript", valueSetCoverage: "supported" })]) }) }));
      emit.mockClear();
      const off = await buildReviewPackets(plan, repo.files, [], index, telemetry, { ...options, config: defaultConfig });
      expect(off.every(packet => packet.candidateDependents === undefined)).toBe(true);
      expect(emit.mock.calls.some(([event]) => event.message === "dependents_traced")).toBe(false);
    } finally { repo.dispose(); }
  });
});
