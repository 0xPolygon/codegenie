import type {
  CandidateFinding,
  CandidateFindingProvenance,
  Confidence,
  FinalFinding,
  NeedsHumanAttentionNote,
  PacketReviewResult,
  ReviewPacket,
  RunCoverageStatus,
  UnifiedDiff,
  VerificationVerdict
} from "../types.js";
import type { TelemetryRecorder } from "../telemetry/telemetry-recorder.js";
import { sha256Hex } from "../util/hashing.js";

const MAX_HUMAN_ATTENTION_NOTES = 5;
const HUMAN_ATTENTION_LOCATION_CAP = 6;

export type RawAttentionHint = {
  id: string;
  source: "follow_up_hint" | "uncertainty";
  question: string;
  files: string[];
  originalFiles: string[];
  droppedPaths: Array<{ path: string; reason: string }>;
  symbols: string[];
  suggestedLenses: string[];
  reason: string;
  confidence: Confidence;
  packetId: string;
};

type AttentionHint = RawAttentionHint & { confidence: Exclude<Confidence, "low"> };

export type AttentionHintGroup = {
  key: string;
  representative: AttentionHint;
  files: string[];
  symbols: string[];
  reasons: string[];
  rawNoteIds: Set<string>;
  droppedPaths: Array<{ path: string; reason: string }>;
  invalidPathCount: number;
  packetIds: Set<string>;
  sources: Set<RawAttentionHint["source"]>;
  count: number;
};

export type HumanAttentionMergeStats = {
  exactDuplicateHints: number;
  nearDuplicateHints: number;
  nearDuplicateGroupsMerged: number;
};

export type HumanAttentionNotes = {
  raw: RawAttentionHint[];
  groups: AttentionHintGroup[];
  notes: NeedsHumanAttentionNote[];
  omittedCount: number;
  mergeStats: HumanAttentionMergeStats;
};

export type VerificationResolution = {
  candidateId: string;
  verdict: VerificationVerdict["verdict"];
  reason: string;
  files: string[];
  symbols: string[];
  terms: Set<string>;
  questionKeys: Set<string>;
  provenance?: CandidateFindingProvenance | undefined;
};

type VerificationSuppressionRecord = {
  groupKey: string;
  noteIds: string[];
  note: NeedsHumanAttentionNote;
  candidateId: string;
  verdict: VerificationVerdict["verdict"];
  reason: string;
  verdictReason: string;
  match: {
    sharedFiles: string[];
    sharedSymbols: string[];
    sharedTerms: number;
    similarity: number;
    questionMatched: boolean;
    provenanceMatched: boolean;
  };
};

export type HumanAttentionOutput = {
  notes: NeedsHumanAttentionNote[];
  omittedCount: number;
  suppressedByFindings: NeedsHumanAttentionNote[];
  suppressedByFindingGroups: AttentionHintGroup[];
  suppressedByVerification: VerificationSuppressionRecord[];
  keptGroups: AttentionHintGroup[];
  selectedGroups: AttentionHintGroup[];
};

export function buildHumanAttentionNotes(
  packetResults: PacketReviewResult[],
  options: { packets: ReviewPacket[]; diff?: UnifiedDiff; telemetry?: TelemetryRecorder }
): HumanAttentionNotes {
  const raw = rawAttentionHints(packetResults, knownAttentionPaths(options.packets, options.diff), options.telemetry);
  const groups = new Map<string, AttentionHintGroup>();
  let eligibleHints = 0;

  for (const hint of raw) {
    if (hint.confidence === "low") {
      continue;
    }
    const question = hint.question.trim();
    if (question.length === 0) {
      continue;
    }
    if (hint.files.length === 0 && hint.symbols.length === 0) {
      options.telemetry?.event({
        stage: 10,
        level: "warn",
        message: "human_attention_note_dropped",
        packetId: hint.packetId,
        data: {
          reason: "no_valid_file_or_symbol",
          noteId: hint.id,
          droppedPaths: hint.droppedPaths
        }
      });
      continue;
    }
    eligibleHints += 1;
    const normalized: AttentionHint = { ...hint, question, confidence: hint.confidence };
    const key = followUpHintKey(normalized);
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        key,
        representative: normalized,
        files: normalized.files,
        symbols: normalized.symbols,
        reasons: cleanStrings([normalized.reason]),
        rawNoteIds: new Set([normalized.id]),
        droppedPaths: normalized.droppedPaths,
        invalidPathCount: normalized.droppedPaths.length,
        packetIds: new Set([normalized.packetId]),
        sources: new Set([normalized.source]),
        count: 1
      });
      continue;
    }
    mergeAttentionGroupInto(existing, {
      key,
      representative: normalized,
      files: normalized.files,
      symbols: normalized.symbols,
      reasons: cleanStrings([normalized.reason]),
      rawNoteIds: new Set([normalized.id]),
      droppedPaths: normalized.droppedPaths,
      invalidPathCount: normalized.droppedPaths.length,
      packetIds: new Set([normalized.packetId]),
      sources: new Set([normalized.source]),
      count: 1
    });
  }

  const exactGroups = [...groups.values()];
  const merged = mergeNearDuplicateAttentionGroups(exactGroups);
  const ranked = merged.groups.sort(compareAttentionGroups);
  const selected = selectHumanAttentionGroups(ranked);
  const mergeStats: HumanAttentionMergeStats = {
    exactDuplicateHints: Math.max(0, eligibleHints - exactGroups.length),
    nearDuplicateHints: merged.stats.nearDuplicateHints,
    nearDuplicateGroupsMerged: merged.stats.nearDuplicateGroupsMerged
  };
  if (raw.length > 0) {
    options.telemetry?.event({
      stage: 10,
      level: "info",
      message: "human_attention_hints_grouped",
      data: {
        rawHints: raw.length,
        rawFollowUpHints: raw.filter((hint) => hint.source === "follow_up_hint").length,
        rawUncertainties: raw.filter((hint) => hint.source === "uncertainty").length,
        eligibleHints,
        exactGroups: exactGroups.length,
        groups: ranked.length,
        emitted: selected.notes.length,
        suppressedGroups: selected.omittedCount,
        duplicateHints: Math.max(0, eligibleHints - ranked.length),
        exactDuplicateHints: mergeStats.exactDuplicateHints,
        nearDuplicateHints: mergeStats.nearDuplicateHints,
        nearDuplicateGroupsMerged: mergeStats.nearDuplicateGroupsMerged,
        maxHumanAttentionNotes: MAX_HUMAN_ATTENTION_NOTES,
        groupedHints: ranked.map((group, index) => ({
          key: group.key,
          question: group.representative.question,
          count: group.count,
          packets: group.packetIds.size,
          files: capStrings(group.files),
          symbols: capStrings(group.symbols),
          sources: [...group.sources].sort(),
          emitted: index < MAX_HUMAN_ATTENTION_NOTES
        }))
      }
    });
  }
  return { raw, groups: ranked, notes: selected.notes, omittedCount: selected.omittedCount, mergeStats };
}

