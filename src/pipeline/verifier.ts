import { buildRepositoryToolDefinitions } from "../llm/tool-definitions.js";
import type { LlmRunner } from "../llm/llm-runner.js";
import { SubmitVerificationVerdictSchema, type SubmitVerificationVerdict } from "../llm/schemas.js";
import type { LensRegistry } from "../skills/lens-registry.js";
import type { PromptBuilder } from "../skills/prompt-builder.js";
import type { TelemetryRecorder } from "../telemetry/telemetry-recorder.js";
import type {
  CandidateFinding,
  CodeninjaConfig,
  PacketReviewResult,
  RepositoryTools,
  ReviewPacket,
  ReviewStage,
  UnifiedDiff,
  VerificationVerdict
} from "../types.js";
import { createWorkerRunner, type WorkerTask } from "./worker-runner.js";
import {
  isFatalLlmError,
  isRecoverableWorkerError,
  validateAnchorForDiff,
  validateAnchorForPacket
} from "./pipeline-utils.js";

const VERIFIER_TOOL_BUDGET = { maxToolCalls: 6, maxInvestigationRounds: 2, maxResultChars: 12_000 };

type VerifyOptions = {
  runner: LlmRunner;
  promptBuilder: PromptBuilder;
  lensRegistry: LensRegistry;
  signal?: AbortSignal;
  checkpoint?: (stage: ReviewStage) => "ok" | "exhausted";
  diff?: UnifiedDiff;
};

type VerificationRecord =
  | { candidateId: string; gate: "suppressed"; gateReason: string }
  | { candidateId: string; gate: "gate_anchor_stripped"; gateReason: string }
  | { candidateId: string; gate: "passed" | "gate_anchor_stripped"; verdict: VerificationVerdict; duplicateOf?: string; clusterId?: string };

export async function verifyFindings(
  input: { packetResults: PacketReviewResult[]; packets: ReviewPacket[] },
  tools: RepositoryTools,
  config: CodeninjaConfig,
  telemetry: TelemetryRecorder,
  opts: VerifyOptions
): Promise<{ verified: CandidateFinding[]; verdicts: VerificationVerdict[]; incompleteCount: number; gateRejections: number; verificationSkipped: boolean }> {
  telemetry.event({ stage: 9, level: "info", message: "stage_started", data: { candidates: candidateCount(input.packetResults) } });
  const packetsById = new Map(input.packets.map((packet) => [packet.id, packet]));
  const records: VerificationRecord[] = [];
  const gatePassed: CandidateFinding[] = [];
  const anchorStripped = new Set<string>();
  let gateRejections = 0;

  for (const candidate of input.packetResults.flatMap((result) => result.findings)) {
    const preGated = preGateAnchor(candidate, packetsById.get(candidate.producedBy.packetId), opts.diff, telemetry);
    if (preGated.anchorStripped) {
      anchorStripped.add(candidate.id);
    }
    const gateReason = gateCandidate(preGated.candidate, config);
    if (gateReason) {
      gateRejections += 1;
      records.push(
        preGated.anchorStripped
          ? { candidateId: candidate.id, gate: "gate_anchor_stripped", gateReason: `invalid_anchor; ${gateReason}` }
          : { candidateId: candidate.id, gate: "suppressed", gateReason }
      );
      telemetry.event({ stage: 9, level: "info", message: "verification_gate_suppressed", data: { candidateId: candidate.id, gateReason } });
      continue;
    }
    gatePassed.push(preGated.candidate);
  }
  const clustered = clusterCandidates(gatePassed, packetsById, telemetry);

  if (!config.review.verify) {
    const verdicts = clustered.all.map((candidate): VerificationVerdict => ({
      candidateId: candidate.id,
      verdict: "keep",
      reason: "verification disabled by config",
      requiredEvidencePresent: true,
      falsePositiveRisk: "low"
    }));
    records.push(...verdicts.map((verdict) => verificationRecord(verdict, anchorStripped)));
    await telemetry.writeArtifact("verification.json", records);
    return { verified: clustered.all, verdicts, incompleteCount: 0, gateRejections, verificationSkipped: true };
  }

  const workerRunner = createWorkerRunner({
    concurrency: config.review.concurrency,
    signal: opts.signal,
    isRetriableError: isRecoverableWorkerError,
    ...(opts.checkpoint !== undefined ? { checkpoint: opts.checkpoint } : {})
  });
  const tasks = clustered.representatives.map((candidate): WorkerTask<VerificationVerdict> => ({
    stage: 9,
    priority: candidate.severity === "critical" ? "critical" : candidate.severity === "high" ? "high" : "normal",
    candidateId: candidate.id,
    timeoutMs: config.review.perPassTimeoutMs,
    retryOnTransient: false,
    run: async (_signal, task) => verifyCandidate(candidate, packetsById.get(candidate.producedBy.packetId), tools, config, opts, task.workerId)
  }));
  const outcomes = await workerRunner.schedule(tasks);
  const verdicts: VerificationVerdict[] = [];
  let incompleteCount = 0;
  for (const outcome of outcomes) {
    if (outcome.outcome === "completed" && outcome.value) {
      verdicts.push(outcome.value);
      records.push(verificationRecord(outcome.value, anchorStripped));
      records.push(...duplicateVerificationRecords(outcome.value, clustered.duplicatesByRepresentative, anchorStripped));
      continue;
    }
    if (isFatalLlmError(outcome.error)) {
      throw outcome.error;
    }
    incompleteCount += 1;
    const candidateId = outcome.task.candidateId ?? "unknown";
    const verdict: VerificationVerdict = {
      candidateId,
      verdict: "reject",
      reason: `verification incomplete: ${outcome.outcome}`,
      requiredEvidencePresent: false,
      falsePositiveRisk: "high",
      verificationIncomplete: true
    };
    verdicts.push(verdict);
    records.push(verificationRecord(verdict, anchorStripped));
    const duplicates = clustered.duplicatesByRepresentative.get(candidateId) ?? [];
    incompleteCount += duplicates.length;
    records.push(...duplicateVerificationRecords(verdict, clustered.duplicatesByRepresentative, anchorStripped));
  }

  const byId = new Map(clustered.representatives.map((candidate) => [candidate.id, candidate]));
  const verified = verdicts.flatMap((verdict) => {
    if (verdict.verificationIncomplete || verdict.verdict === "reject") {
      return [];
    }
    const candidate = byId.get(verdict.candidateId);
    if (!candidate) {
      return [];
    }
    const duplicates = clustered.duplicatesByRepresentative.get(verdict.candidateId) ?? [];
    return [candidate, ...duplicates].map((clusterCandidate) => applyVerificationVerdict(clusterCandidate, verdict));
  });

  await telemetry.writeArtifact("verification.json", records);
  telemetry.event({ stage: 9, level: "info", message: "stage_completed", data: { verified: verified.length, incompleteCount, gateRejections } });
  return { verified, verdicts, incompleteCount, gateRejections, verificationSkipped: false };
}

