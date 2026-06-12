import type { TelemetryRecorder } from "../telemetry/telemetry-recorder.js";
import { withRepositoryToolCallContext } from "../repo/repository-index.js";
import type {
  CodeninjaConfig,
  CoverageLevel,
  DiffFile,
  DiffHunk,
  DiffLine,
  FileFacts,
  HunkCoverageDecision,
  HunkSymbolFacts,
  PacketHunk,
  PacketLine,
  PlannerDossier,
  RepositoryIndex,
  RepositoryToolsHost,
  ReviewPacket,
  ReviewPlan,
  ReviewPriority,
  StaticSignal,
  SurroundingContextHint,
  SymbolInfo,
  ToolBudget
} from "../types.js";
import { sha256Hex } from "../util/hashing.js";

type PacketBuildOptions = {
  config: CodeninjaConfig;
  enabledLenses: string[];
  reviewContext?: PacketReviewContext;
};

type PacketReviewContext = {
  prSummary: string;
  intentText?: string;
};

type PlannedHunk = {
  file: DiffFile;
  hunk: DiffHunk;
  facts: FileFacts;
  symbolFacts: HunkSymbolFacts[];
  staticSignals: StaticSignal[];
  decision?: HunkCoverageDecision;
};

type PacketGroup = {
  hunks: PlannedHunk[];
  kind: ReviewPacket["kind"];
  fileContext?: ReviewPacket["fileContext"];
  wholeFileText?: string;
  degradationReason?: string;
};

const MAX_HUNKS_PER_PACKET = 5;
const MAX_LENSES_PER_PACKET = 6;
const MAX_PATCH_CHARS = 12_000;
const MAX_CONTEXT_CHARS = 8_000;
const MAX_SYMBOL_CONTEXT_CHARS = 3_000;
const MAX_HINT_CONTEXT_CHARS = 2_000;
const MAX_HINT_CONTEXT_LINES = 80;
const NEARBY_GAP_LINES = 30;

export async function buildReviewPackets(
  plan: ReviewPlan,
  filtered: DiffFile[],
  fileFacts: FileFacts[],
  repoIndex: RepositoryIndex,
  telemetry: TelemetryRecorder,
  opts: PacketBuildOptions
): Promise<ReviewPacket[]> {
  telemetry.event({ stage: 6, level: "info", message: "stage_started", data: { name: "packet_builder" } });
  const factsByPath = new Map(fileFacts.map((facts) => [facts.path, facts]));
  const decisions = new Map(plan.coverage.map((decision) => [decision.hunkId, decision]));
  const packets: ReviewPacket[] = [];

  for (const file of filtered) {
    const facts = factsByPath.get(file.path) ?? fallbackFacts(file);
    const planned = file.hunks.map((hunk): PlannedHunk => ({
      file,
      hunk,
      facts,
      symbolFacts: repoIndex.symbolFacts.filter((entry) => entry.hunkId === hunk.id),
      staticSignals: repoIndex.staticSignals.filter((entry) => entry.path === file.path),
      ...(decisions.get(hunk.id) !== undefined ? { decision: decisions.get(hunk.id) as HunkCoverageDecision } : {})
    }));
    const effectiveByHunk = new Map(planned.map((entry) => [entry.hunk.id, effectiveDecision(entry, opts.enabledLenses, telemetry)]));
    const includedPlanned = planned.filter((entry) => effectiveByHunk.get(entry.hunk.id)?.coverage !== "skip");
    if (includedPlanned.length === 0) {
      continue;
    }
    const allowWholeFileContext = includedPlanned.length === planned.length;

    for (const group of await groupHunks(includedPlanned, repoIndex, telemetry, { allowWholeFileContext })) {
      const first = group.hunks[0];
      if (!first) {
        continue;
      }
      const groupDecisions = group.hunks.map((entry) => effectiveByHunk.get(entry.hunk.id)).filter((decision): decision is EffectiveDecision => decision !== undefined);
      const includedDecisions = groupDecisions.filter(isNonSkipDecision);
      const packet = await buildPacket(group.hunks, includedDecisions, group, plan, repoIndex, opts.config, telemetry, opts.reviewContext);
      packets.push(packet);
      await telemetry.writeArtifact(`packets/${packet.id}.json`, packet);
    }
  }

  telemetry.event({ stage: 6, level: "info", message: "stage_completed", data: { packets: packets.length } });
  return packets;
}

