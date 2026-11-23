import type { SearchDelivery, SearchOptions, SearchPage, SearchPageOptions, SearchResult, SourceSelector, SymbolMentionOptions, ToolBackend, ToolPrecision, ToolResultMeta } from "../types.js";
import type { GrepPosition } from "../git/git-client.js";
import { CodegenieError } from "../util/errors.js";
import { containGlob, containPath } from "./path-guard.js";
import type { SourceResolver } from "./source-resolver.js";
import type { LanguageAdapterRegistry } from "./language-adapter.js";
import { decodeToolCursor, encodeToolCursor, toolCursorBinding } from "./tool-cursor.js";

export type SearchEngine = "git-grep";

export type SearchExecution = {
  results: SearchResult[];
  engine: SearchEngine;
  backend: ToolBackend;
  precision: ToolPrecision;
  degraded: boolean;
  degradationReason?: string;
  truncated?: boolean;
  omittedCount?: number;
  discoveryLimited?: boolean;
  omittedCountIsLowerBound?: boolean;
  searchDelivery?: SearchDelivery;
  mentionNext?: { path: string; line: number };
};

export function hasSearchContext(result: SearchResult): boolean {
  return result.enclosingSymbol !== undefined || Boolean(result.contextBefore?.length || result.contextAfter?.length);
}

type SearchPosition = NonNullable<SearchDelivery["nextRead"]>;

export function earlierSearchPosition(left?: SearchPosition, right?: SearchPosition): SearchPosition | undefined {
  if (!left || !right) return left ?? right;
  return left.path < right.path || (left.path === right.path && left.line <= right.line) ? left : right;
}

export function searchContextPosition(result: SearchResult): SearchPosition {
  const line = result.contextBefore?.length ? result.line - result.contextBefore.length
    : result.contextAfter?.length ? result.line + 1 : result.enclosingSymbol?.lineRange[0] ?? result.line;
  return { path: result.path, line };
}

export function searchCutNotice(delivery: SearchDelivery): string {
  const omitted = delivery.discoveryOmittedCount + delivery.backendOmittedCount + delivery.budgetOmittedCount;
  const details = [`Omitted ${delivery.scanIncomplete ? "at least " : ""}${omitted} matching lines.`];
  if (delivery.scanIncomplete) details.push("Scan limited.");
  if (delivery.backendContextStripped || delivery.budgetContextStripped) details.push("Context shortened.");
  if (delivery.shortenedExcerpts) details.push("Matching text shortened.");
  if (delivery.nextRead) details.push(`Next read_range: ${JSON.stringify(delivery.nextRead.path)}@${delivery.source}:${delivery.nextRead.line}.`);
  details.push("Narrow pathGlob to search again.");
  return details.join(" ");
}

/** Report scan and delivery limits independently of the legacy rendered payload. */
export function searchDeliveryMeta(meta: ToolResultMeta, delivery: SearchDelivery, refused = false): ToolResultMeta {
  const omittedCount = delivery.discoveryOmittedCount + delivery.backendOmittedCount + delivery.budgetOmittedCount;
  const truncated = refused || omittedCount > 0 || delivery.scanIncomplete
    || delivery.backendContextStripped || delivery.budgetContextStripped || delivery.shortenedExcerpts > 0;
  const degradationReason = refused || delivery.budgetOmittedCount > 0 || delivery.budgetContextStripped ? "tool_result_budget"
    : delivery.scanIncomplete || delivery.discoveryOmittedCount > 0 ? "search_discovery_limit"
      : truncated ? "search_result_limit" : undefined;
  const { degradationReason: _legacyReason, ...base } = meta;
  return {
    ...base, searchDelivery: delivery, degraded: false, truncated,
    ...(degradationReason ? { degradationReason } : {}),
    deliveryStatus: refused ? "budget_rejected" : truncated ? "truncated" : delivery.deliveredCount ? "full" : "empty",
    omittedCount,
    omittedCountIsLowerBound: delivery.scanIncomplete
  };
}

export class SearchBudgetError extends CodegenieError {
  readonly meta: ToolResultMeta;

  constructor(message: string, delivery: SearchDelivery) {
    super("budget_exhausted", `${message} ${searchCutNotice(delivery)} This is not a zero-match result.`);
    this.meta = { ...searchDeliveryMeta({ backend: "text", precision: "text", degraded: false }, delivery, true),
      degradationReason: "search_result_limit" };
  }
}