function preGateAnchor(
  candidate: CandidateFinding,
  packet: ReviewPacket | undefined,
  diff: UnifiedDiff | undefined,
  telemetry: TelemetryRecorder
): { candidate: CandidateFinding; anchorStripped: boolean } {
  if (!candidate.anchor) {
    return { candidate, anchorStripped: false };
  }
  const anchor = normalizeAnchor(candidate.anchor, packet, diff);
  if (!anchor) {
    const { anchor: _invalidAnchor, ...withoutAnchor } = candidate;
    telemetry.event({
      stage: 9,
      level: "warn",
      message: "gate_anchor_stripped",
      file: candidate.path,
      data: { candidateId: candidate.id, anchor: candidate.anchor }
    });
    return { candidate: { ...withoutAnchor, changedLine: false }, anchorStripped: true };
  }
  return {
    candidate: {
      ...candidate,
      anchor,
      path: anchor.path,
      changedLine: true
    },
    anchorStripped: false
  };
}

function applyVerdictAnchor(candidate: CandidateFinding, verdict: VerificationVerdict): CandidateFinding {
  if (verdict.revisedAnchor === undefined) {
    return candidate;
  }
  return {
    ...candidate,
    anchor: verdict.revisedAnchor,
    path: verdict.revisedAnchor.path,
    changedLine: true
  };
}

function applyVerificationVerdict(candidate: CandidateFinding, verdict: VerificationVerdict): CandidateFinding {
  const revised = verdict.finalFinding !== undefined
    ? applyFindingRevision(candidate, verdict.finalFinding)
    : candidate;
  return applyVerdictAnchor(revised, verdict);
}

function applyFindingRevision(candidate: CandidateFinding, revision: CandidateFinding): CandidateFinding {
  const { clusterId: _revisionClusterId, duplicateOf: _revisionDuplicateOf, ...revisionFields } = revision;
  return {
    ...revisionFields,
    id: candidate.id,
    producedBy: candidate.producedBy,
    ...(candidate.clusterId !== undefined ? { clusterId: candidate.clusterId } : {}),
    ...(candidate.duplicateOf !== undefined ? { duplicateOf: candidate.duplicateOf } : {})
  };
}

