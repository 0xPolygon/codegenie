import { createHash } from "node:crypto";
import { isBuiltin } from "node:module";
import { join } from "node:path";
import { realpath } from "node:fs/promises";
import { redactThenTruncate } from "../telemetry/redaction.js";
import type { DiffFile, ParsedFile, SourceSelector } from "../types.js";
import { CodegenieError } from "../util/errors.js";
import { dependencyPaths, readDependencyBytes, withDependencyFile } from "./dependency-files.js";
import { dependencyUnavailable, goDependencies, NodeDependencyIdentity, resolveGoDependency,
  type DependencyIdentity } from "./dependency-identity.js";
import { treeFromParsed, type LanguageAdapterRegistry } from "./language-adapter.js";
import type { SourceResolver } from "./source-resolver.js";
import { decodeToolCursor, encodeToolCursor, toolCursorBinding } from "./tool-cursor.js";

const FILE_BYTES = 2_000_000;
const SCAN_FILES = 5_000;
const SCAN_BYTES = 20_000_000;
const LINE_CHARS = 2_000;
const LIST_FILES = 200;
const SEARCH_ROWS = 50;
const READ_LINES = 400;

type Pair = { importer: string; module: string; kind: "node" | "go" };
type Position = { path: string; line: number };
type Row = Position & { text?: string; clipped?: boolean; cursor: string };
type IdentityFields = Omit<DependencyIdentity, "root" | "fileHashes">;
type Resolution = Pair & ({ status: "available"; identity: DependencyIdentity } | { status: "unavailable"; reason: string });
export type DependencyReadArgs = {
  module: string; importer: string; path?: string; query?: string; startLine?: number; endLine?: number; cursor?: string;
};
export type DependencyPage = IdentityFields & { rows: Row[]; next?: string; mode: "list" | "search" | "read" };
type Reader = (input: DependencyReadArgs, signal?: AbortSignal) => Promise<DependencyPage>;

export async function buildDependencySources(input: {
  resolver: SourceResolver; registry: LanguageAdapterRegistry; files: DiffFile[]; signal?: AbortSignal;
}): Promise<{ status: Array<Omit<Resolution, "identity"> & { version?: string; reason?: string; identity?: DependencyIdentity["identity"] }>; read?: Reader }> {
  const { resolver, registry, files, signal } = input;
  const paths = new Set(await resolver.listFiles());
  const go = goDependencies(paths.has("go.mod") ? (await resolver.readFile("go.mod"))?.content ?? "" : "");
  const sum = paths.has("go.sum") ? (await resolver.readFile("go.sum"))?.content ?? "" : "";
  const prefixes = [...go.requires.keys()].sort((a, b) => b.length - a.length);
  const pairs = new Map<string, Pair>();
  for (const file of files) {
    signal?.throwIfAborted();
    for (const source of [{ kind: "base" }, { kind: "head" }] as const satisfies SourceSelector[]) {
      if (source.kind === "base" ? file.status === "added" : file.status === "deleted") continue;
      const path = source.kind === "base" ? file.oldPath ?? file.path : file.path;
      const adapter = registry.forPath(path);
      const isGo = adapter.id === "go";
      if (!isGo && !["typescript", "tsx", "javascript"].includes(adapter.id)) continue;
      const content = await resolver.readFile(path, source);
      if (!content) continue;
      const parsed = await adapter.parse({ ...content, language: adapter.id });
      const imports = adapter.getImports(parsed);
      const sites = isGo ? undefined : nodeImportSites(parsed);
      for (const specifier of imports) {
        if (sites && !sites.has(specifier)) continue;
        const module = isGo
          ? prefixes.find(prefix => specifier === prefix || specifier.startsWith(prefix + "/"))
          : nodeModule(specifier);
        if (module) pairs.set(pairKey(file.path, module), { importer: file.path, module, kind: isGo ? "go" : "node" });
      }
    }
  }

  const resolved = new Map<string, Resolution>();
  const node = pairs.size ? new NodeDependencyIdentity(resolver, await realpath(resolver.repoRoot), paths) : undefined;
  const goPackages = new Map<string, Promise<DependencyIdentity>>();
  for (const [key, pair] of pairs) {
    signal?.throwIfAborted();
    const { importer, module, kind } = pair;
    try {
      let identity: DependencyIdentity;
      if (kind === "go") {
        let pending = goPackages.get(module);
        if (!pending) {
          pending = resolveGoDependency(module, go, sum, signal);
          goPackages.set(module, pending);
        }
        identity = await pending;
      } else {
        identity = await node!.resolve(importer, module);
      }
      resolved.set(key, { ...pair, status: "available", identity });
    } catch (error) {
      signal?.throwIfAborted();
      const reason = error instanceof CodegenieError ? error.message : "The tracked or installed dependency record is missing or unreadable.";
      resolved.set(key, { ...pair, status: "unavailable", reason });
    }
  }
  const status = [...resolved.values()].map(row => row.status === "unavailable" ? row : {
    importer: row.importer, module: row.module, kind: row.kind, status: row.status, version: row.identity.version, identity: row.identity.identity
  });
  const available = status.some(row => row.status === "available");
  if (!available) return { status };
  return { status, read: async (args, signal) => {
    const row = resolved.get(pairKey(args.importer, args.module));
    if (!row) {
      const allowed = [...resolved.values()].map(({ importer, module }) => ({ importer, module }));
      throw new CodegenieError("module_not_allowed", "Use a changed importer and its module. Allowed pairs: " + JSON.stringify(allowed));
    }
    if (row.status === "unavailable") dependencyUnavailable(row.reason);
    return readPage(row.identity, args, signal);
  } };
}