type RawSearchOptions = SearchOptions & {
  fixedString?: boolean;
  word?: boolean;
  defaultMaxResults?: number;
  hardMaxResults?: number;
  mention?: string;
};

const DEFAULT_MAX_RESULTS = 50;
const HARD_MAX_RESULTS = 200;
const MAX_QUERY_CHARS = 500;
const MAX_MATCH_TEXT_CHARS = 500;
const MAX_TOTAL_RESULT_CHARS = 16_000;

export class SearchService {
  constructor(
    private readonly resolver: SourceResolver,
    private readonly registry: LanguageAdapterRegistry,
    private readonly limit: <T>(fn: () => Promise<T>) => Promise<T> = (fn) => fn()
  ) {}

  async searchPage(query: string, options: SearchPageOptions = {}): Promise<SearchPage> {
    validateQuery(query);
    const source = options.source ?? { kind: "head" };
    const mode = options.mode ?? "regex";
    const contextMode = options.contextMode ?? "none";
    const maxResults = clampMaxResults(options.maxResults, DEFAULT_MAX_RESULTS, HARD_MAX_RESULTS);
    const caseSensitive = options.caseSensitive ?? true;
    const pathGlob = options.pathGlob === undefined ? undefined : containGlob(this.resolver.repoRoot, options.pathGlob);
    const revision = this.resolver.resolveSource(source);
    const binding = toolCursorBinding(["search_files", revision, source.kind, query, mode, pathGlob ?? null, contextMode, maxResults, caseSensitive]);
    const startAt = options.cursor === undefined ? undefined : this.searchPosition(decodeToolCursor(options.cursor, binding));
    const raw = await this.limit(() => this.resolver.grep(query, {
      source, positioned: true, fixedString: mode === "literal", maxResults: maxResults + 1, caseSensitive,
      ...(pathGlob === undefined ? {} : { glob: pathGlob }),
      ...(startAt ? { startAt } : {})
    })).catch(error => {
      if (error instanceof CodegenieError && error.code === "invalid_args" && options.mode === "regex") {
        throw new CodegenieError("invalid_args", error.message + " Use mode=literal to search for source text.", { cause: error });
      }
      throw error;
    });

    const hits = capMatchTexts(raw.slice(0, maxResults)).results;
    const nextHit = raw[maxResults];
    const skipped = raw.omittedLines ?? 0;
    const delivery: SearchDelivery = {
      source: source.kind, deliveredCount: hits.length, scanIncomplete: nextHit !== undefined,
      ...(raw.emptyScope ? { emptyScope: true } : {}),
      discoveryOmittedCount: Number(nextHit !== undefined), backendOmittedCount: skipped, budgetOmittedCount: 0,
      shortenedExcerpts: hits.filter(hit => hit.excerpt).length, backendContextStripped: false, budgetContextStripped: false,
      ...(raw.firstOmitted ? { nextRead: raw.firstOmitted } : {})
    };
    if (!hits.length && skipped) throw new SearchBudgetError("No matching line fits the search output allowance.", delivery);
    await this.enrich(hits, source, contextMode);
    const fileLengths = new Map<string, number>();
    for (const path of groupByPath(hits).keys()) {
      const file = await this.resolver.readFile(path, source);
      if (!file) throw new CodegenieError("git_ref_missing", "A search result could not be positioned in the pinned source.");
      const text = file.content;
      fileLengths.set(path, text ? text.split("\n").length - Number(text.endsWith("\n")) : 0);
    }
    const cursorFor = ({ path, line }: GrepPosition) => encodeToolCursor(binding, { path, line });
    return {
      revision,
      ...(pathGlob === undefined ? {} : { pathGlob }),
      rows: hits.map(hit => ({ hit, totalLines: fileLengths.get(hit.path)!, cursor: cursorFor(hit) })),
      meta: searchDeliveryMeta({
        backend: "text", precision: "text", degraded: false, requestedSource: source.kind, sourceUsed: source.kind,
        lookupStatus: hits.length ? "found" : "not_found",
        ...(nextHit ? { discoveryLimited: true } : {})
      }, delivery),
      ...(nextHit ? { next: { path: nextHit.path, line: nextHit.line, cursor: cursorFor(nextHit) } } : {})
    };
  }

