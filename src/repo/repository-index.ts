import { AsyncLocalStorage } from "node:async_hooks";
import pLimit from "p-limit";
import type {
  CodegenieConfig,
  DiffFile,
  DiffHunk,
  FileFacts,
  FileOutline,
  HunkSymbolFacts,
  PacketContext,
  RepositoryIndex,
  RepositoryTools,
  RepositoryToolsHost,
  RepositoryToolCallContext,
  ResolvedReviewInput,
  ReviewPacket,
  ReviewStage,
  SearchOptions,
  SearchResult,
  SourceSelector,
  SymbolMentionOptions,
  SymbolLookupSourceSelector,
  SymbolInfo,
  SymbolRef,
  ToolBackend,
  ToolPrecision,
  ToolResultMeta,
  UnifiedDiff
} from "../types.js";
import { parseDiff } from "../git/diff-parser.js";
import type { InternalGitClient } from "../git/git-client.js";
import { createGitClient } from "../git/git-client.js";
import type { TelemetryRecorder } from "../telemetry/telemetry-recorder.js";
import { CodegenieError } from "../util/errors.js";
import { escapeRegExp } from "../util/regex.js";
import { containGlob, containPath } from "./path-guard.js";
import { DiffBlockRenderer } from "./diff-blocks.js";
import { LanguageAdapterRegistry } from "./language-adapter.js";
import { findLikelyTestsForInput } from "./likely-tests.js";
import { assemblePacketContext, readOutline } from "./packet-context.js";
import { SearchService, type SearchEngine } from "./search.js";
import { SourceResolver } from "./source-resolver.js";
import { extractChangedSymbolFacts } from "./symbol-extraction.js";
import { extractStaticSignals } from "./static-signals.js";
import { TreeSitterService } from "./tree-sitter/tree-sitter-service.js";

type BuildRepositoryIndexOptions = {
  git?: InternalGitClient;
};

type ToolMeasurement<T> = {
  value: T;
  meta: ToolResultMeta;
  args?: ToolArgs;
  resultCount?: number;
  resultChars: number;
  engine?: SearchEngine;
};

type ToolArgs = {
  path?: string | undefined;
  symbolName?: string | undefined;
  line?: number | undefined;
  startLine?: number | undefined;
  endLine?: number | undefined;
  query?: string | undefined;
  glob?: string | undefined;
  source?: string | undefined;
  contextMode?: string | undefined;
  maxResults?: number | undefined;
};

type RecordedToolArgs = {
  path?: string;
  symbolName?: string;
  line?: number;
  startLine?: number;
  endLine?: number;
  query?: string;
  glob?: string;
  source?: string;
  contextMode?: string;
  maxResults?: number;
};

const READ_RANGE_MAX_LINES = 400;
const READ_RANGE_MAX_CHARS = 16_000;
const SYMBOL_MAX_LINES = 250;
const SYMBOL_MAX_CHARS = 10_000;
const FIND_DEFINITION_MAX = 20;
const FIND_DEFINITION_CANDIDATES = 30;
const FIND_DEFINITION_MAX_CHARS = 16_000;
const FIND_DEFINITION_DISCOVERY_MATCHES = 300;
const LIST_FILES_MAX = 500;

export async function buildRepositoryIndex(
  resolved: ResolvedReviewInput,
  kept: DiffFile[],
  facts: FileFacts[],
  config: CodegenieConfig,
  telemetry: TelemetryRecorder,
  opts: BuildRepositoryIndexOptions = {}
): Promise<RepositoryIndex> {
  void config;
  telemetry.event({ stage: 4, level: "info", message: "stage_started", data: { name: "repository_index" } });
  const git = opts.git ?? createGitClient(resolved.repoRoot);
  const resolver = await SourceResolver.create(resolved, git);
  const parser = new TreeSitterService({ telemetry });
  const registry = new LanguageAdapterRegistry(parser);
  const diff = parseDiff(resolved.rawDiff);
  const symbolFacts = await extractChangedSymbolFacts(resolver, registry, kept, facts);
  const staticSignals = await extractStaticSignals(resolver, registry, kept, facts, symbolFacts, telemetry);
  const tools = new RepositoryToolsFacade({
    diff,
    resolver,
    registry,
    telemetry
  });
  telemetry.event({
    stage: 4,
    level: "info",
    message: "stage_completed",
    data: { symbolFacts: symbolFacts.length, staticSignals: staticSignals.length }
  });
  return { facts, symbolFacts, staticSignals, tools };
}

export class RepositoryToolsFacade implements RepositoryToolsHost {
  private readonly diffBlocks: DiffBlockRenderer;
  private readonly search: SearchService;
  private readonly limit = pLimit(8);
  private readonly toolCallContext = new AsyncLocalStorage<RepositoryToolCallContext>();

  constructor(
    private readonly opts: {
      diff: UnifiedDiff;
      resolver: SourceResolver;
      registry: LanguageAdapterRegistry;
      telemetry: TelemetryRecorder;
    }
  ) {
    this.diffBlocks = new DiffBlockRenderer(opts.diff);
    this.search = new SearchService(opts.resolver, opts.registry, this.limit);
  }

