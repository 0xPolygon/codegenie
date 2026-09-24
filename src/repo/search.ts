import type { SearchOptions, SearchResult, SourceSelector, SymbolMentionOptions, ToolBackend, ToolPrecision } from "../types.js";
import { CodegenieError } from "../util/errors.js";
import { containGlob } from "./path-guard.js";
import type { SourceResolver } from "./source-resolver.js";
import type { LanguageAdapterRegistry } from "./language-adapter.js";

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
};

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
    if (!raw.length && omittedLines) throw new CodegenieError("budget_exhausted", "All matching lines exceeded the search output allowance; narrow pathGlob or read a known range. This is not a zero-match result.");
    const discoveryLimited = raw.length > maxResults || omittedLines > 0;
    // The extra text match may be a comment, not a verified identifier mention.
    const countOmitted = options.mention === undefined ? omittedLines + Number(raw.length > maxResults) : 0;
    const classified = options.mention === undefined ? undefined : await this.classifyMentions(raw.slice(0, maxResults), options.mention, source);
    const lineCapped = capMatchTexts(classified?.results ?? raw.slice(0, maxResults));
    await this.enrich(lineCapped.results, source, options.contextMode ?? "none");
    const capped = capSearchResultsTotal(lineCapped.results, countOmitted);
    if (lineCapped.results.length > 0 && capped.results.length === 0) throw new CodegenieError("budget_exhausted", "No complete search entry fits the result allowance; narrow pathGlob or read a known range. This is not a zero-match result.");
    const shortened = lineCapped.truncatedTextCount > 0 || capped.shortened;
    const degraded = discoveryLimited || capped.omittedCount > 0 || shortened || (classified?.syntaxFallbacks ?? 0) > 0;
    return {
      results: capped.results, engine: "git-grep",
      backend: classified?.syntaxOnly ? "tree-sitter" : "text",
      precision: classified?.syntaxOnly ? "syntactic" : "text",
      degraded,
      ...(degraded ? { degradationReason: classified?.syntaxFallbacks ? `${classified.syntaxFallbacks} mention result(s) were not syntax-verified` : "search bounded: excerpts shortened or results omitted" } : {}),
      ...(discoveryLimited || capped.omittedCount > 0 || shortened ? { truncated: true, omittedCount: capped.omittedCount, omittedCountIsLowerBound: true, discoveryLimited } : {})
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

function capSearchResultsTotal(results: SearchResult[], initialOmittedCount: number): { results: SearchResult[]; omittedCount: number; shortened: boolean } {
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
  let omittedCount = initialOmittedCount;
  const packed: SearchResult[] = [];
  for (const result of capped) {
    if (JSON.stringify([...packed, result]).length <= MAX_TOTAL_RESULT_CHARS) packed.push(result);
    else omittedCount++;
  }
  return { results: packed, omittedCount, shortened };
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