async function groupHunks(
  planned: PlannedHunk[],
  repoIndex: RepositoryIndex,
  telemetry: TelemetryRecorder,
  opts: { allowWholeFileContext: boolean } = { allowWholeFileContext: true }
): Promise<PacketGroup[]> {
  if (planned.length === 0) {
    return [];
  }
  const first = planned[0];
  if (!first) {
    return [];
  }
  const wholeFileReason = first.facts.processingMode === "whole-file"
    ? "configured whole-file review"
    : first.file.status === "added"
      ? "small added file"
      : undefined;

  if (opts.allowWholeFileContext && wholeFileReason !== undefined && planned.length <= MAX_HUNKS_PER_PACKET) {
    const patchChars = combinedPatchChars(planned);
    if (patchChars <= MAX_PATCH_CHARS) {
      const content = await headContentProbe(first.file, repoIndex, telemetry);
      if (content.fits) {
        return [{
          hunks: planned,
          kind: "whole-file",
          fileContext: { mode: "whole-file", reason: wholeFileReason },
          wholeFileText: content.text
        }];
      }
      return [{
        hunks: planned,
        kind: "file-diff",
        fileContext: { mode: "file-diff", reason: content.reason }
      }];
    }
    const reason = `whole-file downgraded: combined patch exceeds ${MAX_PATCH_CHARS} chars`;
    telemetry.event({
      stage: 6,
      level: "warn",
      message: "whole_file_patch_too_large",
      file: first.file.path,
      data: { patchChars, maxPatchChars: MAX_PATCH_CHARS }
    });
    return hunkFirstGroups(planned, reason);
  }
  return hunkFirstGroups(planned);
}

async function buildPacket(
  planned: PlannedHunk[],
  decisions: NonSkipDecision[],
  group: PacketGroup,
  plan: ReviewPlan,
  repoIndex: RepositoryIndex,
  config: CodeninjaConfig,
  telemetry: TelemetryRecorder,
  reviewContext: PacketReviewContext | undefined
): Promise<ReviewPacket> {
  const first = planned[0];
  if (!first) {
    throw new Error("cannot build empty packet");
  }
  const hunkIds = planned.map((entry) => entry.hunk.id);
  const kind = packetKind(group, planned, first.file);
  const coverage = maxCoverage(decisions.map((decision) => decision.coverage));
  const symbolFacts = planned.flatMap((entry) => entry.symbolFacts);
  const context = await buildContext(repoIndex, first.file, planned.map((entry) => entry.hunk), symbolFacts, telemetry);
  const hintContext = await resolvePacketContextHints(repoIndex, first.file, decisions.flatMap((decision) => decision.surroundingContextHints), telemetry);
  const packetHunks = planned.map((entry, index) => renderPacketHunk(entry.hunk, telemetry, plannerFallbackReason(decisions[index]?.reason)));
  const truncationReason = truncationReasons(packetHunks).join("; ");
  const auxiliaryContextText = [context.text, hintContext.text].filter((text) => text.trim().length > 0).join("\n\n");
  const renderedContext = renderPacketContextText(first.file.path, group.wholeFileText, auxiliaryContextText);
  const contextDropReason = renderedContext.auxiliaryContextDropped
    ? "auxiliary packet context omitted to preserve complete whole-file content"
    : undefined;
  const contextTruncationReason = renderedContext.contextTruncated
    ? `packet context truncated to ${MAX_CONTEXT_CHARS} chars`
    : undefined;
  if (contextTruncationReason !== undefined) {
    telemetry.event({
      stage: 6,
      level: "warn",
      message: "packet_context_truncated",
      file: first.file.path,
      data: { maxContextChars: MAX_CONTEXT_CHARS }
    });
  }
  const packet: ReviewPacket = {
    id: sha256Hex(`${first.file.path}\n${[...hunkIds].sort().join("\n")}\n${kind}`),
    kind,
    prSummary: (reviewContext?.prSummary ?? "Review local diff.").slice(0, 500),
    path: first.file.path,
    ...(first.file.oldPath !== undefined ? { oldPath: first.file.oldPath } : {}),
    fileStatus: first.file.status,
    isDeletedContent: first.file.status === "deleted",
    language: first.facts.language,
    reviewPriority: maxReviewPriority(planned.map((entry) => entry.facts.reviewPriority)),
    coverage,
    lenses: boundedLensUnion(decisions.flatMap((decision) => decision.lenses), first.facts.language, first.file.path, telemetry),
    hunks: packetHunks,
    symbolFacts,
    context: context.context,
    contextText: renderedContext.text,
    relevantTests: context.relevantTests,
    surroundingContextHints: hintContext.workerHints,
    labels: first.facts.labels,
    riskNotes: plan.riskAreas.filter((area) => area.files.includes(first.file.path)).slice(0, 3).map((area) => area.reason),
    toolBudget: toolBudget(coverage, config.review.depth),
    ...(reviewContext?.intentText !== undefined ? { intentText: reviewContext.intentText } : {}),
    ...(context.degradation !== undefined || hintContext.degradation !== undefined || truncationReason.length > 0 || contextDropReason !== undefined || contextTruncationReason !== undefined || group.degradationReason !== undefined
      ? { degraded: { reason: [context.degradation, hintContext.degradation, truncationReason, contextDropReason, contextTruncationReason, group.degradationReason].filter(Boolean).join("; ") } }
      : {}),
    ...(group.fileContext !== undefined
      ? { fileContext: group.fileContext }
      : kind === "file-diff"
        ? { fileContext: { mode: "file-diff", reason: "grouped file hunks" } }
        : {})
  };
  return packet;
}

