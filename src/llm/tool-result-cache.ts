import type { ToolExecutionResult, ToolResultCache, ToolResultCacheLookup } from "./llm-runner.js";
import { buildModelCallCacheKey } from "./model-call-cache.js";

const TOOL_RESULT_CACHE_SCHEMA_VERSION = 1;
const DEFAULT_MAX_ENTRIES = 512;
const DEFAULT_MAX_STORED_RESULT_CHARS = 8_000_000;

const CACHEABLE_TOOL_NAMES = new Set([
  "read_range",
  "read_file_outline",
  "read_symbol",
  "find_definition",
  "read_diff_blocks",
  "search_files",
  "find_symbol_mentions",
  "find_likely_tests",
  "list_files"
]);

type CreateToolResultCacheOptions = {
  runFingerprint?: string;
  maxEntries?: number;
  maxStoredResultChars?: number;
};

type CacheEntry = {
  result: ToolExecutionResult;
  resultChars: number;
};

type InflightEntry = Promise<{ result: ToolExecutionResult; evictedEntries: number }>;

export function createToolResultCache(opts: CreateToolResultCacheOptions = {}): ToolResultCache {
  const maxEntries = Math.max(1, Math.floor(opts.maxEntries ?? DEFAULT_MAX_ENTRIES));
  const maxStoredResultChars = Math.max(1, Math.floor(opts.maxStoredResultChars ?? DEFAULT_MAX_STORED_RESULT_CHARS));
  const entries = new Map<string, CacheEntry>();
  const inflight = new Map<string, InflightEntry>();
  let storedResultChars = 0;

  const touch = (key: string, entry: CacheEntry): void => {
    entries.delete(key);
    entries.set(key, entry);
  };

  const evictIfNeeded = (): number => {
    let evicted = 0;
    while (entries.size > maxEntries || storedResultChars > maxStoredResultChars) {
      const oldest = entries.keys().next().value as string | undefined;
      if (oldest === undefined) {
        break;
      }
      const entry = entries.get(oldest);
      entries.delete(oldest);
      storedResultChars -= entry?.resultChars ?? 0;
      evicted += 1;
    }
    return evicted;
  };

  const write = (key: string, result: ToolExecutionResult): number => {
    const entry = { result: cloneToolResult(result), resultChars: result.text.length };
    const existing = entries.get(key);
    if (existing !== undefined) {
      storedResultChars -= existing.resultChars;
      entries.delete(key);
    }
    entries.set(key, entry);
    storedResultChars += entry.resultChars;
    return evictIfNeeded();
  };

  return {
    execute: async ({ toolName, args, signal, run }): Promise<ToolResultCacheLookup> => {
      throwIfAborted(signal);
      if (!CACHEABLE_TOOL_NAMES.has(toolName)) {
        return {
          result: await run(),
          status: "disabled",
          backendExecuted: true
        };
      }

      const key = buildToolResultCacheKey({
        toolName,
        args,
        ...(opts.runFingerprint !== undefined ? { runFingerprint: opts.runFingerprint } : {})
      });
      const cached = entries.get(key);
      if (cached !== undefined) {
        touch(key, cached);
        return {
          result: cloneToolResult(cached.result),
          status: "hit",
          backendExecuted: false,
          hitKind: "stored"
        };
      }

      const pending = inflight.get(key);
      if (pending !== undefined) {
        const shared = await waitForInflight(pending, signal);
        return {
          result: cloneToolResult(shared.result),
          status: "hit",
          backendExecuted: false,
          hitKind: "inflight"
        };
      }

      const execution = (async (): Promise<{ result: ToolExecutionResult; evictedEntries: number }> => {
        const result = await run();
        if (!isCacheableResult(result)) {
          return { result: cloneToolResult(result), evictedEntries: 0 };
        }
        return {
          result: cloneToolResult(result),
          evictedEntries: write(key, result)
        };
      })();
      inflight.set(key, execution);
      try {
        const completed = await execution;
        return {
          result: cloneToolResult(completed.result),
          status: isCacheableResult(completed.result) ? "write" : "miss",
          backendExecuted: true,
          evictedEntries: completed.evictedEntries
        };
      } finally {
        if (inflight.get(key) === execution) {
          inflight.delete(key);
        }
      }
    }
  };
}

async function waitForInflight(pending: InflightEntry, signal: AbortSignal | undefined): InflightEntry {
  throwIfAborted(signal);
  if (signal === undefined) {
    return pending;
  }
  return await new Promise((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw abortError();
  }
}

function abortError(): Error {
  const error = new Error("tool result cache wait aborted");
  error.name = "AbortError";
  return error;
}

export function buildToolResultCacheKey(input: {
  toolName: string;
  args: Record<string, unknown>;
  runFingerprint?: string;
}): string {
  return buildModelCallCacheKey({
    schemaVersion: TOOL_RESULT_CACHE_SCHEMA_VERSION,
    toolName: input.toolName,
    runFingerprint: input.runFingerprint ?? null,
    args: omitUndefinedDeep(input.args)
  });
}

function isCacheableResult(result: ToolExecutionResult): boolean {
  return result.isError !== true;
}

function cloneToolResult(result: ToolExecutionResult): ToolExecutionResult {
  const output: ToolExecutionResult = { text: result.text };
  if (result.isError !== undefined) {
    output.isError = result.isError;
  }
  if (result.errorCode !== undefined) {
    output.errorCode = result.errorCode;
  }
  if (result.meta !== undefined) {
    output.meta = JSON.parse(JSON.stringify(result.meta)) as NonNullable<ToolExecutionResult["meta"]>;
  }
  return output;
}

function omitUndefinedDeep(input: unknown): unknown {
  if (Array.isArray(input)) {
    return input.map(omitUndefinedDeep);
  }
  if (input && typeof input === "object") {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort()) {
      const value = omitUndefinedDeep((input as Record<string, unknown>)[key]);
      if (value !== undefined) {
        output[key] = value;
      }
    }
    return output;
  }
  return input;
}