  bindPackets(packets: ReviewPacket[]): void {
    this.diffBlocks.bindPackets(packets);
  }

  async withToolCallContext<T>(context: RepositoryToolCallContext, run: () => Promise<T>): Promise<T> {
    return this.toolCallContext.run(context, run);
  }

  async buildPacketContext(
    file: DiffFile,
    hunks: DiffHunk[],
    symbolFacts: HunkSymbolFacts[]
  ): Promise<{ context: PacketContext; outline?: FileOutline; relevantTests: SymbolInfo[]; degradation?: string }> {
    return this.measure(
      "build_packet_context",
      { path: file.path },
      6,
      async () => {
        const value = await assemblePacketContext(this.opts.resolver, this.opts.registry, file, hunks, symbolFacts);
        return {
          value,
          meta: {
            backend: value.degradation ? "text" : "tree-sitter",
            precision: value.degradation ? "heuristic" : "syntactic",
            degraded: value.degradation !== undefined,
            ...(value.degradation !== undefined ? { degradationReason: value.degradation } : {})
          },
          resultCount: value.relevantTests.length,
          resultChars: JSON.stringify(value).length
        };
      }
    );
  }

  async readRange(
    filePath: string,
    startLine: number,
    endLine: number,
    source: SourceSelector = { kind: "head" }
  ): Promise<{ text: string; meta: ToolResultMeta }> {
    return this.measure(
      "read_range",
      { path: filePath, startLine, endLine, source: source.kind },
      7,
      async () => {
        if (startLine < 1 || startLine > endLine) {
          throw new CodegenieError("invalid_args", "readRange requires 1 <= startLine <= endLine");
        }
        const path = containPath(this.opts.resolver.repoRoot, filePath, this.guardTelemetry("read_range"));
        const content = await this.limit(() => this.opts.resolver.readFile(path, source));
        if (!content) {
          const meta: ToolResultMeta = {
            ...degradedMeta("text", "exact", "file missing at selected revision"),
            lookupStatus: "file_missing",
            deliveryStatus: "empty"
          };
          return { value: { text: "", meta }, meta, args: { path, startLine, endLine, source: source.kind }, resultChars: 0 };
        }
        const lines = content.content.length === 0 ? [] : content.content.split(/\n/u);
        const clampedStart = Math.min(Math.max(1, startLine), Math.max(1, lines.length));
        const requestedEnd = Math.min(endLine, lines.length);
        const cappedEnd = Math.min(requestedEnd, clampedStart + READ_RANGE_MAX_LINES - 1);
        const text = capText(lines.slice(clampedStart - 1, cappedEnd).join("\n"), READ_RANGE_MAX_CHARS);
        // omittedCount is a count of real in-file lines that fell outside the
        // returned window because of the line cap. Lines past EOF never existed,
        // and character truncation is signalled by `truncated` alone.
        const omittedLines = Math.max(0, requestedEnd - cappedEnd);
        const meta: ToolResultMeta = {
          backend: "text",
          precision: "exact",
          degraded: false,
          lookupStatus: "found",
          deliveryStatus: omittedLines > 0 || text.truncated ? "truncated" : "full",
          ...(omittedLines > 0 || text.truncated
            ? { truncated: true, ...(omittedLines > 0 ? { omittedCount: omittedLines } : {}) }
            : {})
        };
        return { value: { text: text.text, meta }, meta, args: { path, startLine, endLine, source: source.kind }, resultChars: text.text.length };
      }
    );
  }

  async readFileOutline(filePath: string, source: SourceSelector = { kind: "head" }): Promise<{ outline: FileOutline; meta: ToolResultMeta }> {
    return this.measure(
      "read_file_outline",
      { path: filePath, source: source.kind },
      7,
      async () => {
        const path = containPath(this.opts.resolver.repoRoot, filePath, this.guardTelemetry("read_file_outline"));
        const result = await this.limit(() => readOutline(this.opts.resolver, this.opts.registry, path, source));
        const meta: ToolResultMeta = {
          backend: result.degraded ? "text" : "tree-sitter",
          precision: result.degraded ? "heuristic" : "syntactic",
          degraded: result.degraded,
          ...(result.degradationReason !== undefined ? { degradationReason: result.degradationReason } : {}),
          ...(result.truncated ? { truncated: true, omittedCount: result.omittedCount ?? 0 } : {})
        };
        return {
          value: { outline: result.outline, meta },
          meta,
          args: { path, source: source.kind },
          resultCount: result.outline.topLevelSymbols.length + result.outline.testSymbols.length,
          resultChars: JSON.stringify(result.outline).length
        };
      }
    );
  }

