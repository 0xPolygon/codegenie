import { withMeta, withSixToolMeta, renderSourceBlockHeader, numberSourceLine } from "./repository-tool-guidance.js";
import { createPackableToolResult, renderOutlineToolResult } from "./search-result-packing.js";
import { submissionIssues } from "./submit-preservation.js";
import { Type } from "typebox";
import type { RepositoryTools, ReviewToolSurface, SearchPage, SearchPageOptions, SourceFileMap, SourceSelector, SymbolLookupSourceSelector } from "../types.js";
import { CodegenieError, isCodegenieError } from "../util/errors.js";
import type { ToolDefinition, ToolExecutionResult } from "./llm-runner.js";
import { withRepositoryToolCallContext } from "../repo/repository-index.js";
import { hasSearchContext, SearchBudgetError, searchContextPosition, searchDeliveryMeta } from "../repo/search.js";
import { buildFindUsagesTool } from "./usage-tool.js";
import { MAX_SMALL_SOURCE_CHARS } from "../repo/source-file-map.js";
import { buildReadDefinitionTool } from "./definition-tool.js";
import type { ReadChangeInput } from "../repo/read-change.js";

const SourceSelectorSchema = Type.Optional(
  Type.Object(
    {
      kind: Type.Union([Type.Literal("head"), Type.Literal("base")])
    },
    { additionalProperties: false }
  )
);

const SymbolLookupSourceSelectorSchema = Type.Optional(
  Type.Object(
    {
      kind: Type.Union([Type.Literal("head"), Type.Literal("base"), Type.Literal("auto")])
    },
    { additionalProperties: false }
  )
);

const PATH_DISCOVERY_GUIDANCE = "Use known file paths; package/import directories and function names do not establish filenames. Discover unknown paths with list_files (head only), find_definition or search_files at the intended revision before reading.";
const LIST_FILES_GUIDANCE = "List tracked files at the head revision using a repo-relative glob: ** crosses directories; * and ? match within a segment; [ab] character classes and {api,data}/** alternatives are supported, including dotfiles. Use **/*.txt to include nested files. This is a glob, not a regular expression or gitignore file; use braces for path alternatives. Untracked files are excluded.";

export type RepositoryToolDefinitionOptions = {
  includeLikelyTests?: boolean;
  toolSurface?: ReviewToolSurface;
  currentHunks?: readonly string[];
};

const SIX_TOOL_NAMES = ["read_change", "read_range", "read_definition", "find_usages", "search_files", "list_files"] as const;
const sixToolFactories: Partial<Record<typeof SIX_TOOL_NAMES[number], (tools: RepositoryTools, options: RepositoryToolDefinitionOptions) => ToolDefinition>> = {
  read_definition: buildReadDefinitionTool,
  read_change: buildSixReadChangeTool,
  read_range: buildSixReadRangeTool,
  find_usages: buildFindUsagesTool,
  search_files: buildSixSearchTool,
  list_files: buildSixListFilesTool
};

export function assertRepositoryToolSurfaceAvailable(surface: ReviewToolSurface = "current"): void {
  if (surface === "six" && SIX_TOOL_NAMES.some(name => !sixToolFactories[name])) {
    throw new CodegenieError("config_error", 'review.toolSurface = "six" requires a build with all six repository tools. Select "current" for this build.');
  }
}

export function normalizeRepositoryToolArguments(tool: ToolDefinition, args: Record<string, unknown>): Record<string, unknown> {
  const properties = (tool.parameters as { properties?: Record<string, unknown> }).properties;
  if (properties?.cursor && args?.cursor === "") {
    const { cursor: _emptyCursor, ...firstPageArgs } = args;
    return tool.normalizeArguments?.(firstPageArgs) ?? firstPageArgs;
  }
  return tool.normalizeArguments?.(args) ?? args;
}

/** Reject invalid raw arguments before SDK coercion can change a requested range. */
export function assertRepositoryToolArguments(tool: Pick<ToolDefinition, "name" | "parameters">, args: unknown): void {
  const properties = (tool.parameters as { properties?: Record<string, unknown> }).properties;
  if (properties?.source && args && typeof args === "object" && "source" in args && typeof args.source === "string") {
    const auto = tool.name === "read_symbol" || tool.name === "find_definition" || tool.name === "read_definition" ? ', or {"kind":"auto"}' : "";
    throw new CodegenieError("invalid_args", `source must be an object: {"kind":"head"} or {"kind":"base"}${auto}; not a string`);
  }
  const issues = submissionIssues(tool.parameters, args);
  if (issues.length) throw new CodegenieError("invalid_args", `Invalid arguments for ${tool.name}: ${issues.slice(0, 5)
    .map(issue => `${issue.path || "arguments"}: ${issue.kind}`).join("; ")}`);
  const range = args as Record<string, unknown>;
  if (tool.name === "read_range" && ("startLine" in range || "endLine" in range)
    && (!Number.isSafeInteger(range.startLine) || !Number.isSafeInteger(range.endLine)
      || (range.startLine as number) < 1 || (range.startLine as number) > (range.endLine as number))) {
    throw new CodegenieError("invalid_args", "read_range requires integer bounds with 1 <= startLine <= endLine");
  }
}

