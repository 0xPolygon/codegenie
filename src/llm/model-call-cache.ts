import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { sha256Hex } from "../util/hashing.js";
import { CodegenieError } from "../util/errors.js";
import { provisionCodegenieGitignore } from "../telemetry/run-artifacts.js";
import { stripCredentials } from "../telemetry/redaction.js";
import type { Logger, ReviewStage } from "../types.js";
import type { TelemetryRecorder } from "../telemetry/telemetry-recorder.js";
import type { ModelCallCache, PiAssistantMessage, StoredProviderResponse } from "./llm-runner.js";

export const MODEL_CALL_CACHE_SCHEMA_VERSION = 1;

type CreateModelCallCacheOptions = {
  dir: string;
  repoRoot: string;
  runFingerprint: string;
  logger: Logger;
  telemetry: TelemetryRecorder;
};

type CacheFileInfo = {
  path: string;
  size: number;
  mtimeMs: number;
};

type EvictionResult = {
  deletedCount: number;
  deletedBytes: number;
};

const MAX_CACHE_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_CACHE_BYTES = 500 * 1024 * 1024;

export async function createModelCallCache(opts: CreateModelCallCacheOptions): Promise<ModelCallCache> {
  const dir = path.resolve(opts.repoRoot, opts.dir);
  refuseTrackedCacheDirectory(opts.repoRoot, dir);
  if (path.relative(path.resolve(opts.repoRoot, ".codegenie"), dir).split(path.sep)[0] !== "..") {
    provisionCodegenieGitignore(opts.repoRoot);
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const eviction = evictCacheEntries(dir);
  opts.telemetry.event({
    stage: 0,
    level: "debug",
    message: "model_call_cache_evicted",
    data: {
      dir,
      deletedCount: eviction.deletedCount,
      deletedBytes: eviction.deletedBytes,
      maxAgeDays: 14,
      maxBytes: MAX_CACHE_BYTES
    }
  });

  return {
    runFingerprint: opts.runFingerprint,
    get: async (key, stage) => {
      const filePath = cacheEntryPath(dir, key);
      if (!existsSync(filePath)) {
        opts.telemetry.event({ stage: stage ?? 0, level: "debug", message: "model_call_cache_miss", cacheStatus: "miss" });
        return { status: "miss", reason: "not_found" };
      }
      try {
        const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
        if (!isRecord(parsed) || parsed.cacheSchemaVersion !== MODEL_CALL_CACHE_SCHEMA_VERSION) {
          unlinkBestEffort(filePath);
          opts.telemetry.event({
            stage: stageForTelemetry(stage, parsed),
            level: "debug",
            message: "model_call_cache_schema_miss",
            cacheStatus: "miss"
          });
          return { status: "miss", reason: "schema_mismatch" };
        }
        if (!isStoredProviderResponse(parsed)) {
          unlinkBestEffort(filePath);
          opts.telemetry.event({
            stage: stageForTelemetry(stage, parsed),
            level: "debug",
            message: "model_call_cache_invalid_miss",
            cacheStatus: "miss"
          });
          return { status: "miss", reason: "invalid_entry" };
        }
        opts.telemetry.event({ stage: parsed.stage, level: "debug", message: "model_call_cache_hit", cacheStatus: "hit" });
        return { status: "hit", response: parsed };
      } catch {
        unlinkBestEffort(filePath);
        opts.telemetry.event({ stage: stage ?? 0, level: "debug", message: "model_call_cache_unreadable", cacheStatus: "miss" });
        return { status: "miss", reason: "unreadable" };
      }
    },
    put: async (key, entry) => {
      const filePath = cacheEntryPath(dir, key);
      const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
      try {
        mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
        writeFileSync(tmpPath, `${JSON.stringify(stripCredentials(entry), null, 2)}\n`, { mode: 0o600 });
        renameSync(tmpPath, filePath);
        opts.telemetry.event({ stage: entry.stage, level: "debug", message: "model_call_cache_write", cacheStatus: "write" });
        return { status: "write" };
      } catch (cause) {
        unlinkBestEffort(tmpPath);
        const error = cause instanceof Error ? stripCredentials(cause.message) : stripCredentials(String(cause));
        opts.logger.warn({
          runId: opts.telemetry.runId,
          stage: entry.stage,
          event: "model_call_cache_write_failed",
          message: "failed to write model-call cache entry",
          data: { error }
        });
        opts.telemetry.event({
          stage: entry.stage,
          level: "warn",
          message: "model_call_cache_write_failed",
          cacheStatus: "miss",
          data: { error }
        });
        return { status: "miss", reason: "write_failed" };
      }
    }
  };
}

export function buildModelCallCacheKey(input: Record<string, unknown>): string {
  return sha256Hex(stableJson(input));
}

export function modelCallCacheEntryPath(dir: string, key: string): string {
  return cacheEntryPath(dir, key);
}

function cacheEntryPath(dir: string, key: string): string {
  return path.join(dir, `v${MODEL_CALL_CACHE_SCHEMA_VERSION}`, key.slice(0, 3), `${key}.json`);
}

function refuseTrackedCacheDirectory(repoRoot: string, dir: string): void {
  const relative = path.relative(repoRoot, dir);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return;
  }
  if (relative === "") {
    throw new CodegenieError("config_error", "model-call cache directory cannot be the repository root", {
      context: { dir }
    });
  }

  const result = spawnSync("git", ["-C", repoRoot, "ls-files", "--", relative], {
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new CodegenieError("config_error", "failed to inspect model-call cache directory tracking status", {
      context: { dir, status: result.status, stderr: result.stderr.trim() }
    });
  }
  if (result.status === 0 && result.stdout.trim().length > 0) {
    throw new CodegenieError("config_error", "model-call cache directory contains git-tracked files", {
      context: { dir, tracked: result.stdout.trim().split(/\r?\n/).slice(0, 5) }
    });
  }
}

function evictCacheEntries(dir: string): EvictionResult {
  const result: EvictionResult = { deletedCount: 0, deletedBytes: 0 };
  const now = Date.now();
  for (const file of listCacheFiles(dir)) {
    if (now - file.mtimeMs > MAX_CACHE_AGE_MS) {
      if (unlinkBestEffort(file.path)) {
        result.deletedCount += 1;
        result.deletedBytes += file.size;
      }
    }
  }

  const files = listCacheFiles(dir).sort((a, b) => a.mtimeMs - b.mtimeMs);
  let totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  for (const file of files) {
    if (totalBytes <= MAX_CACHE_BYTES) {
      break;
    }
    if (unlinkBestEffort(file.path)) {
      result.deletedCount += 1;
      result.deletedBytes += file.size;
    }
    totalBytes -= file.size;
  }
  return result;
}

function listCacheFiles(dir: string): CacheFileInfo[] {
  const files: CacheFileInfo[] = [];
  const visit = (current: string): void => {
    if (!existsSync(current)) {
      return;
    }
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
      } else if (entry.isFile() && entry.name.endsWith(".json")) {
        const stat = statSync(entryPath);
        files.push({ path: entryPath, size: stat.size, mtimeMs: stat.mtimeMs });
      }
    }
  };
  visit(dir);
  return files;
}