  private searchPosition(value: unknown): GrepPosition {
    if (value && typeof value === "object" && "path" in value && typeof value.path === "string" && "line" in value &&
        typeof value.line === "number" && Number.isSafeInteger(value.line) && value.line > 0) {
      return { path: containPath(this.resolver.repoRoot, value.path), line: value.line };
    }
    throw new CodegenieError("invalid_args", "Search cursor has an invalid match position.");
  }

  async search(query: string, options: RawSearchOptions = {}): Promise<SearchExecution> {
    validateQuery(query);
    const source = options.source ?? { kind: "head" };
    const pathGlob = options.pathGlob === undefined ? undefined : containGlob(this.resolver.repoRoot, options.pathGlob);
    const maxResults = clampMaxResults(options.maxResults, options.defaultMaxResults ?? DEFAULT_MAX_RESULTS, options.hardMaxResults ?? HARD_MAX_RESULTS);
    const requested = maxResults + 1;
    const raw = await this.gitGrep(query, {
      ...options,
      source,
      maxResults: requested,
      ...(pathGlob !== undefined ? { pathGlob } : {})
    });

    const omittedLines = raw.omittedLines ?? 0;
    if (!raw.length && omittedLines) {
      if (options.mention !== undefined) {
        const next = raw.firstOmitted ? ` First unread match: ${raw.firstOmitted.path}@${source.kind}:${raw.firstOmitted.line}.` : "";
        throw new CodegenieError("budget_exhausted", `All matching lines exceeded the search output allowance; narrow pathGlob or read a known range. This is not a zero-match result.${next}`);
      }
      throw new SearchBudgetError("No matching line fits the search output allowance.", {
        source: source.kind, deliveredCount: 0, scanIncomplete: false, discoveryOmittedCount: 0,
        backendOmittedCount: omittedLines, budgetOmittedCount: 0, shortenedExcerpts: 0,
        backendContextStripped: false, budgetContextStripped: false,
        ...(raw.firstOmitted ? { nextRead: raw.firstOmitted } : {})
      });
    }
    const scanIncomplete = raw.length > maxResults;
    const discoveryLimited = scanIncomplete || (options.mention !== undefined && omittedLines > 0);
    // The extra text match may be a comment, not a verified identifier mention.
    const discoveryOmittedCount = options.mention === undefined ? Number(scanIncomplete) : 0;
    const classified = options.mention === undefined ? undefined : await this.classifyMentions(raw.slice(0, maxResults), options.mention, source);
    const lineCapped = capMatchTexts(classified?.results ?? raw.slice(0, maxResults));
    await this.enrich(lineCapped.results, source, options.contextMode ?? "none");
    const capped = capSearchResultsTotal(lineCapped.results);
    const backendOmittedCount = capped.omittedCount + (options.mention === undefined ? omittedLines : 0);
    const omittedCount = discoveryOmittedCount + backendOmittedCount;
    const shortened = lineCapped.truncatedTextCount > 0 || capped.shortened;
    const degraded = discoveryLimited || omittedCount > 0 || shortened || (classified?.syntaxFallbacks ?? 0) > 0;
    const shortenedHit = capped.results.find(result => result.excerpt);
    const strippedHit = capped.shortened ? lineCapped.results.find(hasSearchContext) : undefined;
    const nextRead = earlierSearchPosition(
      earlierSearchPosition(raw.firstOmitted, raw[maxResults]),
      earlierSearchPosition(capped.firstOmitted, earlierSearchPosition(
        shortenedHit && { path: shortenedHit.path, line: shortenedHit.line },
        strippedHit && searchContextPosition(strippedHit)
      ))
    );
    const searchDelivery: SearchDelivery | undefined = options.mention === undefined ? {
      source: source.kind,
      ...(raw.emptyScope ? { emptyScope: true } : {}),
      deliveredCount: capped.results.length,
      scanIncomplete,
      discoveryOmittedCount,
      backendOmittedCount,
      budgetOmittedCount: 0,
      shortenedExcerpts: capped.results.filter(result => result.excerpt).length,
      backendContextStripped: capped.shortened && lineCapped.results.some(hasSearchContext),
      budgetContextStripped: false,
      ...(nextRead ? { nextRead: { path: nextRead.path, line: nextRead.line } } : {})
    } : undefined;
    if (lineCapped.results.length > 0 && capped.results.length === 0) {
      if (searchDelivery) throw new SearchBudgetError("No complete search entry fits the result allowance.", searchDelivery);
      throw new CodegenieError("budget_exhausted", "No complete search entry fits the result allowance; narrow pathGlob or read a known range. This is not a zero-match result.");
    }
    return {
      results: capped.results, engine: "git-grep",
      backend: classified?.syntaxOnly ? "tree-sitter" : "text",
      precision: classified?.syntaxOnly ? "syntactic" : "text",
      degraded,
      ...(searchDelivery ? { searchDelivery } : {}),
      ...(options.mention !== undefined && nextRead ? { mentionNext: nextRead } : {}),
      ...(degraded ? { degradationReason: classified?.syntaxFallbacks ? `${classified.syntaxFallbacks} mention result(s) were not syntax-verified` : "search bounded: excerpts shortened or results omitted" } : {}),
      ...(discoveryLimited || omittedCount > 0 || shortened ? { truncated: true, omittedCount, omittedCountIsLowerBound: true, discoveryLimited } : {})
    };
  }