export function buildRepositoryToolDefinitions(tools: RepositoryTools, options: RepositoryToolDefinitionOptions = {}): ToolDefinition[] {
  assertRepositoryToolSurfaceAvailable(options.toolSurface);
  if (options.toolSurface === "six") {
    return SIX_TOOL_NAMES.map(name => sixToolFactories[name]!(tools, options));
  }
  const definitions: ToolDefinition[] = [
    buildBoundedReadRangeTool(tools),
    {
      name: "read_file_outline",
      description: "Read a compact outline of imports, top-level symbols, and test symbols. Without syntax support, symbolExtraction is unavailable: empty symbol arrays do not mean no definitions. Small files can include complete numbered source when it fits; larger or locally bounded outlines provide a read_range hint. For known source locations, prefer read_range directly. " + PATH_DISCOVERY_GUIDANCE,
      parameters: Type.Object(
        {
          path: Type.String({ minLength: 1 }),
          source: SourceSelectorSchema
        },
        { additionalProperties: false }
      ),
      execute: (args, signal) => wrapTool(signal, async () => {
        const input = args as { path: string; source?: SourceSelector };
        const result = await runWithoutFacadeRecording(tools, () => tools.readFileOutline(input.path, input.source));
        return { text: renderOutlineToolResult(result.outline, result.meta), outline: result.outline, meta: result.meta };
      })
    },
    {
      name: "read_symbol",
      description: "Requires path; discover an unknown path with find_definition first. Read a symbol by exact symbolName or by the smallest enclosing symbol at line; provide exactly one of symbolName or line. Without syntax support, returns a text window around a matching name/line, not a verified symbol body; prefer read_range for known locations. Use source {kind:\"auto\"} for renamed or deleted symbols so head is searched first, then base. " + PATH_DISCOVERY_GUIDANCE,
      parameters: Type.Object(
        {
          path: Type.String({ minLength: 1 }),
          symbolName: Type.Optional(Type.String({ minLength: 1, description: "Provide exactly one of symbolName or line." })),
          line: Type.Optional(Type.Integer({ minimum: 1, description: "Provide exactly one of symbolName or line." })),
          source: SymbolLookupSourceSelectorSchema
        },
        { additionalProperties: false }
      ),
      execute: (args, signal) => wrapTool(signal, async () => {
        const input = args as { path: string; symbolName?: string; line?: number; source?: SymbolLookupSourceSelector };
        if ((input.symbolName === undefined) === (input.line === undefined)) {
          throw new CodegenieError("invalid_args", "read_symbol requires exactly one of symbolName or line");
        }
        const selector: { symbolName?: string; line?: number } = {};
        if (input.symbolName !== undefined) {
          selector.symbolName = input.symbolName;
        }
        if (input.line !== undefined) {
          selector.line = input.line;
        }
        const result = await runWithoutFacadeRecording(tools, () => tools.readSymbol(input.path, selector, input.source));
        if (result.meta.deliveryStatus === "budget_rejected") {
          return { text: withMeta("The first source line exceeds the source character limit; use search_files to locate a shorter excerpt.", result.meta),
            meta: result.meta, isError: true, errorCode: "budget_exhausted" };
        }
        const range = result.meta.deliveredLineRange;
        if (range && result.text !== undefined) {
          const meta = result.meta.precision === "text" && result.meta.lookupStatus === "found"
            ? { ...result.meta, lookupStatus: "unavailable" as const } : result.meta;
          const records = result.text.split("\n").map((line, index) => numberSourceLine(line, range[0] + index));
          return { ...createPackableToolResult({ open: "", records, separator: "\n", close: "" }, meta),
            ...(meta.deliveryStatus === "full" && !meta.truncated && meta.precision === "syntactic"
              ? { rawSource: result.text, sourceLineRange: range } : {}) };
        }
        const payload = {
          lookupStatus: result.meta.lookupStatus,
          deliveryStatus: result.meta.deliveryStatus,
          recovery: result.meta.recovery,
          symbol: result.symbol,
          text: result.text ?? ""
        };
        return {
          text: withMeta(JSON.stringify(payload, null, 2), result.meta),
          meta: result.meta
        };
      })
    },
    {
      name: "find_definition",
      description: "Find definition candidates for an exact symbol name, optionally constrained by pathGlob and source. Without syntax support, candidates are text matches, not proven definitions; inspect their source with read_range. Use source {kind:\"auto\"} for renamed or deleted symbols so head is searched first, then base.",
      parameters: Type.Object(
        {
          symbolName: Type.String({ minLength: 1, maxLength: 200 }),
          pathGlob: Type.Optional(Type.String({ minLength: 1 })),
          source: SymbolLookupSourceSelectorSchema
        },
        { additionalProperties: false }
      ),
      execute: (args, signal) => wrapTool(signal, async () => {
        const input = args as { symbolName: string; pathGlob?: string; source?: SymbolLookupSourceSelector };
        const result = await runWithoutFacadeRecording(tools, () => tools.findDefinition(input.symbolName, optionalOptions({ pathGlob: input.pathGlob, source: input.source })));
        if (result.definitions.length === 0) return { text: withMeta(JSON.stringify(result.definitions, null, 2), result.meta), definitions: result.definitions, meta: result.meta };
        const revision = result.meta.sourceUsed ?? (input.source?.kind === "base" ? "base" : "head");
        const records: string[] = [];
        const labels: string[] = [];
        const keepWithNext: boolean[] = [];
        const index: string[] = [];
        for (const hit of result.definitions) {
          const { symbol, text, totalLines, deliveredLineRange, nextLine } = hit;
          if (text === undefined || totalLines === undefined || deliveredLineRange === undefined) {
            index.push(`${symbol.path}@${revision} ${symbol.name}: declaration lines ${symbol.lineRange[0]}-${symbol.lineRange[1]}${totalLines !== undefined ? ` of ${totalLines}` : ""}; body unavailable; use read_range`);
            continue;
          }
          const header = renderSourceBlockHeader(symbol.path, revision, symbol.lineRange, totalLines, "declaration")
            .replace(" declaration lines ", symbol.nativeKind === "text declaration" ? " unverified text window lines " : " declaration lines ");
          index.push(`${header} (${symbol.nativeKind ?? symbol.kind})`);
          const lines = text.split("\n");
          records.push(header);
          labels.push(`${symbol.path}@${revision}:${deliveredLineRange[0]}`);
          keepWithNext.push(true);
          for (let i = 0; i < lines.length; i++) {
            const line = deliveredLineRange[0] + i;
            const last = i === lines.length - 1 && (nextLine !== undefined || deliveredLineRange[0] !== symbol.lineRange[0] || deliveredLineRange[1] !== symbol.lineRange[1])
              ? `\n[Delivered lines ${deliveredLineRange[0]}-${deliveredLineRange[1]} of ${totalLines}${nextLine !== undefined ? `; source continues at ${symbol.path}@${revision}:${nextLine}` : ""}]` : "";
            records.push(`${numberSourceLine(lines[i]!, line)}${last}`);
            labels.push(`${symbol.path}@${revision}:${line}`);
            keepWithNext.push(false);
          }
        }
        if (records.length === 0) {
          const meta = { ...result.meta, deliveryStatus: "budget_rejected" as const, truncated: true };
          return { text: withMeta(`Definition source could not be delivered as whole positioned lines; use a narrower read_range. ${index.join("; ")}`, meta), isError: true,
            errorCode: "budget_exhausted", meta };
        }
        const open = index.length > 1 ? `Definition locations:\n${index.join("\n")}\n\n` : "";
        const only = result.definitions.length === 1 ? result.definitions[0] : undefined;
        const meta = only?.deliveredLineRange && only.totalLines !== undefined
          ? { ...result.meta, deliveredLineRange: only.deliveredLineRange, totalLines: only.totalLines } : result.meta;
        return { ...createPackableToolResult({ open, records, separator: "\n", close: "", labels, keepWithNext }, meta), definitions: result.definitions };
      })
    },
    {
      name: "read_diff_blocks",
      description: "Read rendered diff hunks; provide exactly one of packetId or path.",
      parameters: Type.Object(
        {
          packetId: Type.Optional(Type.String({ minLength: 1, description: "Provide exactly one of packetId or path." })),
          path: Type.Optional(Type.String({ minLength: 1, description: "Provide exactly one of packetId or path." }))
        },
        { additionalProperties: false }
      ),
      execute: (args, signal) => wrapTool(signal, async () => {
        const input = args as { packetId?: string; path?: string };
        if ((input.packetId === undefined) === (input.path === undefined)) {
          throw new CodegenieError("invalid_args", "read_diff_blocks requires exactly one of packetId or path");
        }
        const result = await runWithoutFacadeRecording(tools, () => tools.readDiffBlocks(input));
        if (result.packable) {
          const packed = createPackableToolResult(result.packable, result.meta);
          return result.meta.deliveryStatus === "budget_rejected"
            ? { text: packed.text, meta: result.meta, isError: true, errorCode: "budget_exhausted" } : packed;
        }
        return { text: withMeta(result.blocks.join("\n\n"), result.meta), meta: result.meta };
      })
    },
    {
      name: "search_files",
      description: "Search committed text at head (default) or base with case-sensitive POSIX ERE: name|other, [0-9], [[:space:]]. Escape literal punctuation, for example name\\( or return \\{. No lookarounds or Perl digit classes. Set caseSensitive=false to ignore case. pathGlob uses list_files glob semantics, including {api,data}/** alternatives. Results include 1-based line/column locations for read_range. contextMode defaults to none; lines adds up to two neighboring lines; symbols adds an enclosing symbol when available. Works without syntax support. Defaults to 50 matches, at most 200, also bounded by output budgets. Invalid syntax is an error; empty or truncated results do not prove repository-wide absence."
        + (tools.searchFilesPage ? " Continue with the returned cursor and the same search arguments." : ""),
      parameters: Type.Object(
        {
          query: Type.String({ minLength: 1, maxLength: 500 }),
          pathGlob: Type.Optional(Type.String({ minLength: 1 })),
          contextMode: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("lines"), Type.Literal("symbols")])),
          maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
          caseSensitive: Type.Optional(Type.Boolean()),
          source: SourceSelectorSchema,
          ...(tools.searchFilesPage ? { cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })) } : {})
        },
        { additionalProperties: false }
      ),
      execute: (args, signal) => wrapTool(signal, async () => {
        const input = args as SearchPageOptions & { query: string };
        if (tools.searchFilesPage) {
          const { query, ...options } = input;
          const page = await runWithoutFacadeRecording(tools, () => tools.searchFilesPage!(query, options));
          return renderSearchPage(page, options.source?.kind ?? "head");
        }
        const result = await runWithoutFacadeRecording(tools, () => tools.searchFiles(input.query, optionalOptions({
          pathGlob: input.pathGlob,
          contextMode: input.contextMode,
          maxResults: input.maxResults,
          caseSensitive: input.caseSensitive,
          source: input.source
        })));
        return { text: withMeta(JSON.stringify(result.results), result.meta), searchResults: result.results, meta: result.meta };
      })
    },
    {
      name: "find_symbol_mentions",
      description: "Find case-sensitive, literal whole-word identifier mentions at head (default) or base; symbolName is not a regex. Without a syntax adapter these are text matches, including comments/strings, not proof of semantic references. pathGlob uses list_files glob semantics including {api,data}/** alternatives. contextMode: none (default), lines, symbols; defaults to 100 matches, at most 300, with bounded output and syntax inspection.",
      parameters: Type.Object(
        {
          symbolName: Type.String({ minLength: 1, maxLength: 200 }),
          pathGlob: Type.Optional(Type.String({ minLength: 1 })),
          contextMode: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("lines"), Type.Literal("symbols")])),
          maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 300 })),
          source: SourceSelectorSchema
        },
        { additionalProperties: false }
      ),
      execute: (args, signal) => wrapTool(signal, async () => {
        const input = args as Parameters<RepositoryTools["findSymbolMentions"]>[1] & { symbolName: string };
        const result = await runWithoutFacadeRecording(tools, () => tools.findSymbolMentions(input.symbolName, optionalOptions({
          pathGlob: input.pathGlob,
          contextMode: input.contextMode,
          maxResults: input.maxResults,
          source: input.source
        })));
        if (result.results.length && result.positioning) {
          const revision = input.source?.kind ?? "head";
          const records = (includeContext: boolean) => result.results.map(hit => {
            const total = result.positioning!.fileLengths[hit.path]!;
            const before = includeContext ? hit.contextBefore ?? [] : [];
            const after = includeContext ? (hit.contextAfter ?? []).slice(0, Math.max(0, total - hit.line)) : [];
            const start = hit.line - before.length;
            const end = hit.line + after.length;
            const excerpt = hit.excerpt ? `Matching-line excerpt starts at column ${hit.excerptStartColumn ?? 1}; use read_range for the whole line.` : undefined;
            return [renderSourceBlockHeader(hit.path, revision, [start, end], total),
              ...(includeContext && hit.enclosingSymbol ? [`Enclosing ${hit.enclosingSymbol.name}, lines ${hit.enclosingSymbol.lineRange.join("-")}`] : []),
              ...before.map((line, index) => numberSourceLine(line, start + index)),
              ...(excerpt ? [excerpt] : []),
              `${hit.line}:${hit.column ?? 1}\t${hit.matchText}`,
              ...after.map((line, index) => numberSourceLine(line, hit.line + index + 1))].join("\n");
          });
          const next = result.positioning.next;
          const render = (includeContext: boolean) => {
            const firstContext = result.results.find(hit => hit.contextBefore?.length || hit.contextAfter?.length || hit.enclosingSymbol);
            const contextLine = firstContext && (firstContext.contextBefore?.length ? firstContext.line - firstContext.contextBefore.length
              : firstContext.contextAfter?.length ? firstContext.line + 1 : firstContext.enclosingSymbol?.lineRange[0] ?? firstContext.line);
            const open = !includeContext && firstContext
              ? `Context omitted to fit the result budget; next: ${firstContext.path}@${revision}:${contextLine} (omitted context; inspect with read_range).\n` : "";
            const meta = !includeContext ? { ...result.meta, truncated: true, deliveryStatus: "truncated" as const } : result.meta;
            return createPackableToolResult({ open, records: records(includeContext), separator: "\n", close: "",
              labels: result.results.map(hit => `${hit.path}@${revision}:${hit.line - (includeContext ? hit.contextBefore?.length ?? 0 : 0)}`),
              ...(next ? { nextPage: `${next.path}@${revision}:${next.line}; inspect with read_range or narrow the search` } : {})
            }, meta);
          };
          const hasContext = result.results.some(hit => hit.contextBefore?.length || hit.contextAfter?.length || hit.enclosingSymbol);
          return { ...render(true), searchResults: result.results, ...(hasContext ? { budgetFallback: render(false) } : {}) };
        }
        if (result.positioning?.next) {
          const { path, line } = result.positioning.next;
          const location = `${path}@${input.source?.kind ?? "head"}:${line}`;
          return { ...createPackableToolResult({ open: "", records: [
            `No verified mention delivered before the scan limit; next unread raw match: ${location}. Inspect with read_range or narrow the search.`
          ], separator: "\n", close: "", labels: [location] }, result.meta), searchResults: result.results };
        }
        return { text: withMeta(JSON.stringify(result.results), result.meta), searchResults: result.results, meta: result.meta };
      })
    },
    {
      name: "find_likely_tests",
      description: "Find likely tests using deterministic test conventions; provide at least one of path or symbol. If results are cut, use read_range at the next returned test path and line.",
      parameters: Type.Object(
        {
          path: Type.Optional(Type.String({ minLength: 1, description: "Provide at least one of path or symbol." })),
          symbol: Type.Optional(
            Type.Object(
              {
                path: Type.String({ minLength: 1 }),
                name: Type.String({ minLength: 1 }),
                kind: Type.String({ minLength: 1 }),
                lineRange: Type.Tuple([Type.Integer({ minimum: 1 }), Type.Integer({ minimum: 1 })])
              },
              { additionalProperties: true, description: "Provide at least one of path or symbol." }
            )
          ),
          source: SourceSelectorSchema
        },
        { additionalProperties: false }
      ),
      execute: (args, signal) => wrapTool(signal, async () => {
        const input = args as Parameters<RepositoryTools["findLikelyTests"]>[0];
        const result = await runWithoutFacadeRecording(tools, () => tools.findLikelyTests(input));
        if (!result.tests.length) return { text: withMeta("[]", result.meta), meta: result.meta };
        const revision = input.source?.kind ?? "head";
        return createPackableToolResult({
          open: "[\n",
          records: result.tests.map(test => JSON.stringify(test, null, 2).split("\n").map(line => "  " + line).join("\n")),
          separator: ",\n", close: "\n]",
          labels: result.tests.map(test => `${test.path}@${revision}:${test.lineRange[0]}`)
        }, result.meta);
      })
    },
    tools.listFilesPage ? {
      ...buildSixListFilesTool(tools),
      description: LIST_FILES_GUIDANCE + " Continue from the returned cursor with the same glob."
    } : {
      name: "list_files",
      description: LIST_FILES_GUIDANCE + " Bounded results disclose omissions; narrow the glob when truncated.",
      parameters: Type.Object(
        {
          glob: Type.String({ minLength: 1 })
        },
        { additionalProperties: false }
      ),
      execute: (args, signal) => wrapTool(signal, async () => {
        const input = args as { glob: string };
        const result = await runWithoutFacadeRecording(tools, () => tools.listFiles(input.glob));
        return { text: withMeta(result.paths.join("\n"), result.meta), filePaths: result.paths, meta: result.meta };
      })
    }
  ];
  return options.includeLikelyTests === false
    ? definitions.filter((tool) => tool.name !== "find_likely_tests")
    : definitions;
}