export function packetReviewContextFromDossier(dossier: PlannerDossier): PacketReviewContext {
  const title = deterministicDeclaredIntent(dossier);
  const summary = truncateTail(
    `${title} (${dossier.totals.files} changed file${dossier.totals.files === 1 ? "" : "s"}, ${dossier.totals.hunks} reviewable hunk${dossier.totals.hunks === 1 ? "" : "s"}, +${dossier.totals.addedLines}/-${dossier.totals.deletedLines}).`,
    500
  );
  const body = dossier.pr?.body?.trim();
  const commitBody = dossier.commits[0]?.body?.trim();
  const intentParts = [title, body && body.length > 0 ? body : commitBody].filter((part): part is string => part !== undefined && part.length > 0);
  return {
    prSummary: summary,
    ...(intentParts.length > 0 ? { intentText: truncateTail(intentParts.join("\n\n"), 1000) } : {})
  };
}

function deterministicDeclaredIntent(dossier: PlannerDossier): string {
  const prTitle = dossier.pr?.title?.trim();
  if (prTitle && prTitle.length > 0) {
    return prTitle;
  }
  const commitTitle = dossier.commits[0]?.title?.trim();
  if (commitTitle && commitTitle.length > 0) {
    return commitTitle;
  }
  return "Review local diff.";
}

function hunkFirstGroups(planned: PlannedHunk[], degradationReason?: string): PacketGroup[] {
  const groups: PacketGroup[] = [];
  let current: PlannedHunk[] = [];

  for (const entry of planned) {
    if (current.length === 0) {
      current = [entry];
      continue;
    }
    const candidate = [...current, entry];
    if (canJoinGroup(current, entry) && candidate.length <= MAX_HUNKS_PER_PACKET && combinedPatchChars(candidate) <= MAX_PATCH_CHARS) {
      current = candidate;
      continue;
    }
    groups.push(packetGroup(current, degradationReason));
    current = [entry];
  }
  if (current.length > 0) {
    groups.push(packetGroup(current, degradationReason));
  }
  return groups;
}

function canJoinGroup(current: PlannedHunk[], next: PlannedHunk): boolean {
  const previous = current[current.length - 1];
  if (!previous || previous.file.path !== next.file.path) {
    return false;
  }
  return sameEnclosingSymbol(current, next) || nearbyHunk(previous.hunk, next.hunk);
}

function sameEnclosingSymbol(current: PlannedHunk[], next: PlannedHunk): boolean {
  const currentSymbol = symbolIdentity(current[current.length - 1]);
  const nextSymbol = symbolIdentity(next);
  return currentSymbol !== undefined && currentSymbol === nextSymbol;
}

function symbolIdentity(entry: PlannedHunk | undefined): string | undefined {
  const fact = entry?.symbolFacts.find((candidate) => candidate.enclosingSymbol !== undefined);
  if (!fact?.enclosingSymbol) {
    return undefined;
  }
  return `${fact.enclosingSymbol}:${fact.symbolRange?.join("-") ?? ""}`;
}

function nearbyHunk(previous: DiffHunk, next: DiffHunk): boolean {
  const previousEnd = previous.newLines > 0
    ? previous.newStart + previous.newLines - 1
    : previous.newStart;
  const nextStart = next.newLines > 0 ? next.newStart : next.oldStart;
  return Math.abs(nextStart - previousEnd) <= NEARBY_GAP_LINES;
}

function packetGroup(hunks: PlannedHunk[], degradationReason?: string): PacketGroup {
  const first = hunks[0];
  const kind: ReviewPacket["kind"] =
    first && hunks.length > 1 && hunks.length === first.file.hunks.length
      ? "file-diff"
      : hunks.length > 1
        ? "coalesced-hunks"
        : "hunk";
  return { hunks, kind, ...(degradationReason !== undefined ? { degradationReason } : {}) };
}

function packetKind(group: PacketGroup, planned: PlannedHunk[], file: DiffFile): ReviewPacket["kind"] {
  if (group.kind === "whole-file" || group.kind === "file-diff") {
    return group.kind;
  }
  if (planned.length > 1 && planned.length === file.hunks.length) {
    return "file-diff";
  }
  if (planned.length > 1) {
    return "coalesced-hunks";
  }
  return "hunk";
}

type EffectiveDecision = {
  coverage: CoverageLevel;
  lenses: string[];
  surroundingContextHints: HunkCoverageDecision["surroundingContextHints"];
  reason: string;
};

type NonSkipDecision = EffectiveDecision & { coverage: Exclude<CoverageLevel, "skip"> };

function isNonSkipDecision(decision: EffectiveDecision): decision is NonSkipDecision {
  return decision.coverage !== "skip";
}