  async readSymbol(
    filePath: string,
    selector: { symbolName?: string; line?: number },
    source: SymbolLookupSourceSelector = { kind: "head" }
  ): Promise<{ text?: string; symbol?: SymbolInfo; meta: ToolResultMeta }> {
    return this.measure(
      "read_symbol",
      { path: filePath, symbolName: selector.symbolName, line: selector.line, source: source.kind },
      7,
      async () => {
        if ((selector.symbolName === undefined) === (selector.line === undefined)) {
          throw new CodegenieError("invalid_args", "readSymbol requires exactly one selector");
        }
        const path = containPath(this.opts.resolver.repoRoot, filePath, this.guardTelemetry("read_symbol"));
        if (source.kind !== "auto") {
          return this.readSymbolAtSource(path, selector, source, source.kind);
        }
        const head = await this.readSymbolAtSource(path, selector, { kind: "head" }, "auto");
        if (head.resultCount && head.resultCount > 0) {
          return withSourceMeta(head, "auto", "head", false, false);
        }
        const base = await this.readSymbolAtSource(path, selector, { kind: "base" }, "auto");
        if (base.resultCount && base.resultCount > 0) {
          return withSourceMeta(base, "auto", "base", true, true);
        }
        return withSourceMeta(base, "auto", "base", true, false);
      }
    );
  }

  private async readSymbolAtSource(
    path: string,
    selector: { symbolName?: string; line?: number },
    source: SourceSelector,
    requestedSource: "head" | "base" | "auto"
  ): Promise<ToolMeasurement<{ text?: string; symbol?: SymbolInfo; meta: ToolResultMeta }>> {
    const content = await this.limit(() => this.opts.resolver.readFile(path, source));
    if (!content) {
      const meta = {
        ...degradedMeta("text", "text", "file missing at selected revision"),
        lookupStatus: "file_missing" as const,
        deliveryStatus: "empty" as const,
        requestedSource,
        sourceUsed: source.kind
      };
      return { value: { meta }, meta, args: { path, symbolName: selector.symbolName, line: selector.line, source: requestedSource }, resultChars: 0 };
    }
    const adapter = this.opts.registry.forPath(path);
    const parsed = await adapter.parse({
      path,
      language: this.opts.registry.languageForPath(path),
      content: content.content,
      source,
      contentSha: content.contentSha
    });
    if (parsed.tree !== undefined) {
      const symbols = adapter.listSymbols(parsed);
      const matches =
        selector.line !== undefined
          ? [adapter.getEnclosingSymbol(parsed, selector.line)].filter((symbol): symbol is SymbolInfo => symbol !== undefined)
          : symbols.filter((symbol) => symbolMatches(symbol, selector.symbolName ?? ""));
      const symbol = matches[0];
      const symbolSnippet = symbol ? snippet(content.content, symbol.lineRange, SYMBOL_MAX_LINES, SYMBOL_MAX_CHARS) : undefined;
      const meta: ToolResultMeta = {
        backend: "tree-sitter",
        precision: "syntactic",
        degraded: symbol === undefined,
        lookupStatus: symbol === undefined ? "not_found" : matches.length > 1 ? "ambiguous" : "found",
        deliveryStatus: symbol === undefined ? "empty" : symbolSnippet?.truncated ? "truncated" : "full",
        requestedSource,
        sourceUsed: source.kind,
        ...(symbol === undefined ? { degradationReason: "symbol not found" } : {}),
        ...(matches.length > 1 ? { truncated: true, omittedCount: matches.length - 1 } : {})
      };
      if (symbol !== undefined && symbolSnippet?.truncated) {
        meta.truncated = true;
        meta.omittedCount = (meta.omittedCount ?? 0) + symbolSnippet.omittedCount;
        meta.recovery = recoveryReadRange(path, symbol.lineRange, source, "read exact symbol range because read_symbol was truncated");
      }
      const text = symbolSnippet?.text;
      return {
        value: { ...(text !== undefined ? { text } : {}), ...(symbol !== undefined ? { symbol } : {}), meta },
        meta,
        args: { path, symbolName: selector.symbolName, line: selector.line, source: requestedSource },
        resultCount: symbol ? 1 : 0,
        resultChars: text?.length ?? 0
      };
    }
    const fallback = fallbackSymbolText(content.content, selector);
    const meta: ToolResultMeta = {
      ...degradedMeta("text", "text", "tree-sitter unavailable; returned text window"),
      lookupStatus: fallback === undefined ? "not_found" : "found",
      deliveryStatus: fallback === undefined ? "empty" : fallback.truncated ? "truncated" : "full",
      requestedSource,
      sourceUsed: source.kind
    };
    if (fallback?.truncated) {
      meta.truncated = true;
      meta.omittedCount = fallback.omittedCount;
    }
    return {
      value: { ...(fallback !== undefined ? { text: fallback.text } : {}), meta },
      meta,
      args: { path, symbolName: selector.symbolName, line: selector.line, source: requestedSource },
      resultCount: fallback === undefined ? 0 : 1,
      resultChars: fallback?.text.length ?? 0
    };
  }