  async findSymbolMentions(symbolName: string, options: SymbolMentionOptions = {}): Promise<SearchExecution> {
    return this.search(symbolName, { ...options, fixedString: true, word: true, defaultMaxResults: 100, hardMaxResults: 300, mention: symbolName });
  }

  private async classifyMentions(results: SearchResult[], symbolName: string, source: SourceSelector) {
    const attemptedFiles = new Set<string>();
    let unverified = 0;
    // Generic text matches affect precision, but are not a failed syntax lookup.
    let syntaxFallbacks = 0;
    const kept: SearchResult[] = [];

    for (const result of results) {
      const alreadyAttempted = attemptedFiles.has(result.path);
      if (attemptedFiles.size >= 25 && !alreadyAttempted) {
        unverified += 1;
        if (this.registry.forPath(result.path).id !== "generic") {
          syntaxFallbacks += 1;
        }
        kept.push(result);
        continue;
      }
      attemptedFiles.add(result.path);
      const verified = await this.verifyIdentifierMention(result, symbolName, source);
      if (verified === true) {
        kept.push(result);
      } else if (verified === undefined) {
        unverified += 1;
        if (this.registry.forPath(result.path).id !== "generic") {
          syntaxFallbacks += 1;
        }
        kept.push(result);
      }
    }

    const syntaxOnly = kept.length > 0 && unverified === 0;
    return { results: kept, syntaxOnly, syntaxFallbacks };
  }

  private async gitGrep(query: string, options: RawSearchOptions & { pathGlob?: string; source: SourceSelector; maxResults: number }): Promise<import("../git/git-client.js").GrepResults> {
    return this.limit(() => this.resolver.grep(query, {
      source: options.source,
      maxResults: options.maxResults,
      ...(options.pathGlob !== undefined ? { glob: options.pathGlob } : {}),
      ...(options.caseSensitive !== undefined ? { caseSensitive: options.caseSensitive } : {}),
      ...(options.fixedString !== undefined ? { fixedString: options.fixedString } : {}),
      ...(options.word !== undefined ? { word: options.word } : {})
    }));
  }

  private async enrich(results: SearchResult[], source: SourceSelector, mode: SearchOptions["contextMode"]): Promise<void> {
    if (mode === "lines") {
      await this.enrichLines(results, source);
    } else if (mode === "symbols") {
      await this.enrichSymbols(results, source);
    }
  }

  private async enrichLines(results: SearchResult[], source: SourceSelector): Promise<void> {
    const byPath = groupByPath(results);
    for (const [filePath, matches] of byPath) {
      const content = await this.resolver.readFile(filePath, source);
      if (!content) {
        continue;
      }
      const lines = content.content.split(/\n/u);
      for (const match of matches) {
        const index = match.line - 1;
        match.contextBefore = lines.slice(Math.max(0, index - 2), index);
        match.contextAfter = lines.slice(index + 1, Math.min(lines.length, index + 3));
      }
    }
  }