function effectiveDecision(
  planned: PlannedHunk,
  enabledLenses: string[],
  telemetry: TelemetryRecorder
): EffectiveDecision {
  const decision = planned.decision;
  if (!decision) {
    telemetry.event({
      stage: 6,
      level: "warn",
      message: "planner_missing_coverage",
      file: planned.file.path,
      data: { hunkId: planned.hunk.id }
    });
    return {
      coverage: "normal",
      lenses: defaultLensesForLanguage(planned.facts.language, enabledLenses),
      surroundingContextHints: [],
      reason: "planner_missing_coverage"
    };
  }
  if (decision.coverage === "skip") {
    telemetry.event({
      stage: 6,
      level: "info",
      message: "planner_hunk_skipped",
      file: planned.file.path,
      data: { hunkId: planned.hunk.id, reason: decision.reason }
    });
    return decision;
  }
  if (decision.lenses.length === 0) {
    telemetry.event({
      stage: 6,
      level: "warn",
      message: "planner_empty_lenses",
      file: planned.file.path,
      data: { hunkId: planned.hunk.id }
    });
    return {
      ...decision,
      lenses: defaultLensesForLanguage(planned.facts.language, enabledLenses),
      reason: `planner_empty_lenses: ${decision.reason}`
    };
  }
  return decision;
}

function plannerFallbackReason(reason: string | undefined): string | undefined {
  if (reason === undefined) {
    return undefined;
  }
  return reason.startsWith("planner_missing_coverage") || reason.startsWith("planner_empty_lenses") || reason.startsWith("planner_invalid_skip")
    ? reason
    : undefined;
}

function renderPacketHunk(hunk: DiffHunk, telemetry: TelemetryRecorder, plannerFallback: string | undefined = undefined): PacketHunk {
  const lines = hunk.lines.map(packetLine);
  const changedNewLineNumbers = lines.flatMap((line) => (line.kind === "add" && line.newLine !== undefined ? [line.newLine] : []));
  const changedOldLineNumbers = lines.flatMap((line) => (line.kind === "delete" && line.oldLine !== undefined ? [line.oldLine] : []));
  const window = patchWindow(lines);
  if (window.truncated) {
    telemetry.event({
      stage: 6,
      level: "warn",
      message: "packet_hunk_truncated",
      file: hunk.path,
      data: { hunkId: hunk.id, omittedLineCount: window.omittedLineCount, maxPatchChars: MAX_PATCH_CHARS }
    });
  }
  return {
    hunkId: hunk.id,
    oldStart: hunk.oldStart,
    oldLines: hunk.oldLines,
    newStart: hunk.newStart,
    newLines: hunk.newLines,
    header: hunk.header,
    lines: window.lines,
    contentWithLineNumbers: window.contentWithLineNumbers,
    changedNewLineNumbers,
    changedOldLineNumbers,
    ...(plannerFallback !== undefined ? { plannerFallbackReason: plannerFallback } : {}),
    ...(window.truncated ? { truncated: true, omittedLineCount: window.omittedLineCount } : {})
  };
}

function truncationReasons(hunks: PacketHunk[]): string[] {
  return hunks.flatMap((hunk) =>
    hunk.truncated
      ? [`patch truncated: ${hunk.omittedLineCount ?? 0} line(s) omitted from ${hunk.hunkId}`]
      : []
  );
}

function patchWindow(lines: PacketLine[]): { lines: PacketLine[]; contentWithLineNumbers: string; truncated: boolean; omittedLineCount: number } {
  const full = renderLines(lines);
  if (full.length <= MAX_PATCH_CHARS) {
    return { lines, contentWithLineNumbers: full, truncated: false, omittedLineCount: 0 };
  }

  const changedIndices = lines
    .map((line, index) => (line.kind === "context" ? -1 : index))
    .filter((index) => index >= 0);
  const center = changedIndices[Math.floor(changedIndices.length / 2)] ?? Math.floor(lines.length / 2);
  let start = center;
  let end = center;
  let windowLines = fitWindow(lines, start, end);
  let expanded = true;

  while (expanded) {
    expanded = false;
    const before = start > 0 ? fitWindow(lines, start - 1, end) : undefined;
    if (before && before.contentWithLineNumbers.length <= MAX_PATCH_CHARS) {
      start -= 1;
      windowLines = before;
      expanded = true;
    }
    const after = end < lines.length - 1 ? fitWindow(lines, start, end + 1) : undefined;
    if (after && after.contentWithLineNumbers.length <= MAX_PATCH_CHARS) {
      end += 1;
      windowLines = after;
      expanded = true;
    }
  }

  return {
    lines: windowLines.lines,
    contentWithLineNumbers: windowLines.contentWithLineNumbers,
    truncated: true,
    omittedLineCount: lines.length - windowLines.lines.length
  };
}