  async readDiffBlocks(input: { packetId?: string; path?: string }): Promise<{ blocks: string[]; meta: ToolResultMeta }> {
    return this.measure(
      "read_diff_blocks",
      { path: input.path },
      7,
      async () => {
        if ((input.path === undefined) === (input.packetId === undefined)) {
          throw new CodegenieError("invalid_args", "readDiffBlocks requires exactly one selector");
        }
        const normalizedInput =
          input.path !== undefined
            ? { path: containPath(this.opts.resolver.repoRoot, input.path, this.guardTelemetry("read_diff_blocks")) }
            : input;
        const value = this.diffBlocks.read(normalizedInput);
        return {
          value,
          meta: value.meta,
          args: { path: normalizedInput.path },
          resultCount: value.blocks.length,
          resultChars: value.blocks.join("\n").length
        };
      }
    );
  }

  async findDefinition(
    symbolName: string,
    options: { pathGlob?: string; source?: SymbolLookupSourceSelector } = {}
  ): Promise<{ definitions: Array<{ symbol: SymbolInfo; text?: string }>; meta: ToolResultMeta }> {
    return this.measure(
      "find_definition",
      { symbolName, glob: options.pathGlob, source: options.source?.kind },
      7,
      async () => {
        if (symbolName.length === 0) {
          throw new CodegenieError("invalid_args", "symbolName must be non-empty");
        }
        const pathGlob =
          options.pathGlob === undefined
            ? undefined
            : containGlob(this.opts.resolver.repoRoot, options.pathGlob, this.guardTelemetry("find_definition"));
        const requestedSource = options.source?.kind ?? "head";
        if (requestedSource !== "auto") {
          const exactSource: SourceSelector = requestedSource === "base" ? { kind: "base" } : { kind: "head" };
          return this.findDefinitionAtSource(symbolName, pathGlob, exactSource, requestedSource);
        }
        const head = await this.findDefinitionAtSource(symbolName, pathGlob, { kind: "head" }, "auto");
        if (head.resultCount && head.resultCount > 0) {
          return withSourceMeta(head, "auto", "head", false, false);
        }
        const base = await this.findDefinitionAtSource(symbolName, pathGlob, { kind: "base" }, "auto");
        if (base.resultCount && base.resultCount > 0) {
          return withSourceMeta(base, "auto", "base", true, true);
        }
        return withSourceMeta(base, "auto", "base", true, false);
      }
    );
  }