  private async enrichSymbols(results: SearchResult[], source: SourceSelector): Promise<void> {
    for (const match of results.slice(0, 25)) {
      const content = await this.resolver.readFile(match.path, source);
      if (!content) {
        continue;
      }
      const adapter = this.registry.forPath(match.path);
      const parsed = await adapter.parse({
        path: match.path,
        language: this.registry.languageForPath(match.path),
        content: content.content,
        source,
        contentSha: content.contentSha
      });
      const symbol = adapter.getEnclosingSymbol(parsed, match.line);
      if (symbol) {
        const { name, kind, path, lineRange } = symbol;
        match.enclosingSymbol = { name, kind, path, lineRange };
      }
    }
  }

  private async verifyIdentifierMention(result: SearchResult, symbolName: string, source: SourceSelector): Promise<boolean | undefined> {
    const content = await this.resolver.readFile(result.path, source);
    if (!content) {
      return undefined;
    }
    const adapter = this.registry.forPath(result.path);
    const parsed = await adapter.parse({
      path: result.path,
      language: this.registry.languageForPath(result.path),
      content: content.content,
      source,
      contentSha: content.contentSha
    });
    const tree = parsed.tree as { rootNode?: { descendantForPosition?: (start: { row: number; column: number }) => unknown } } | undefined;
    const node = tree?.rootNode?.descendantForPosition?.({ row: result.line - 1, column: Math.max(0, (result.column ?? 1) - 1) }) as
      | { type?: string; text?: string; isExtra?: boolean }
      | undefined;
    if (!node) {
      return undefined;
    }
    if (node.isExtra === true || /comment|string|template/u.test(node.type ?? "")) {
      return false;
    }
    return node.text === symbolName && /identifier|property_identifier/u.test(node.type ?? "");
  }
}

function validateQuery(query: string): void {
  if (query.length === 0) {
    throw new CodegenieError("invalid_args", "query must be non-empty");
  }
  if (query.length > MAX_QUERY_CHARS) {
    throw new CodegenieError("invalid_args", "query exceeds 500 characters");
  }
}

function clampMaxResults(value: number | undefined, defaultValue: number, hardCap: number): number {
  if (value === undefined) {
    return defaultValue;
  }
  return Math.max(1, Math.min(value, hardCap));
}

function capMatchTexts(results: SearchResult[]): { results: SearchResult[]; truncatedTextCount: number } {
  let truncatedTextCount = 0;
  return {
    results: results.map((result) => {
      if (result.matchText.length <= MAX_MATCH_TEXT_CHARS) {
        return result;
      }
      truncatedTextCount += 1;
      const matchOffset = Buffer.from(result.matchText).subarray(0, (result.column ?? 1) - 1).toString("utf8").length;
      const offset = Math.max(0, matchOffset - 120);
      return { ...result, matchText: result.matchText.slice(offset, offset + MAX_MATCH_TEXT_CHARS), excerptStartColumn: Buffer.byteLength(result.matchText.slice(0, offset)) + 1, excerpt: true };
    }),
    truncatedTextCount
  };
}

function capSearchResultsTotal(results: SearchResult[]) {
  const capped = results.map(result => ({ ...result }));
  // Optional context must never evict core match locations.
  const shortened = JSON.stringify(capped).length > MAX_TOTAL_RESULT_CHARS;
  if (shortened) {
    for (const result of capped) {
      delete result.contextBefore;
      delete result.contextAfter;
      delete result.enclosingSymbol;
    }
  }
  let omittedCount = 0;
  let firstOmitted: SearchPosition | undefined;
  const packed: SearchResult[] = [];
  for (const result of capped) {
    if (JSON.stringify([...packed, result]).length <= MAX_TOTAL_RESULT_CHARS) packed.push(result);
    else {
      omittedCount++;
      firstOmitted ??= { path: result.path, line: result.line };
    }
  }
  return { results: packed, omittedCount, shortened, firstOmitted };
}

function groupByPath(results: SearchResult[]): Map<string, SearchResult[]> {
  const grouped = new Map<string, SearchResult[]>();
  for (const result of results) {
    const bucket = grouped.get(result.path);
    if (bucket) {
      bucket.push(result);
    } else {
      grouped.set(result.path, [result]);
    }
  }
  return grouped;
}