export function buildSixReadChangeTool(tools: RepositoryTools, options: RepositoryToolDefinitionOptions = {}): ToolDefinition {
  const currentHunks = options.currentHunks;
  return {
    name: "read_change",
    description: "List changed files and stable hunk IDs with no selector, or read the numbered base/head diff using path or hunkId. If both are supplied, path must name the file of hunkId (either path for a rename). With a selector, context: \"function\" shows the enclosing declaration on both revisions when the syntax supports it. Continue a clipped result with the cursor and the same selector and context.",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ minLength: 1 })),
      hunkId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
      context: Type.Optional(Type.Literal("function")),
      cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 }))
    }, { additionalProperties: false }),
    ...(currentHunks?.length ? {
      resultCacheScope: (args: Record<string, unknown>) => args.path === undefined && args.hunkId === undefined
        ? currentHunks.join(",") : undefined
    } : {}),
    execute: (args, signal) => wrapTool(signal, async () => {
      if (!tools.readChange) throw new CodegenieError("config_error", "This repository cannot read changed hunks.");
      const result = await tools.readChange(args as ReadChangeInput, currentHunks);
      if (!result.packable) return { text: withMeta(result.text ?? "", result.meta), meta: result.meta };
      const packed = createPackableToolResult(result.packable, result.meta);
      return result.meta.deliveryStatus === "budget_rejected"
        ? { text: packed.text, meta: packed.meta!, isError: true, errorCode: "budget_exhausted" } : packed;
    })
  };
}

