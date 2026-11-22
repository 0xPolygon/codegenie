import type { SourceFileMap, SourceSelector } from "../types.js";
import { CodegenieError } from "../util/errors.js";
import type { LanguageAdapterRegistry } from "./language-adapter.js";
import { containPath } from "./path-guard.js";
import type { SourceResolver } from "./source-resolver.js";
import { decodeToolCursor, encodeToolCursor, toolCursorBinding } from "./tool-cursor.js";

export const MAX_SMALL_SOURCE_CHARS = 4_000;
const DECLARATIONS_PER_PAGE = 60;

export async function readSourceFileMap(resolver: SourceResolver, registry: LanguageAdapterRegistry, file: string,
  source: SourceSelector = { kind: "head" }, cursor?: string): Promise<SourceFileMap> {
  const path = containPath(resolver.repoRoot, file);
  const binding = toolCursorBinding(["read_range:file-map", resolver.resolveSource(source), source.kind, path]);
  const offset = cursor === undefined ? 0 : decodeToolCursor(cursor, binding);
  if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) {
    throw new CodegenieError("invalid_args", "File map cursor has an invalid declaration position.");
  }
  const requestedSource = source.kind;
  const textMeta = { backend: "text" as const, precision: "exact" as const, degraded: false, requestedSource, sourceUsed: requestedSource };
  const content = await resolver.readFile(path, source);
  if (!content) {
    return { path, offset, totalDeclarations: 0, declarations: [],
      meta: { ...textMeta, lookupStatus: "file_missing", deliveryStatus: "empty" } };
  }

  const text = content.content;
  const totalLines = text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;
  const smallSource = cursor === undefined && text.length <= MAX_SMALL_SOURCE_CHARS ? { smallSource: text } : {};
  const adapter = registry.forPath(path);
  const parsed = await adapter.parse({ path, language: registry.languageForPath(path), content: text, source, contentSha: content.contentSha });
  if (!parsed.tree || parsed.hasErrors) {
    return { path, offset, totalDeclarations: 0, declarations: [], ...smallSource,
      meta: { ...textMeta, totalLines, lookupStatus: "unavailable", deliveryStatus: "empty" } };
  }

  const symbols = adapter.listSymbols(parsed).filter(symbol => symbol.lineRange[0] <= totalLines)
    .sort((a, b) => a.lineRange[0] - b.lineRange[0] || a.lineRange[1] - b.lineRange[1]);
  if (cursor !== undefined && offset >= symbols.length) {
    throw new CodegenieError("invalid_args", "File map cursor is past the last declaration.");
  }
  const page = symbols.slice(offset, offset + DECLARATIONS_PER_PAGE);
  const declarations = page.map((symbol, i) => ({
    symbol: { ...symbol, lineRange: [symbol.lineRange[0], Math.min(symbol.lineRange[1], totalLines)] as [number, number] },
    cursor: encodeToolCursor(binding, offset + i)
  }));
  const omittedCount = symbols.length - offset - page.length;
  return { path, offset, totalDeclarations: symbols.length, declarations, ...smallSource,
    ...(omittedCount > 0 ? { next: encodeToolCursor(binding, offset + page.length) } : {}),
    meta: {
      ...textMeta, backend: "tree-sitter", precision: "syntactic", totalLines, lookupStatus: "found",
      deliveryStatus: omittedCount > 0 ? "truncated" : page.length ? "full" : "empty",
      ...(omittedCount > 0 ? { truncated: true, omittedCount, degradationReason: "file_map_page_limit" } : {})
    }
  };
}
