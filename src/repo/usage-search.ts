import type { SourceSelector } from "../types.js";
import { CodegenieError } from "../util/errors.js";
import { isRepositoryTestPath } from "../util/path-roles.js";
import { sha256Hex } from "../util/hashing.js";
import type { SourceResolver } from "./source-resolver.js";
import type { LanguageAdapterRegistry } from "./language-adapter.js";
import { classifyUsageSyntax, type UsageOccurrence } from "./usage-syntax.js";
import pathUtil from "node:path";

export type UsageSearchOptions = { source?: SourceSelector; scope?: "all" | "tests"; pathGlob?: string; cursor?: string; maxRows?: number; signal?: AbortSignal };
export type UsageRow = UsageOccurrence & { revision: "head" | "base"; fileLines: number; excerpt?: string; excerptOmitted?: true };
export type TextUsageRow = { revision: "head" | "base"; path: string; line: number; column: number; fileLines: number; excerpt?: string; excerptOmitted?: true };
export type UsageEntry = { kind: "syntactic"; row: UsageRow; cursor: string } | { kind: "text"; row: TextUsageRow; cursor: string };
export type UsagePage = { revision: "head" | "base"; scope: "all" | "tests"; pathGlob?: string; rows: UsageRow[]; textMatches: TextUsageRow[];
  entries: UsageEntry[]; candidateFiles: number; filesScanned: number; filesParsed: number; candidateProgress: number; scanComplete: boolean; coverageComplete: boolean;
  stopReason?: "row_limit" | "file_scan_limit"; nextCursor?: string; omissions: string[]; omittedDiagnostics: number };

type Cursor = { version: 1; binding: string; path: string; line: number; column: number; incomplete?: boolean; startFile?: boolean };
const MAX_FILES_PER_PAGE = 500;
const MAX_ROWS = 100;
const MAX_EXCERPT_CHARS = 2_000;

/** Bounded pinned-tree traversal. A cursor resumes at the first unreturned occurrence. */
export async function findUsages(
  resolver: SourceResolver, registry: LanguageAdapterRegistry, name: string, options: UsageSearchOptions = {}
): Promise<UsagePage> {
  if (!name || name.length > 500 || /[\r\n\0]/u.test(name) || name.split(".").some(part => part.length === 0)) {
    throw new CodegenieError("invalid_args", "name must be a non-empty single-line name with no empty dotted segment (maximum 500 characters)");
  }
  checkAbort(options.signal);
  const source = options.source ?? { kind: "head" };
  const scope = options.scope ?? "all";
  const requested = options.maxRows ?? 50;
  if (!Number.isInteger(requested) || requested < 1 || requested > MAX_ROWS) throw new CodegenieError("invalid_args", `maxRows must be between 1 and ${MAX_ROWS}`);
  const binding = sha256Hex(JSON.stringify([resolver.resolveSource(source), source.kind, name, scope, options.pathGlob ?? null]));
  const cursor = options.cursor ? decodeCursor(options.cursor, binding) : undefined;
  // Prefer supported source files over text-only leads so documentation does not
  // consume the first pages before syntactic callers are offered.
  const paths = (await resolver.grepFiles(name.split(".").at(-1)!, options.pathGlob, source)).filter(path => scope === "all" || isRepositoryTestPath(path))
    .sort((a, b) => Number(!isSupportedSource(a)) - Number(!isSupportedSource(b)) || (a < b ? -1 : a > b ? 1 : 0));
  checkAbort(options.signal);
  const start = cursor ? paths.indexOf(cursor.path) : 0;
  if (start < 0) throw new CodegenieError("invalid_args", "cursor path is not present in the selected tree and scope");
  let repositoryPaths: Set<string> | undefined;
  const rows: UsageRow[] = [];
  const textMatches: TextUsageRow[] = [];
  const entries: UsageEntry[] = [];
  const omissions: string[] = [];
  let omittedDiagnostics = 0;
  const recordOmission = (value: string): void => { if (omissions.length < 3) omissions.push(value); else omittedDiagnostics++; };
  let filesScanned = 0;
  let filesParsed = 0;
  let coverageComplete = !cursor?.incomplete;
  const page = (next?: Cursor, stopReason?: UsagePage["stopReason"]): UsagePage => ({ revision: source.kind, scope, ...(options.pathGlob !== undefined ? { pathGlob: options.pathGlob } : {}), rows, textMatches, entries, candidateFiles: paths.length, filesScanned, filesParsed, candidateProgress: start + filesScanned,
    scanComplete: next === undefined, coverageComplete: next === undefined && coverageComplete,
    ...(stopReason ? { stopReason } : {}), ...(next ? { nextCursor: encodeCursor({ ...next, ...(!coverageComplete ? { incomplete: true } : {}) }) } : {}), omissions, omittedDiagnostics });
  for (const path of paths.slice(start)) {
    checkAbort(options.signal);
    if (filesScanned >= MAX_FILES_PER_PAGE) return page({ version: 1, binding, path, line: 1, column: 1, startFile: true }, "file_scan_limit");
    filesScanned++;
    const file = await resolver.readFile(path, source);
    checkAbort(options.signal);
    if (!file) { coverageComplete = false; recordOmission(`${path}: pinned file unavailable`); continue; }
    const lines = file.content.split("\n");
    if (file.content.endsWith("\n")) lines.pop();
    const adapter = registry.forPath(path);
    const parsed = await adapter.parse({ path, language: registry.languageForPath(path), content: file.content, source, contentSha: file.contentSha });
    checkAbort(options.signal);
    if (parsed.tree) filesParsed++;
    const syntax = classifyUsageSyntax(parsed, name);
    if (!syntax || parsed.hasErrors) coverageComplete = false;
    const matches: Iterable<{ line: number; column: number; occurrence?: UsageOccurrence }> = syntax
      ? syntax.sort(compareUsageGroups).map(occurrence => ({ line: occurrence.line, column: occurrence.column, occurrence }))
      : findTextMatches(lines, name);
    if (parsed.hasErrors) recordOmission(`${path}: parse has errors; syntax matches may be incomplete`);
    let reachedCursor = !cursor || path !== cursor.path || cursor.startFile === true;
    for (const match of matches) {
      if (!reachedCursor) {
        if (match.line !== cursor!.line || match.column !== cursor!.column) continue;
        reachedCursor = true;
      }
      if (rows.length + textMatches.length >= requested) return page({ version: 1, binding, path, line: match.line, column: match.column }, "row_limit");
      const excerpt = lines[match.line - 1];
      const location = { revision: source.kind, path, line: match.line, column: match.column, fileLines: lines.length,
        ...(excerpt !== undefined && excerpt.length <= MAX_EXCERPT_CHARS ? { excerpt } : { excerptOmitted: true as const }) };
      const entryCursor = encodeCursor({ version: 1, binding, path, line: match.line, column: match.column,
        ...(!coverageComplete ? { incomplete: true } : {}) });
      if (match.occurrence) {
        const evidence = match.occurrence.bindingEvidence;
        let row: UsageRow;
        if (evidence?.moduleSpecifier.startsWith(".")) {
          repositoryPaths ??= new Set(await resolver.listFiles(undefined, source));
          const target = resolveRelativeModule(path, evidence.moduleSpecifier, repositoryPaths);
          row = { ...match.occurrence, ...location, bindingEvidence: { ...evidence, ...(target ? { candidateModulePath: target } : {}) } };
        } else row = { ...match.occurrence, ...location };
        rows.push(row);
        entries.push({ kind: "syntactic", row, cursor: entryCursor });
      }
      else { textMatches.push(location); entries.push({ kind: "text", row: location, cursor: entryCursor }); }
    }
    if (!reachedCursor) throw new CodegenieError("invalid_args", "cursor position is not present in the selected pinned file");
  }
  return page();
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CodegenieError("llm_call_failed", "repository tool aborted");
}