async function wrapTool(signal: AbortSignal, run: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult> {
  try {
    throwIfAborted(signal);
    return await Promise.race([run(), abortPromise(signal)]);
  } catch (error) {
    if (isCancellationError(error)) {
      throw error;
    }
    if (isCodegenieError(error)) {
      return {
        text: `tool error: ${error.code}: ${error.message}`,
        isError: true,
        errorCode: error.code,
        meta: error instanceof SearchBudgetError ? error.meta : { backend: "text", precision: "text", degraded: true, degradationReason: error.code }
      };
    }
    throw error;
  }
}

function abortPromise(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const onAbort = (): void => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw abortError(signal);
  }
}

function abortError(signal: AbortSignal): CodegenieError {
  const reason = signal.reason;
  const timedOut = reason instanceof Error && reason.message.toLowerCase().includes("timeout");
  return new CodegenieError("llm_call_failed", timedOut ? "repository tool timed out" : "repository tool aborted", {
    recoverable: true,
    context: { reason: timedOut ? "timeout" : "aborted" },
    cause: reason
  });
}

function isCancellationError(error: unknown): boolean {
  return isCodegenieError(error) && error.code === "llm_call_failed";
}

async function runWithoutFacadeRecording<T>(tools: RepositoryTools, run: () => Promise<T>): Promise<T> {
  return withRepositoryToolCallContext(tools, { stage: 7, initiator: "model", record: false }, run);
}