function fitWindow(lines: PacketLine[], start: number, end: number): { lines: PacketLine[]; contentWithLineNumbers: string } {
  const selected = lines.slice(start, end + 1);
  const contentWithLineNumbers = renderWindow(selected, start, end, lines.length);
  if (contentWithLineNumbers.length <= MAX_PATCH_CHARS || selected.length !== 1) {
    return { lines: selected, contentWithLineNumbers };
  }

  const line = selected[0];
  if (!line) {
    return { lines: [], contentWithLineNumbers: "" };
  }
  const originalContent = line.content;
  let fitted = line;
  for (let contentLength = Math.max(0, originalContent.length - 1); contentLength >= 0; contentLength -= Math.max(1, Math.ceil(contentLength / 4))) {
    const truncatedChars: number = originalContent.length - contentLength;
    const marker = ` [... ${truncatedChars} chars truncated ...]`;
    const contentBudget = Math.max(0, contentLength - marker.length);
    fitted = { ...line, content: `${originalContent.slice(0, contentBudget)}${marker}` };
    const rendered = renderWindow([fitted], start, end, lines.length);
    if (rendered.length <= MAX_PATCH_CHARS || contentBudget === 0) {
      return { lines: [fitted], contentWithLineNumbers: rendered };
    }
  }
  return { lines: [fitted], contentWithLineNumbers: renderWindow([fitted], start, end, lines.length) };
}

function renderWindow(lines: PacketLine[], start: number, end: number, totalLines: number): string {
  const parts: string[] = [];
  if (start > 0) {
    parts.push(`[... ${start} lines omitted above ...]`);
  }
  parts.push(renderLines(lines));
  const omittedBelow = totalLines - end - 1;
  if (omittedBelow > 0) {
    parts.push(`[... ${omittedBelow} lines omitted below ...]`);
  }
  return parts.filter(Boolean).join("\n");
}

function packetLine(line: DiffLine): PacketLine {
  return {
    kind: line.kind,
    content: line.content,
    ...(line.oldLineNumber !== undefined ? { oldLine: line.oldLineNumber } : {}),
    ...(line.newLineNumber !== undefined ? { newLine: line.newLineNumber } : {})
  };
}

function renderLines(lines: PacketLine[]): string {
  return lines
    .map((line) => {
      const oldLine = line.oldLine === undefined ? " " : String(line.oldLine);
      const newLine = line.newLine === undefined ? " " : String(line.newLine);
      const prefix = line.kind === "add" ? "+" : line.kind === "delete" ? "-" : " ";
      return `${oldLine.padStart(4)} ${newLine.padStart(4)} ${prefix}${line.content}`;
    })
    .join("\n");
}

function combinedPatchChars(planned: PlannedHunk[]): number {
  return planned.reduce((sum, entry) => sum + renderLines(entry.hunk.lines.map(packetLine)).length, 0);
}

async function headContentProbe(
  file: DiffFile,
  repoIndex: RepositoryIndex,
  telemetry: TelemetryRecorder
): Promise<{ fits: true; reason: string; text: string } | { fits: false; reason: string }> {
  const source = file.status === "deleted" ? { kind: "base" as const } : { kind: "head" as const };
  const readPath = file.status === "deleted" ? file.oldPath ?? file.path : file.path;
  const sourceLabel = source.kind === "base" ? "base" : "head";
  try {
    const result = await withRepositoryToolCallContext(
      repoIndex.tools,
      { stage: 6, initiator: "harness" },
      () => repoIndex.tools.readRange(readPath, 1, 10_000, source)
    );
    if (result.meta.degraded) {
      return { fits: false, reason: `whole-file downgraded: ${sourceLabel} content unavailable` };
    }
    const renderedWholeFileLength = renderWholeFileBlock(file.path, result.text).length;
    const tooLarge = renderedWholeFileLength > MAX_CONTEXT_CHARS || result.meta.truncated === true;
    return tooLarge
      ? { fits: false, reason: `whole-file downgraded: rendered ${sourceLabel} content exceeds ${MAX_CONTEXT_CHARS} chars` }
      : { fits: true, reason: `${sourceLabel} content fits whole-file context budget`, text: result.text };
  } catch (error) {
    telemetry.event({
      stage: 6,
      level: "warn",
      message: "whole_file_content_probe_failed",
      file: file.path,
      data: { path: readPath, source: source.kind, error: error instanceof Error ? error.message : String(error) }
    });
    return { fits: false, reason: `whole-file downgraded: ${sourceLabel} content unavailable` };
  }
}

