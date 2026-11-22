import type {
  Confidence,
  NeedsHumanAttentionNote,
  PacketReviewResult,
  ReviewPacket,
  UnifiedDiff
} from "../types.js";
import type { TelemetryRecorder } from "../telemetry/telemetry-recorder.js";
import { sha256Hex } from "../util/hashing.js";
import {
  cleanStrings,
  normalizeFollowUpQuestion as normalizeQuestion,
  normalizeLooseFollowUpQuestion as normalizeLooseQuestion,
  normalizedAttentionTerms as normalizedTerms,
  tokenJaccard
} from "../util/text-similarity.js";

export const MAX_HUMAN_ATTENTION_NOTES = 5;
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

export type SelectedHumanAttention = {
  groups: AttentionHintGroup[];
  notes: NeedsHumanAttentionNote[];
  omittedCount: number;
};

export function buildHumanAttentionNotes(
  packetResults: PacketReviewResult[],
  options: { packets: ReviewPacket[]; diff?: UnifiedDiff; repositoryPaths?: readonly string[]; telemetry?: TelemetryRecorder; rawHints?: RawAttentionHint[] }
): HumanAttentionNotes {
  const raw = options.rawHints ?? rawAttentionHints(packetResults, knownAttentionPaths(options.packets, options.diff, options.repositoryPaths), options.telemetry);
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
  if (options.rawHints) {
    // Reconciliation works on original IDs. Grouping must not erase untouched
    // members just because they share a file or symbol with the representative.
    for (const group of ranked) {
      const questions = [...new Set(raw.filter(hint => group.rawNoteIds.has(hint.id)).map(hint => hint.question))];
      group.representative = { ...group.representative, question: questions.join("; ") };
    }
  }
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
): SelectedHumanAttention {
  const emittedGroups = groups.slice(0, MAX_HUMAN_ATTENTION_NOTES);
  const emitted = emittedGroups.map(toAttentionNote);
  return { groups: emittedGroups, notes: emitted, omittedCount: Math.max(0, groups.length - emitted.length) };
}

export function humanAttentionArtifact(
  attention: HumanAttentionNotes,
  output: SelectedHumanAttention,
  composerPromptGroups: AttentionHintGroup[],
  reconciled?: HumanAttentionNotes
): Record<string, unknown> {
  return {
    schemaVersion: 3,
    notes: attention.raw.map(rawAttentionHintArtifact),
    groups: attention.groups.map(attentionGroupArtifact),
    ...(reconciled ? { reconciledGroups: reconciled.groups.map(attentionGroupArtifact) } : {}),
    mergeStats: attention.mergeStats,
    composerPromptGroupIds: composerPromptGroups.map((group) => group.key),
    outputGroupIds: output.groups.map((group) => group.key),
    outputNotes: output.notes,
    omittedCount: output.omittedCount
  };
}

type KnownAttentionPaths = Map<string, "file" | "directory">;

function rawAttentionHints(
  packetResults: PacketReviewResult[],
  knownPaths: KnownAttentionPaths,
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

function knownAttentionPaths(packets: ReviewPacket[], diff: UnifiedDiff | undefined, repositoryPaths: readonly string[] = []): KnownAttentionPaths {
  const paths: KnownAttentionPaths = new Map();
  const add = (value: string | undefined) => {
    const normalized = normalizeAttentionPath(value ?? "");
    if (normalized === undefined) return;
    paths.set(normalized, "file");
    for (let slash = normalized.lastIndexOf("/"); slash > 0; slash = normalized.lastIndexOf("/", slash - 1)) {
      const parent = normalized.slice(0, slash);
      if (paths.has(parent)) break;
      paths.set(parent, "directory");
    }
  };
  // Unchanged files can answer packet questions too. These paths come from the
  // reviewed Git tree, not model output or the current worktree.
  for (const filePath of repositoryPaths) add(filePath);
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
  knownPaths: KnownAttentionPaths,
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
    if (validation.reason === "directory") continue;
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

function validateAttentionPath(pathValue: string, knownPaths: KnownAttentionPaths): { validPath?: string; reason: string } {
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
  if (knownPaths.size === 0 || knownPaths.get(normalized) === "file") {
    return { validPath: normalized, reason: "valid" };
  }
  return { reason: knownPaths.get(normalized.replace(/\/$/u, "")) === "directory" ? "directory" : "unknown_path" };
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