function optionalOptions<T extends Record<string, unknown>>(input: T): Partial<T> {
  const output: Partial<T> = {};
  for (const [key, value] of Object.entries(input) as Array<[keyof T, T[keyof T]]>) {
    if (value !== undefined) {
      output[key] = value;
    }
  }
  return output;
}

function buildBoundedReadRangeTool(tools: RepositoryTools, renderMeta = withMeta): ToolDefinition {
  return {
    name: "read_range",
    description: "Read committed text at head (default) or base. Works for any text format without syntax support. Both startLine and endLine are required inclusive 1-based integers, with startLine <= endLine. Prefer a small window around a diff or search hit. Returns numbered source with file length and delivered range. Reads up to 400 lines / 16,000 source characters before local budget limits. A cut gives the next line. An end beyond EOF is clipped. A start beyond EOF returns no source and gives the file length. Missing files have lookup=file_missing. " + PATH_DISCOVERY_GUIDANCE,
    parameters: Type.Object(
      {
        path: Type.String({ minLength: 1 }),
        startLine: Type.Integer({ minimum: 1 }),
        endLine: Type.Integer({ minimum: 1 }),
        source: SourceSelectorSchema
      },
      { additionalProperties: false }
    ),
    execute: (args, signal) => wrapTool(signal, async () => {
      const input = args as { path: string; startLine: number; endLine: number; source?: SourceSelector };
      const { text, meta } = await runWithoutFacadeRecording(tools, () => tools.readRange(input.path, input.startLine, input.endLine, input.source));
      if (meta.deliveryStatus === "budget_rejected") {
        return {
          text: renderMeta(`Source line ${input.startLine} exceeds the source character limit. Use search_files scoped to this file to locate a match.`, meta),
          meta,
          isError: true,
          errorCode: "budget_exhausted"
        };
      }
      const range = meta.deliveredLineRange;
      const records = text.split("\n");
      const sourceLineRange: [number, number] | undefined = meta.deliveryStatus === "full"
        ? range ?? (text ? [input.startLine, Math.min(input.endLine, input.startLine + records.length - 1)] : undefined)
        : undefined;
      const placement = sourceLineRange ? { sourceLineRange, rawSource: text } : {};
      if (!range) {
        if (meta.requestedRange && meta.deliveryStatus === "empty") {
          return createPackableToolResult({ open: "", records: [], separator: "\n", close: "" }, meta);
        }
        return { text: renderMeta(text, meta), meta, ...placement };
      }
      const terminalNewline = records.length > range[1] - range[0] + 1;
      if (terminalNewline) records.pop();
      const numbered = records.map((line, index) => numberSourceLine(line, range[0] + index));
      return {
        ...createPackableToolResult({ open: "", records: numbered, separator: "\n", close: terminalNewline ? "\n" : "" }, meta),
        ...placement
      };
    })
  };
}

