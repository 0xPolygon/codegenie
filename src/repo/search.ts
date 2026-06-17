import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { rgPath } from "@vscode/ripgrep";
import picomatch from "picomatch";
import type { SearchOptions, SearchResult, SourceSelector, SymbolMentionOptions, ToolBackend, ToolPrecision } from "../types.js";
import { CodeninjaError } from "../util/errors.js";
import { containGlob, containPath } from "./path-guard.js";
import type { SourceResolver } from "./source-resolver.js";
import type { LanguageAdapterRegistry } from "./language-adapter.js";

export type SearchEngine = "git-grep" | "ripgrep";

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
const MAX_RIPGREP_BUFFER_CHARS = 64 * 1024;
const MAX_RIPGREP_OUTPUT_CHARS = 256 * 1024;
const RIPGREP_RAW_RESULT_MULTIPLIER = 5;

export class SearchService {
  constructor(
    private readonly resolver: SourceResolver,
    private readonly registry: LanguageAdapterRegistry,
    // Shared bounded-concurrency gate for subprocess work (ripgrep spawns and
    // git ls-tree blob checks), so search spawns count against the same budget
    // as the rest of the repository tools. Defaults to unbounded for tests.
    private readonly limit: <T>(fn: () => Promise<T>) => Promise<T> = (fn) => fn()
  ) {}

  async search(query: string, options: RawSearchOptions = {}): Promise<SearchExecution> {
    validateQuery(query);
    const source = options.source ?? { kind: "head" };
    const pathGlob = options.pathGlob === undefined ? undefined : containGlob(this.resolver.repoRoot, options.pathGlob);
    const maxResults = clampMaxResults(options.maxResults, options.defaultMaxResults ?? DEFAULT_MAX_RESULTS, options.hardMaxResults ?? HARD_MAX_RESULTS);
    const requested = maxResults + 1;
    let engine: SearchEngine = "git-grep";
    let raw: SearchResult[];

    if (this.canUseRipgrep(source)) {
      const engineOptions = {
        ...options,
        maxResults: requested,
        ...(pathGlob !== undefined ? { pathGlob } : {})
      };
      const ripgrep = await this.tryRipgrep(query, {
        ...engineOptions
      });
      if (ripgrep.ok) {
        engine = "ripgrep";
        raw = ripgrep.results;
      } else {
        raw = await this.gitGrep(query, { ...engineOptions, source });
      }
    } else {
      raw = await this.gitGrep(query, {
        ...options,
        source,
        maxResults: requested,
        ...(pathGlob !== undefined ? { pathGlob } : {})
      });
    }

    const countOmitted = raw.length > maxResults ? raw.length - maxResults : 0;
    const lineCapped = capMatchTexts(raw.slice(0, maxResults));
    await this.enrich(lineCapped.results, source, options.contextMode ?? "none");
    const capped = capSearchResultsTotal(lineCapped.results, countOmitted + lineCapped.truncatedTextCount);
    return {
      results: capped.results,
      engine,
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
      if (error instanceof CodeninjaError && error.code === "git_ref_missing") {
        throw new CodeninjaError("invalid_args", "search pattern or revision could not be searched", { cause: error });
      }
      throw error;
    }
  }

  private async tryRipgrep(
    query: string,
    options: RawSearchOptions & { pathGlob?: string; maxResults: number }
  ): Promise<{ ok: true; results: SearchResult[] } | { ok: false; reason: string }> {
    const args = [
      "--json",
      "--line-number",
      "--column",
      "--no-config",
      "--no-messages",
      // --no-ignore is required so force-added files inside gitignored directories
      // (tracked content) are still searched; untracked results are dropped by the
      // tracked-blob post-filter below.
      "--no-ignore",
      "--hidden",
      "--glob",
      "!.git/**",
      ...(options.pathGlob !== undefined ? ["--glob", options.pathGlob] : []),
      "--max-count",
      String(options.maxResults),
      ...(options.caseSensitive === false ? ["-i"] : []),
      ...(options.fixedString === true ? ["-F"] : []),
      ...(options.word === true ? ["-w"] : []),
      "--regexp",
      query,
      "."
    ];
    const ripgrep = await this.limit(() => this.runRipgrepCapped(args, options.maxResults * RIPGREP_RAW_RESULT_MULTIPLIER));
    if (!ripgrep.ok) {
      return ripgrep;
    }
    return { ok: true, results: (await this.filterTrackedBlobResults(ripgrep.results, options.pathGlob)).slice(0, options.maxResults) };
  }