export function selectHumanAttentionGroups(
  groups: AttentionHintGroup[]
): { groups: AttentionHintGroup[]; notes: NeedsHumanAttentionNote[]; omittedCount: number } {
  const emittedGroups = groups.slice(0, MAX_HUMAN_ATTENTION_NOTES);
  const emitted = emittedGroups.map(toAttentionNote);
  return { groups: emittedGroups, notes: emitted, omittedCount: Math.max(0, groups.length - emitted.length) };
}

export function selectHumanAttentionForOutput(
  groups: AttentionHintGroup[],
  findings: FinalFinding[],
  packetsById: Map<string, ReviewPacket>,
  verificationResolutions: VerificationResolution[],
  telemetry?: TelemetryRecorder
): HumanAttentionOutput {
  const availableAfterFindings = groups.filter((group) => !findings.some((finding) => attentionGroupCoveredByFinding(group, finding, packetsById)));
  const suppressedByFindingGroups = groups.filter((group) => !availableAfterFindings.includes(group));
  const suppressedByFindings = suppressedByFindingGroups.map(toAttentionNote);
  const verificationSuppression = suppressAttentionGroupsResolvedByVerification(availableAfterFindings, verificationResolutions);
  const selected = selectHumanAttentionGroups(verificationSuppression.available);

  if (suppressedByFindings.length > 0) {
    telemetry?.event({
      stage: 10,
      level: "info",
      message: "human_attention_hints_suppressed_by_findings",
      data: {
        suppressed: suppressedByFindings.length,
        remainingGroups: availableAfterFindings.length
      }
    });
  }
  if (verificationSuppression.suppressed.length > 0) {
    telemetry?.event({
      stage: 10,
      level: "info",
      message: "human_attention_hints_suppressed_by_verification",
      data: {
        suppressed: verificationSuppression.suppressed.length,
        remainingGroups: verificationSuppression.available.length,
        candidates: verificationSuppression.suppressed.map((record) => ({
          candidateId: record.candidateId,
          verdict: record.verdict,
          groupKey: record.groupKey
        }))
      }
    });
  }

  return {
    notes: selected.notes,
    omittedCount: selected.omittedCount,
    suppressedByFindings,
    suppressedByFindingGroups,
    suppressedByVerification: verificationSuppression.suppressed,
    keptGroups: verificationSuppression.available,
    selectedGroups: selected.groups
  };
}

export function suppressAttentionGroupsResolvedByVerification(
  groups: AttentionHintGroup[],
  resolutions: VerificationResolution[]
): { available: AttentionHintGroup[]; suppressed: VerificationSuppressionRecord[] } {
  if (resolutions.length === 0) {
    return { available: groups, suppressed: [] };
  }
  const available: AttentionHintGroup[] = [];
  const suppressed: VerificationSuppressionRecord[] = [];
  for (const group of groups) {
    const match = firstVerificationResolutionMatch(group, resolutions);
    if (match === undefined) {
      available.push(group);
      continue;
    }
    suppressed.push({
      groupKey: group.key,
      noteIds: [...group.rawNoteIds].sort(),
      note: toAttentionNote(group),
      candidateId: match.resolution.candidateId,
      verdict: match.resolution.verdict,
      reason: `resolved by stage 9 ${match.resolution.verdict} verdict for ${match.resolution.candidateId}`,
      verdictReason: match.resolution.reason,
      match: {
        sharedFiles: match.sharedFiles,
        sharedSymbols: match.sharedSymbols,
        sharedTerms: match.sharedTerms,
        similarity: match.similarity,
        questionMatched: match.questionMatched,
        provenanceMatched: match.provenanceMatched
      }
    });
  }
  return { available, suppressed };
}