  private async findDefinitionAtSource(
    symbolName: string,
    pathGlob: string | undefined,
    source: SourceSelector,
    requestedSource: "head" | "base" | "auto"
  ): Promise<ToolMeasurement<{ definitions: Array<{ symbol: SymbolInfo; text?: string }>; meta: ToolResultMeta }>> {
    const discoveryName = bareIdentifierForDiscovery(symbolName);
    const grepOptions = {
      source,
      maxResults: FIND_DEFINITION_DISCOVERY_MATCHES + 1,
      fixedString: true,
      word: true,
      ...(pathGlob !== undefined ? { glob: pathGlob } : {})
    };
    const discoveryMatches = await this.limit(() => this.opts.resolver.grep(discoveryName, grepOptions));
    const matches = discoveryMatches.slice(0, FIND_DEFINITION_DISCOVERY_MATCHES);
    const omittedDiscoveryMatches = Math.max(0, discoveryMatches.length - matches.length);
    const allCandidatePaths = [...new Set(matches.map((match) => match.path))];
    const candidatePaths = allCandidatePaths.slice(0, FIND_DEFINITION_CANDIDATES);
    const omittedCandidatePaths = Math.max(0, allCandidatePaths.length - candidatePaths.length);
    const definitions: Array<{ symbol: SymbolInfo; text?: string }> = [];
    let fallbackCount = 0;
    let omittedByTruncation = 0;
    let omittedByDefinitionCap = 0;
    let processedCandidates = 0;
    for (const candidate of candidatePaths) {
      if (definitions.length >= FIND_DEFINITION_MAX) {
        break;
      }
      processedCandidates += 1;
      const candidateData = await this.limit(async () => {
        const content = await this.opts.resolver.readFile(candidate, source);
        if (!content) {
          return undefined;
        }
        const adapter = this.opts.registry.forPath(candidate);
        const parsed = await adapter.parse({
          path: candidate,
          language: this.opts.registry.languageForPath(candidate),
          content: content.content,
          source,
          contentSha: content.contentSha
        });
        return { content, adapter, parsed };
      });
      if (!candidateData) {
        continue;
      }
      const { content, adapter, parsed } = candidateData;
      if (parsed.tree !== undefined) {
        const matchingSymbols = adapter.listSymbols(parsed).filter((symbol) => symbolMatches(symbol, symbolName));
        if (matchingSymbols.length === 0 && definitions.length < FIND_DEFINITION_MAX) {
          const fallbackDefinition = fallbackDefinitionFromText(content.content, candidate, symbolName);
          if (fallbackDefinition !== undefined) {
            fallbackCount += 1;
            definitions.push(fallbackDefinition);
          }
        }
        for (let index = 0; index < matchingSymbols.length; index += 1) {
          if (definitions.length >= FIND_DEFINITION_MAX) {
            omittedByDefinitionCap += matchingSymbols.length - index;
            break;
          }
          const symbol = matchingSymbols[index];
          if (!symbol) {
            continue;
          }
          const definitionSnippet = snippet(content.content, symbol.lineRange, SYMBOL_MAX_LINES, SYMBOL_MAX_CHARS);
          definitions.push({
            symbol,
            text: definitionSnippet.text
          });
          if (definitionSnippet.truncated) {
            omittedByTruncation += definitionSnippet.omittedCount;
          }
        }
      } else {
        const match = matches.find((item) => item.path === candidate);
        if (match) {
          fallbackCount += 1;
          definitions.push({
            symbol: {
              path: candidate,
              name: symbolName,
              kind: "other",
              nativeKind: "text match",
              lineRange: [match.line, match.line]
            },
            text: match.matchText
          });
        }
      }
    }
    // When the definition cap is hit, omissions are remaining same-file
    // definition symbols plus unprocessed candidate files, not raw grep
    // line-match counts.
    const cappedAtMax = definitions.length >= FIND_DEFINITION_MAX;
    const omittedByCap = cappedAtMax ? Math.max(0, candidatePaths.length - processedCandidates) : 0;
    const cappedDefinitions = capDefinitionResultsTotal(
      definitions,
      omittedByCap + omittedByDefinitionCap + omittedByTruncation + omittedCandidatePaths + omittedDiscoveryMatches
    );
    const definitionLookupStatus =
      cappedDefinitions.definitions.length === 0
        ? cappedDefinitions.omittedCount > 0 ? "ambiguous" : "not_found"
        : cappedDefinitions.definitions.length > 1 ? "ambiguous" : "found";
    const definitionDeliveryStatus =
      cappedDefinitions.definitions.length === 0
        ? "empty"
        : cappedDefinitions.omittedCount > 0 ? "truncated" : "full";
    const singleDefinition = cappedDefinitions.definitions.length === 1 ? cappedDefinitions.definitions[0] : undefined;
    const definitionRecovery =
      singleDefinition !== undefined && definitionDeliveryStatus === "truncated"
        ? recoveryReadRange(
            singleDefinition.symbol.path,
            singleDefinition.symbol.lineRange,
            source,
            "read exact definition range because find_definition was truncated"
          )
        : undefined;
    const meta: ToolResultMeta = {
      backend: fallbackCount === cappedDefinitions.definitions.length ? "text" : "tree-sitter",
      precision: fallbackCount === cappedDefinitions.definitions.length ? "text" : "syntactic",
      degraded: fallbackCount > 0,
      lookupStatus: definitionLookupStatus,
      deliveryStatus: definitionDeliveryStatus,
      requestedSource,
      sourceUsed: source.kind,
      ...(fallbackCount > 0 ? { degradationReason: `${fallbackCount} definition candidate(s) used text fallback` } : {}),
      ...(definitionRecovery !== undefined ? { recovery: definitionRecovery } : {}),
      ...(cappedDefinitions.omittedCount > 0 ? { truncated: true, omittedCount: cappedDefinitions.omittedCount } : {})
    };
    return {
      value: { definitions: cappedDefinitions.definitions, meta },
      meta,
      args: { symbolName, glob: pathGlob, source: requestedSource },
      resultCount: cappedDefinitions.definitions.length,
      resultChars: JSON.stringify(cappedDefinitions.definitions).length
    };
  }

  async searchFiles(query: string, options: SearchOptions = {}): Promise<{ results: SearchResult[]; meta: ToolResultMeta }> {
    return this.measure(
      "search_files",
      { query, glob: options.pathGlob, source: options.source?.kind, contextMode: options.contextMode, maxResults: options.maxResults },
      7,
      async () => {
        const normalizedOptions = this.normalizeSearchOptions(options, "search_files");
        const execution = await this.search.search(query, normalizedOptions);
        const meta = metaFromSearch(execution);
        return {
          value: { results: execution.results, meta },
          meta,
          args: {
            query,
            glob: normalizedOptions.pathGlob,
            source: normalizedOptions.source?.kind,
            contextMode: normalizedOptions.contextMode,
            maxResults: normalizedOptions.maxResults
          },
          engine: execution.engine,
          resultCount: execution.results.length,
          resultChars: JSON.stringify(execution.results).length
        };
      }
    );
  }

  async findSymbolMentions(
    symbolName: string,
    options: SymbolMentionOptions = {}
  ): Promise<{ results: SearchResult[]; meta: ToolResultMeta }> {
    return this.measure(
      "find_symbol_mentions",
      {
        symbolName,
        glob: options.pathGlob,
        source: options.source?.kind,
        contextMode: options.contextMode,
        maxResults: options.maxResults
      },
      7,
      async () => {
        const normalizedOptions = this.normalizeSearchOptions(options, "find_symbol_mentions");
        const execution = await this.search.findSymbolMentions(symbolName, normalizedOptions);
        const meta = metaFromSearch(execution);
        return {
          value: { results: execution.results, meta },
          meta,
          args: {
            symbolName,
            glob: normalizedOptions.pathGlob,
            source: normalizedOptions.source?.kind,
            contextMode: normalizedOptions.contextMode,
            maxResults: normalizedOptions.maxResults
          },
          engine: execution.engine,
          resultCount: execution.results.length,
          resultChars: JSON.stringify(execution.results).length
        };
      }
    );
  }