function unlinkBestEffort(filePath: string): boolean {
  try {
    rmSync(filePath, { force: true });
    return true;
  } catch {
    // Best-effort cleanup only.
    return false;
  }
}

function isStoredProviderResponse(input: unknown): input is StoredProviderResponse {
  if (!isRecord(input)) {
    return false;
  }
  return (
    input.cacheSchemaVersion === MODEL_CALL_CACHE_SCHEMA_VERSION &&
    typeof input.createdAt === "string" &&
    isReviewStage(input.stage) &&
    isPiAssistantMessage(input.message) &&
    typeof input.finishReason === "string" &&
    isUsage(input.usage)
  );
}

function isPiAssistantMessage(input: unknown): input is PiAssistantMessage {
  return (
    isRecord(input) &&
    input.role === "assistant" &&
    Array.isArray(input.content) &&
    input.content.every(isMessageContentBlock) &&
    typeof input.provider === "string" &&
    typeof input.model === "string" &&
    isMessageUsage(input.usage) &&
    isOptionalString(input.stopReason) &&
    isOptionalNumber(input.timestamp)
  );
}

function isMessageContentBlock(input: unknown): input is PiAssistantMessage["content"][number] {
  if (!isRecord(input)) {
    return false;
  }
  if (input.type === "text") {
    return typeof input.text === "string";
  }
  if (input.type === "toolCall") {
    return typeof input.id === "string" && typeof input.name === "string" && isRecord(input.arguments);
  }
  // Pi may preserve provider-specific assistant blocks such as Anthropic
  // `thinking`. They are safe to cache as opaque JSON as long as they are
  // typed records; callers that understand them can pass them back unchanged.
  return typeof input.type === "string";
}