export function buildVerificationResolutionIndex(
  verdicts: VerificationVerdict[],
  packetResults: PacketReviewResult[],
  verifiedFindings: CandidateFinding[],
  packetsById: Map<string, ReviewPacket>,
  coverage: RunCoverageStatus
): VerificationResolution[] {
  if (coverage.verificationSkipped === true || verdicts.length === 0) {
    return [];
  }
  const candidatesById = candidateFindingsById(packetResults, verifiedFindings, verdicts);
  return verdicts.flatMap((verdict): VerificationResolution[] => {
    if (!verdictResolvesPredicate(verdict)) {
      return [];
    }
    const original = candidatesById.get(verdict.candidateId);
    const resolved = verdict.finalFinding ?? original;
    if (original === undefined && resolved === undefined) {
      return [];
    }
    const files = cleanStrings([
      ...(original !== undefined ? candidateFiles(original, packetsById) : []),
      ...(resolved !== undefined ? candidateFiles(resolved, packetsById) : [])
    ]);
    const symbols = cleanStrings([
      ...(original !== undefined ? candidateSymbols(original, packetsById) : []),
      ...(resolved !== undefined ? candidateSymbols(resolved, packetsById) : [])
    ]);
    const normalizedQuestionKeys = new Set([
      ...(original?.provenance !== undefined ? questionKeys(original.provenance.question) : []),
      ...(resolved?.provenance !== undefined ? questionKeys(resolved.provenance.question) : [])
    ]);
    const terms = normalizedTerms([
      original !== undefined ? candidateResolutionText(original) : "",
      resolved !== undefined && resolved !== original ? candidateResolutionText(resolved) : "",
      verdict.reason,
      symbols.join(" ")
    ].join(" "));
    return [{
      candidateId: verdict.candidateId,
      verdict: verdict.verdict,
      reason: verdict.reason,
      files,
      symbols,
      terms,
      questionKeys: normalizedQuestionKeys,
      ...((resolved?.provenance ?? original?.provenance) !== undefined ? { provenance: resolved?.provenance ?? original?.provenance } : {})
    }];
  });
}

export function humanAttentionArtifact(
  attention: HumanAttentionNotes,
  output: HumanAttentionOutput,
  composerPromptGroups: AttentionHintGroup[]
): Record<string, unknown> {
  return {
    schemaVersion: 2,
    notes: attention.raw.map(rawAttentionHintArtifact),
    groups: attention.groups.map(attentionGroupArtifact),
    mergeStats: attention.mergeStats,
    composerPromptGroupIds: composerPromptGroups.map((group) => group.key),
    outputGroupIds: output.selectedGroups.map((group) => group.key),
    outputNotes: output.notes,
    omittedCount: output.omittedCount,
    suppressedByFindings: output.suppressedByFindingGroups.map((group) => ({
      groupKey: group.key,
      noteIds: [...group.rawNoteIds].sort()
    })),
    suppressedByVerification: output.suppressedByVerification.map((record) => ({
      groupKey: record.groupKey,
      noteIds: record.noteIds,
      candidateId: record.candidateId,
      verdict: record.verdict,
      reason: record.reason,
      verdictReason: record.verdictReason,
      match: record.match
    })),
    keptForOutputGroupIds: output.keptGroups.map((group) => group.key)
  };
}

function rawAttentionHints(
  packetResults: PacketReviewResult[],
  knownPaths: Set<string>,
  telemetry: TelemetryRecorder | undefined
): RawAttentionHint[] {
  const raw: RawAttentionHint[] = [];
  for (const result of packetResults) {
    for (const hint of result.followUpHints) {
      const files = validateAttentionFiles(result.packetId, hint.files, knownPaths, telemetry);
      raw.push({
        id: rawAttentionHintId(result.packetId, "follow_up_hint", hint.question, files.files, hint.symbols),
        source: "follow_up_hint",
        question: hint.question.trim(),
        files: files.files,
        originalFiles: cleanStrings(hint.files),
        droppedPaths: files.dropped,
        symbols: cleanStrings(hint.symbols),
        reason: hint.reason.trim(),
        suggestedLenses: cleanStrings(hint.suggestedLenses),
        confidence: hint.confidence,
        packetId: result.packetId
      });
    }
    for (const uncertainty of result.uncertainties) {
      const files = validateAttentionFiles(result.packetId, uncertainty.files, knownPaths, telemetry);
      raw.push({
        id: rawAttentionHintId(result.packetId, "uncertainty", uncertainty.question, files.files, uncertainty.symbols),
        source: "uncertainty",
        question: uncertainty.question.trim(),
        files: files.files,
        originalFiles: cleanStrings(uncertainty.files),
        droppedPaths: files.dropped,
        symbols: cleanStrings(uncertainty.symbols),
        reason: "Packet reviewer could not resolve this question from the reviewed context.",
        suggestedLenses: [],
        confidence: "medium",
        packetId: result.packetId
      });
    }
  }
  return raw;
}