function duplicateVerificationRecords(
  verdict: VerificationVerdict,
  duplicatesByRepresentative: Map<string, CandidateFinding[]>,
  anchorStripped: Set<string>
): VerificationRecord[] {
  return (duplicatesByRepresentative.get(verdict.candidateId) ?? []).map((duplicate) => {
    const duplicateVerdict: VerificationVerdict = {
      ...verdict,
      candidateId: duplicate.id,
      ...(verdict.finalFinding !== undefined ? { finalFinding: applyVerificationVerdict(duplicate, verdict) } : {})
    };
    return {
      candidateId: duplicate.id,
      gate: anchorStripped.has(duplicate.id) ? "gate_anchor_stripped" as const : "passed" as const,
      duplicateOf: verdict.candidateId,
      clusterId: duplicate.clusterId ?? verdict.candidateId,
      verdict: duplicateVerdict
    };
  });
}

function verificationRecord(verdict: VerificationVerdict, anchorStripped: Set<string>): VerificationRecord {
  return {
    candidateId: verdict.candidateId,
    gate: anchorStripped.has(verdict.candidateId) ? "gate_anchor_stripped" : "passed",
    verdict
  };
}

async function verifyCandidate(
  candidate: CandidateFinding,
  packet: ReviewPacket | undefined,
  tools: RepositoryTools,
  config: CodeninjaConfig,
  opts: VerifyOptions,
  workerId: string
): Promise<VerificationVerdict> {
  const skills = opts.lensRegistry.skillsForLens(candidate.producedBy.lensId);
  const prompt = opts.promptBuilder.buildVerifierPrompt({
    candidate,
    originContext: packet?.contextText ?? "",
    hunksText: packet?.hunks.map((hunk) => hunk.contentWithLineNumbers).join("\n\n") ?? "",
    skills
  });
  const submitted = await opts.runner.runStructured<SubmitVerificationVerdict>({
    stage: 9,
    prompt: prompt.prompt,
    schema: SubmitVerificationVerdictSchema,
    templateVersion: prompt.templateVersion,
    tools: buildRepositoryToolDefinitions(tools),
    toolBudget: VERIFIER_TOOL_BUDGET,
    timeoutMs: config.review.perPassTimeoutMs,
    telemetryContext: { workerId, candidateId: candidate.id, packetId: candidate.producedBy.packetId }
  });
  const revised = submitted.finalFinding !== undefined
    ? revisedFinding(candidate, submitted.finalFinding, packet, opts.diff)
    : undefined;
  const revisedAnchor = normalizeAnchor(submitted.revisedAnchor, packet, opts.diff);
  return {
    candidateId: candidate.id,
    verdict: submitted.verdict,
    reason: submitted.reason,
    requiredEvidencePresent: submitted.requiredEvidencePresent,
    falsePositiveRisk: submitted.falsePositiveRisk,
    ...(revised !== undefined ? { finalFinding: revised } : {}),
    ...(revisedAnchor !== undefined ? { revisedAnchor } : {})
  };
}

function revisedFinding(
  original: CandidateFinding,
  submitted: SubmitVerificationVerdict["finalFinding"],
  packet: ReviewPacket | undefined,
  diff: UnifiedDiff | undefined
): CandidateFinding | undefined {
  if (!submitted) {
    return undefined;
  }
  const submittedAnchor = normalizeAnchor(submitted.anchor, packet, diff);
  const originalAnchor = validateAnchorForDiff(original.anchor, diff);
  const anchor = submittedAnchor ?? originalAnchor;
  const revised: CandidateFinding = {
    id: original.id,
    title: submitted.title,
    severity: submitted.severity,
    confidence: submitted.confidence,
    path: anchor !== undefined ? pathFromAnchor(anchor, original.path) : original.path,
    changedLine: anchor !== undefined,
    category: submitted.category,
    evidence: submitted.evidence,
    failureMode: submitted.failureMode,
    whyThisMatters: submitted.whyThisMatters,
    verification: submitted.verification,
    producedBy: original.producedBy,
    ...(original.clusterId !== undefined ? { clusterId: original.clusterId } : {}),
    ...(original.duplicateOf !== undefined ? { duplicateOf: original.duplicateOf } : {})
  };
  if (anchor !== undefined) {
    revised.anchor = anchor;
  }
  if (submitted.suggestedFix !== undefined) {
    revised.suggestedFix = submitted.suggestedFix;
  }
  if (submitted.suggestedTest !== undefined) {
    revised.suggestedTest = submitted.suggestedTest;
  }
  return revised;
}

function pathFromAnchor(anchor: CandidateFinding["anchor"], fallbackPath: string): string {
  if (!anchor) {
    return fallbackPath;
  }
  return anchor.path;
}

function normalizeAnchor(
  anchor: CandidateFinding["anchor"],
  packet: ReviewPacket | undefined,
  diff: UnifiedDiff | undefined
): CandidateFinding["anchor"] {
  const packetValid = packet ? validateAnchorForPacket(anchor, packet) : anchor;
  return validateAnchorForDiff(packetValid, diff);
}