function normalizeSixReadRangeBounds(args: Record<string, unknown>): Record<string, unknown> {
  const source = args.source;
  if (source === null || typeof source !== "object" || (!("startLine" in source) && !("endLine" in source))) {
    return args;
  }
  const { kind, startLine, endLine } = source as Record<string, unknown>;
  if ("startLine" in args || "endLine" in args || "cursor" in args ||
    (kind !== "head" && kind !== "base") || Object.keys(source).length !== 3 ||
    typeof startLine !== "number" || typeof endLine !== "number" ||
    !Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || startLine < 1 || startLine > endLine) {
    throw new CodegenieError("invalid_args", "Provide both top-level startLine and endLine as inclusive integers with 1 <= startLine <= endLine. Use source only for its revision kind, and omit the declaration map cursor when giving bounds");
  }
  return { ...args, startLine, endLine, source: { kind } };
}

export function buildSixReadRangeTool(tools: RepositoryTools): ToolDefinition {
  const bounded = buildBoundedReadRangeTool(tools, withSixToolMeta);
  return {
    name: "read_range",
    description: 'Read pinned repository source at head or base. Use top-level startLine and endLine for a numbered range and source: {kind:"head"} or {kind:"base"} for the revision. Omit both bounds for a small complete file or a paged declaration map. Pass its cursor with the same path and source to continue the map.',
    normalizeArguments: normalizeSixReadRangeBounds,
    parameters: Type.Object({
      path: Type.String({ minLength: 1 }),
      source: SourceSelectorSchema,
      startLine: Type.Optional(Type.Integer({ minimum: 1 })),
      endLine: Type.Optional(Type.Integer({ minimum: 1 })),
      cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 }))
    }, { additionalProperties: false }),
    execute: (args, signal) => {
      const { path, source, startLine, endLine, cursor } = args as {
        path: string; source?: SourceSelector; startLine?: number; endLine?: number; cursor?: string;
      };
      if (cursor === undefined && (startLine !== undefined || endLine !== undefined)) return bounded.execute(args, signal);
      return wrapTool(signal, async () => {
        if (startLine !== undefined || endLine !== undefined) {
          throw new CodegenieError("invalid_args", "Use the declaration map cursor without line bounds.");
        }
        if (!tools.readSourceFileMap) throw new CodegenieError("config_error", "This repository cannot produce file maps.");
        const map = await runWithoutFacadeRecording(tools, () => tools.readSourceFileMap!(path, source, cursor));
        const fallback = renderSourceFileMap(map);
        const totalLines = map.meta.totalLines;
        if (map.smallSource === undefined || totalLines === undefined) return fallback;

        const lines = map.smallSource.split("\n").slice(0, totalLines);
        const revision = source?.kind ?? "head";
        const meta = {
          backend: "text" as const, precision: "exact" as const, degraded: false,
          requestedSource: revision, sourceUsed: revision, lookupStatus: "found" as const,
          deliveryStatus: totalLines ? "full" as const : "empty" as const,
          totalLines, requestedRange: { path: map.path, startLine: 1, endLine: Math.max(1, totalLines) },
          ...(totalLines ? { deliveredLineRange: [1, totalLines] as [number, number] } : {})
        };
        const sourceResult = createPackableToolResult({
          open: "", records: lines.map((line, index) => numberSourceLine(line, index + 1)),
          separator: "\n", close: map.smallSource.endsWith("\n") ? "\n" : ""
        }, meta);
        return sourceResult.text.length <= MAX_SMALL_SOURCE_CHARS
          ? { ...sourceResult,
            ...(meta.deliveredLineRange ? { sourceLineRange: meta.deliveredLineRange, rawSource: map.smallSource } : {}),
            budgetFallback: fallback }
          : fallback;
      });
    }
  };
}

