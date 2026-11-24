import { Type } from "typebox";
import type { RepositoryTools, SourceSelector } from "../types.js";
import { withRepositoryToolCallContext } from "../repo/repository-index.js";
import { CodegenieError, isCodegenieError } from "../util/errors.js";
import type { ToolDefinition, ToolExecutionResult } from "./llm-runner.js";
import { packUsagePage } from "./usage-result-packing.js";

/** Descriptor is installed only by the six-tool surface selector. */
export function buildFindUsagesTool(tools: RepositoryTools): ToolDefinition {
  return {
    name: "find_usages",
    description: 'Find lexical uses, including calls, constructions, references, imports and re-exports. Pass source as {"kind":"head"} (default) or {"kind":"base"}. Pass scope and pathGlob at the top level beside source. Results identify source positions, enclosing declarations and import spelling; bindings and dynamic dispatch remain unresolved. Search an enclosing declaration\'s searchName to follow its callers; a dotted name narrows a common method. Set scope to tests to search test files. A cursor resumes the first unread row; use the same name, source, scope and pathGlob. Text-only matches are labelled separately. A renamed re-export consumed in another file can be missed.',
    parameters: Type.Object({
      name: Type.String({ minLength: 1, maxLength: 500 }),
      source: Type.Optional(Type.Object({ kind: Type.Union([Type.Literal("head"), Type.Literal("base")]) }, { additionalProperties: false })),
      scope: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("tests")])),
      pathGlob: Type.Optional(Type.String({ minLength: 1 })),
      cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 }))
    }, { additionalProperties: false }),
    async execute(args, signal): Promise<ToolExecutionResult> {
      if (!tools.findUsages) throw new CodegenieError("invalid_args", "find_usages is unavailable for this repository adapter");
      const input = args as { name: string; source?: SourceSelector; scope?: "all" | "tests"; pathGlob?: string; cursor?: string };
      if (signal.aborted) throw new CodegenieError("llm_call_failed", "repository tool aborted");
      try {
        const { name, ...options } = input;
        const run = withRepositoryToolCallContext(tools, { stage: 7, initiator: "model", record: false },
          () => tools.findUsages!(name, { ...options, signal }));
        const result = await raceAbort(run, signal);
        const canonical = packUsagePage(result.page, name, Number.MAX_SAFE_INTEGER);
        return { text: canonical.text, usagePage: { name, page: result.page },
          meta: canonical.isError ? { ...result.meta, deliveryStatus: "budget_rejected", degradationReason: "usage_scan_limit" } : result.meta,
          ...(canonical.isError ? { isError: true, errorCode: "budget_exhausted" as const } : {}) };
      } catch (error) {
        if (isCodegenieError(error) && error.code === "llm_call_failed") throw error;
        if (isCodegenieError(error)) return { text: `tool error: ${error.code}: ${error.message}`, isError: true,
          errorCode: error.code, meta: { backend: "text", precision: "text", degraded: true, degradationReason: error.code } };
        throw error;
      }
    }
  };
}

async function raceAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort: (() => void) | undefined;
  try {
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new CodegenieError("llm_call_failed", "repository tool aborted"));
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    return await Promise.race([operation, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}
