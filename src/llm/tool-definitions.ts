import { Type } from "@earendil-works/pi-ai";
import type { RepositoryTools, SourceSelector, SymbolLookupSourceSelector, ToolResultMeta } from "../types.js";
import { CodeninjaError, isCodeninjaError } from "../util/errors.js";
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

export function buildRepositoryToolDefinitions(tools: RepositoryTools): ToolDefinition[] {
  return [
    {
      name: "read_range",
      description: "Read an inclusive 1-based line range from a file at the head or base revision.",
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
        return { text: withMeta(result.text, result.meta), meta: result.meta };
      })
    },
    {
      name: "read_file_outline",
      description: "Read a compact outline of imports, top-level symbols, and test symbols for a file.",
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
        return { text: withMeta(JSON.stringify(result.outline, null, 2), result.meta), meta: result.meta };
      })
    },
    {
      name: "read_symbol",
      description: "Read a symbol by exact symbolName or by the smallest enclosing symbol at line; provide exactly one selector. Use source {kind:\"auto\"} for renamed or deleted symbols so head is searched first, then base.",
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
          throw new CodeninjaError("invalid_args", "read_symbol requires exactly one of symbolName or line");
        }
        const selector: { symbolName?: string; line?: number } = {};
        if (input.symbolName !== undefined) {
          selector.symbolName = input.symbolName;
        }
        if (input.line !== undefined) {
          selector.line = input.line;
        }
        const result = await runWithoutFacadeRecording(tools, () => tools.readSymbol(input.path, selector, input.source));
        return {
          text: withMeta(JSON.stringify({ symbol: result.symbol, text: result.text ?? "" }, null, 2), result.meta),
          meta: result.meta
        };
      })
    },
    {
      name: "find_definition",
      description: "Find definition candidates for an exact symbol name, optionally constrained by pathGlob and source. Use source {kind:\"auto\"} for renamed or deleted symbols so head is searched first, then base.",
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
        return { text: withMeta(JSON.stringify(result.definitions, null, 2), result.meta), meta: result.meta };
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
          throw new CodeninjaError("invalid_args", "read_diff_blocks requires exactly one of packetId or path");
        }
        const result = await runWithoutFacadeRecording(tools, () => tools.readDiffBlocks(input));
        return { text: withMeta(result.blocks.join("\n\n"), result.meta), meta: result.meta };
      })
    },
    {
      name: "search_files",
      description: "Search file contents with a POSIX ERE query at the head or base revision.",
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
        return { text: withMeta(JSON.stringify(result.results, null, 2), result.meta), meta: result.meta };
      })
    },
    {
      name: "find_symbol_mentions",
      description: "Find text/token mentions of an identifier, optionally constrained by pathGlob and source.",
      parameters: Type.Object(
        {
          symbolName: Type.String({ minLength: 1, maxLength: 200 }),
          pathGlob: Type.Optional(Type.String({ minLength: 1 })),
          source: SourceSelectorSchema
        },
        { additionalProperties: false }
      ),
      execute: (args, signal) => wrapTool(signal, async () => {
        const input = args as { symbolName: string; pathGlob?: string; source?: SourceSelector };
        const result = await runWithoutFacadeRecording(tools, () => tools.findSymbolMentions(input.symbolName, optionalOptions({ pathGlob: input.pathGlob, source: input.source })));
        return { text: withMeta(JSON.stringify(result.results, null, 2), result.meta), meta: result.meta };
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
      description: "List repository files at head matching a gitignore-style glob.",
      parameters: Type.Object(
        {
          glob: Type.String({ minLength: 1 })
        },
        { additionalProperties: false }
      ),
      execute: (args, signal) => wrapTool(signal, async () => {
        const input = args as { glob: string };
        const result = await runWithoutFacadeRecording(tools, () => tools.listFiles(input.glob));
        return { text: withMeta(result.paths.join("\n"), result.meta), meta: result.meta };
      })
    }
  ];
}

async function wrapTool(signal: AbortSignal, run: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult> {
  try {
    throwIfAborted(signal);
    return await Promise.race([run(), abortPromise(signal)]);
  } catch (error) {
    if (isCancellationError(error)) {
      throw error;
    }
    if (isCodeninjaError(error)) {
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

function abortError(signal: AbortSignal): CodeninjaError {
  const reason = signal.reason;
  const timedOut = reason instanceof Error && reason.message.toLowerCase().includes("timeout");
  return new CodeninjaError("llm_call_failed", timedOut ? "repository tool timed out" : "repository tool aborted", {
    recoverable: true,
    context: { reason: timedOut ? "timeout" : "aborted" },
    cause: reason
  });
}

function isCancellationError(error: unknown): boolean {
  return isCodeninjaError(error) && error.code === "llm_call_failed";
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
  if (meta.degraded) {
    notes.push(`degraded${meta.degradationReason ? `: ${meta.degradationReason}` : ""}`);
  }
  if (meta.truncated) {
    notes.push(`truncated${meta.omittedCount ? `: ${meta.omittedCount} omitted` : ""}`);
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
