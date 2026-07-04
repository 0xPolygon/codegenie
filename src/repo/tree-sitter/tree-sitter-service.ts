import { createRequire } from "node:module";
import type { ParseInput, ParsedFile } from "../../types.js";
import type { TelemetryRecorder } from "../../telemetry/telemetry-recorder.js";
import { sha256Hex } from "../../util/hashing.js";
import { Parser, Language, type Tree } from "web-tree-sitter";

export type GrammarId = "go" | "typescript" | "tsx" | "javascript";

type CachedParse = {
  key: string;
  language: GrammarId;
  tree?: Tree;
  hasErrors: boolean;
};

const require = createRequire(import.meta.url);
const MAX_PARSE_BYTES = 1_500_000;
const PARSE_TIMEOUT_MS = 1_000;
const MAX_CACHE_ENTRIES = 128;

const GRAMMAR_WASM: Record<GrammarId, string> = {
  go: "tree-sitter-go/tree-sitter-go.wasm",
  typescript: "tree-sitter-typescript/tree-sitter-typescript.wasm",
  tsx: "tree-sitter-typescript/tree-sitter-tsx.wasm",
  javascript: "tree-sitter-javascript/tree-sitter-javascript.wasm"
};

export class TreeSitterService {
  private readonly telemetry: TelemetryRecorder | undefined;
  private initPromise: Promise<void> | undefined;
  private readonly languages = new Map<GrammarId, Promise<Language | undefined>>();
  private readonly unavailable = new Set<GrammarId>();
  private readonly cache = new Map<string, CachedParse>();
  private readonly inflight = new Map<string, Promise<ParsedFile>>();

  constructor(opts: { telemetry?: TelemetryRecorder } = {}) {
    this.telemetry = opts.telemetry;
  }

  routePath(filePath: string): GrammarId | undefined {
    if (filePath.endsWith(".go")) {
      return "go";
    }
    if (filePath.endsWith(".tsx")) {
      return "tsx";
    }
    if (filePath.endsWith(".d.ts") || /\.(?:ts|mts|cts)$/u.test(filePath)) {
      return "typescript";
    }
    if (/\.(?:js|jsx|mjs|cjs)$/u.test(filePath)) {
      return "javascript";
    }
    return undefined;
  }

  isGrammarAvailable(language: string): boolean {
    return isGrammarId(language) && !this.unavailable.has(language);
  }

  async parse(input: ParseInput): Promise<ParsedFile> {
    const grammarId = isGrammarId(input.language) ? input.language : this.routePath(input.path);
    if (grammarId === undefined || this.unavailable.has(grammarId)) {
      return genericParsed(input, false);
    }
    if (Buffer.byteLength(input.content, "utf8") > MAX_PARSE_BYTES) {
      return { ...genericParsed(input, true), adapterId: grammarId };
    }

    const cacheKey = cacheKeyFor(input, grammarId);
    const cached = this.cache.get(cacheKey);
    if (cached) {
      this.cache.delete(cacheKey);
      this.cache.set(cacheKey, cached);
      return parsedFromCache(input, cached);
    }

    let pending = this.inflight.get(cacheKey);
    if (!pending) {
      pending = this.parseUncached(input, grammarId, cacheKey);
      this.inflight.set(cacheKey, pending);
    }
    try {
      return await pending;
    } finally {
      this.inflight.delete(cacheKey);
    }
  }

  private async parseUncached(input: ParseInput, grammarId: GrammarId, cacheKey: string): Promise<ParsedFile> {
    const language = await this.loadLanguage(grammarId);
    if (language === undefined) {
      return { ...genericParsed(input, true), adapterId: grammarId };
    }

    const parser = new Parser();
    try {
      parser.setLanguage(language);
      const startedAt = Date.now();
      let timedOut = false;
      const tree = parser.parse(input.content, null, {
        progressCallback: () => {
          timedOut = Date.now() - startedAt > PARSE_TIMEOUT_MS;
          return timedOut;
        }
      });

      const cacheableTree = tree !== null && !timedOut ? tree : undefined;
      const cached: CachedParse = {
        key: cacheKey,
        language: grammarId,
        ...(cacheableTree !== undefined ? { tree: cacheableTree } : {}),
        hasErrors: timedOut || tree === null || (tree.rootNode.hasError ?? false)
      };
      if (tree !== null && cacheableTree === undefined) {
        tree.delete();
      }
      this.remember(cached);
      return parsedFromCache(input, cached);
    } catch {
      return { ...genericParsed(input, true), adapterId: grammarId };
    } finally {
      parser.delete();
    }
  }

  private async loadLanguage(grammarId: GrammarId): Promise<Language | undefined> {
    if (this.unavailable.has(grammarId)) {
      return undefined;
    }
    let pending = this.languages.get(grammarId);
    if (!pending) {
      pending = this.loadLanguageUncached(grammarId);
      this.languages.set(grammarId, pending);
    }
    return pending;
  }

  private async loadLanguageUncached(grammarId: GrammarId): Promise<Language | undefined> {
    try {
      await this.init();
      return await Language.load(require.resolve(GRAMMAR_WASM[grammarId]));
    } catch (error) {
      this.unavailable.add(grammarId);
      this.telemetry?.event({
        stage: 4,
        level: "warn",
        message: "parser_unavailable",
        data: {
          language: grammarId,
          error: error instanceof Error ? error.message : String(error)
        }
      });
      return undefined;
    }
  }

  private async init(): Promise<void> {
    this.initPromise ??= Parser.init({
      locateFile: (filename: string) => {
        if (filename.endsWith(".wasm")) {
          return require.resolve("web-tree-sitter/web-tree-sitter.wasm");
        }
        return filename;
      }
    });
    await this.initPromise;
  }

  private remember(entry: CachedParse): void {
    this.cache.set(entry.key, entry);
    if (this.cache.size <= MAX_CACHE_ENTRIES) {
      return;
    }
    const oldest = this.cache.keys().next().value as string | undefined;
    if (oldest === undefined) {
      return;
    }
    const evicted = this.cache.get(oldest);
    this.cache.delete(oldest);
    evicted?.tree?.delete();
  }
}

function cacheKeyFor(input: ParseInput, grammarId: GrammarId): string {
  return `${input.contentSha ?? sha256Hex(input.content)}:${grammarId}`;
}

function parsedFromCache(input: ParseInput, cached: CachedParse): ParsedFile {
  return {
    path: input.path,
    language: cached.language,
    adapterId: cached.language,
    source: input.source,
    content: input.content,
    ...(input.contentSha !== undefined ? { contentSha: input.contentSha } : {}),
    ...(cached.tree !== undefined ? { tree: cached.tree } : {}),
    hasErrors: cached.hasErrors
  };
}

export function languageFromPath(filePath: string): string {
  const service = new TreeSitterService();
  return service.routePath(filePath) ?? fallbackLanguageFromPath(filePath);
}

export function isGrammarId(language: string): language is GrammarId {
  return language === "go" || language === "typescript" || language === "tsx" || language === "javascript";
}

function genericParsed(input: ParseInput, hasErrors: boolean): ParsedFile {
  return {
    path: input.path,
    language: input.language,
    adapterId: "generic",
    source: input.source,
    content: input.content,
    ...(input.contentSha !== undefined ? { contentSha: input.contentSha } : {}),
    hasErrors
  };
}

function fallbackLanguageFromPath(filePath: string): string {
  const match = /\.([^.\\/]+)$/u.exec(filePath);
  return match?.[1]?.toLowerCase() ?? "text";
}