function renderSourceFileMap(map: SourceFileMap): ToolExecutionResult {
  const { meta, path, declarations, totalDeclarations, offset, next } = map;
  if (meta.totalLines === undefined) return { text: withSixToolMeta("", meta), meta };
  const header = `${path}@${meta.sourceUsed} file map, ${meta.totalLines} lines`;
  if (!declarations.length) {
    const note = meta.lookupStatus === "unavailable" ? "Declaration parsing is unavailable." : "No declarations found.";
    return createPackableToolResult({
      open: `${header}\n`, records: [`${note} Use read_range with line bounds.`], separator: "\n", close: ""
    }, meta);
  }
  const records = declarations.map(({ symbol }, index) =>
    `${offset + index + 1}\t${symbol.nativeKind ?? symbol.kind} ${symbol.name}\tlines ${symbol.lineRange[0]}-${symbol.lineRange[1]}`);
  const labels = declarations.map(({ cursor }, index) => `declaration ${offset + index + 1}, cursor=${cursor}`);
  return createPackableToolResult({
    open: `${header}, ${totalDeclarations} declarations\n`, records, separator: "\n", close: "", labels,
    ...(next ? { nextPage: `declaration ${offset + declarations.length + 1}, cursor=${next}` } : {})
  }, meta);
}

export function buildSixSearchTool(tools: RepositoryTools): ToolDefinition {
  return {
    name: "search_files",
    description: 'Search pinned repository source. Use mode "regex" for POSIX ERE (default, e.g. "track\\(") or mode "literal" for source text (e.g. "track("). To search base, pass source: {"kind":"base"}. Continue with the returned cursor and the same query, mode, source, pathGlob and contextMode.',
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 500 }),
      mode: Type.Optional(Type.Union([Type.Literal("regex"), Type.Literal("literal")])),
      pathGlob: Type.Optional(Type.String({ minLength: 1 })),
      source: SourceSelectorSchema,
      contextMode: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("lines"), Type.Literal("symbols")])),
      cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 }))
    }, { additionalProperties: false }),
    execute: (args, signal) => wrapTool(signal, async () => {
      const { query, ...options } = args as SearchPageOptions & { query: string };
      if (!tools.searchFilesPage) throw new CodegenieError("config_error", "This repository cannot produce search pages.");
      const page = await runWithoutFacadeRecording(tools, () => tools.searchFilesPage!(query, { ...options, mode: options.mode ?? "regex" }));
      return renderSearchPage(page, options.source?.kind ?? "head");
    })
  };
}