  async findLikelyTests(
    input: { path?: string; symbol?: SymbolRef; source?: SourceSelector }
  ): Promise<{ tests: SymbolRef[]; meta: ToolResultMeta }> {
    return this.measure(
      "find_likely_tests",
      { path: input.path ?? input.symbol?.path, symbolName: input.symbol?.name, source: input.source?.kind },
      7,
      async () => {
        if (input.path === undefined && input.symbol === undefined) {
          throw new CodegenieError("invalid_args", "findLikelyTests requires a path or symbol");
        }
        const normalizedInput = this.normalizeLikelyTestsInput(input);
        const result = await findLikelyTestsForInput(this.opts.resolver, this.opts.registry, normalizedInput);
        const meta: ToolResultMeta = {
          backend: result.backend,
          precision: "heuristic",
          degraded: false,
          ...(result.truncated ? { truncated: true, omittedCount: result.omittedCount ?? 0 } : {})
        };
        return {
          value: { tests: result.tests, meta },
          meta,
          args: {
            path: normalizedInput.path ?? normalizedInput.symbol?.path,
            symbolName: normalizedInput.symbol?.name,
            source: normalizedInput.source?.kind
          },
          resultCount: result.tests.length,
          resultChars: JSON.stringify(result.tests).length
        };
      }
    );
  }

  async listFiles(glob: string): Promise<{ paths: string[]; meta: ToolResultMeta }> {
    return this.measure(
      "list_files",
      { glob },
      7,
      async () => {
        const contained = containGlob(this.opts.resolver.repoRoot, glob, this.guardTelemetry("list_files"));
        const paths = await this.opts.resolver.listFiles(contained);
        const truncated = paths.length > LIST_FILES_MAX;
        const visible = paths.slice(0, LIST_FILES_MAX);
        const meta: ToolResultMeta = {
          backend: "text",
          precision: "exact",
          degraded: false,
          ...(truncated ? { truncated: true, omittedCount: paths.length - LIST_FILES_MAX } : {})
        };
        return {
          value: { paths: visible, meta },
          meta,
          args: { glob: contained },
          resultCount: visible.length,
          resultChars: visible.join("\n").length
        };
      }
    );
  }

  private async measure<T>(
    tool: string,
    args: ToolArgs,
    stage: ReviewStage,
    run: () => Promise<ToolMeasurement<T>>
  ): Promise<T> {
    const started = Date.now();
    const context = this.toolCallContext.getStore();
    try {
      const measurement = await run();
      if (context?.record !== false) {
        this.opts.telemetry.recordToolCall({
          ...toolCallContextRecordFields(context, stage),
          tool,
          args: cleanArgs(measurement.args ?? args),
          backend: measurement.meta.backend,
          precision: measurement.meta.precision,
          ...(measurement.engine !== undefined ? { engine: measurement.engine } : {}),
          degraded: measurement.meta.degraded,
          ...(measurement.meta.degradationReason !== undefined ? { degradationReason: measurement.meta.degradationReason } : {}),
          ...(measurement.meta.truncated !== undefined ? { truncated: measurement.meta.truncated } : {}),
          ...(measurement.meta.omittedCount !== undefined ? { omittedCount: measurement.meta.omittedCount } : {}),
          ...(measurement.meta.lookupStatus !== undefined ? { lookupStatus: measurement.meta.lookupStatus } : {}),
          ...(measurement.meta.deliveryStatus !== undefined ? { deliveryStatus: measurement.meta.deliveryStatus } : {}),
          ...(measurement.meta.recovery !== undefined ? { recovery: measurement.meta.recovery } : {}),
          ...(measurement.resultCount !== undefined ? { resultCount: measurement.resultCount } : {}),
          resultChars: measurement.resultChars,
          durationMs: Date.now() - started,
          status: "ok"
        });
      }
      return measurement.value;
    } catch (error) {
      const isRejected = error instanceof CodegenieError && error.code === "path_outside_repo";
      if (context?.record !== false) {
        this.opts.telemetry.recordToolCall({
          ...toolCallContextRecordFields(context, stage),
          tool,
          args: cleanArgs(args),
          backend: "text",
          precision: "text",
          degraded: true,
          degradationReason: error instanceof Error ? error.message : String(error),
          resultChars: 0,
          durationMs: Date.now() - started,
          status: isRejected ? "rejected" : "error",
          ...(error instanceof CodegenieError ? { errorCode: error.code } : {})
        });
      }
      throw error;
    }
  }

  private guardTelemetry(toolName: string): Parameters<typeof containPath>[2] {
    return { telemetry: this.opts.telemetry, stage: 7, toolName };
  }