function knownAttentionPaths(packets: ReviewPacket[], diff: UnifiedDiff | undefined): Set<string> {
  const paths = new Set<string>();
  const add = (value: string | undefined) => {
    const normalized = normalizeAttentionPath(value ?? "");
    if (normalized !== undefined) {
      paths.add(normalized);
    }
  };
  for (const file of diff?.files ?? []) {
    add(file.path);
    add(file.oldPath);
  }
  for (const packet of packets) {
    add(packet.path);
    add(packet.oldPath);
    add(packet.context.path);
    for (const fact of packet.symbolFacts) {
      add(fact.path);
    }
    for (const symbol of packet.relevantTests) {
      add(symbol.path);
    }
    for (const symbol of packet.packetSymbols ?? []) {
      add(symbol.path);
    }
    for (const hint of packet.surroundingContextHints) {
      add(hint.path);
    }
    if (packet.context.enclosingFunction !== undefined) {
      add(packet.context.enclosingFunction.path);
    }
    if (packet.context.enclosingType !== undefined) {
      add(packet.context.enclosingType.path);
    }
    if (packet.context.enclosingMethod !== undefined) {
      add(packet.context.enclosingMethod.path);
    }
  }
  return paths;
}

function validateAttentionFiles(
  packetId: string,
  files: string[],
  knownPaths: Set<string>,
  telemetry: TelemetryRecorder | undefined
): { files: string[]; dropped: Array<{ path: string; reason: string }> } {
  const valid: string[] = [];
  const dropped: Array<{ path: string; reason: string }> = [];
  for (const original of cleanStrings(files)) {
    const validation = validateAttentionPath(original, knownPaths);
    if (validation.validPath !== undefined) {
      valid.push(validation.validPath);
      continue;
    }
    dropped.push({ path: original, reason: validation.reason });
    telemetry?.event({
      stage: 10,
      level: "warn",
      message: "human_attention_note_path_dropped",
      packetId,
      data: {
        originalPath: original,
        reason: validation.reason
      }
    });
  }
  return { files: cleanStrings(valid), dropped };
}

function validateAttentionPath(pathValue: string, knownPaths: Set<string>): { validPath?: string; reason: string } {
  const trimmed = pathValue.trim();
  if (trimmed.length === 0) {
    return { reason: "empty" };
  }
  if (isAbsolutePathLike(trimmed)) {
    return { reason: "absolute_path" };
  }
  const normalized = normalizeAttentionPath(trimmed);
  if (normalized === undefined) {
    return { reason: "invalid_path" };
  }
  if (normalized.split("/").some((part) => part === "..")) {
    return { reason: "traversal" };
  }
  if (knownPaths.size > 0 && !knownPaths.has(normalized)) {
    return { reason: "unknown_path" };
  }
  return { validPath: normalized, reason: "valid" };
}

