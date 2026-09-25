import { MISSING_FILE_GUIDANCE } from "./repository-tool-guidance.js";
import { submissionIssues } from "./submit-preservation.js";
import { Type } from "@earendil-works/pi-ai";
import type { RepositoryTools, SourceSelector, SymbolLookupSourceSelector, ToolResultMeta } from "../types.js";
import { CodegenieError, isCodegenieError } from "../util/errors.js";
import type { ToolDefinition, ToolExecutionResult } from "./llm-runner.js";
import { withRepositoryToolCallContext } from "../repo/repository-index.js";

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

export type RepositoryToolDefinitionOptions = {
  includeLikelyTests?: boolean;
};

/** Reject invalid raw arguments before SDK coercion can change a requested range. */
export function assertRepositoryToolArguments(tool: Pick<ToolDefinition, "name" | "parameters">, args: unknown): void {
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
  const definitions: ToolDefinition[] = [
    {
      name: "read_range",
      description: "Read committed text at head (default) or base; works for any text format without syntax support. Both startLine and endLine are required inclusive 1-based integers, with startLine <= endLine. Prefer a small window around a diff or search hit. Returns at most 400 lines / 16,000 characters before local budget limits, with truncation metadata. An end beyond EOF is clipped; a start beyond EOF returns empty text, never the last line. Missing files have lookup=file_missing. " + PATH_DISCOVERY_GUIDANCE,
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
        const result = await runWithoutFacadeRecording(tools, () => tools.readRange(input.path, input.startLine, input.endLine, input.source));
        return { text: withMeta(result.text, result.meta), meta: result.meta,
          ...(result.meta.deliveryStatus === "full" && result.text.length > 0
            ? { sourceLineRange: [input.startLine, Math.min(input.endLine, input.startLine + result.text.split("\n").length - 1)] as [number, number] } : {}) };
      })
    },
    {
      name: "read_file_outline",
      description: "Read a compact outline of imports, top-level symbols, and test symbols. Without syntax support, symbolExtraction is unavailable: empty symbol arrays do not mean no definitions. Small files can include complete sourceText when it fits; larger or locally bounded outlines provide a read_range hint. For known source locations, prefer read_range directly. " + PATH_DISCOVERY_GUIDANCE,
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
        return { text: withMeta(JSON.stringify(result.outline, null, 2), result.meta), outline: result.outline, meta: result.meta };
      })
    },
    {
      name: "read_symbol",
      description: "Requires path; discover an unknown path with find_definition first. Read a symbol by exact symbolName or by the smallest enclosing symbol at line; provide exactly one selector. Without syntax support, returns a text window around a matching name/line, not a verified symbol body; prefer read_range for known locations. Use source {kind:\"auto\"} for renamed or deleted symbols so head is searched first, then base. " + PATH_DISCOVERY_GUIDANCE,
      parameters: Type.Object(
        {
          path: Type.String({ minLength: 1 }),
          symbolName: Type.Optional(Type.String({ minLength: 1 })),
          line: Type.Optional(Type.Integer({ minimum: 1 })),
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
        return { text: withMeta(JSON.stringify(result.definitions, null, 2), result.meta), definitions: result.definitions, meta: result.meta };
      })
    },
    {
      name: "read_diff_blocks",
      description: "Read rendered diff hunks by packetId or path; provide exactly one selector.",
      parameters: Type.Object(
        {
          packetId: Type.Optional(Type.String({ minLength: 1 })),
          path: Type.Optional(Type.String({ minLength: 1 }))
        },
        { additionalProperties: false }
      ),
      execute: (args, signal) => wrapTool(signal, async () => {
        const input = args as { packetId?: string; path?: string };
        if ((input.packetId === undefined) === (input.path === undefined)) {
          throw new CodegenieError("invalid_args", "read_diff_blocks requires exactly one of packetId or path");
        }
        const result = await runWithoutFacadeRecording(tools, () => tools.readDiffBlocks(input));
        return { text: withMeta(result.blocks.join("\n\n"), result.meta), meta: result.meta };
      })
    },
    {
      name: "search_files",
      description: "Search committed text at head (default) or base with case-sensitive POSIX ERE: name|other, [0-9], [[:space:]]; no lookarounds or Perl digit classes. Set caseSensitive=false to ignore case. pathGlob uses list_files glob semantics, including {api,data}/** alternatives. Results include 1-based line/column locations for read_range. contextMode defaults to none; lines adds up to two neighboring lines; symbols adds an enclosing symbol when available. Works without syntax support. Defaults to 50 matches, at most 200, also bounded by output budgets. Invalid syntax is an error; empty or truncated results do not prove repository-wide absence.",
      parameters: Type.Object(
        {
          query: Type.String({ minLength: 1, maxLength: 500 }),
          pathGlob: Type.Optional(Type.String({ minLength: 1 })),
          contextMode: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("lines"), Type.Literal("symbols")])),
          maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
          caseSensitive: Type.Optional(Type.Boolean()),
          source: SourceSelectorSchema
        },
        { additionalProperties: false }
      ),
      execute: (args, signal) => wrapTool(signal, async () => {
        const input = args as Parameters<RepositoryTools["searchFiles"]>[1] & { query: string };
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
        return { text: withMeta(JSON.stringify(result.results), result.meta), searchResults: result.results, meta: result.meta };
      })
    },
    {
      name: "find_likely_tests",
      description: "Find likely tests for a path or symbol using deterministic test conventions.",
      parameters: Type.Object(
        {
          path: Type.Optional(Type.String({ minLength: 1 })),
          symbol: Type.Optional(
            Type.Object(
              {
                path: Type.String({ minLength: 1 }),
                name: Type.String({ minLength: 1 }),
                kind: Type.String({ minLength: 1 }),
                lineRange: Type.Tuple([Type.Integer({ minimum: 1 }), Type.Integer({ minimum: 1 })])
              },
              { additionalProperties: true }
            )
          ),
          source: SourceSelectorSchema
        },
        { additionalProperties: false }
      ),
      execute: (args, signal) => wrapTool(signal, async () => {
        const input = args as Parameters<RepositoryTools["findLikelyTests"]>[0];
        const result = await runWithoutFacadeRecording(tools, () => tools.findLikelyTests(input));
        return { text: withMeta(JSON.stringify(result.tests, null, 2), result.meta), meta: result.meta };
      })
    },
    {
      name: "list_files",
      description: "List tracked files at the head revision using a repo-relative glob: ** crosses directories; * and ? match within a segment; [ab] character classes and {api,data}/** alternatives are supported, including dotfiles. Use **/*.txt to include nested files. This is a glob, not a regular expression or gitignore file; use braces for path alternatives. Untracked files are excluded. Bounded results disclose omissions; narrow the glob when truncated.",
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
        meta: { backend: "text", precision: "text", degraded: true, degradationReason: error.code }
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

function withMeta(text: string, meta: ToolResultMeta): string {
  const notes: string[] = [];
  if (meta.requestedSource !== undefined || meta.sourceUsed !== undefined) {
    notes.push(`source: requested ${meta.requestedSource ?? "unspecified"}, used ${meta.sourceUsed ?? "unknown"}`);
  }
  if (meta.sourceFallback) {
    notes.push("source fallback: head to base");
  }
  if (meta.baseOnly) {
    notes.push("symbol exists only in base");
  }
  if (meta.lookupStatus !== undefined) {
    notes.push(`lookup: ${meta.lookupStatus}`);
  }
  if (meta.lookupStatus === "file_missing") {
    notes.push(MISSING_FILE_GUIDANCE);
  }
  if (meta.deliveryStatus !== undefined) {
    notes.push(`delivery: ${meta.deliveryStatus}`);
  }
  if (meta.recovery !== undefined) {
    notes.push(
      `recovery: call ${meta.recovery.tool} path=${meta.recovery.path} startLine=${String(meta.recovery.startLine)} endLine=${String(meta.recovery.endLine)} source=${meta.recovery.source}`
    );
  }
  if (meta.degraded) {
    notes.push(`degraded${meta.degradationReason ? `: ${meta.degradationReason}` : ""}`);
  }
  if (meta.truncated) {
    notes.push(`truncated${meta.omittedCount ? `: ${meta.omittedCountIsLowerBound ? "at least " : ""}${meta.omittedCount} omitted` : ""}`);
  }
  return notes.length > 0 ? `${text}\n\n[tool meta: ${notes.join("; ")}]` : text;
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