  private normalizeLikelyTestsInput(input: { path?: string; symbol?: SymbolRef; source?: SourceSelector }): {
    path?: string;
    symbol?: SymbolRef;
    source?: SourceSelector;
  } {
    const normalizedPath = input.path
      ? containPath(this.opts.resolver.repoRoot, input.path, this.guardTelemetry("find_likely_tests"))
      : undefined;
    const normalizedSymbol =
      input.symbol !== undefined
        ? {
            ...input.symbol,
            path: containPath(this.opts.resolver.repoRoot, input.symbol.path, this.guardTelemetry("find_likely_tests"))
          }
        : undefined;
    return {
      ...(normalizedPath !== undefined ? { path: normalizedPath } : {}),
      ...(normalizedSymbol !== undefined ? { symbol: normalizedSymbol } : {}),
      ...(input.source !== undefined ? { source: input.source } : {})
    };
  }

  private normalizeSearchOptions<T extends { pathGlob?: string; source?: SourceSelector; maxResults?: number; contextMode?: string }>(
    options: T,
    toolName: string
  ): T {
    if (options.pathGlob === undefined) {
      return options;
    }
    return {
      ...options,
      pathGlob: containGlob(this.opts.resolver.repoRoot, options.pathGlob, this.guardTelemetry(toolName))
    };
  }
}

export async function withRepositoryToolCallContext<T>(
  tools: RepositoryTools,
  context: RepositoryToolCallContext,
  run: () => Promise<T>
): Promise<T> {
  const contextualTools = tools as RepositoryTools & {
    withToolCallContext?: <U>(context: RepositoryToolCallContext, run: () => Promise<U>) => Promise<U>;
  };
  return contextualTools.withToolCallContext ? contextualTools.withToolCallContext(context, run) : run();
}

function metaFromSearch(execution: {
  backend: ToolBackend;
  precision: ToolPrecision;
  degraded: boolean;
  degradationReason?: string;
  truncated?: boolean;
  omittedCount?: number;
}): ToolResultMeta {
  return {
    backend: execution.backend,
    precision: execution.precision,
    degraded: execution.degraded,
    ...(execution.degradationReason !== undefined ? { degradationReason: execution.degradationReason } : {}),
    ...(execution.truncated !== undefined ? { truncated: execution.truncated } : {}),
    ...(execution.omittedCount !== undefined ? { omittedCount: execution.omittedCount } : {})
  };
}

function degradedMeta(backend: ToolBackend, precision: ToolPrecision, reason: string): ToolResultMeta {
  return {
    backend,
    precision,
    degraded: true,
    degradationReason: reason
  };
}

function withSourceMeta<T extends { meta: ToolResultMeta }>(
  measurement: ToolMeasurement<T>,
  requestedSource: "head" | "base" | "auto",
  sourceUsed: "head" | "base",
  sourceFallback: boolean,
  baseOnly: boolean
): ToolMeasurement<T> {
  const meta: ToolResultMeta = {
    ...measurement.meta,
    requestedSource,
    sourceUsed,
    ...(sourceFallback ? { sourceFallback: true } : {}),
    ...(baseOnly ? { baseOnly: true } : {})
  };
  return {
    ...measurement,
    meta,
    value: { ...measurement.value, meta }
  };
}

function snippet(
  content: string,
  range: [number, number],
  maxLines: number,
  maxChars: number
): { text: string; truncated: boolean; omittedCount: number } {
  const lines = content.split(/\n/u);
  const end = Math.min(lines.length, range[1], range[0] + maxLines - 1);
  const lineOmissions = Math.max(0, range[1] - end);
  const text = lines.slice(Math.max(0, range[0] - 1), end).join("\n");
  const capped = capText(text, maxChars);
  return {
    ...capped,
    truncated: lineOmissions > 0 || capped.truncated,
    omittedCount: lineOmissions + capped.omittedCount
  };
}

function capText(text: string, maxChars: number): { text: string; truncated: boolean; omittedCount: number } {
  if (text.length <= maxChars) {
    return { text, truncated: false, omittedCount: 0 };
  }
  return { text: text.slice(0, maxChars), truncated: true, omittedCount: 1 };
}

function fallbackSymbolText(
  content: string,
  selector: { symbolName?: string; line?: number }
): { text: string; truncated: boolean; omittedCount: number } | undefined {
  const lines = content.split(/\n/u);
  if (selector.line !== undefined) {
    const start = Math.max(1, selector.line - 20);
    const end = Math.min(lines.length, selector.line + 20);
    return capText(lines.slice(start - 1, end).join("\n"), SYMBOL_MAX_CHARS);
  }
  if (selector.symbolName !== undefined) {
    const pattern = new RegExp(`\\b${escapeRegExp(selector.symbolName)}\\b`, "u");
    const index = lines.findIndex((line) => pattern.test(line));
    if (index >= 0) {
      const start = Math.max(0, index - 20);
      const end = Math.min(lines.length, index + 21);
      return capText(lines.slice(start, end).join("\n"), SYMBOL_MAX_CHARS);
    }
  }
  return undefined;
}