function nodeImportSites(file: ParsedFile): Set<string> {
  const tree = treeFromParsed(file);
  const imports = new Set<string>();
  if (!tree) return imports;
  const pending = [tree.rootNode];
  while (pending.length) {
    const node = pending.pop()!;
    const source = node.type === "import_statement" || node.type === "export_statement"
      ? node.childForFieldName("source")
      : node.type === "call_expression" && node.childForFieldName("function")?.text === "require"
        ? node.childForFieldName("arguments")?.namedChildren[0] : undefined;
    // The ordinary outline's lexical import scan also sees quoted examples.
    // Dependency access requires an import or require in the parsed source.
    if (source?.type === "string" && !source.hasError) imports.add(source.text.slice(1, -1));
    pending.push(...node.namedChildren);
  }
  return imports;
}

function nodeModule(specifier: string): string | undefined {
  if (isBuiltin(specifier) || specifier.startsWith("node:")) return undefined;
  const match = /^(?:@[-\w.]+\/)?[a-zA-Z0-9_][-\w.]*(?=\/|$)/u.exec(specifier)?.[0];
  return match;
}

function pairKey(importer: string, module: string): string {
  return JSON.stringify([importer, module]);
}

function validatePath(path: string): void {
  if (/^[A-Za-z]:|[\\\x00-\x1f\x7f]/u.test(path) || path.split("/").some(part => !part || part === "." || part === "..")) {
    throw new CodegenieError("path_outside_module", "Use a relative path inside the resolved dependency.");
  }
}

function positionFromCursor(input: string, binding: string): Position {
  const value = decodeToolCursor(input, binding);
  if (!value || typeof value !== "object" || !("path" in value) || typeof value.path !== "string" ||
      !("line" in value) || typeof value.line !== "number" || !Number.isSafeInteger(value.line) || value.line < 1) {
    throw new CodegenieError("invalid_args", "Invalid dependency cursor position.");
  }
  validatePath(value.path);
  return { path: value.path, line: value.line };
}

function makeRow(path: string, line: number, cursor: string, text?: string): Row {
  const clean = text === undefined ? undefined : redactThenTruncate(text, LINE_CHARS, "", true);
  return { path, line, cursor, ...(clean !== undefined ? { text: clean } : {}),
    ...(text !== undefined && text.length > LINE_CHARS ? { clipped: true } : {}) };
}

function decodeText(bytes: Buffer): string {
  try {
    if (bytes.includes(0)) throw new Error("binary");
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new CodegenieError("binary_or_too_large", "Dependency source is not UTF-8 text.");
  }
}