function isMessageUsage(input: unknown): input is PiAssistantMessage["usage"] {
  return (
    input === undefined ||
    (
      isRecord(input) &&
      isOptionalNumber(input.input) &&
      isOptionalNumber(input.output) &&
      isOptionalNumber(input.cacheRead) &&
      isOptionalNumber(input.cacheWrite) &&
      isOptionalNumber(input.totalTokens) &&
      isMessageCost(input.cost)
    )
  );
}

function isMessageCost(input: unknown): input is NonNullable<NonNullable<PiAssistantMessage["usage"]>["cost"]> {
  return input === undefined || (
    isRecord(input) &&
    isOptionalNumber(input.input) &&
    isOptionalNumber(input.output) &&
    isOptionalNumber(input.cacheRead) &&
    isOptionalNumber(input.cacheWrite) &&
    isOptionalNumber(input.total)
  );
}

function isUsage(input: unknown): input is StoredProviderResponse["usage"] {
  return (
    isRecord(input) &&
    isOptionalNumber(input.inputTokens) &&
    isOptionalNumber(input.uncachedInputTokens) &&
    isOptionalNumber(input.cacheReadTokens) &&
    isOptionalNumber(input.cacheWriteTokens) &&
    isOptionalNumber(input.billableInputTokens) &&
    isOptionalNumber(input.outputTokens) &&
    isOptionalNumber(input.totalTokens) &&
    isOptionalNumber(input.costUSD) &&
    isOptionalNumber(input.inputCostUSD) &&
    isOptionalNumber(input.outputCostUSD) &&
    isOptionalNumber(input.cacheReadCostUSD) &&
    isOptionalNumber(input.cacheWriteCostUSD)
  );
}

function isOptionalNumber(input: unknown): boolean {
  return input === undefined || typeof input === "number";
}

function isOptionalString(input: unknown): boolean {
  return input === undefined || typeof input === "string";
}

function stageForTelemetry(requestStage: ReviewStage | undefined, parsed: unknown): ReviewStage | 0 {
  if (requestStage !== undefined) {
    return requestStage;
  }
  return isRecord(parsed) && isReviewStage(parsed.stage) ? parsed.stage : 0;
}

function isReviewStage(input: unknown): input is ReviewStage {
  return typeof input === "number" && Number.isInteger(input) && input >= 1 && input <= 11;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return Boolean(input && typeof input === "object" && !Array.isArray(input));
}

function stableJson(input: unknown): string {
  return JSON.stringify(sortJson(input));
}

function sortJson(input: unknown): unknown {
  if (Array.isArray(input)) {
    return input.map(sortJson);
  }
  if (input && typeof input === "object") {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort()) {
      output[key] = sortJson((input as Record<string, unknown>)[key]);
    }
    return output;
  }
  return input;
}