function renderPacketContextText(
  path: string,
  wholeFileText: string | undefined,
  contextText: string
): { text: string; auxiliaryContextDropped: boolean; contextTruncated: boolean } {
  if (wholeFileText === undefined) {
    if (contextText.length > MAX_CONTEXT_CHARS) {
      return { text: truncateTail(contextText, MAX_CONTEXT_CHARS), auxiliaryContextDropped: false, contextTruncated: true };
    }
    return { text: contextText, auxiliaryContextDropped: false, contextTruncated: false };
  }
  const wholeFileBlock = renderWholeFileBlock(path, wholeFileText);
  if (contextText.trim().length === 0) {
    return { text: wholeFileBlock, auxiliaryContextDropped: false, contextTruncated: false };
  }
  const combined = `${wholeFileBlock}\n\n${contextText}`;
  if (combined.length <= MAX_CONTEXT_CHARS) {
    return { text: combined, auxiliaryContextDropped: false, contextTruncated: false };
  }
  return { text: wholeFileBlock, auxiliaryContextDropped: true, contextTruncated: false };
}

function renderWholeFileBlock(path: string, wholeFileText: string): string {
  return wholeFileText.trim().length > 0
    ? `Whole file content for ${path}:\n${wholeFileText}`
    : `Whole file content for ${path}: <empty file>`;
}

function truncateTail(input: string, maxChars: number): string {
  if (input.length <= maxChars) {
    return input;
  }
  const marker = "\n[... content truncated to fit packet context budget ...]";
  return `${input.slice(0, Math.max(0, maxChars - marker.length)).trimEnd()}${marker}`;
}