function gateCandidate(candidate: CandidateFinding, config: CodeninjaConfig): string | undefined {
  if (candidate.evidence.changedCode.trim().length === 0) {
    return "missing_evidence";
  }
  if (candidate.failureMode.trim().length === 0) {
    return "missing_failure_mode";
  }
  if (belowConfidence(candidate.confidence, config.review.minConfidence) && candidate.severity !== "critical" && candidate.severity !== "high") {
    return "low_confidence";
  }
  return undefined;
}

function belowConfidence(actual: CandidateFinding["confidence"], minimum: CandidateFinding["confidence"]): boolean {
  return confidenceRank(actual) > confidenceRank(minimum);
}

function candidateCount(results: PacketReviewResult[]): number {
  return results.reduce((sum, result) => sum + result.findings.length, 0);
}

function clusterCandidates(
  candidates: CandidateFinding[],
  packetsById: Map<string, ReviewPacket>,
  telemetry: TelemetryRecorder
): {
  all: CandidateFinding[];
  representatives: CandidateFinding[];
  duplicatesByRepresentative: Map<string, CandidateFinding[]>;
} {
  const clusters: CandidateFinding[][] = [];
  for (const candidate of candidates) {
    const cluster = clusters.find((members) => duplicateCandidate(candidate, members[0], packetsById));
    if (cluster) {
      cluster.push(candidate);
    } else {
      clusters.push([candidate]);
    }
  }

  const all: CandidateFinding[] = [];
  const representatives: CandidateFinding[] = [];
  const duplicatesByRepresentative = new Map<string, CandidateFinding[]>();

  for (const cluster of clusters) {
    const representative = verifierRepresentative(cluster);
    const clusteredRepresentative = cluster.length > 1 ? { ...representative, clusterId: representative.id } : representative;
    const duplicates = cluster
      .filter((candidate) => candidate.id !== representative.id)
      .map((candidate) => ({
        ...candidate,
        clusterId: representative.id,
        duplicateOf: representative.id
      }));
    representatives.push(clusteredRepresentative);
    all.push(clusteredRepresentative, ...duplicates);
    if (duplicates.length > 0) {
      duplicatesByRepresentative.set(representative.id, duplicates);
      telemetry.event({
        stage: 9,
        level: "info",
        message: "verification_candidates_clustered",
        data: { representativeId: representative.id, duplicateIds: duplicates.map((candidate) => candidate.id) }
      });
    }
  }

  return { all, representatives, duplicatesByRepresentative };
}

function duplicateCandidate(
  a: CandidateFinding,
  b: CandidateFinding | undefined,
  packetsById: Map<string, ReviewPacket>
): boolean {
  if (!b || a.path !== b.path || a.category !== b.category) {
    return false;
  }
  const aLocation = locationClusterKey(a, packetsById);
  const bLocation = locationClusterKey(b, packetsById);
  if (aLocation === undefined || aLocation !== bLocation) {
    return false;
  }
  return normalize(a.title) === normalize(b.title) || normalize(a.evidence.changedCode) === normalize(b.evidence.changedCode);
}

function locationClusterKey(candidate: CandidateFinding, packetsById: Map<string, ReviewPacket>): string | undefined {
  if (candidate.anchor) {
    return `anchor:${candidate.anchor.path}:${candidate.anchor.side}:${candidate.anchor.line}:${candidate.anchor.hunkId}`;
  }
  const packet = packetsById.get(candidate.producedBy.packetId);
  const symbols = [...new Set(
    (packet?.symbolFacts ?? [])
      .map((fact) => fact.enclosingSymbol)
      .filter((symbol): symbol is string => symbol !== undefined && symbol.trim().length > 0)
  )];
  if (symbols.length !== 1) {
    return undefined;
  }
  return `symbol:${candidate.path}:${symbols[0]}`;
}

function verifierRepresentative(candidates: CandidateFinding[]): CandidateFinding {
  const first = [...candidates].sort((a, b) =>
    confidenceRank(a.confidence) - confidenceRank(b.confidence) ||
    severityRank(a.severity) - severityRank(b.severity) ||
    a.id.localeCompare(b.id)
  )[0];
  if (!first) {
    throw new Error("cannot choose representative from empty verification cluster");
  }
  return first;
}

function severityRank(severity: CandidateFinding["severity"]): number {
  return { critical: 0, high: 1, medium: 2, low: 3 }[severity];
}

function confidenceRank(confidence: CandidateFinding["confidence"]): number {
  return { high: 0, medium: 1, low: 2 }[confidence];
}

function normalize(input: string): string {
  return input.toLowerCase().replace(/\s+/gu, " ").trim();
}