function linesOf(text: string): string[] {
  const lines = text.split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

async function textFile(identity: DependencyIdentity, path: string, signal?: AbortSignal, budget?: { bytes: number }): Promise<string | undefined> {
  signal?.throwIfAborted();
  return withDependencyFile(identity.root, join(identity.root, path), async (fd, size) => {
    if (size > FILE_BYTES) throw new CodegenieError("binary_or_too_large", "Dependency source exceeds 2 MB.");
    if (budget && size > budget.bytes) return undefined;
    // Read at most the observed size plus an overflow check, even if a concurrent write grows the file.
    const buffer = await readDependencyBytes(fd, size);
    if (budget) budget.bytes -= buffer.length;
    if (identity.fileHashes && createHash("sha256").update(buffer).digest("hex") !== identity.fileHashes.get(path)) {
      dependencyUnavailable("Go module file differs from the verified go.sum tree.");
    }
    signal?.throwIfAborted();
    return decodeText(buffer);
  });
}

async function readPage(identity: DependencyIdentity, args: DependencyReadArgs, signal?: AbortSignal): Promise<DependencyPage> {
  const { module, importer, path, query, startLine, endLine } = args;
  if (path !== undefined) validatePath(path);
  const mode = query !== undefined ? "search" : path !== undefined ? "read" : "list";
  if ((mode !== "read" && (startLine !== undefined || endLine !== undefined)) ||
    (query !== undefined && (!query || /[\r\n\0]/u.test(query))) ||
    (startLine !== undefined && (!Number.isSafeInteger(startLine) || startLine < 1)) ||
    (endLine !== undefined && (!Number.isSafeInteger(endLine) || endLine < (startLine ?? 1)))) {
    throw new CodegenieError("invalid_args", "Use a single-line literal query, or a file path with ordered positive line bounds.");
  }
  const { root: _root, fileHashes: _hashes, ...fields } = identity;
  const binding = toolCursorBinding([module, importer, identity.root, fields, path, query, startLine, endLine]);
  const cursor = (path: string, line: number) => encodeToolCursor(binding, { path, line });
  const position = args.cursor ? positionFromCursor(args.cursor, binding) : undefined;
  if (mode === "read") {
    if (position && (position.path !== path || position.line < (startLine ?? 1) || (endLine !== undefined && position.line > endLine))) {
      throw new CodegenieError("invalid_args", "Dependency cursor is outside the requested range.");
    }
    let text: string | undefined;
    try {
      text = await textFile(identity, path!, signal);
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof CodegenieError) throw error;
      throw new CodegenieError("invalid_args", "Dependency file does not exist or is unreadable. List files first.");
    }
    const lines = linesOf(text!);
    const from = position?.line ?? startLine ?? 1;
    const end = Math.min(endLine ?? lines.length, lines.length);
    const delivered = Math.min(end, from + READ_LINES - 1);
    const rows = lines.slice(from - 1, delivered).map((text, i) => makeRow(path!, from + i, cursor(path!, from + i), text));
    return { ...fields, mode, rows, ...(delivered < end ? { next: cursor(path!, delivered + 1) } : {}) };
  }

  const limit = mode === "list" ? LIST_FILES : SEARCH_ROWS;
  const rows: Row[] = [];
  const budget = { bytes: SCAN_BYTES };
  let scanned = 0;
  let resume = position === undefined;
  for await (const file of dependencyPaths(identity.root)) {
    signal?.throwIfAborted();
    if (path && !file.startsWith(path)) continue;
    if (!resume && file !== position?.path) continue;
    resume = true;
    const first = position?.path === file ? position.line : 1;
    if (scanned >= SCAN_FILES || rows.length >= limit) return { ...fields, mode, rows, next: cursor(file, first) };
    scanned++;
    try {
      const text = await textFile(identity, file, signal, budget);
      if (text === undefined) return { ...fields, mode, rows, next: cursor(file, first) };
      if (query === undefined) rows.push(makeRow(file, 1, cursor(file, 1)));
      else {
        const lines = linesOf(text);
        for (let i = first - 1; i < lines.length; i++) {
          if (!lines[i]!.includes(query)) continue;
          if (rows.length >= limit) return { ...fields, mode, rows, next: cursor(file, i + 1) };
          rows.push(makeRow(file, i + 1, cursor(file, i + 1), lines[i]!));
        }
      }
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof CodegenieError && error.code === "dependency_unavailable") throw error;
      // Listing and search skip binaries, oversized files and escaping links.
      if (!(error instanceof CodegenieError) && !["ENOENT", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  if (!resume) throw new CodegenieError("invalid_args", "Dependency cursor path is no longer present.");
  return { ...fields, mode, rows };
}
