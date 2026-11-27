import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import { defaultConfig } from "../src/config/schema.js";
import { parseDiff } from "../src/git/diff-parser.js";
import { packTextToolResult } from "../src/llm/search-result-packing.js";
import { assertRepositoryToolArguments, buildRepositoryToolDefinitions } from "../src/llm/tool-definitions.js";
import { buildRepositoryIndex } from "../src/repo/repository-index.js";
import type { ResolvedReviewInput, TraceDependentsMode } from "../src/types.js";
import { git, nullTelemetry, writeRepoFile } from "./helpers/git.js";
import { textRepository } from "./helpers/text-repository.js";

const pkg = "@sample/lookup";
const importer = "src/main.ts";
const file = "index.js";
const installedDir = "node_modules/.pnpm/@sample+lookup@1.2.0/node_modules/@sample/lookup";
const integrity = "sha512-fixture";
const manifest = (name: string, version: string) => JSON.stringify({ name, version });
const hash = (bytes: string) => createHash("sha256").update(bytes).digest("hex");

async function identityFixture(files: Record<string, string>, updates: Record<string, string>) {
  const repo = await textRepository(files, updates);
  const { baseCommit, headCommit } = repo.resolver.binding;
  const rawDiff = git(repo.repo, ["diff", baseCommit, headCommit]);
  const resolved: ResolvedReviewInput = { mode: "commit_range", repoRoot: repo.repo, startCommit: baseCommit,
    endCommit: headCommit, mergeBase: baseCommit, headSha: headCommit, commits: [], rawDiff };
  return { ...repo, resolved };
}

async function index(repo: Awaited<ReturnType<typeof identityFixture>>, mode: TraceDependentsMode = "dependencies") {
  const event = vi.fn();
  const result = await buildRepositoryIndex(repo.resolved, parseDiff(repo.resolved.rawDiff).files, [],
    { ...defaultConfig, review: { ...defaultConfig.review, traceDependents: mode } }, { ...nullTelemetry(), event });
  return { ...result, event };
}

async function pnpmFixture({ workspace = false, corrupt }: {
  workspace?: boolean; corrupt?: "importer" | "integrity" | "version" | "yarn" | "bun" | "format";
} = {}) {
  const owner = workspace ? "packages/app" : ".";
  const changed = workspace ? owner + "/" + importer : importer;
  const lock = { lockfileVersion: corrupt === "format" ? "8.0" : "9.0",
    importers: { [owner]: { dependencies: { [pkg]: { specifier: "^1.0.0", version: "1.2.0(peer@1.0.0)" } } } },
    packages: { [pkg + "@1.2.0"]: { resolution: { integrity } } } };
  const manager = corrupt === "yarn" || corrupt === "bun" ? corrupt : "pnpm";
  const files = { "package.json": JSON.stringify({ packageManager: manager + "@12.0.0" }),
    "pnpm-lock.yaml": stringify(lock), [changed]: `import { exec } from "${pkg}/client";\nexport const old = exec();\n`,
    ...(workspace ? { [owner + "/package.json"]: manifest("app", "1.0.0") } : {}) };
  // Only the base import remains. The head importer and lockfile still own the installed package.
  const repo = await identityFixture(files, { [changed]: "export const current = 1;\n" });
  const installed = structuredClone(lock);
  if (corrupt === "importer") installed.importers[owner]!.dependencies[pkg]!.specifier = "~1.2.0";
  if (corrupt === "integrity") installed.packages[pkg + "@1.2.0"]!.resolution.integrity = "sha512-other";
  writeRepoFile(repo.repo, "node_modules/.pnpm/lock.yaml", stringify(installed));
  writeRepoFile(repo.repo, installedDir + "/package.json", manifest(pkg, corrupt === "version" ? "2.0.0" : "1.2.0"));
  writeRepoFile(repo.repo, installedDir + "/" + file, "export const source = true;\n");
  if (workspace) writeRepoFile(repo.repo, owner + "/node_modules/@sample/.fixture", "");
  else writeRepoFile(repo.repo, "node_modules/@sample/.fixture", "");
  symlinkSync(join(repo.repo, installedDir), join(repo.repo, owner, "node_modules", pkg), "dir");
  return { ...repo, args: { importer: changed, module: pkg }, packageRoot: join(repo.repo, installedDir) };
}