function normalizeAttentionPath(pathValue: string): string | undefined {
  const normalized = pathValue
    .trim()
    .replace(/\\/gu, "/")
    .replace(/:\d+(?:-\d+)?$/u, "")
    .replace(/^\.\//u, "")
    .replace(/\/{2,}/gu, "/");
  if (normalized.length === 0 || normalized === ".") {
    return undefined;
  }
  return normalized;
}

function isAbsolutePathLike(pathValue: string): boolean {
  return pathValue.startsWith("/") || /^[a-z]:[\\/]/iu.test(pathValue);
}

function rawAttentionHintId(
  packetId: string,
  source: RawAttentionHint["source"],
  question: string,
  files: string[],
  symbols: string[]
): string {
  return `note-${sha256Hex([
    packetId,
    source,
    normalizeQuestion(question),
    cleanStrings(files).join(","),
    cleanStrings(symbols).join(",")
  ].join("\0")).slice(0, 12)}`;
}

function mergeNearDuplicateAttentionGroups(
  groups: AttentionHintGroup[]
): { groups: AttentionHintGroup[]; stats: Omit<HumanAttentionMergeStats, "exactDuplicateHints"> } {
  const merged: AttentionHintGroup[] = [];
  let nearDuplicateHints = 0;
  let nearDuplicateGroupsMerged = 0;

  for (const group of groups) {
    const existing = merged.find((candidate) => attentionGroupsShareRootQuestion(candidate, group));
    if (existing === undefined) {
      merged.push(group);
      continue;
    }
    mergeAttentionGroupInto(existing, group);
    nearDuplicateHints += group.count;
    nearDuplicateGroupsMerged += 1;
  }

  return { groups: merged, stats: { nearDuplicateHints, nearDuplicateGroupsMerged } };
}

function attentionGroupsShareRootQuestion(a: AttentionHintGroup, b: AttentionHintGroup): boolean {
  const sharedFiles = sortedIntersection(normalizedSet(a.files), normalizedSet(b.files));
  const sharedSymbols = sortedIntersection(normalizedSet(a.symbols), normalizedSet(b.symbols));
  if (sharedFiles.length === 0 || sharedSymbols.length === 0) {
    return false;
  }

  const aTerms = attentionGroupTerms(a);
  const bTerms = attentionGroupTerms(b);
  const sharedTerms = intersectionCount(aTerms, bTerms);
  const similarity = tokenJaccard(aTerms, bTerms);
  const questionMatched = questionKeys(a.representative.question).some((key) =>
    questionKeys(b.representative.question).includes(key)
  );

  return questionMatched || sharedTerms >= 3 || similarity >= 0.24;
}

function mergeAttentionGroupInto(target: AttentionHintGroup, source: AttentionHintGroup): void {
  target.count += source.count;
  for (const packetId of source.packetIds) {
    target.packetIds.add(packetId);
  }
  for (const sourceKind of source.sources) {
    target.sources.add(sourceKind);
  }
  for (const noteId of source.rawNoteIds) {
    target.rawNoteIds.add(noteId);
  }
  target.files = mergeStrings(target.files, source.files);
  target.symbols = mergeStrings(target.symbols, source.symbols);
  target.reasons = mergeStrings(target.reasons, source.reasons);
  target.droppedPaths = mergeDroppedPaths(target.droppedPaths, source.droppedPaths);
  target.invalidPathCount += source.invalidPathCount;
  target.representative = strongerAttentionHint(target.representative, source.representative);
  target.key = mergedAttentionGroupKey(target);
}

function mergedAttentionGroupKey(group: AttentionHintGroup): string {
  const files = group.files.map(normalize).filter(Boolean).slice(0, 4).join(",");
  const symbols = group.symbols.map(normalize).filter(Boolean).slice(0, 4).join(",");
  const terms = [...attentionGroupTerms(group)].sort().slice(0, 8).join(",");
  return `human_attention|merged|files:${files}|symbols:${symbols}|terms:${terms}`;
}

function toAttentionNote(group: AttentionHintGroup): NeedsHumanAttentionNote {
  return {
    question: group.representative.question,
    files: capStrings(group.files),
    symbols: capStrings(group.symbols),
    reason: attentionNoteReason(group),
    confidence: group.representative.confidence,
    sourcePacketIds: [...group.packetIds].sort()
  };
}

function attentionNoteReason(group: AttentionHintGroup): string {
  const base = group.representative.reason;
  const relatedReasons = group.reasons
    .filter((reason) => normalizeQuestion(reason) !== normalizeQuestion(base))
    .slice(0, 2);
  const related = relatedReasons.length > 0 ? ` Related reasons: ${relatedReasons.join(" ")}` : "";
  const grouped = group.count > 1
    ? ` Grouped from ${group.count} related hints across ${group.packetIds.size} packet${group.packetIds.size === 1 ? "" : "s"}.`
    : "";
  return `${base}${related}${grouped}`.trim();
}

function attentionGroupArtifact(group: AttentionHintGroup): Record<string, unknown> {
  return {
    key: group.key,
    noteIds: [...group.rawNoteIds].sort(),
    question: group.representative.question,
    reason: group.representative.reason,
    confidence: group.representative.confidence,
    files: group.files,
    droppedPaths: group.droppedPaths,
    invalidPathCount: group.invalidPathCount,
    symbols: group.symbols,
    reasons: group.reasons,
    packetIds: [...group.packetIds].sort(),
    sources: [...group.sources].sort(),
    count: group.count
  };
}

function rawAttentionHintArtifact(hint: RawAttentionHint): Record<string, unknown> {
  return {
    id: hint.id,
    source: hint.source,
    packetId: hint.packetId,
    question: hint.question,
    reason: hint.reason,
    confidence: hint.confidence,
    files: hint.files,
    originalFiles: hint.originalFiles,
    droppedPaths: hint.droppedPaths,
    symbols: hint.symbols,
    suggestedLenses: hint.suggestedLenses
  };
}

function firstVerificationResolutionMatch(
  group: AttentionHintGroup,
  resolutions: VerificationResolution[]
): (VerificationResolutionMatch & { resolution: VerificationResolution }) | undefined {
  for (const resolution of resolutions) {
    const match = attentionGroupResolvedByVerification(group, resolution);
    if (match !== undefined) {
      return { ...match, resolution };
    }
  }
  return undefined;
}

type VerificationResolutionMatch = {
  sharedFiles: string[];
  sharedSymbols: string[];
  sharedTerms: number;
  similarity: number;
  questionMatched: boolean;
  provenanceMatched: boolean;
};

function attentionGroupResolvedByVerification(
  group: AttentionHintGroup,
  resolution: VerificationResolution
): VerificationResolutionMatch | undefined {
  if (resolution.provenance !== undefined && attentionGroupMatchesProvenance(group, resolution.provenance)) {
    const groupTerms = attentionGroupTerms(group);
    const sharedTerms = intersectionCount(groupTerms, resolution.terms);
    const similarity = tokenJaccard(groupTerms, resolution.terms);
    return {
      sharedFiles: sortedIntersection(normalizedSet(group.files), normalizedSet(resolution.files)),
      sharedSymbols: sortedIntersection(normalizedSet(group.symbols), normalizedSet(resolution.symbols)),
      sharedTerms,
      similarity,
      questionMatched: true,
      provenanceMatched: true
    };
  }

  const groupFiles = normalizedSet(group.files);
  const resolutionFiles = normalizedSet(resolution.files);
  const sharedFiles = sortedIntersection(groupFiles, resolutionFiles);
  if (groupFiles.size > 0 && resolutionFiles.size > 0 && sharedFiles.length === 0) {
    return undefined;
  }

  const groupSymbols = normalizedSet(group.symbols);
  const resolutionSymbols = normalizedSet(resolution.symbols);
  const sharedSymbols = sortedIntersection(groupSymbols, resolutionSymbols);
  if (sharedFiles.length === 0 && sharedSymbols.length === 0) {
    if (group.invalidPathCount > 0) {
      const groupTerms = attentionGroupTerms(group);
      const sharedTerms = intersectionCount(groupTerms, resolution.terms);
      const similarity = tokenJaccard(groupTerms, resolution.terms);
      const questionMatched = questionKeys(group.representative.question).some((key) => resolution.questionKeys.has(key));
      return questionMatched || sharedTerms >= 7 || similarity >= 0.55
        ? { sharedFiles, sharedSymbols, sharedTerms, similarity, questionMatched, provenanceMatched: false }
        : undefined;
    }
    return undefined;
  }

  const groupTerms = attentionGroupTerms(group);
  const sharedTerms = intersectionCount(groupTerms, resolution.terms);
  const similarity = tokenJaccard(groupTerms, resolution.terms);
  const questionMatched = questionKeys(group.representative.question).some((key) => resolution.questionKeys.has(key));

  if (sharedFiles.length > 0 && sharedSymbols.length > 0) {
    return questionMatched || sharedTerms >= 3 || similarity >= 0.3
      ? { sharedFiles, sharedSymbols, sharedTerms, similarity, questionMatched, provenanceMatched: false }
      : undefined;
  }
  if (sharedSymbols.length > 0) {
    return questionMatched || sharedTerms >= 4 || similarity >= 0.35
      ? { sharedFiles, sharedSymbols, sharedTerms, similarity, questionMatched, provenanceMatched: false }
      : undefined;
  }
  return questionMatched || sharedTerms >= 5 || similarity >= 0.45
    ? { sharedFiles, sharedSymbols, sharedTerms, similarity, questionMatched, provenanceMatched: false }
    : undefined;
}

function attentionGroupMatchesProvenance(group: AttentionHintGroup, provenance: CandidateFindingProvenance): boolean {
  if (provenance.source !== "uncertainty_promotion") {
    return false;
  }
  if (!group.packetIds.has(provenance.sourcePacketId) || !group.sources.has(provenance.sourceKind)) {
    return false;
  }
  const questionMatched = questionKeys(group.representative.question).some((key) =>
    questionKeys(provenance.question).includes(key)
  );
  if (!questionMatched) {
    return false;
  }
  const sharedFiles = sortedIntersection(normalizedSet(group.files), normalizedSet(provenance.files));
  return sharedFiles.length > 0 || group.invalidPathCount > 0;
}

function attentionGroupCoveredByFinding(
  group: AttentionHintGroup,
  finding: FinalFinding,
  packetsById: Map<string, ReviewPacket>
): boolean {
  const sharesSymbol = groupSharesFindingSymbol(group, finding, packetsById);
  const sharesFile = groupSharesFindingFile(group, finding);
  if (!sharesSymbol && !sharesFile) {
    if (group.invalidPathCount === 0) {
      return false;
    }
    const sharedTerms = intersectionCount(attentionGroupTerms(group), rootCauseTerms(finding));
    const similarity = tokenJaccard(attentionGroupTerms(group), rootCauseTerms(finding));
    return sharedTerms >= 7 || similarity >= 0.55;
  }

  const sharedTerms = intersectionCount(attentionGroupTerms(group), rootCauseTerms(finding));
  const similarity = tokenJaccard(attentionGroupTerms(group), rootCauseTerms(finding));

  if (sharesSymbol) {
    return sharedTerms >= 4 || similarity >= 0.35;
  }
  return sharedTerms >= 5 || similarity >= 0.45;
}

function groupSharesFindingSymbol(
  group: AttentionHintGroup,
  finding: FinalFinding,
  packetsById: Map<string, ReviewPacket>
): boolean {
  const left = normalizedSet(group.symbols);
  if (left.size === 0) {
    return false;
  }
  const right = normalizedSet(symbolsForFinding(finding, packetsById));
  return right.size > 0 && [...left].some((symbol) => right.has(symbol));
}

function groupSharesFindingFile(group: AttentionHintGroup, finding: FinalFinding): boolean {
  const groupFiles = normalizedSet(group.files);
  if (groupFiles.size === 0) {
    return false;
  }
  const findingFiles = normalizedSet([
    finding.path,
    ...(finding.evidence.relatedCode ?? []).map((related) => related.path)
  ]);
  return [...groupFiles].some((file) => findingFiles.has(file));
}

function candidateFindingsById(
  packetResults: PacketReviewResult[],
  verifiedFindings: CandidateFinding[],
  verdicts: VerificationVerdict[]
): Map<string, CandidateFinding> {
  const candidates = new Map<string, CandidateFinding>();
  for (const result of packetResults) {
    for (const finding of result.findings) {
      candidates.set(finding.id, finding);
    }
  }
  for (const finding of verifiedFindings) {
    candidates.set(finding.id, finding);
  }
  for (const verdict of verdicts) {
    if (verdict.finalFinding !== undefined) {
      candidates.set(verdict.finalFinding.id, verdict.finalFinding);
    }
  }
  return candidates;
}

function verdictResolvesPredicate(verdict: VerificationVerdict): boolean {
  return verdict.verificationIncomplete !== true &&
    verdict.requiredEvidencePresent === true &&
    !/^verification disabled by config$/iu.test(verdict.reason.trim());
}

function candidateFiles(candidate: CandidateFinding, packetsById: Map<string, ReviewPacket>): string[] {
  const packet = packetsById.get(candidate.producedBy.packetId);
  return cleanStrings([
    candidate.path,
    candidate.anchor?.path ?? "",
    ...(candidate.provenance?.files ?? []),
    packet?.path ?? "",
    packet?.oldPath ?? ""
  ]);
}

function candidateSymbols(candidate: CandidateFinding, packetsById: Map<string, ReviewPacket>): string[] {
  return cleanStrings([
    ...symbolsForFinding(candidate, packetsById),
    ...(candidate.provenance?.symbols ?? [])
  ]);
}

function candidateResolutionText(candidate: CandidateFinding): string {
  return [
    candidate.title,
    candidate.failureMode,
    candidate.whyThisMatters,
    candidate.verification,
    candidate.suggestedFix ?? "",
    candidate.evidence.changedCode,
    ...(candidate.evidence.relatedCode ?? []).flatMap((related) => [related.path, related.lines, related.whyRelevant]),
    candidate.provenance?.question ?? "",
    candidate.provenance?.reason ?? ""
  ].join(" ");
}

function compareAttentionGroups(a: AttentionHintGroup, b: AttentionHintGroup): number {
  return attentionGroupRank(b) - attentionGroupRank(a) ||
    a.representative.question.localeCompare(b.representative.question) ||
    a.key.localeCompare(b.key);
}

function attentionGroupRank(group: AttentionHintGroup): number {
  const confidenceScore = (2 - confidenceRank(group.representative.confidence)) * 1000;
  const packetScore = Math.min(group.packetIds.size, 5) * 100;
  const duplicateScore = Math.min(group.count, 10) * 10;
  const specificityScore = Math.min(group.files.length, 3) + Math.min(group.symbols.length, 3) + (normalizedQuestionWords(group.representative.question).length >= 6 ? 2 : 0);
  return confidenceScore + packetScore + duplicateScore + specificityScore;
}

function strongerAttentionHint(a: AttentionHint, b: AttentionHint): AttentionHint {
  const confidenceDelta = confidenceRank(a.confidence) - confidenceRank(b.confidence);
  if (confidenceDelta !== 0) {
    return confidenceDelta < 0 ? a : b;
  }
  if (b.reason.trim().length > a.reason.trim().length) {
    return b;
  }
  return a;
}

function followUpHintKey(hint: AttentionHint): string {
  const exactQuestion = normalizeQuestion(hint.question);
  const looseQuestion = normalizeLooseQuestion(exactQuestion);
  if (exactQuestion === looseQuestion) {
    return `follow_up|exact|${exactQuestion}`;
  }
  const files = cleanStrings(hint.files).slice(0, 3).join(",");
  const symbols = cleanStrings(hint.symbols).slice(0, 3).join(",");
  return `follow_up|near|${looseQuestion}|files:${files}|symbols:${symbols}`;
}

function questionKeys(question: string): string[] {
  const exact = normalizeQuestion(question);
  const loose = normalizeLooseQuestion(exact);
  return [...new Set([exact, loose].filter((key) => key.length > 0))];
}

function normalizedQuestionWords(question: string): string[] {
  const normalized = normalizeLooseQuestion(normalizeQuestion(question));
  return normalized.length === 0 ? [] : normalized.split(" ");
}

function attentionGroupTerms(group: AttentionHintGroup): Set<string> {
  return normalizedTerms([
    group.representative.question,
    group.representative.reason,
    group.reasons.join(" "),
    group.symbols.join(" ")
  ].join(" "));
}

function rootCauseTerms(finding: CandidateFinding): Set<string> {
  return normalizedTerms([
    finding.title,
    finding.failureMode,
    finding.whyThisMatters,
    finding.suggestedFix ?? "",
    finding.evidence.changedCode,
    ...(finding.evidence.relatedCode ?? []).flatMap((related) => [related.whyRelevant, related.lines])
  ].join(" "));
}

function symbolsForFinding(finding: CandidateFinding, packetsById: Map<string, ReviewPacket>): string[] {
  const packet = packetsById.get(finding.producedBy.packetId);
  const symbols = new Set<string>();
  if (finding.anchor?.hunkId) {
    const symbol = symbolForHunk(packet, finding.anchor.hunkId);
    if (symbol !== undefined) {
      symbols.add(symbol);
    }
  }
  for (const hunk of matchingEvidenceHunks(finding, packet)) {
    const symbol = symbolForHunk(packet, hunk.hunkId);
    if (symbol !== undefined) {
      symbols.add(symbol);
    }
  }
  const packetSymbol = uniquePacketSymbol(packet);
  if (packetSymbol !== undefined) {
    symbols.add(packetSymbol);
  }
  return [...symbols];
}

function matchingEvidenceHunks(finding: CandidateFinding, packet: ReviewPacket | undefined): ReviewPacket["hunks"] {
  if (!packet) {
    return [];
  }
  const needle = normalizeSnippet(finding.evidence.changedCode);
  if (needle.length === 0) {
    return [];
  }
  return packet.hunks.filter((hunk) => {
    const haystack = normalizeSnippet(hunk.lines.map((line) => line.content).join("\n"));
    return haystack.length > 0 && (haystack.includes(needle) || needle.includes(haystack));
  });
}

function symbolForHunk(packet: ReviewPacket | undefined, hunkId: string): string | undefined {
  const symbols = [...new Set(
    (packet?.symbolFacts ?? [])
      .filter((fact) => fact.hunkId === hunkId)
      .map((fact) => fact.enclosingSymbol)
      .filter((symbol): symbol is string => symbol !== undefined && symbol.trim().length > 0)
  )];
  return symbols.length === 1 ? symbols[0] : undefined;
}

function uniquePacketSymbol(packet: ReviewPacket | undefined): string | undefined {
  const symbols = [...new Set(
    (packet?.symbolFacts ?? [])
      .map((fact) => fact.enclosingSymbol)
      .filter((symbol): symbol is string => symbol !== undefined && symbol.trim().length > 0)
  )];
  return symbols.length === 1 ? symbols[0] : undefined;
}

function normalizeSnippet(input: string): string {
  return input
    .split(/\r?\n/u)
    .map((line) => line.replace(/^\s*[+-]\s?/u, "").trim())
    .join("\n")
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizedTerms(text: string): Set<string> {
  const stopWords = new Set([
    "about",
    "after",
    "also",
    "before",
    "because",
    "being",
    "cannot",
    "check",
    "code",
    "confirm",
    "could",
    "from",
    "have",
    "into",
    "line",
    "more",
    "review",
    "should",
    "that",
    "this",
    "verify",
    "when",
    "where",
    "will",
    "with",
    "without",
    "would"
  ]);
  return new Set(text
    .toLowerCase()
    .replace(/[^a-z0-9_]+/gu, " ")
    .split(/\s+/u)
    .map((term) => term.trim())
    .filter((term) => term.length >= 4 && !stopWords.has(term)));
}

function normalizeQuestion(question: string): string {
  return question.toLowerCase()
    .replace(/[`"'’]/gu, "")
    .replace(/[^a-z0-9_./:-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizeLooseQuestion(question: string): string {
  return question
    .replace(/^(please\s+)?(check|confirm|verify|investigate|review)\s+(whether|if|that)?\s*/u, "")
    .replace(/^(whether|if)\s+/u, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizedSet(values: string[]): Set<string> {
  return new Set(values.map(normalize).filter(Boolean));
}

function sortedIntersection(a: Set<string>, b: Set<string>): string[] {
  return [...a].filter((value) => b.has(value)).sort();
}

function intersectionCount(a: Set<string>, b: Set<string>): number {
  let count = 0;
  for (const value of a) {
    if (b.has(value)) {
      count += 1;
    }
  }
  return count;
}

function tokenJaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) {
    return 0;
  }
  const shared = intersectionCount(a, b);
  return shared / (a.size + b.size - shared);
}

function cleanStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))].sort();
}

function capStrings(values: string[]): string[] {
  return values.slice(0, HUMAN_ATTENTION_LOCATION_CAP);
}

function mergeStrings(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])].sort();
}

function mergeDroppedPaths(
  a: Array<{ path: string; reason: string }>,
  b: Array<{ path: string; reason: string }>
): Array<{ path: string; reason: string }> {
  const byKey = new Map<string, { path: string; reason: string }>();
  for (const item of [...a, ...b]) {
    byKey.set(`${item.path}\0${item.reason}`, item);
  }
  return [...byKey.values()].sort((left, right) => left.path.localeCompare(right.path) || left.reason.localeCompare(right.reason));
}

function confidenceRank(confidence: Confidence): number {
  return { high: 0, medium: 1, low: 2 }[confidence];
}

function normalize(input: string): string {
  return input.toLowerCase().replace(/\s+/gu, " ").trim();
}
