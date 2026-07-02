import { cp, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  CandidateFinding,
  EvalArtifacts,
  EvalHintEvent,
  EvalRunInfo,
  EvalSelectionRecord,
  EvalVerificationRecord,
  FinalFinding,
  BudgetSummary,
  ReviewPacket,
  ReviewPlan,
  RunCoverageStatus
} from "../types.js";
import { CodegenieError } from "../util/errors.js";
import { canonicalArtifactPath } from "../telemetry/run-artifacts.js";

export async function allocateRunDir(logsDir: string): Promise<{ runNumber: number; dir: string }> {
  await mkdir(logsDir, { recursive: true });
  let next = await nextRunNumber(logsDir);
  for (;;) {
    const dir = path.join(logsDir, String(next));
    try {
      await mkdir(dir);
      return { runNumber: next, dir };
    } catch (error) {
      if (!isNodeErrorCode(error, "EEXIST")) {
        throw error;
      }
      next += 1;
    }
  }
}

export async function loadEvalArtifacts(telemetryDir: string): Promise<EvalArtifacts> {
  const dir = path.resolve(telemetryDir);
  // Scoring must never crash on a missing or unreadable artifact — a failed
  // review already lost its findings; losing the scorer's record of the run
  // compounds the damage (plan 89 A1, run 0c4d5213/24). Unreadable artifacts
  // degrade to empty defaults and are disclosed via missingArtifacts.
  const missingArtifacts: string[] = [];
  const candidates = await readScoredJson<CandidateFinding[]>(dir, "candidate-findings.json", missingArtifacts);
  const finalFindings = await readScoredJson<FinalFinding[]>(dir, "final-findings.json", missingArtifacts);
  const selectionRaw = await readOptionalArtifact<unknown>(dir, "final-selection.json");
  const coverageRaw = await readOptionalArtifact<unknown>(dir, "coverage.json");
  const reviewPlan = await readOptionalArtifact<ReviewPlan>(dir, "review-plan.json");
  const coverage = normalizeCoverage(coverageRaw);
  const metricsSources: EvalArtifacts["metricsSources"] = {};
  const costProfile = await readOptionalArtifact<unknown>(dir, "cost-profile.json");
  const modelCallsSummary = await readOptionalArtifact<unknown>(dir, "model-calls-summary.json");
  const toolCallsSummary = await readOptionalArtifact<unknown>(dir, "tool-calls-summary.json");
  const budgetSummary = await readOptionalArtifact<BudgetSummary>(dir, "budget-summary.json");
  const runJson = await readOptionalJson<unknown>(dir, "run.json");
  const telemetry = await readOptionalJson<unknown>(dir, "telemetry.json");
  const modelCalls = await readOptionalJsonl(path.join(dir, "model-calls.jsonl"));
  const toolCalls = await readOptionalJsonl(path.join(dir, "tool-calls.jsonl"));
  if (costProfile !== undefined) {
    metricsSources.costProfile = costProfile;
  }
  if (modelCallsSummary !== undefined) {
    metricsSources.modelCallsSummary = modelCallsSummary;
  }
  if (toolCallsSummary !== undefined) {
    metricsSources.toolCallsSummary = toolCallsSummary;
  }
  if (budgetSummary !== undefined) {
    metricsSources.budgetSummary = budgetSummary;
  }
  if (runJson !== undefined) {
    metricsSources.runJson = runJson;
  }
  if (telemetry !== undefined) {
    metricsSources.telemetry = telemetry;
  }
  if (modelCalls !== undefined) {
    metricsSources.modelCalls = modelCalls;
  }
  if (toolCalls !== undefined) {
    metricsSources.toolCalls = toolCalls;
  }
  const artifacts: EvalArtifacts = {
    candidates: Array.isArray(candidates) ? candidates : [],
    verification: normalizeVerification(await readOptionalArtifact<unknown>(dir, "verification.json")),
    finalSelection: normalizeSelection(selectionRaw),
    finalFindings: Array.isArray(finalFindings) ? finalFindings : [],
    missingArtifacts,
    packets: await loadPackets(path.join(dir, "stages", "06-packets", "packets")),
    hintEvents: await loadHintEvents(path.join(dir, "events.jsonl")),
    metricsSources
  };
  if (reviewPlan !== undefined) {
    artifacts.reviewPlan = reviewPlan;
  }
  if (coverage !== undefined) {
    artifacts.coverage = coverage;
  }
  return artifacts;
}

