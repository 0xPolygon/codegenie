import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ParseInput, ParsedFile } from "../../types.js";
import type { TelemetryRecorder } from "../../telemetry/telemetry-recorder.js";
import { sha256Hex } from "../../util/hashing.js";
import { Parser, Language, type Tree } from "web-tree-sitter";

export const GRAMMAR_IDS = ["go", "typescript", "tsx", "javascript", "rust", "python", "solidity"] as const;
export type GrammarId = (typeof GRAMMAR_IDS)[number];

type ParserLike = {
  setLanguage(language: Language): void;
  parse(
    content: string,
    oldTree: null,
    options: { progressCallback: () => boolean }
  ): Tree | null;
  delete(): void;
};

export type TreeSitterServiceOptions = {
  telemetry?: TelemetryRecorder;
  initialize?: () => Promise<void>;
  resolveGrammarWasm?: (grammarId: GrammarId) => string;
  loadLanguage?: (wasmPath: string) => Promise<Language>;
  createParser?: () => ParserLike;
  now?: () => number;
  maxParseBytes?: number;
  parseTimeoutMs?: number;
};

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

// The grammar packages are devDependencies: they are native-build packages, and
// tree-sitter-solidity misspells its optional-peer key as `tree_sitter`, so npm
// treats native tree-sitter as a required peer and compiles it from source. The
// build copies their WASM into bundled-grammars/ (scripts/copy-grammars.mjs),
// which ships in the package, leaving an installed codegenie native-free.
export const GRAMMAR_WASM: Record<GrammarId, { package: string; file: string }> = {
  go: { package: "tree-sitter-go", file: "tree-sitter-go.wasm" },
  typescript: { package: "tree-sitter-typescript", file: "tree-sitter-typescript.wasm" },
  tsx: { package: "tree-sitter-typescript", file: "tree-sitter-tsx.wasm" },
  javascript: { package: "tree-sitter-javascript", file: "tree-sitter-javascript.wasm" },
  rust: { package: "tree-sitter-rust", file: "tree-sitter-rust.wasm" },
  python: { package: "tree-sitter-python", file: "tree-sitter-python.wasm" },
  solidity: { package: "tree-sitter-solidity", file: "tree-sitter-solidity.wasm" }
};

const BUNDLED_GRAMMAR_DIRECTORY = fileURLToPath(new URL("../../../bundled-grammars/", import.meta.url));

// Prefers the bundled copy an installed package ships; falls back to the
// devDependency so a fresh checkout parses before its first build.
function resolveBundledGrammarWasm(grammarId: GrammarId): string {
  const { package: packageName, file } = GRAMMAR_WASM[grammarId];
  const bundled = path.join(BUNDLED_GRAMMAR_DIRECTORY, file);
  return existsSync(bundled) ? bundled : require.resolve(`${packageName}/${file}`);
}

export class TreeSitterService {
  private readonly telemetry: TelemetryRecorder | undefined;
  private initPromise: Promise<void> | undefined;
  private readonly languages = new Map<GrammarId, Promise<Language | undefined>>();
  private readonly unavailable = new Set<GrammarId>();
  private readonly cache = new Map<string, CachedParse>();
  private readonly inflight = new Map<string, Promise<ParsedFile>>();
  private readonly opts: TreeSitterServiceOptions;

  constructor(opts: TreeSitterServiceOptions = {}) {
    this.opts = opts;
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
    if (filePath.endsWith(".rs")) {
      return "rust";
    }
    if (filePath.endsWith(".py")) {
      return "python";
    }
    if (filePath.endsWith(".sol")) {
      return "solidity";
    }
    return undefined;
  }

  isGrammarAvailable(language: string): boolean {
    return isGrammarId(language) && !this.unavailable.has(language);
  }

  async parse(input: ParseInput): Promise<ParsedFile> {
    const grammarId = isGrammarId(input.language) ? input.language : this.routePath(input.path);
    if (grammarId === undefined) {
      return genericParsed(input, false);
    }
    if (this.unavailable.has(grammarId)) {
      return unavailableParsed(input, grammarId);
    }
    if (Buffer.byteLength(input.content, "utf8") > (this.opts.maxParseBytes ?? MAX_PARSE_BYTES)) {
      return unavailableParsed(input, grammarId);
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
      return unavailableParsed(input, grammarId);
    }

    const parser = this.opts.createParser?.() ?? new Parser();
    try {
      parser.setLanguage(language);
      const now = this.opts.now ?? Date.now;
      const startedAt = now();
      let timedOut = false;
      const tree = parser.parse(input.content, null, {
        progressCallback: () => {
          timedOut = now() - startedAt > (this.opts.parseTimeoutMs ?? PARSE_TIMEOUT_MS);
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
      return unavailableParsed(input, grammarId);
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
      const wasmPath = this.opts.resolveGrammarWasm?.(grammarId) ?? resolveBundledGrammarWasm(grammarId);
      return await (this.opts.loadLanguage?.(wasmPath) ?? Language.load(wasmPath));
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
    this.initPromise ??= this.opts.initialize?.() ?? Parser.init({
      locateFile: (filename: string) => filename.endsWith(".wasm")
        ? require.resolve("web-tree-sitter/web-tree-sitter.wasm")
        : filename
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
  return (GRAMMAR_IDS as readonly string[]).includes(language);
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

function unavailableParsed(input: ParseInput, grammarId: GrammarId): ParsedFile {
  return {
    ...genericParsed(input, true),
    language: grammarId,
    adapterId: grammarId
  };
}

function fallbackLanguageFromPath(filePath: string): string {
  if (filePath.endsWith(".pyi")) {
    return "unknown";
  }
  const match = /\.([^.\\/]+)$/u.exec(filePath);
  return match?.[1]?.toLowerCase() ?? "text";
}