function renderSearchPage(page: SearchPage, revision: SourceSelector["kind"]): ToolExecutionResult {
  const full = renderSearchRows(page, revision);
  if (page.meta.deliveryStatus === "empty") {
    const text = page.meta.searchDelivery?.emptyScope ? `No tracked files match pathGlob at ${revision}.`
      : `No matches in the selected ${revision} scope.`;
    return { ...full, budgetFallback: { ...full, text } };
  }
  const firstContext = page.rows.find(({ hit }) => hasSearchContext(hit));
  const delivery = page.meta.searchDelivery;
  if (!firstContext || !delivery) return full;
  // Optional context is shed before match locations when the complete page
  // exceeds its allowance. The cursor still belongs to the original query.
  const rows = page.rows.map(({ hit, ...row }) => {
    const { contextBefore: _before, contextAfter: _after, enclosingSymbol: _symbol, ...match } = hit;
    return { ...row, hit: match };
  });
  const position = searchContextPosition(firstContext.hit);
  const meta = searchDeliveryMeta(page.meta, { ...delivery, budgetContextStripped: true });
  const notice = `Context omitted to fit the result budget. Use read_range at ${JSON.stringify(position.path)}@${revision}:${position.line}.\n`;
  return { ...full, budgetFallback: renderSearchRows({ ...page, rows, meta }, revision, notice) };
}

function renderSearchRows(page: SearchPage, revision: SourceSelector["kind"], notice = ""): ToolExecutionResult {
  const total = page.rows.length + (page.meta.omittedCount ?? 0);
  const scope = page.pathGlob === undefined ? "all files" : JSON.stringify(page.pathGlob);
  const open = `Search at ${revision} (${page.revision}) in ${scope}: ${page.meta.omittedCountIsLowerBound ? "at least " : ""}${total} matches from this position\n${notice}`;
  const files = new Set<string>();
  const records = page.rows.map(({ hit, totalLines }) => {
    const header = files.has(hit.path) ? [] : [`${JSON.stringify(hit.path)}@${revision}: ${totalLines} lines`];
    files.add(hit.path);
    const before = hit.contextBefore ?? [];
    const after = hit.contextAfter ?? [];
    const excerpt = hit.excerpt ? ` (excerpt starts at byte column ${hit.excerptStartColumn})` : "";
    const enclosing = hit.enclosingSymbol;
    return [
      ...header,
      ...(enclosing ? [`Enclosing ${enclosing.name}, lines ${enclosing.lineRange.join("-")}`] : []),
      ...before.map((line, index) => numberSourceLine(line, hit.line - before.length + index)),
      `${hit.line}:${hit.column ?? 1}${excerpt}\t${hit.matchText}`,
      ...after.slice(0, totalLines - hit.line).map((line, index) => numberSourceLine(line, hit.line + index + 1))
    ].join("\n");
  });
  return { ...createPackableToolResult({
    open, records, separator: "\n", close: "",
    labels: page.rows.map(({ hit }) => `${JSON.stringify(hit.path)}@${revision}:${hit.line}`),
    cursors: page.rows.map(row => row.cursor),
    searchExcerptFlags: page.rows.map(row => row.hit.excerpt === true),
    ...(page.next ? { nextPage: `${JSON.stringify(page.next.path)}@${revision}:${page.next.line}, cursor=${page.next.cursor}` } : {})
  }, page.meta), searchResults: page.rows.map(row => row.hit) };
}

export function buildSixListFilesTool(tools: RepositoryTools): ToolDefinition {
  return {
    name: "list_files",
    description: "List committed paths in the pinned head tree matching a repository glob. Continue with the same glob and returned cursor. Use read_change for removed or renamed paths.",
    parameters: Type.Object({
      glob: Type.String({ minLength: 1 }),
      cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 }))
    }, { additionalProperties: false }),
    execute: (args, signal) => wrapTool(signal, async () => {
      const { glob, cursor } = args as { glob: string; cursor?: string };
      if (!tools.listFilesPage) throw new CodegenieError("config_error", "This repository cannot produce file listing pages.");
      const page = await runWithoutFacadeRecording(tools, () => tools.listFilesPage!(glob, cursor));
      return { ...createPackableToolResult({
        open: `Head tree ${page.tree}, glob ${JSON.stringify(page.glob)}: ${page.totalPaths} paths\n`,
        records: page.rows.map(row => JSON.stringify(row.path)), separator: "\n", close: "",
        labels: page.rows.map(row => JSON.stringify(row.path)),
        cursors: page.rows.map(row => row.cursor),
        ...(page.next ? { nextPage: `${JSON.stringify(page.next.path)}, cursor=${page.next.cursor}` } : {})
      }, page.meta), filePaths: page.rows.map(row => row.path) };
    })
  };
}