describe("installed dependency source", () => {
  it.each([false, true])("uses the tracked pnpm importer and installed identity (workspace=%s)", async workspace => {
    const repo = await pnpmFixture({ workspace });
    try {
      const available = await index(repo);
      expect(available.event).toHaveBeenCalledWith(expect.objectContaining({ message: "dependency_source_status",
        data: { pairs: [expect.objectContaining({ ...repo.args, version: "1.2.0", status: "available" })] } }));
      expect(await available.tools.readDependency!({ ...repo.args, path: file })).toMatchObject({
        version: "1.2.0", lockfile: "pnpm-lock.yaml", location: installedDir,
        identity: "lockfile-matched; bytes as installed", rows: [{ path: file, line: 1, text: "export const source = true;" }]
      });
      await expect(available.tools.readDependency!({ ...repo.args, importer: "src/untouched.ts" }))
        .rejects.toMatchObject({ code: "module_not_allowed", message: expect.stringContaining(repo.args.importer) });
      const off = await index(repo, "off");
      expect(off.tools.readDependency).toBeUndefined();
      expect(off.event.mock.calls.some(([event]) => event.message === "dependency_source_status")).toBe(false);
      const all = await index(repo, "all");
      expect(all.traceDependents).toBeTypeOf("function");
      expect(all.tools.readDependency).toBeTypeOf("function");
      expect(available.traceDependents).toBeUndefined();
    } finally { repo.dispose(); }
  });

  it("keeps an installed dependency out of scope when the changed file only quotes an import", async () => {
    const repo = await pnpmFixture();
    try {
      const before = repo.resolved.endCommit!;
      writeRepoFile(repo.repo, importer, `export const example = "import { exec } from '${pkg}';";\n`);
      git(repo.repo, ["add", "--", importer]);
      git(repo.repo, ["commit", "-m", "Add an import example"]);
      const after = git(repo.repo, ["rev-parse", "HEAD"]).trim();
      repo.resolved = { ...repo.resolved, startCommit: before, mergeBase: before, endCommit: after, headSha: after,
        rawDiff: git(repo.repo, ["diff", before, after]) };
      const result = await index(repo);
      expect(result.tools.readDependency).toBeUndefined();
      expect(result.event).toHaveBeenCalledWith(expect.objectContaining({ message: "dependency_source_status", data: { pairs: [] } }));
    } finally { repo.dispose(); }
  });

  it.each(["importer", "integrity", "version", "yarn", "bun", "format"] as const)("refuses mismatched or unsupported records (%s)", async corrupt => {
    const repo = await pnpmFixture({ corrupt });
    try {
      const result = await index(repo);
      expect(result.tools.readDependency).toBeUndefined();
      expect(result.event).toHaveBeenCalledWith(expect.objectContaining({ message: "dependency_source_status",
        data: { pairs: [expect.objectContaining({ ...repo.args, status: "unavailable", reason: expect.any(String) })] } }));
    } finally { repo.dispose(); }
  });

  it("limits literal search by total source bytes and resumes the first unread file", async () => {
    const repo = await pnpmFixture();
    try {
      const padding = " ".repeat(2_000_000);
      for (let i = 0; i < 10; i++) writeRepoFile(repo.packageRoot, `bulk/0${i}.js`, padding);
      writeRepoFile(repo.packageRoot, "bulk/10.js", "match\n");
      const reader = (await index(repo)).tools.readDependency!;
      const args = { ...repo.args, path: "bulk", query: "match" };
      const page = await reader(args);
      expect(page.rows).toEqual([]);
      expect(page.next).toBeTypeOf("string");
      expect((await reader({ ...args, cursor: page.next! })).rows).toEqual([
        expect.objectContaining({ path: "bulk/10.js", line: 1, text: "match" })
      ]);
    } finally { repo.dispose(); }
  });

  it("pins the nearest npm copy and refuses fallback on its mismatch", async () => {
    const nested = "packages/app/node_modules/" + pkg;
    const root = "node_modules/" + pkg;
    const path = "packages/app/src/app.ts";
    const packages = { [root]: { version: "1.0.0", integrity }, [nested]: { version: "2.0.0", integrity } };
    const lock = JSON.stringify({ lockfileVersion: 3, packages });
    const repo = await identityFixture({ "package.json": manifest("workspace", "1.0.0"), "package-lock.json": lock,
      "packages/app/package.json": manifest("app", "1.0.0"), [path]: "" },
    { [path]: `import { load } from "${pkg}";\nexport const value = load();\n` });
    try {
      writeRepoFile(repo.repo, "node_modules/.package-lock.json", lock);
      for (const [directory, entry] of Object.entries(packages)) {
        writeRepoFile(repo.repo, directory + "/package.json", manifest(pkg, entry.version));
        writeRepoFile(repo.repo, directory + "/" + file, "const version = " + JSON.stringify(entry.version));
      }
      const result = await index(repo);
      expect(await result.tools.readDependency!({ importer: path, module: pkg, path: file })).toMatchObject({
        version: "2.0.0", lockEntry: `packages[${nested}]`
      });
      writeRepoFile(repo.repo, nested + "/package.json", manifest(pkg, "0.3.0"));
      expect((await index(repo)).tools.readDependency).toBeUndefined();
    } finally { repo.dispose(); }
  });

  it("checks read/list/search limits, cursor binding, binaries and escaping symlinks", async () => {
    const repo = await pnpmFixture();
    try {
      for (let n = 0; n < 201; n++) writeRepoFile(repo.packageRoot, `paths/${String(n).padStart(3,"0")}.js`, "a text file\n");
      writeRepoFile(repo.packageRoot, "long.js", "dot.*\n".repeat(405) + "x".repeat(2_010) + "\n");
      writeFileSync(join(repo.packageRoot, "binary.dat"), Buffer.from([0, 1, 2]));
      writeRepoFile(repo.packageRoot, "oversized.txt", "x".repeat(2_000_001));
      symlinkSync(join(repo.repo, "package.json"), join(repo.packageRoot, "outside.json"));
      const { tools } = await index(repo);
      const reader = tools.readDependency!;
      const list = await reader(repo.args);
      expect(list.rows).toHaveLength(200);
      expect(list.next).toBeTypeOf("string");
      const remainder = await reader({ ...repo.args, cursor: list.next! });
      expect(remainder.rows.length).toBeGreaterThan(0);
      expect([...list.rows, ...remainder.rows].some(row => /binary|oversized|outside/u.test(row.path))).toBe(false);

      const query = { ...repo.args, path: "long", query: "dot.*" };
      const search = await reader(query);
      expect(search.rows).toHaveLength(50);
      expect((await reader({ ...query, cursor: search.next! })).rows[0]!.line).toBe(51);
      await expect(reader({ ...query, query: "dot.", cursor: search.next! })).rejects.toMatchObject({ code: "invalid_args" });
      const read = { ...repo.args, path: "long.js" };
      const firstPage = await reader(read);
      expect(firstPage.rows).toHaveLength(400);
      const second = await reader({ ...read, cursor: firstPage.next! });
      expect(second.rows[0]!.line).toBe(401);
      expect(second.rows.at(-1)).toMatchObject({ clipped: true, text: "x".repeat(2_000) });
      for (const path of ["binary.dat", "oversized.txt"]) {
        await expect(reader({ ...repo.args, path })).rejects.toMatchObject({ code: "binary_or_too_large" });
      }
      for (const path of ["outside.json", "../package.json"]) {
        await expect(reader({ ...repo.args, path })).rejects.toMatchObject({ code: "path_outside_module" });
      }
      await expect(reader({ ...read, startLine: 3, endLine: 1 })).rejects.toMatchObject({ code: "invalid_args" });

      for (const surface of ["current", "six"] as const) {
        expect(buildRepositoryToolDefinitions(tools, { toolSurface: surface }).some(tool => tool.name === "read_dependency")).toBe(false);
        const tool = buildRepositoryToolDefinitions(tools, { toolSurface: surface, includeDependency: true }).at(-1)!;
        expect(tool.name).toBe("read_dependency");
        expect(tool.parameters).not.toHaveProperty("oneOf");
        assertRepositoryToolArguments(tool, read);
        const result = await tool.execute(read, new AbortController().signal);
        const packed = packTextToolResult(result, 1_000);
        const continuation = /cursor=([\w-]+)/u.exec(packed.text)?.[1];
        expect(packed.text).toContain("untrusted-data");
        expect(packed.text).toContain("lockfile-matched; bytes as installed");
        expect(continuation).toBeTypeOf("string");
        expect((await reader({ ...read, cursor: continuation! })).rows[0]!.line).toBe(packed.packable!.records.length + 1);
      }
    } finally { repo.dispose(); }
  });

  it("checks Go's extracted dirhash, case escaping, mutation and replace", async () => {
    const cache = mkdtempSync(join(tmpdir(), "codegenie-gomod-"));
    vi.stubEnv("GOMODCACHE", cache);
    const module = "example.com/Acme/Dep";
    const version = "v1.1.0";
    const prefix = module + "@" + version;
    const contents = "package api\n";
    const entry = hash(contents) + "  " + prefix + "/api/main.go\n";
    const dirhash = createHash("sha256").update(entry).digest("base64");
    const source = "package fixture\nimport _ \"" + module + "/api\"\n";
    const tracked = { "go.mod": "module elsewhere.test/a\ngo 1.24\nrequire (\n "+
      "example.com/Acme v1.0.0\n " + prefix.replace("@", " ") + "\n)\n",
      "go.sum": prefix.replace("@", " ") + " h1:" + dirhash + "\n", "main.go": "package fixture\n" };
    const repo = await identityFixture(tracked, { "main.go": source });
    const replaced = await identityFixture(tracked, { "main.go": source,
      "go.mod": tracked["go.mod"] + "replace " + module + " => ../local\n" });
    try {
      const relative = "example.com/!acme/!dep@v1.1.0/api/main.go";
      writeRepoFile(cache, relative, contents);
      const result = await index(repo);
      const args = { importer: "main.go", module, path: "api/main.go" };
      await expect(result.tools.readDependency!(args)).resolves.toMatchObject({ lockfile: "go.sum", identity: "go.sum verified",
        lockEntry: prefix, integrity: "h1:" + dirhash, rows: [{ path: args.path, line: 1, text: "package api" }] });
      expect((await index(replaced)).tools.readDependency).toBeUndefined();
      writeRepoFile(cache, relative, contents + "// changed");
      await expect(result.tools.readDependency!(args)).rejects.toMatchObject({ code: "dependency_unavailable" });
      expect((await index(repo)).tools.readDependency).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
      repo.dispose();
      replaced.dispose();
      rmSync(cache, { recursive: true, force: true });
    }
  });
});