function fallbackDefinitionFromText(content: string, path: string, symbolName: string): { symbol: SymbolInfo; text?: string } | undefined {
  const bareName = bareIdentifierForDiscovery(symbolName);
  if (!/^[A-Za-z_$][\w$]*$/u.test(bareName)) {
    return undefined;
  }
  const escaped = escapeRegExp(bareName);
  const patterns = [
    new RegExp(`^\\s*func\\s+(?:\\([^)]*\\)\\s*)?${escaped}\\s*\\(`, "u"),
    new RegExp(`^\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${escaped}\\b`, "u"),
    new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+${escaped}\\b`, "u"),
    new RegExp(`^\\s*(?:export\\s+)?(?:class|interface|type|enum)\\s+${escaped}\\b`, "u"),
    new RegExp(`^\\s*(?:pub\\s+)?(?:async\\s+)?fn\\s+${escaped}\\b`, "u"),
    new RegExp(`^\\s*(?:pub\\s+)?(?:struct|enum|trait|type)\\s+${escaped}\\b`, "u"),
    new RegExp(`^\\s*(?:function|contract|interface|library|struct|enum|modifier|event|error)\\s+${escaped}\\b`, "u")
  ];
  const lines = content.split(/\n/u);
  const index = lines.findIndex((line) => patterns.some((pattern) => pattern.test(line)));
  if (index < 0) {
    return undefined;
  }
  const line = index + 1;
  const endLine = Math.min(lines.length, line + 39);
  const declaration = lines[index]?.trim() ?? bareName;
  const text = snippet(content, [line, endLine], 80, SYMBOL_MAX_CHARS);
  return {
    symbol: {
      path,
      name: bareName,
      kind: fallbackSymbolKind(declaration),
      nativeKind: "text declaration",
      lineRange: [line, endLine],
      exported: /^[A-Z]/u.test(bareName) || /\bexport\b|\bpub\b/u.test(declaration),
      signature: declaration
    },
    text: text.text
  };
}

function fallbackSymbolKind(declaration: string): SymbolInfo["kind"] {
  if (/\b(?:class|interface|type|enum|struct|trait|contract|library)\b/u.test(declaration)) {
    return "type";
  }
  if (/\b(?:const|let|var)\b/u.test(declaration)) {
    return "value";
  }
  return "function";
}

function symbolMatches(symbol: SymbolInfo, query: string): boolean {
  return symbol.name === query || `${symbol.ownerType ?? ""}.${symbol.name}`.replace(/^\./u, "") === normalizeQualifiedQuery(query);
}

function normalizeQualifiedQuery(query: string): string {
  const trimmed = query.trim();
  const receiverMethod = /(?:^|\.)(?:\(\*?([A-Za-z_$][\w$]*)\)|\*?([A-Za-z_$][\w$]*))\.([A-Za-z_$][\w$]*)$/u.exec(trimmed);
  if (receiverMethod) {
    return `${receiverMethod[1] ?? receiverMethod[2]}.${receiverMethod[3]}`;
  }
  return trimmed.replace(/^\(\*/u, "").replace(/^\*/u, "").replace(/\)/gu, "");
}

function bareIdentifierForDiscovery(query: string): string {
  const normalized = normalizeQualifiedQuery(query);
  const match = /[A-Za-z_$][\w$]*$/u.exec(normalized);
  return match?.[0] ?? normalized;
}

function cleanArgs(args: ToolArgs): RecordedToolArgs {
  return Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined)) as RecordedToolArgs;
}

function toolCallContextRecordFields(
  context: RepositoryToolCallContext | undefined,
  fallbackStage: ReviewStage
): {
  stage: ReviewStage;
  initiator: "model" | "harness";
  workerId?: string;
  packetId?: string;
  taskId?: string;
  candidateId?: string;
  modelCallId?: string;
} {
  if (context === undefined) {
    return { stage: fallbackStage, initiator: "harness" };
  }
  return {
    stage: context.stage,
    initiator: context.initiator,
    ...(context.workerId !== undefined ? { workerId: context.workerId } : {}),
    ...(context.packetId !== undefined ? { packetId: context.packetId } : {}),
    ...(context.taskId !== undefined ? { taskId: context.taskId } : {}),
    ...(context.candidateId !== undefined ? { candidateId: context.candidateId } : {}),
    ...(context.modelCallId !== undefined ? { modelCallId: context.modelCallId } : {})
  };
}

function capDefinitionResultsTotal(
  definitions: Array<{ symbol: SymbolInfo; text?: string }>,
  initialOmittedCount: number
): { definitions: Array<{ symbol: SymbolInfo; text?: string }>; omittedCount: number } {
  const capped = [...definitions];
  let omittedCount = initialOmittedCount;
  while (JSON.stringify(capped).length > FIND_DEFINITION_MAX_CHARS && capped.length > 0) {
    capped.pop();
    omittedCount += 1;
  }
  return { definitions: capped, omittedCount };
}

function recoveryReadRange(path: string, lineRange: [number, number], source: SourceSelector, reason: string): NonNullable<ToolResultMeta["recovery"]> {
  return {
    tool: "read_range",
    path,
    startLine: lineRange[0],
    endLine: lineRange[1],
    source: source.kind,
    reason
  };
}
