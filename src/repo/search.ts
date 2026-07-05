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
};

type RawSearchOptions = SearchOptions & {
  fixedString?: boolean;
  word?: boolean;
  defaultMaxResults?: number;
  hardMaxResults?: number;
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

    const countOmitted = raw.length > maxResults ? raw.length - maxResults : 0;
    const lineCapped = capMatchTexts(raw.slice(0, maxResults));
    await this.enrich(lineCapped.results, source, options.contextMode ?? "none");
    const capped = capSearchResultsTotal(lineCapped.results, countOmitted + lineCapped.truncatedTextCount);
    return {
      results: capped.results,
      engine: "git-grep",
      backend: "text",
      precision: "text",
      degraded: capped.omittedCount > 0,
      ...(capped.omittedCount > 0 ? { degradationReason: "search results truncated" } : {}),
      ...(capped.omittedCount > 0 ? { truncated: true, omittedCount: capped.omittedCount } : {})
    };
  }

  async findSymbolMentions(
    symbolName: string,
    options: SymbolMentionOptions = {}
  ): Promise<SearchExecution> {
    const execution = await this.search(symbolName, {
      ...options,
      fixedString: true,
      word: true,
      defaultMaxResults: 100,
      hardMaxResults: 300
    });
    const attemptedFiles = new Set<string>();
    let unverified = 0;
    const kept: SearchResult[] = [];

    for (const result of execution.results) {
      const alreadyAttempted = attemptedFiles.has(result.path);
      if (attemptedFiles.size >= 25 && !alreadyAttempted) {
        unverified += 1;
        kept.push(result);
        continue;
      }
      attemptedFiles.add(result.path);
      const verified = await this.verifyIdentifierMention(result, symbolName, options.source ?? { kind: "head" });
      if (verified === true) {
        kept.push(result);
      } else if (verified === undefined) {
        unverified += 1;
        kept.push(result);
      }
    }

    return {
      ...execution,
      results: kept,
      backend: unverified === 0 ? "tree-sitter" : "text",
      precision: unverified === 0 ? "syntactic" : "text",
      degraded: execution.degraded || unverified > 0,
      ...(unverified > 0
        ? { degradationReason: `${unverified} mention result(s) were not syntax-verified` }
        : execution.degradationReason !== undefined
          ? { degradationReason: execution.degradationReason }
          : {})
    };
  }

  private async gitGrep(query: string, options: RawSearchOptions & { pathGlob?: string; source: SourceSelector; maxResults: number }): Promise<SearchResult[]> {
    try {
      return await this.limit(() => this.resolver.grep(query, {
        source: options.source,
        maxResults: options.maxResults,
        ...(options.pathGlob !== undefined ? { glob: options.pathGlob } : {}),
        ...(options.caseSensitive !== undefined ? { caseSensitive: options.caseSensitive } : {}),
        ...(options.fixedString !== undefined ? { fixedString: options.fixedString } : {}),
        ...(options.word !== undefined ? { word: options.word } : {})
      }));
    } catch (error) {
      if (error instanceof CodegenieError && error.code === "git_ref_missing") {
        throw new CodegenieError("invalid_args", "search pattern or revision could not be searched", { cause: error });
      }
      throw error;
    }
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
        match.enclosingSymbol = symbol;
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
      return { ...result, matchText: `${result.matchText.slice(0, MAX_MATCH_TEXT_CHARS)}...` };
    }),
    truncatedTextCount
  };
}

function capSearchResultsTotal(results: SearchResult[], initialOmittedCount: number): { results: SearchResult[]; omittedCount: number } {
  const capped = [...results];
  let omittedCount = initialOmittedCount;
  while (JSON.stringify(capped).length > MAX_TOTAL_RESULT_CHARS && capped.length > 0) {
    capped.pop();
    omittedCount += 1;
  }
  return { results: capped, omittedCount };
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