async function buildContext(
  repoIndex: RepositoryIndex,
  file: DiffFile,
  hunks: DiffHunk[],
  symbolFacts: HunkSymbolFacts[],
  telemetry: TelemetryRecorder
): Promise<{ context: ReviewPacket["context"]; text: string; relevantTests: SymbolInfo[]; degradation?: string }> {
  if (!isToolsHost(repoIndex.tools)) {
    return { context: { path: file.path }, text: "", relevantTests: [] };
  }
  try {
    const result = await repoIndex.tools.buildPacketContext(file, hunks, symbolFacts);
    const symbolSource = await readEnclosingSymbolSource(repoIndex, file, symbolFacts, telemetry);
    const degradation = [result.degradation, symbolSource.degradation].filter(Boolean).join("; ");
    return {
      context: result.context,
      text: renderContext(result, symbolSource.text),
      relevantTests: result.relevantTests,
      ...(degradation.length > 0 ? { degradation } : {})
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    telemetry.event({ stage: 6, level: "warn", message: "packet_context_degraded", file: file.path, data: { error: message } });
    return { context: { path: file.path }, text: "", relevantTests: [], degradation: message };
  }
}

async function readEnclosingSymbolSource(
  repoIndex: RepositoryIndex,
  file: DiffFile,
  symbolFacts: HunkSymbolFacts[],
  telemetry: TelemetryRecorder
): Promise<{ text: string; degradation?: string }> {
  const fact = primarySymbolFact(symbolFacts);
  const selector = fact === undefined ? undefined : symbolSourceSelector(fact);
  if (fact === undefined || selector === undefined) {
    return { text: "" };
  }
  const source = fact.changedLinesSide === "old" ? { kind: "base" as const } : { kind: "head" as const };
  const readPath = fact.changedLinesSide === "old" ? file.oldPath ?? file.path : file.path;
  try {
    const result = await withRepositoryToolCallContext(
      repoIndex.tools,
      { stage: 6, initiator: "harness" },
      () => repoIndex.tools.readSymbol(readPath, selector, source)
    );
    if (result.text === undefined || result.text.trim().length === 0) {
      return result.meta.degraded
        ? { text: "", degradation: result.meta.degradationReason ?? "enclosing symbol source unavailable" }
        : { text: "" };
    }
    const label = result.symbol?.name ?? fact.enclosingSymbol ?? `line ${String(selector.line ?? "")}`.trim();
    const block = [
      `Enclosing symbol source for ${readPath}:${label}`,
      result.text.trimEnd()
    ].join("\n");
    const truncated = block.length > MAX_SYMBOL_CONTEXT_CHARS;
    const text = truncateTail(block, MAX_SYMBOL_CONTEXT_CHARS);
    if (truncated || result.meta.truncated === true) {
      telemetry.event({
        stage: 6,
        level: "warn",
        message: "packet_symbol_source_truncated",
        file: file.path,
        data: {
          hunkId: fact.hunkId,
          symbol: result.symbol?.name ?? fact.enclosingSymbol,
          path: readPath,
          maxChars: MAX_SYMBOL_CONTEXT_CHARS,
          providerTruncated: result.meta.truncated === true
        }
      });
      return { text, degradation: "enclosing symbol source truncated" };
    }
    return { text };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    telemetry.event({
      stage: 6,
      level: "warn",
      message: "packet_symbol_source_unavailable",
      file: file.path,
      data: { hunkId: fact.hunkId, path: readPath, error: message }
    });
    return { text: "", degradation: `enclosing symbol source unavailable: ${message}` };
  }
}

function primarySymbolFact(symbolFacts: HunkSymbolFacts[]): HunkSymbolFacts | undefined {
  return [...symbolFacts]
    .filter((fact) => fact.symbolRange !== undefined || fact.changedLines.length > 0 || fact.enclosingSymbol !== undefined)
    .sort((a, b) => {
      const lineA = a.symbolRange?.[0] ?? a.changedLines[0] ?? Number.MAX_SAFE_INTEGER;
      const lineB = b.symbolRange?.[0] ?? b.changedLines[0] ?? Number.MAX_SAFE_INTEGER;
      const named = Number(b.enclosingSymbol !== undefined) - Number(a.enclosingSymbol !== undefined);
      return lineA - lineB || named || a.hunkId.localeCompare(b.hunkId);
    })[0];
}

function symbolSourceSelector(fact: HunkSymbolFacts): { symbolName?: string; line?: number } | undefined {
  const line = fact.symbolRange?.[0] ?? fact.changedLines[0];
  if (line !== undefined) {
    return { line };
  }
  return fact.enclosingSymbol !== undefined ? { symbolName: fact.enclosingSymbol } : undefined;
}

async function resolvePacketContextHints(
  repoIndex: RepositoryIndex,
  file: DiffFile,
  hints: SurroundingContextHint[],
  telemetry: TelemetryRecorder
): Promise<{ text: string; workerHints: SurroundingContextHint[]; degradation?: string }> {
  const blocks: string[] = [];
  const workerHints: SurroundingContextHint[] = [];
  const failures: string[] = [];

  for (const hint of hints) {
    if (hint.expectedUse !== "packet_context") {
      workerHints.push(hint);
      continue;
    }
    const hintPath = hint.path ?? file.path;
    if (hintPath !== file.path) {
      workerHints.push(toToolLookupHint(hint));
      continue;
    }
    try {
      const resolved = await resolvePacketContextHint(repoIndex, hint, hintPath);
      if (resolved === undefined) {
        workerHints.push(toToolLookupHint(hint));
        continue;
      }
      blocks.push(resolved);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      telemetry.event({
        stage: 6,
        level: "warn",
        message: "packet_context_hint_unresolved",
        file: hintPath,
        data: { kind: hint.kind, reason: hint.reason, error: message }
      });
      failures.push(`${hintPath}: ${hint.reason}`);
      workerHints.push(toToolLookupHint(hint));
    }
  }

  return {
    text: truncateTail(blocks.join("\n\n"), MAX_HINT_CONTEXT_CHARS),
    workerHints,
    ...(failures.length > 0 ? { degradation: `planner packet_context hint(s) unresolved: ${failures.slice(0, 3).join("; ")}` } : {})
  };
}

async function resolvePacketContextHint(
  repoIndex: RepositoryIndex,
  hint: SurroundingContextHint,
  path: string
): Promise<string | undefined> {
  if (hint.lineRange !== undefined) {
    const start = Math.max(1, Math.min(hint.lineRange[0], hint.lineRange[1]));
    const end = Math.min(Math.max(hint.lineRange[0], hint.lineRange[1]), start + MAX_HINT_CONTEXT_LINES - 1);
    const result = await withRepositoryToolCallContext(
      repoIndex.tools,
      { stage: 6, initiator: "harness" },
      () => repoIndex.tools.readRange(path, start, end, { kind: "head" })
    );
    return renderHintContextBlock(hint, path, `${start}-${end}`, result.text);
  }
  const symbol = hint.symbol;
  if (symbol !== undefined) {
    const result = await withRepositoryToolCallContext(
      repoIndex.tools,
      { stage: 6, initiator: "harness" },
      () => repoIndex.tools.readSymbol(path, { symbolName: symbol }, { kind: "head" })
    );
    if (result.text === undefined || result.text.trim().length === 0) {
      return undefined;
    }
    return renderHintContextBlock(hint, path, symbol, result.text);
  }
  return undefined;
}

function renderHintContextBlock(
  hint: SurroundingContextHint,
  path: string,
  locator: string,
  text: string
): string {
  return truncateTail(
    [
      `Planner packet context (${hint.kind}) for ${path}:${locator}`,
      `Reason: ${hint.reason}`,
      text.trimEnd()
    ].filter((part) => part.length > 0).join("\n"),
    MAX_HINT_CONTEXT_CHARS
  );
}

function toToolLookupHint(hint: SurroundingContextHint): SurroundingContextHint {
  return { ...hint, expectedUse: "tool_lookup" };
}

function renderContext(result: Awaited<ReturnType<RepositoryToolsHost["buildPacketContext"]>>, symbolSourceText = ""): string {
  const parts: string[] = [];
  if (symbolSourceText.trim().length > 0) {
    parts.push(symbolSourceText);
  }
  if (result.outline) {
    parts.push(`Outline for ${result.outline.path}`);
    if (result.outline.imports.length > 0) {
      parts.push(`Imports: ${result.outline.imports.join(", ")}`);
    }
    if (result.outline.topLevelSymbols.length > 0) {
      parts.push(`Top-level symbols: ${result.outline.topLevelSymbols.map((symbol) => symbol.name).join(", ")}`);
    }
  }
  if (result.relevantTests.length > 0) {
    parts.push(`Likely tests: ${result.relevantTests.map((symbol) => `${symbol.path}:${symbol.name}`).join(", ")}`);
  }
  return parts.join("\n");
}

function isToolsHost(tools: RepositoryIndex["tools"]): tools is RepositoryToolsHost {
  return typeof (tools as RepositoryToolsHost).buildPacketContext === "function";
}

function maxCoverage(levels: Array<Exclude<CoverageLevel, "skip">>): Exclude<CoverageLevel, "skip"> {
  if (levels.includes("deep")) {
    return "deep";
  }
  if (levels.includes("normal")) {
    return "normal";
  }
  return "light";
}

function boundedLensUnion(lenses: string[], language: string, filePath: string, telemetry: TelemetryRecorder): string[] {
  const frequencies = new Map<string, number>();
  for (const lens of lenses) {
    frequencies.set(lens, (frequencies.get(lens) ?? 0) + 1);
  }
  const unique = [...frequencies.keys()];
  const languageLens = primaryLanguageLens(language, unique);
  const coreLenses = unique
    .filter((lens) => lens !== languageLens && lens.startsWith("core/"))
    .sort();
  const customLenses = unique
    .filter((lens) => lens !== languageLens && !lens.startsWith("core/"))
    .sort((a, b) => (frequencies.get(b) ?? 0) - (frequencies.get(a) ?? 0) || a.localeCompare(b));
  const ordered = [
    ...(languageLens !== undefined ? [languageLens] : []),
    ...coreLenses,
    ...customLenses
  ];
  const kept = ordered.slice(0, MAX_LENSES_PER_PACKET);
  const dropped = ordered.slice(MAX_LENSES_PER_PACKET);
  if (dropped.length > 0) {
    telemetry.event({
      stage: 6,
      level: "warn",
      message: "packet_lenses_dropped",
      file: filePath,
      data: { kept, dropped, maxLenses: MAX_LENSES_PER_PACKET }
    });
  }
  return kept;
}

function primaryLanguageLens(language: string, lenses: string[]): string | undefined {
  if (language === "go" && lenses.includes("lang/go")) {
    return "lang/go";
  }
  if (["typescript", "javascript", "ts", "js", "tsx", "jsx"].includes(language) && lenses.includes("lang/typescript")) {
    return "lang/typescript";
  }
  const exact = `lang/${language}`;
  return lenses.includes(exact) ? exact : undefined;
}

function defaultLensesForLanguage(language: string, enabled: string[]): string[] {
  const selected = enabled.filter((lens) => lens.startsWith("core/"));
  if (language === "go" && enabled.includes("lang/go")) {
    selected.push("lang/go");
  } else if (["typescript", "javascript", "ts", "js", "tsx", "jsx"].includes(language) && enabled.includes("lang/typescript")) {
    selected.push("lang/typescript");
  }
  return [...new Set(selected.length > 0 ? selected : enabled.slice(0, 1))];
}

function maxReviewPriority(priorities: ReviewPriority[]): ReviewPriority {
  const order: Record<ReviewPriority, number> = { critical: 0, high: 1, normal: 2, low: 3 };
  return [...priorities].sort((a, b) => order[a] - order[b])[0] ?? "normal";
}

function toolBudget(coverage: Exclude<CoverageLevel, "skip">, depth: CodeninjaConfig["review"]["depth"]): ToolBudget {
  const base = {
    light: { maxToolCalls: 2, maxInvestigationRounds: 1, maxResultChars: 4000 },
    normal: { maxToolCalls: 8, maxInvestigationRounds: 3, maxResultChars: 16000 },
    deep: { maxToolCalls: 15, maxInvestigationRounds: 5, maxResultChars: 32000 }
  }[coverage];
  const scale = depth === "deep" ? 1.5 : depth === "light" ? 0.5 : 1;
  const round = depth === "light" ? Math.floor : Math.ceil;
  return {
    maxToolCalls: Math.max(1, round(base.maxToolCalls * scale)),
    maxInvestigationRounds: Math.max(1, round(base.maxInvestigationRounds * scale)),
    maxResultChars: Math.max(4000, round(base.maxResultChars * scale))
  };
}

function fallbackFacts(file: DiffFile): FileFacts {
  return {
    path: file.path,
    language: file.language,
    processingMode: "per-hunk",
    testStatus: "unknown",
    isGenerated: false,
    isVendored: false,
    isLockfile: false,
    isBinary: file.isBinary === true,
    changedLines: file.hunks.reduce((sum, hunk) => sum + hunk.lines.filter((line) => line.kind !== "context").length, 0),
    hunkCount: file.hunks.length,
    labels: [],
    reviewPriority: "normal" satisfies ReviewPriority,
    reasons: [],
    provenance: []
  };
}