function isSupportedSource(path: string): boolean { return /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|go)$/u.test(path); }

function compareUsageGroups(a: UsageOccurrence, b: UsageOccurrence): number {
  return a.enclosing.lineRange[0] - b.enclosing.lineRange[0] || (a.enclosing.startColumn ?? 0) - (b.enclosing.startColumn ?? 0)
    || a.enclosing.lineRange[1] - b.enclosing.lineRange[1] || (a.enclosing.endColumnExclusive ?? 0) - (b.enclosing.endColumnExclusive ?? 0)
    || a.line - b.line || a.column - b.column;
}

function resolveRelativeModule(from: string, specifier: string, paths: Set<string>): string | undefined {
  const stem = pathUtil.posix.normalize(pathUtil.posix.join(pathUtil.posix.dirname(from), specifier));
  if (stem === ".." || stem.startsWith("../") || pathUtil.posix.isAbsolute(stem)) return undefined;
  const replacements = stem.endsWith(".js") ? [stem.slice(0, -3) + ".ts", stem.slice(0, -3) + ".tsx"]
    : stem.endsWith(".mjs") ? [stem.slice(0, -4) + ".mts"] : stem.endsWith(".cjs") ? [stem.slice(0, -4) + ".cts"] : [];
  const candidates = [stem, ...replacements, ...[".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"].map(ext => stem + ext),
    ...[".ts", ".tsx", ".js", ".jsx"].map(ext => `${stem}/index${ext}`)].filter(candidate => paths.has(candidate));
  return candidates.length === 1 ? candidates[0] : undefined;
}

function* findTextMatches(lines: string[], name: string): Generator<{ line: number; column: number }> {
  for (const [index, line] of lines.entries()) {
    let at = line.indexOf(name);
    while (at >= 0) { yield { line: index + 1, column: at + 1 }; at = line.indexOf(name, at + Math.max(1, name.length)); }
  }
}

function encodeCursor(cursor: Cursor): string { return Buffer.from(JSON.stringify(cursor)).toString("base64url"); }
function decodeCursor(value: string, binding: string): Cursor {
  try {
    if (value.length > 4_096) throw new Error("oversized cursor");
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (typeof parsed === "object" && parsed !== null) {
      const cursor = parsed as Partial<Cursor>;
      if (cursor.version === 1 && cursor.binding === binding && typeof cursor.path === "string"
        && Number.isSafeInteger(cursor.line) && cursor.line! > 0 && Number.isSafeInteger(cursor.column) && cursor.column! > 0
        && (cursor.incomplete === undefined || typeof cursor.incomplete === "boolean")
        && (cursor.startFile === undefined || typeof cursor.startFile === "boolean")) return cursor as Cursor;
    }
  } catch { /* invalid cursor */ }
  throw new CodegenieError("invalid_args", "cursor does not match the revision, name, scope and pathGlob of this lookup");
}