export async function findPreviousRun(
  logsDir: string,
  caseName: string,
  before: number
): Promise<{ runNumber: number; dir: string } | undefined> {
  let entries: string[];
  try {
    entries = await readdir(logsDir);
  } catch {
    return undefined;
  }
  const runNumbers = entries
    .map((entry) => Number(entry))
    .filter((entry) => Number.isInteger(entry) && entry > 0 && entry < before)
    .sort((a, b) => b - a);

  for (const runNumber of runNumbers) {
    const dir = path.join(logsDir, String(runNumber));
    const info = await readOptionalJson<EvalRunInfo>(dir, "info.json");
    if (info?.caseName === caseName) {
      return { runNumber, dir };
    }
  }
  return undefined;
}

export async function writeEvalRunInfo(dir: string, info: EvalRunInfo): Promise<void> {
  const target = path.join(dir, "info.json");
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(info, null, 2)}\n`);
  await rename(tmp, target);
}

export function resolveTelemetryDir(runOrTelemetryDir: string): string {
  const resolved = path.resolve(runOrTelemetryDir);
  if (path.basename(resolved) === "telemetry") {
    return resolved;
  }
  return path.join(resolved, "telemetry");
}

export async function copyTelemetryArtifacts(sourceRunOrTelemetryDir: string, destinationRunDir: string): Promise<string> {
  const sourceTelemetry = resolveTelemetryDir(sourceRunOrTelemetryDir);
  await assertDirectory(sourceTelemetry, `artifact telemetry directory does not exist: ${sourceTelemetry}`);
  const destinationTelemetry = path.join(destinationRunDir, "telemetry");
  await cp(sourceTelemetry, destinationTelemetry, { recursive: true });
  return destinationTelemetry;
}

export async function copyReviewOutput(sourceRunOrTelemetryDir: string, destinationRunDir: string): Promise<void> {
  const sourceRunDir = path.basename(path.resolve(sourceRunOrTelemetryDir)) === "telemetry"
    ? path.dirname(path.resolve(sourceRunOrTelemetryDir))
    : path.resolve(sourceRunOrTelemetryDir);
  try {
    await cp(path.join(sourceRunDir, "codegenie-review.out.md"), path.join(destinationRunDir, "codegenie-review.out.md"));
    return;
  } catch {
    // Older or raw telemetry artifact sets may only have final-review.md.
  }
  try {
    await cp(path.join(resolveTelemetryDir(sourceRunOrTelemetryDir), "final-review.md"), path.join(destinationRunDir, "codegenie-review.out.md"));
  } catch {
    // Review output is helpful but not required for deterministic re-scoring.
  }
}

async function nextRunNumber(logsDir: string): Promise<number> {
  const entries = await readdir(logsDir);
  const existing = entries
    .map((entry) => Number(entry))
    .filter((entry) => Number.isInteger(entry) && entry > 0);
  return existing.length === 0 ? 1 : Math.max(...existing) + 1;
}

// Optional artifact read with the same pre-layout-v2 root fallback as
// readScoredJson (plan 83): old runs stay loadable for replay and compare.
async function readOptionalArtifact<T>(dir: string, logicalName: string): Promise<T | undefined> {
  const relPath = canonicalArtifactPath(logicalName);
  const primary = await readOptionalJson<T>(dir, relPath);
  if (primary !== undefined || relPath === logicalName) {
    return primary;
  }
  return readOptionalJson<T>(dir, logicalName);
}

// Tolerant read for scoring inputs: resolution failures, missing files, and
// unparseable JSON all degrade to undefined and are recorded by logical name,
// so a broken review run still produces a scored (and disclosed) data point.
// Pre-layout-v2 runs stored artifacts at the telemetry root, so the bare
// logical name is tried as a fallback (plan 83): old runs stay comparable.
async function readScoredJson<T>(dir: string, logicalName: string, missing: string[]): Promise<T | undefined> {
  let relPath: string;
  try {
    relPath = canonicalArtifactPath(logicalName);
  } catch {
    missing.push(`${logicalName} (unknown artifact path)`);
    return undefined;
  }
  const candidates = relPath === logicalName ? [relPath] : [relPath, logicalName];
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return JSON.parse(await readFile(path.join(dir, candidate), "utf8")) as T;
    } catch (error) {
      lastError = error;
      if (!isNodeErrorCode(error, "ENOENT")) {
        break;
      }
    }
  }
  missing.push(isNodeErrorCode(lastError, "ENOENT") ? logicalName : `${logicalName} (unreadable)`);
  return undefined;
}

async function readOptionalJson<T>(dir: string, fileName: string): Promise<T | undefined> {
  const filePath = path.join(dir, fileName);
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) {
      return undefined;
    }
    throw new CodegenieError("invalid_args", `failed to read eval artifact: ${filePath}`, {
      context: { path: filePath },
      cause: error
    });
  }
}

async function readOptionalJsonl(filePath: string): Promise<unknown[] | undefined> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

async function loadPackets(packetDir: string): Promise<ReviewPacket[]> {
  let entries: string[];
  try {
    entries = await readdir(packetDir);
  } catch {
    return [];
  }
  const packets: ReviewPacket[] = [];
  for (const entry of entries.filter((item) => item.endsWith(".json")).sort()) {
    packets.push(JSON.parse(await readFile(path.join(packetDir, entry), "utf8")) as ReviewPacket);
  }
  return packets;
}

async function loadHintEvents(filePath: string): Promise<EvalHintEvent[]> {
  const records = await readOptionalJsonl(filePath);
  if (!records) {
    return [];
  }
  return records.flatMap((record) => {
    if (!isRecord(record) || (record.message !== "follow_up_hint" && record.message !== "uncertainty")) {
      return [];
    }
    const data = isRecord(record.data) ? record.data : {};
    const question = typeof data.question === "string" ? data.question : "";
    if (question.trim().length === 0) {
      return [];
    }
    const packetId = typeof record.packetId === "string"
      ? record.packetId
      : typeof data.packetId === "string"
        ? data.packetId
        : undefined;
    return [{
      ...(packetId !== undefined ? { packetId } : {}),
      question,
      files: arrayOfStrings(data.files),
      symbols: arrayOfStrings(data.symbols),
      ...(typeof data.reason === "string" ? { reason: data.reason } : {}),
      confidence: parseConfidence(data.confidence)
    }];
  });
}

function normalizeVerification(input: unknown): EvalVerificationRecord[] {
  return Array.isArray(input) ? input.filter(isRecord) as EvalVerificationRecord[] : [];
}

function normalizeSelection(input: unknown): EvalSelectionRecord[] {
  if (Array.isArray(input)) {
    return input.filter(isRecord) as EvalSelectionRecord[];
  }
  if (isRecord(input) && Array.isArray(input.records)) {
    return input.records.filter(isRecord) as EvalSelectionRecord[];
  }
  return [];
}

function normalizeCoverage(input: unknown): (RunCoverageStatus & { hunks?: unknown[] }) | undefined {
  if (!isRecord(input)) {
    return undefined;
  }
  if (isRecord(input.status)) {
    return {
      ...(input.status as RunCoverageStatus),
      ...(Array.isArray(input.records) ? { hunks: input.records } : {})
    };
  }
  return input as RunCoverageStatus & { hunks?: unknown[] };
}

async function assertDirectory(dir: string, message: string): Promise<void> {
  try {
    const info = await stat(dir);
    if (info.isDirectory()) {
      return;
    }
  } catch {
    // Fall through to consistent CodegenieError.
  }
  throw new CodegenieError("invalid_args", message, { context: { path: dir } });
}

function arrayOfStrings(input: unknown): string[] {
  return Array.isArray(input) ? input.filter((value): value is string => typeof value === "string") : [];
}

function parseConfidence(input: unknown): EvalHintEvent["confidence"] {
  return input === "high" || input === "medium" || input === "low" ? input : "low";
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === "object" && !Array.isArray(input);
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === code;
}
