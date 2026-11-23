import type { DefinitionHit, SymbolLookupSourceSelector, ToolResultMeta } from "../types.js";
import { CodegenieError } from "../util/errors.js";
import { isTextFallbackHit } from "./repository-index.js";
import { decodeToolCursor, encodeToolCursor, toolCursorBinding } from "./tool-cursor.js";

export type DefinitionPageOptions = { path?: string; source?: SymbolLookupSourceSelector; cursor?: string };
export type DefinitionPage = { name: string; path?: string; requestedSource: "head" | "base" | "auto";
  sourceUsed: "head" | "base"; hits: DefinitionHit[]; meta: ToolResultMeta; offset: number; binding: string };

export class DefinitionDirectoryBudgetError extends CodegenieError {
  constructor(readonly scope: NonNullable<ToolResultMeta["definitionScope"]>, cause: CodegenieError) {
    super("budget_exhausted",
      `Directory ${JSON.stringify(scope.directory)} is too broad for read_definition. Narrow path to a subdirectory or exact file. No files searched.`,
      { cause });
  }
}

/** Bind a declaration-list position to both pinned trees and the original scope. */
export function makeDefinitionPage(name: string, options: DefinitionPageOptions,
  result: { definitions: DefinitionHit[]; meta: ToolResultMeta }, trees: { headCommit: string; baseCommit: string }): DefinitionPage {
  const requestedSource = options.source?.kind ?? "head";
  const sourceUsed = result.meta.sourceUsed ?? (requestedSource === "base" ? "base" : "head");
  const hits = [...result.definitions].sort((a, b) => Number(isTextFallbackHit(a)) - Number(isTextFallbackHit(b))
    || (a.symbol.path < b.symbol.path ? -1 : a.symbol.path > b.symbol.path ? 1 : 0)
    || a.symbol.lineRange[0] - b.symbol.lineRange[0]);
  const scope = result.meta.definitionScope;
  const selector = scope ? { directory: scope.directory } : options.path ?? null;
  const binding = toolCursorBinding(["read_definition", trees.headCommit, trees.baseCommit, name, selector, requestedSource, sourceUsed]);
  let offset = 0;
  if (options.cursor !== undefined) {
    const position = decodeToolCursor(options.cursor, binding) as { index?: unknown; path?: unknown; line?: unknown };
    if (!position || !Number.isSafeInteger(position.index) || typeof position.index !== "number" || position.index < 0 || position.index >= hits.length
      || hits[position.index]?.symbol.path !== position.path || hits[position.index]?.symbol.lineRange[0] !== position.line) {
      throw new CodegenieError("invalid_args", "Definition cursor does not identify a declaration in this pinned lookup.");
    }
    offset = position.index;
  }
  const backendNote = result.meta.lookupNote
    ?.replaceAll("; use read_range or find_symbol_mentions.", "; use read_range or find_usages.")
    .replaceAll("; use find_symbol_mentions.", "; use find_usages.")
    .replaceAll(". Narrow pathGlob; this occurrence", ". Narrow the path; this occurrence");
  const directoryNote = scope
    ? `Path ${JSON.stringify(scope.directory)} is a directory at ${sourceUsed}. Searched that directory and its descendants.`
    : undefined;
  const lookupNote = [directoryNote, backendNote].filter(Boolean).join(" ");
  const meta = { ...result.meta, ...(lookupNote ? { lookupNote } : {}) };
  return { name, ...(options.path !== undefined ? { path: options.path } : {}), requestedSource, sourceUsed, hits, meta, offset, binding };
}

export function definitionCursor(page: DefinitionPage, index: number): string {
  const hit = page.hits[index];
  if (!hit) throw new CodegenieError("invalid_args", "Definition cursor is outside the declaration list.");
  return encodeToolCursor(page.binding, { index, path: hit.symbol.path, line: hit.symbol.lineRange[0] });
}
