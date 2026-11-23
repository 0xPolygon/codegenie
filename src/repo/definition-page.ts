import type { DefinitionHit, SymbolLookupSourceSelector, ToolResultMeta } from "../types.js";
import { CodegenieError } from "../util/errors.js";
import { isTextFallbackHit } from "./repository-index.js";
import { decodeToolCursor, encodeToolCursor, toolCursorBinding } from "./tool-cursor.js";

export type DefinitionPageOptions = { path?: string; source?: SymbolLookupSourceSelector; cursor?: string };
export type DefinitionPage = { name: string; path?: string; requestedSource: "head" | "base" | "auto";
  sourceUsed: "head" | "base"; hits: DefinitionHit[]; meta: ToolResultMeta; offset: number; binding: string };

/** Bind a declaration-list position to both pinned trees and the original scope. */
export function makeDefinitionPage(name: string, options: DefinitionPageOptions,
  result: { definitions: DefinitionHit[]; meta: ToolResultMeta }, trees: { headCommit: string; baseCommit: string }): DefinitionPage {
  const requestedSource = options.source?.kind ?? "head";
  const sourceUsed = result.meta.sourceUsed ?? (requestedSource === "base" ? "base" : "head");
  const hits = [...result.definitions].sort((a, b) => Number(isTextFallbackHit(a)) - Number(isTextFallbackHit(b))
    || (a.symbol.path < b.symbol.path ? -1 : a.symbol.path > b.symbol.path ? 1 : 0)
    || a.symbol.lineRange[0] - b.symbol.lineRange[0]);
  const binding = toolCursorBinding(["read_definition", trees.headCommit, trees.baseCommit, name, options.path ?? null, requestedSource, sourceUsed]);
  let offset = 0;
  if (options.cursor !== undefined) {
    const position = decodeToolCursor(options.cursor, binding) as { index?: unknown; path?: unknown; line?: unknown };
    if (!position || !Number.isSafeInteger(position.index) || typeof position.index !== "number" || position.index < 0 || position.index >= hits.length
      || hits[position.index]?.symbol.path !== position.path || hits[position.index]?.symbol.lineRange[0] !== position.line) {
      throw new CodegenieError("invalid_args", "Definition cursor does not identify a declaration in this pinned lookup.");
    }
    offset = position.index;
  }
  const lookupNote = result.meta.lookupNote
    ?.replaceAll("; use read_range or find_symbol_mentions.", "; use read_range or find_usages.")
    .replaceAll("; use find_symbol_mentions.", "; use find_usages.")
    .replaceAll(". Narrow pathGlob; this occurrence", ". Narrow the path; this occurrence");
  const meta = { ...result.meta, ...(lookupNote !== undefined ? { lookupNote } : {}) };
  return { name, ...(options.path !== undefined ? { path: options.path } : {}), requestedSource, sourceUsed, hits, meta, offset, binding };
}

export function definitionCursor(page: DefinitionPage, index: number): string {
  const hit = page.hits[index];
  if (!hit) throw new CodegenieError("invalid_args", "Definition cursor is outside the declaration list.");
  return encodeToolCursor(page.binding, { index, path: hit.symbol.path, line: hit.symbol.lineRange[0] });
}
