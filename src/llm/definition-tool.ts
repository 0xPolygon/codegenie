import { Type } from "typebox";
import type { RepositoryTools, SymbolLookupSourceSelector } from "../types.js";
import { withRepositoryToolCallContext } from "../repo/repository-index.js";
import { CodegenieError, isCodegenieError } from "../util/errors.js";
import type { ToolDefinition } from "./llm-runner.js";
import { packDefinitionPage } from "./definition-result-packing.js";

export function buildReadDefinitionTool(tools: RepositoryTools): ToolDefinition {
  return {
    name: "read_definition",
    description: 'Read verified declarations by name, including Owner.method and Go receiver forms. An optional path is exact and never broadened. Use source {"kind":"auto"} to try head then base. A cursor continues declaration locations; use read_range for an omitted or cut body. Text-only leads are unverified.',
    parameters: Type.Object({ name: Type.String({ minLength: 1, maxLength: 200 }), path: Type.Optional(Type.String({ minLength: 1 })),
      source: Type.Optional(Type.Object({ kind: Type.Union([Type.Literal("head"), Type.Literal("base"), Type.Literal("auto")]) }, { additionalProperties: false })),
      cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })) }, { additionalProperties: false }),
    async execute(args, signal) {
      if (!tools.readDefinitionPage) throw new CodegenieError("invalid_args", "read_definition is unavailable for this repository adapter");
      if (signal.aborted) throw new CodegenieError("llm_call_failed", "repository tool aborted");
      try {
        const { name, ...options } = args as { name: string; path?: string; source?: SymbolLookupSourceSelector; cursor?: string };
        const operation = withRepositoryToolCallContext(tools, { stage: 7, initiator: "model", record: false }, () => tools.readDefinitionPage!(name, options));
        const page = await raceAbort(operation, signal);
        if (signal.aborted) throw new CodegenieError("llm_call_failed", "repository tool aborted");
        return { ...packDefinitionPage(page, Number.MAX_SAFE_INTEGER), definitionPage: page };
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
