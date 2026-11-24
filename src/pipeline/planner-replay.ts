import { Type } from "typebox";
import { Check } from "typebox/value";
import { TransportAdmissionError } from "../llm/transport-admission.js";
import type { TelemetryRecorder } from "../telemetry/telemetry-recorder.js";
import type { PlannerDossier } from "../types.js";
import { sha256Hex } from "../util/hashing.js";
import { stableJson } from "../util/json.js";
import type { PlannerRunResult } from "./planner.js";

export type PlannerReplay = {
  capture: string;
  captureSHA256: string;
  diffSHA256: string;
  expectedDossierSHA256: string;
  baseSHA: string;
  headSHA: string;
  hunks: Array<{ path: string; hunkId: string }>;
};

const hint = Type.Object({
  kind: Type.Union([Type.Literal("enclosing_symbol"), Type.Literal("call_site"), Type.Literal("test"), Type.Literal("line_range"), Type.Literal("other")]),
  path: Type.Optional(Type.String()), symbol: Type.Optional(Type.String()),
  lineRange: Type.Optional(Type.Array(Type.Integer(), { minItems: 2, maxItems: 2 })),
  reason: Type.String(), expectedUse: Type.Union([Type.Literal("packet_context"), Type.Literal("tool_lookup")])
}, { additionalProperties: true });
const resultSchema = Type.Object({
  plan: Type.Object({
    diffUnderstanding: Type.Object({ declaredIntent: Type.String(), inferredBehavior: Type.String() }, { additionalProperties: true }),
    coverage: Type.Array(Type.Object({
      hunkId: Type.String({ minLength: 1 }), path: Type.String({ minLength: 1 }),
      coverage: Type.Union([Type.Literal("deep"), Type.Literal("normal"), Type.Literal("light"), Type.Literal("skip")]),
      lenses: Type.Array(Type.String()), surroundingContextHints: Type.Array(hint), reason: Type.String(),
      focusNotes: Type.Optional(Type.Array(Type.String())), relatedSymbols: Type.Optional(Type.Array(Type.String())), relatedFiles: Type.Optional(Type.Array(Type.String()))
    }, { additionalProperties: true }))
  }, { additionalProperties: true }),
  plannerCoverage: Type.Object({ submittedEntries: Type.Integer({ minimum: 0 }), acceptedEntries: Type.Integer({ minimum: 0 }),
    acceptedUniqueHunks: Type.Integer({ minimum: 0 }), rejectedUnknownHunk: Type.Integer({ minimum: 0 }) }, { additionalProperties: true }),
  degradedPlanning: Type.Boolean(), chunked: Type.Boolean()
}, { additionalProperties: true });

type CaptureEvent = { kind: "event"; event: Parameters<TelemetryRecorder["event"]>[0] } | { kind: "artifact"; name: string; data: unknown };
const hashPattern = /^[a-f0-9]{64}$/u;
const record = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x);

/** Verify all replay bindings before writing any captured telemetry or making a model call. */
export async function replayPlanner(replay: PlannerReplay, dossier: PlannerDossier, rawDiff: string, telemetry: TelemetryRecorder): Promise<PlannerRunResult> {
  let result!: PlannerRunResult;
  let events!: CaptureEvent[];
  try {
    if (typeof replay.capture !== "string" || !hashPattern.test(replay.captureSHA256) || sha256Hex(replay.capture) !== replay.captureSHA256 ||
        !hashPattern.test(replay.diffSHA256) || sha256Hex(rawDiff) !== replay.diffSHA256 || !hashPattern.test(replay.expectedDossierSHA256) ||
        dossier.target.headSha !== replay.headSHA || dossier.target.mergeBase !== replay.baseSHA) throw new Error("identity");
    const { runId: _runId, ...stableDossier } = dossier;
    if (sha256Hex(stableJson(stableDossier)) !== replay.expectedDossierSHA256) throw new Error("dossier");
    const inventory = dossier.hunkIndex.flatMap((entry) => entry.hunkIds.map((hunkId) => ({ path: entry.path, hunkId })));
    if (!Array.isArray(replay.hunks) || stableJson(inventory) !== stableJson(replay.hunks)) throw new Error("hunks");
    const parsed: unknown = JSON.parse(replay.capture);
    if (!record(parsed) || !Check(resultSchema, parsed.result) || !Array.isArray(parsed.telemetry) ||
        (parsed.dossierDigest !== undefined && parsed.dossierDigest !== replay.expectedDossierSHA256)) throw new Error("capture");
    result = parsed.result as unknown as PlannerRunResult;
    const known = new Set(inventory.map((hunk) => `${hunk.path}\0${hunk.hunkId}`));
    if (result.plan.coverage.some((entry) => !known.has(`${entry.path}\0${entry.hunkId}`))) throw new Error("coverage");
    let planArtifacts = 0;
    for (const item of parsed.telemetry) {
      if (!record(item)) throw new Error("telemetry");
      if (item.kind === "event") {
        if (!record(item.event) || item.event.stage !== 5 || typeof item.event.level !== "string" ||
            !["debug", "info", "warn", "error"].includes(item.event.level) || typeof item.event.message !== "string" ||
            (item.event.data !== undefined && !record(item.event.data))) throw new Error("event");
      } else if (item.kind === "artifact") {
        if (item.name === "review-plan.json") {
          planArtifacts++;
          if (stableJson(item.data) !== stableJson(result.plan)) throw new Error("plan artifact");
        } else if (item.name !== "planner-dossier-chunks.json" || !Array.isArray(item.data)) throw new Error("artifact");
      } else throw new Error("telemetry kind");
    }
    if (planArtifacts !== 1) throw new Error("plan artifact count");
    events = parsed.telemetry as CaptureEvent[];
  } catch (error) {
    if (error instanceof TransportAdmissionError) throw error;
    throw new TransportAdmissionError("binding_mismatch");
  }
  for (const item of events) {
    if (item.kind === "event") telemetry.event({ ...item.event, data: { ...(item.event.data ?? {}), replayed: true } });
    else await telemetry.writeArtifact(item.name, item.data);
  }
  telemetry.event({ stage: 5, level: "info", message: "planner_replayed", data: { captureSHA256: replay.captureSHA256, replayed: true } });
  return result;
}