  private async runRipgrepCapped(
    args: string[],
    maxResults: number
  ): Promise<{ ok: true; results: SearchResult[] } | { ok: false; reason: string }> {
    return new Promise((resolve) => {
      const child = spawn(rgPath, args, {
        cwd: this.resolver.repoRoot,
        shell: false,
        stdio: ["ignore", "pipe", "ignore"]
      });
      const results: SearchResult[] = [];
      let buffer = "";
      let outputChars = 0;
      let stoppedAfterLimit = false;
      let stoppedAfterOutputCap = false;
      let settled = false;

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (stoppedAfterOutputCap) {
          return;
        }
        outputChars += chunk.length;
        if (outputChars > MAX_RIPGREP_OUTPUT_CHARS || buffer.length + chunk.length > MAX_RIPGREP_BUFFER_CHARS) {
          stoppedAfterOutputCap = true;
          child.kill("SIGTERM");
          return;
        }
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const result = parseRipgrepLine(line, this.resolver.repoRoot, this.resolver.worktree.untrackedPaths);
          if (result !== undefined) {
            results.push(result);
          }
          if (results.length >= maxResults) {
            stoppedAfterLimit = true;
            child.kill("SIGTERM");
            return;
          }
        }
      });

      child.on("error", (error) => {
        if (!settled) {
          settled = true;
          resolve({ ok: false, reason: `ripgrep failed to spawn: ${error.message}; fell back to git grep` });
        }
      });

      child.on("close", (code) => {
        if (settled) {
          return;
        }
        settled = true;
        if (!stoppedAfterLimit && !stoppedAfterOutputCap && buffer.trim().length > 0) {
          const result = parseRipgrepLine(buffer, this.resolver.repoRoot, this.resolver.worktree.untrackedPaths);
          if (result !== undefined && results.length < maxResults) {
            results.push(result);
          }
        }
        if (stoppedAfterOutputCap) {
          resolve({ ok: false, reason: "ripgrep output exceeded cap; fell back to git grep" });
        } else if (stoppedAfterLimit || code === 0 || code === 1) {
          resolve({ ok: true, results });
        } else {
          resolve({ ok: false, reason: "ripgrep rejected the pattern; fell back to git grep" });
        }
      });
    });
  }

  private async filterTrackedBlobResults(results: SearchResult[], pathGlob: string | undefined): Promise<SearchResult[]> {
    const isMatch = pathGlob === undefined ? undefined : picomatch(pathGlob, { dot: true });
    const tracked = new Map<string, boolean>();
    const filtered: SearchResult[] = [];
    for (const result of results) {
      if (isMatch !== undefined && !isMatch(result.path)) {
        continue;
      }
      let keep = tracked.get(result.path);
      if (keep === undefined) {
        try {
          const entry = await this.limit(() => this.resolver.git.lsTreeEntry(this.resolver.binding.headCommit, result.path));
          keep = entry?.type === "blob";
        } catch {
          keep = false;
        }
        tracked.set(result.path, keep);
      }
      if (keep) {
        filtered.push(result);
      }
    }
    return filtered;
  }

  private canUseRipgrep(source: SourceSelector): boolean {
    return source.kind === "head" &&
      this.resolver.worktree.headEqualsReviewedHead &&
      this.resolver.worktree.trackedClean &&
      this.resolver.worktree.untrackedPaths.size === 0;
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
    throw new CodeninjaError("invalid_args", "query must be non-empty");
  }
  if (query.length > MAX_QUERY_CHARS) {
    throw new CodeninjaError("invalid_args", "query exceeds 500 characters");
  }
}

function clampMaxResults(value: number | undefined, defaultValue: number, hardCap: number): number {
  if (value === undefined) {
    return defaultValue;
  }
  return Math.max(1, Math.min(value, hardCap));
}

function parseRipgrepLine(line: string, repoRoot: string, untrackedPaths: Set<string>): SearchResult | undefined {
  if (!line.trim()) {
    return undefined;
  }
  let record: {
    type?: string;
    data?: {
      path?: { text?: string };
      lines?: { text?: string };
      line_number?: number;
      submatches?: Array<{ start?: number }>;
    };
  };
  try {
    record = JSON.parse(line) as typeof record;
  } catch {
    return undefined;
  }
  if (record.type !== "match") {
    return undefined;
  }
  const filePath = containRipgrepPath(repoRoot, normalizeRipgrepPath(record.data?.path?.text));
  if (!filePath || untrackedPaths.has(filePath)) {
    return undefined;
  }
  const lineNumber = record.data?.line_number;
  if (lineNumber === undefined) {
    return undefined;
  }
  return {
    path: filePath,
    line: lineNumber,
    column: (record.data?.submatches?.[0]?.start ?? 0) + 1,
    matchText: (record.data?.lines?.text ?? "").replace(/\n$/u, "")
  };
}

function normalizeRipgrepPath(filePath: string | undefined): string | undefined {
  if (filePath === undefined) {
    return undefined;
  }
  return filePath.replace(/^\.\//u, "");
}

function containRipgrepPath(repoRoot: string, filePath: string | undefined): string | undefined {
  if (filePath === undefined) {
    return undefined;
  }
  try {
    const contained = containPath(repoRoot, filePath);
    const rootReal = realpathSync(repoRoot);
    const targetReal = realpathSync(path.join(repoRoot, contained));
    const relative = path.relative(rootReal, targetReal);
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
      return contained;
    }
  } catch {
    return undefined;
  }
  return undefined;
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
