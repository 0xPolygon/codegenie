import type { TelemetryRecorder } from "../telemetry/telemetry-recorder.js";
import { withRepositoryToolCallContext } from "../repo/repository-index.js";
import { buildTestCoverageDelta } from "../repo/test-coverage-delta.js";
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
  RelatedChangedContext,
  RepositoryIndex,
  RepositoryToolsHost,
  ReviewPacket,
  ReviewPlan,
  ReviewProfile,
  ReviewPriority,
  SearchResult,
  SourceSelector,
  StaticSignal,
  SurroundingContextHint,
  SymbolRef,
  SymbolInfo,
  PacketContextQuality,
  ToolBudget,
  ToolResultMeta,
  IntentSignals
} from "../types.js";
import { sha256Hex } from "../util/hashing.js";
import { scaleToolBudget } from "../util/budget.js";
import { isDisclosableCoverageReason } from "../util/coverage-reasons.js";

type PacketBuildOptions = {
  config: CodeninjaConfig;
  enabledLenses: string[];
  reviewContext?: PacketReviewContext;
};

type PacketReviewContext = {
  prSummary: string;
  intentText?: string;
  intentSignals?: IntentSignals;
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

type HunkRelationshipSource = "same_symbol" | "symbol_mention" | "planner_hint";
type HunkRelationshipStrength = "strong" | "medium" | "weak";

type HunkRelationshipEdge = {
  fromHunkId: string;
  toHunkId?: string | undefined;
  toPath?: string | undefined;
  toSymbol?: string | undefined;
  reason: string;
  source: HunkRelationshipSource;
  strength: HunkRelationshipStrength;
};

type RelatedContextOmission = {
  hunkId: string;
  targetHunkId?: string | undefined;
  reason: string;
};

type HunkRelationshipGraph = {
  edgesByHunk: Map<string, HunkRelationshipEdge[]>;
  edges: HunkRelationshipEdge[];
  plannedByHunk: Map<string, PlannedHunk>;
  omittedEdges: number;
  relatedContextAttached: Array<{ hunkId: string; targetHunkId?: string | undefined; path: string; symbol?: string | undefined; reason: string }>;
  relatedContextOmitted: RelatedContextOmission[];
};

const MAX_HUNKS_PER_PACKET = 5;
const MAX_LENSES_PER_PACKET = 6;
const MAX_PATCH_CHARS = 12_000;
const MAX_CONTEXT_CHARS = 8_000;
const DEFAULT_SYMBOL_CONTEXT_CHARS = 3_000;
const MAX_ADAPTIVE_SYMBOL_CONTEXT_CHARS = 6_000;
const SYMBOL_EXCERPT_WINDOW = 8;
const MAX_SYMBOL_EXCERPT_CHARS = 2_500;
const MAX_HINT_CONTEXT_CHARS = 2_000;
const MAX_HINT_CONTEXT_LINES = 80;
const CALL_SITE_MENTION_LOOKUP_LIMIT = 50;
const CALL_SITE_CONTEXT_SYMBOL_LIMIT = 4;
const MAX_STATIC_SIGNALS_PER_PACKET_HUNK = 5;
const NEARBY_GAP_LINES = 30;
const MAX_ATTENTION_NOTES = 3;
const MAX_ATTENTION_NOTE_CHARS = 300;
const MAX_RELATED_CONTEXTS_PER_PACKET = 3;
const MAX_RELATED_CONTEXT_SNIPPET_CHARS = 2_500;
const MAX_RELATED_CONTEXT_PATCH_CHARS = 1_500;
const MAX_RELATIONSHIP_EDGES_PER_HUNK = 8;
const MAX_RELATIONSHIP_SYMBOL_LOOKUPS = 20;
const MAX_RELATIONSHIP_MENTION_RESULTS = 40;

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
  const symbolContextMetrics = emptySymbolContextMetrics();
  const plannedByFile = new Map<string, PlannedHunk[]>();
  const effectiveByHunk = new Map<string, EffectiveDecision>();
  const allPlanned: PlannedHunk[] = [];

  for (const file of filtered) {
    const facts = factsByPath.get(file.path) ?? fallbackFacts(file);
    const fileSignals = repoIndex.staticSignals.filter((entry) => entry.path === file.path);
    const planned = file.hunks.map((hunk): PlannedHunk => ({
      file,
      hunk,
      facts,
      symbolFacts: repoIndex.symbolFacts.filter((entry) => entry.hunkId === hunk.id),
      staticSignals: staticSignalsForHunk(file, hunk, fileSignals),
      ...(decisions.get(hunk.id) !== undefined ? { decision: decisions.get(hunk.id) as HunkCoverageDecision } : {})
    }));
    plannedByFile.set(file.path, planned);
    allPlanned.push(...planned);
    for (const entry of planned) {
      effectiveByHunk.set(entry.hunk.id, effectiveDecision(entry, opts.enabledLenses, telemetry));
    }
  }

  const relationshipGraph = await buildHunkRelationshipGraph(allPlanned, effectiveByHunk, repoIndex, telemetry);

  for (const file of filtered) {
    const planned = plannedByFile.get(file.path) ?? [];
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
      const packet = await buildPacket(group.hunks, includedDecisions, group, relationshipGraph, repoIndex, opts.config, telemetry, opts.reviewContext, symbolContextMetrics);
      packets.push(packet);
    }
  }

  for (const packet of packets) {
    await telemetry.writeArtifact(`packets/${packet.id}.json`, packet);
  }
  await telemetry.writeArtifact("hunk-relationships.json", relationshipGraphArtifact(relationshipGraph));
  telemetry.event({
    stage: 6,
    level: "info",
    message: "stage_completed",
    data: {
      packets: packets.length,
      symbolContext: symbolContextMetrics
    }
  });
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
  relationshipGraph: HunkRelationshipGraph,
  repoIndex: RepositoryIndex,
  config: CodeninjaConfig,
  telemetry: TelemetryRecorder,
  reviewContext: PacketReviewContext | undefined,
  symbolContextMetrics: SymbolContextMetrics
): Promise<ReviewPacket> {
  const first = planned[0];
  if (!first) {
    throw new Error("cannot build empty packet");
  }
  const hunkIds = planned.map((entry) => entry.hunk.id);
  const kind = packetKind(group, planned, first.file);
  const coverage = maxCoverage(decisions.map((decision) => decision.coverage));
  const reviewPriority = maxReviewPriority(planned.map((entry) => entry.facts.reviewPriority));
  const symbolFacts = planned.flatMap((entry) => entry.symbolFacts);
  const packetHunks = planned.map((entry, index) =>
    renderPacketHunk(entry.hunk, entry.staticSignals, telemetry, plannerFallbackReason(decisions[index]?.reason))
  );
  const patchChars = packetHunks.reduce((sum, hunk) => sum + hunk.contentWithLineNumbers.length, 0);
  const testCoverageDelta = buildTestCoverageDelta(first.file, planned.map((entry) => entry.hunk), first.facts, symbolFacts);
  const relatedChangedContext = await buildRelatedChangedContext(planned, relationshipGraph, repoIndex, telemetry);
  const attentionNotes = attentionNotesForPacket(decisions, relatedChangedContext);
  const context = await buildContext(repoIndex, first.file, planned.map((entry) => entry.hunk), symbolFacts, telemetry, {
    coverage,
    reviewPriority,
    hunkCount: planned.length,
    patchChars,
    lenses: decisions.flatMap((decision) => decision.lenses),
    attentionNotes,
    labels: first.facts.labels
  }, symbolContextMetrics);
  const hintContext = await resolvePacketContextHints(repoIndex, first.file, decisions.flatMap((decision) => decision.surroundingContextHints), telemetry);
  const truncationReason = truncationReasons(packetHunks).join("; ");
  const auxiliaryContextText = [context.text, hintContext.text].filter((text) => text.trim().length > 0).join("\n\n");
  const renderedContext = renderPacketContextText(first.file.path, group.wholeFileText, auxiliaryContextText);
  const contextDropReason = renderedContext.auxiliaryContextDropped
    ? "auxiliary packet context omitted to preserve complete whole-file content"
    : undefined;
  const contextTruncationReason = renderedContext.contextTruncated
    ? `packet context truncated to ${MAX_CONTEXT_CHARS} chars`
    : undefined;
  const contextQuality = finalContextQuality(context.contextQuality, renderedContext.text, truncationReason.length > 0 || renderedContext.contextTruncated);
  const contextDegradationReasons = [
    ...context.contextDegradationReasons,
    ...(truncationReason.length > 0 ? [truncationReason] : []),
    ...(hintContext.degradation !== undefined ? [hintContext.degradation] : []),
    ...(contextDropReason !== undefined ? [contextDropReason] : []),
    ...(contextTruncationReason !== undefined ? [contextTruncationReason] : [])
  ];
  if (contextTruncationReason !== undefined) {
    telemetry.event({
      stage: 6,
      level: "warn",
      message: "packet_context_truncated",
      file: first.file.path,
      data: { maxContextChars: MAX_CONTEXT_CHARS }
    });
  }
  const reviewProfile = packetReviewProfile({
    coverage,
    reviewPriority,
    planned,
    attentionNotes,
    hintCount: decisions.reduce((sum, decision) => sum + decision.surroundingContextHints.length, 0)
  });
  const lenses = routedPacketLenses({
    lenses: decisions.flatMap((decision) => decision.lenses),
    language: first.facts.language,
    file: first.file,
    facts: first.facts,
    planned,
    relevantTests: context.relevantTests,
    attentionNotes,
    coverage,
    reviewPriority,
    reviewProfile,
    telemetry
  });
  emitPacketContextQuality(telemetry, first.file.path, coverage, reviewPriority, contextQuality, contextDegradationReasons);
  const packet: ReviewPacket = {
    id: sha256Hex(`${first.file.path}\n${[...hunkIds].sort().join("\n")}\n${kind}`),
    kind,
    prSummary: (reviewContext?.prSummary ?? "Review local diff.").slice(0, 500),
    path: first.file.path,
    ...(first.file.oldPath !== undefined ? { oldPath: first.file.oldPath } : {}),
    fileStatus: first.file.status,
    isDeletedContent: first.file.status === "deleted",
    language: first.facts.language,
    reviewPriority,
    coverage,
    reviewProfile,
    lenses,
    hunks: packetHunks,
    symbolFacts,
    context: context.context,
    contextText: renderedContext.text,
    contextQuality,
    ...(contextDegradationReasons.length > 0 ? { contextDegradationReasons } : {}),
    ...(testCoverageDelta !== undefined ? { testCoverageDelta } : {}),
    ...(context.packetSymbols.length > 0 ? { packetSymbols: context.packetSymbols } : {}),
    relevantTests: context.relevantTests,
    surroundingContextHints: hintContext.workerHints,
    labels: first.facts.labels,
    attentionNotes,
    relatedChangedContext,
    toolBudget: scaleToolBudget(toolBudget(coverage, config.review.depth, reviewProfile), config.review.budgetMultiplier),
    ...(reviewContext?.intentText !== undefined ? { intentText: reviewContext.intentText } : {}),
    ...(reviewContext?.intentSignals !== undefined ? { intentSignals: reviewContext.intentSignals } : {}),
    ...(context.degradation !== undefined || truncationReason.length > 0 || contextDropReason !== undefined || contextTruncationReason !== undefined || group.degradationReason !== undefined
      ? { degraded: { reason: [context.degradation, truncationReason, contextDropReason, contextTruncationReason, group.degradationReason].filter(Boolean).join("; ") } }
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
    ...(intentParts.length > 0 ? { intentText: truncateTail(intentParts.join("\n\n"), 1000) } : {}),
    ...(dossier.intentSignals !== undefined ? { intentSignals: dossier.intentSignals } : {})
  };
}

function attentionNotesForPacket(
  decisions: NonSkipDecision[],
  relatedChangedContext: RelatedChangedContext[]
): string[] {
  const notes = [
    ...decisions.flatMap((decision) => {
      const hunkScopedAttention =
        (decision.focusNotes ?? []).length > 0 ||
        (decision.relatedSymbols ?? []).length > 0 ||
        (decision.relatedFiles ?? []).length > 0 ||
        decision.surroundingContextHints.length > 0;
      return [
        hunkScopedAttention && isDisclosableCoverageReason(decision.reason) ? decision.reason : "",
        ...(decision.focusNotes ?? []),
        ...decision.surroundingContextHints.map((hint) => hint.reason)
      ];
    }),
    ...relatedChangedContext.map((context) => context.reason)
  ];
  return dedupe(notes.map(normalizeNote).filter((note) => note.length > 0)).slice(0, MAX_ATTENTION_NOTES);
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

async function buildHunkRelationshipGraph(
  planned: PlannedHunk[],
  effectiveByHunk: Map<string, EffectiveDecision>,
  repoIndex: RepositoryIndex,
  telemetry: TelemetryRecorder
): Promise<HunkRelationshipGraph> {
  const included = planned.filter((entry) => effectiveByHunk.get(entry.hunk.id)?.coverage !== "skip");
  const graph: HunkRelationshipGraph = {
    edgesByHunk: new Map(),
    edges: [],
    plannedByHunk: new Map(included.map((entry) => [entry.hunk.id, entry])),
    omittedEdges: 0,
    relatedContextAttached: [],
    relatedContextOmitted: []
  };
  addSameSymbolEdges(graph, included);
  addPlannerHintEdges(graph, included, effectiveByHunk);
  await addSymbolMentionEdges(graph, included, repoIndex, telemetry);
  telemetry.event({
    stage: 6,
    level: "info",
    message: "relationship_graph_built",
    data: {
      nodes: included.length,
      edges: graph.edges.length,
      omittedEdges: graph.omittedEdges
    }
  });
  return graph;
}

function addSameSymbolEdges(graph: HunkRelationshipGraph, planned: PlannedHunk[]): void {
  const bySymbol = new Map<string, PlannedHunk[]>();
  for (const entry of planned) {
    for (const key of changedLocalSymbolKeys(entry)) {
      bySymbol.set(key, [...(bySymbol.get(key) ?? []), entry]);
    }
  }
  for (const group of bySymbol.values()) {
    if (group.length < 2) {
      continue;
    }
    for (const from of group) {
      for (const to of group) {
        if (from.hunk.id === to.hunk.id) {
          continue;
        }
        addRelationshipEdge(graph, {
          fromHunkId: from.hunk.id,
          toHunkId: to.hunk.id,
          toPath: to.file.path,
          toSymbol: primarySymbolName(to),
          source: "same_symbol",
          strength: "strong",
          reason: `Related changed hunk in the same enclosing symbol ${primarySymbolName(to) ?? "unknown"}.`
        });
      }
    }
  }
}

function addPlannerHintEdges(
  graph: HunkRelationshipGraph,
  planned: PlannedHunk[],
  effectiveByHunk: Map<string, EffectiveDecision>
): void {
  const changedBySymbol = changedHunksBySymbol(planned);
  const changedByPath = changedHunksByPath(planned);
  for (const entry of planned) {
    const decision = effectiveByHunk.get(entry.hunk.id);
    if (decision === undefined) {
      continue;
    }
    const symbolHints = cleanStrings([
      ...(decision.relatedSymbols ?? []),
      ...decision.surroundingContextHints.flatMap((hint) => hint.symbol ?? [])
    ]);
    for (const symbol of symbolHints) {
      for (const target of changedBySymbol.get(normalizedSymbolKey(symbol)) ?? []) {
        if (target.hunk.id === entry.hunk.id) {
          continue;
        }
        addRelationshipEdge(graph, {
          fromHunkId: entry.hunk.id,
          toHunkId: target.hunk.id,
          toPath: target.file.path,
          toSymbol: primarySymbolName(target),
          source: "planner_hint",
          strength: "strong",
          reason: `Planner context hint links this hunk to changed symbol ${primarySymbolName(target) ?? symbol}.`
        });
      }
    }

    const fileHints = cleanStrings([
      ...(decision.relatedFiles ?? []),
      ...decision.surroundingContextHints.flatMap((hint) => hint.path ?? [])
    ]).map(stripLocationSuffix);
    for (const filePath of fileHints) {
      for (const target of changedByPath.get(filePath) ?? []) {
        if (target.hunk.id === entry.hunk.id) {
          continue;
        }
        addRelationshipEdge(graph, {
          fromHunkId: entry.hunk.id,
          toHunkId: target.hunk.id,
          toPath: target.file.path,
          toSymbol: primarySymbolName(target),
          source: "planner_hint",
          strength: "medium",
          reason: `Planner context hint names changed file ${target.file.path}.`
        });
      }
    }
  }
}

async function addSymbolMentionEdges(
  graph: HunkRelationshipGraph,
  planned: PlannedHunk[],
  repoIndex: RepositoryIndex,
  telemetry: TelemetryRecorder
): Promise<void> {
  const changedBySymbol = changedHunksBySymbol(planned);
  const changedFiles = new Set(planned.map((entry) => entry.file.path));
  const symbols = dedupe(planned.flatMap((entry) => primarySymbolName(entry) ?? []))
    .filter((symbol) => bareIdentifier(symbol).length > 0)
    .slice(0, MAX_RELATIONSHIP_SYMBOL_LOOKUPS);
  for (const symbol of symbols) {
    let results: SearchResult[] = [];
    try {
      const lookup = await withRepositoryToolCallContext(
        repoIndex.tools,
        { stage: 6, initiator: "harness" },
        () => repoIndex.tools.findSymbolMentions(bareIdentifier(symbol), {
          source: { kind: "head" },
          contextMode: "symbols",
          maxResults: MAX_RELATIONSHIP_MENTION_RESULTS
        })
      );
      results = lookup.results.filter((result) => changedFiles.has(result.path));
    } catch (error) {
      telemetry.event({
        stage: 6,
        level: "warn",
        message: "relationship_symbol_mentions_unavailable",
        data: { symbol, error: error instanceof Error ? error.message : String(error) }
      });
      continue;
    }

    const sourceHunks = changedBySymbol.get(normalizedSymbolKey(symbol)) ?? [];
    const sourceIdentities = new Set(sourceHunks.flatMap(changedLocalSymbolKeys));
    if (sourceIdentities.size > 1) {
      telemetry.event({
        stage: 6,
        level: "debug",
        message: "relationship_symbol_mentions_ambiguous",
        data: { symbol, changedSymbolIdentities: sourceIdentities.size }
      });
      continue;
    }
    for (const result of results) {
      const mentionTargets = planned.filter((entry) => mentionBelongsToChangedSymbol(entry, result));
      for (const source of sourceHunks) {
        for (const target of mentionTargets) {
          if (source.hunk.id === target.hunk.id || samePrimarySymbol(source, target)) {
            continue;
          }
          addRelationshipEdge(graph, {
            fromHunkId: source.hunk.id,
            toHunkId: target.hunk.id,
            toPath: target.file.path,
            toSymbol: primarySymbolName(target),
            source: "symbol_mention",
            strength: result.enclosingSymbol !== undefined ? "strong" : "medium",
            reason: `Changed symbol ${primarySymbolName(source) ?? symbol} is mentioned inside changed symbol ${primarySymbolName(target) ?? result.enclosingSymbol?.name ?? target.file.path}.`
          });
          addRelationshipEdge(graph, {
            fromHunkId: target.hunk.id,
            toHunkId: source.hunk.id,
            toPath: source.file.path,
            toSymbol: primarySymbolName(source),
            source: "symbol_mention",
            strength: result.enclosingSymbol !== undefined ? "strong" : "medium",
            reason: `Changed symbol ${primarySymbolName(target) ?? target.file.path} mentions changed symbol ${primarySymbolName(source) ?? symbol}.`
          });
        }
      }
    }
  }
}

function addRelationshipEdge(graph: HunkRelationshipGraph, edge: HunkRelationshipEdge): void {
  const key = relationshipEdgeKey(edge);
  if (graph.edges.some((candidate) => relationshipEdgeKey(candidate) === key)) {
    return;
  }
  const existingForHunk = graph.edgesByHunk.get(edge.fromHunkId) ?? [];
  if (existingForHunk.length >= MAX_RELATIONSHIP_EDGES_PER_HUNK) {
    graph.omittedEdges += 1;
    return;
  }
  graph.edges.push(edge);
  graph.edgesByHunk.set(edge.fromHunkId, [...existingForHunk, edge]);
}

function relationshipEdgeKey(edge: HunkRelationshipEdge): string {
  return `${edge.fromHunkId}\0${edge.toHunkId ?? ""}\0${edge.toPath ?? ""}\0${edge.toSymbol ?? ""}\0${edge.source}`;
}

async function buildRelatedChangedContext(
  planned: PlannedHunk[],
  graph: HunkRelationshipGraph,
  repoIndex: RepositoryIndex,
  telemetry: TelemetryRecorder
): Promise<RelatedChangedContext[]> {
  const currentHunks = new Set(planned.map((entry) => entry.hunk.id));
  const currentFiles = new Set(planned.map((entry) => entry.file.path));
  const targets = new Map<string, HunkRelationshipEdge>();
  for (const hunkId of currentHunks) {
    for (const edge of graph.edgesByHunk.get(hunkId) ?? []) {
      if (edge.toHunkId === undefined || currentHunks.has(edge.toHunkId)) {
        continue;
      }
      if (edge.strength === "weak") {
        continue;
      }
      targets.set(edge.toHunkId, edge);
    }
  }

  const contexts: RelatedChangedContext[] = [];
  for (const edge of [...targets.values()].sort(compareRelationshipEdges)) {
    if (contexts.length >= MAX_RELATED_CONTEXTS_PER_PACKET) {
      graph.relatedContextOmitted.push({ hunkId: [...currentHunks].join(","), targetHunkId: edge.toHunkId, reason: "related context cap exceeded" });
      continue;
    }
    const related = edge.toHunkId === undefined ? undefined : graph.plannedByHunk.get(edge.toHunkId);
    if (related === undefined) {
      graph.relatedContextOmitted.push({ hunkId: [...currentHunks].join(","), targetHunkId: edge.toHunkId, reason: "target hunk unavailable" });
      continue;
    }
    if (currentFiles.has(related.file.path) && currentHunks.has(related.hunk.id)) {
      continue;
    }
    const context = await relatedContextForTarget(related, edge, repoIndex, telemetry);
    if (context === undefined) {
      graph.relatedContextOmitted.push({ hunkId: [...currentHunks].join(","), targetHunkId: edge.toHunkId, reason: "source unavailable" });
      continue;
    }
    contexts.push(context);
    graph.relatedContextAttached.push({
      hunkId: [...currentHunks].join(","),
      targetHunkId: edge.toHunkId,
      path: context.path,
      ...(context.symbol !== undefined ? { symbol: context.symbol } : {}),
      reason: edge.reason
    });
    telemetry.event({
      stage: 6,
      level: "info",
      message: "related_context_attached",
      file: context.path,
      data: { fromHunks: [...currentHunks], targetHunkId: edge.toHunkId, source: edge.source, strength: edge.strength }
    });
  }
  if (graph.relatedContextOmitted.length > 0) {
    telemetry.event({
      stage: 6,
      level: "debug",
      message: "related_context_omitted",
      data: { count: graph.relatedContextOmitted.length }
    });
  }
  return contexts;
}

async function relatedContextForTarget(
  target: PlannedHunk,
  edge: HunkRelationshipEdge,
  repoIndex: RepositoryIndex,
  telemetry: TelemetryRecorder
): Promise<RelatedChangedContext | undefined> {
  const fact = primarySymbolFactWithMergedChanges(target.symbolFacts);
  const patchExcerpt = truncateTail(renderLines(target.hunk.lines.map(packetLine)), MAX_RELATED_CONTEXT_PATCH_CHARS);
  const base: RelatedChangedContext = {
    path: target.file.path,
    hunkId: target.hunk.id,
    ...(primarySymbolName(target) !== undefined ? { symbol: primarySymbolName(target) } : {}),
    ...(fact?.symbolRange !== undefined ? { lineRange: fact.symbolRange } : {}),
    reason: edge.reason,
    patchExcerpt
  };
  if (fact === undefined) {
    return base;
  }
  const selector = symbolSourceSelector(fact);
  if (selector === undefined) {
    return base;
  }
  const source = fact.changedLinesSide === "old" ? { kind: "base" as const } : { kind: "head" as const };
  const readPath = fact.changedLinesSide === "old" ? target.file.oldPath ?? target.file.path : target.file.path;
  try {
    const result = await withRepositoryToolCallContext(
      repoIndex.tools,
      { stage: 6, initiator: "harness" },
      () => repoIndex.tools.readSymbol(readPath, selector, source)
    );
    if (result.text === undefined || result.text.trim().length === 0) {
      return base;
    }
    return {
      ...base,
      path: readPath,
      ...(result.symbol?.name !== undefined ? { symbol: result.symbol.name } : {}),
      ...(result.symbol?.lineRange !== undefined ? { lineRange: result.symbol.lineRange } : {}),
      sourceSnippet: truncateTail(result.text, MAX_RELATED_CONTEXT_SNIPPET_CHARS)
    };
  } catch (error) {
    telemetry.event({
      stage: 6,
      level: "warn",
      message: "related_context_source_unavailable",
      file: target.file.path,
      data: { hunkId: target.hunk.id, symbol: fact.enclosingSymbol, error: error instanceof Error ? error.message : String(error) }
    });
    return base;
  }
}

function relationshipGraphArtifact(graph: HunkRelationshipGraph): Record<string, unknown> {
  return {
    nodes: [...graph.plannedByHunk.values()].map((entry) => ({
      hunkId: entry.hunk.id,
      path: entry.file.path,
      symbol: primarySymbolName(entry),
      symbolRange: primarySymbolFact(entry.symbolFacts)?.symbolRange
    })),
    edges: graph.edges.map((edge) => ({
      fromHunkId: edge.fromHunkId,
      toHunkId: edge.toHunkId,
      toPath: edge.toPath,
      toSymbol: edge.toSymbol,
      source: edge.source,
      strength: edge.strength,
      reason: edge.reason
    })),
    omittedEdges: graph.omittedEdges,
    relatedContextAttached: graph.relatedContextAttached,
    relatedContextOmitted: graph.relatedContextOmitted
  };
}

function changedHunksBySymbol(planned: PlannedHunk[]): Map<string, PlannedHunk[]> {
  const bySymbol = new Map<string, PlannedHunk[]>();
  for (const entry of planned) {
    for (const key of changedSymbolKeys(entry)) {
      bySymbol.set(key, [...(bySymbol.get(key) ?? []), entry]);
    }
  }
  return bySymbol;
}

function changedHunksByPath(planned: PlannedHunk[]): Map<string, PlannedHunk[]> {
  const byPath = new Map<string, PlannedHunk[]>();
  for (const entry of planned) {
    byPath.set(entry.file.path, [...(byPath.get(entry.file.path) ?? []), entry]);
    if (entry.file.oldPath !== undefined) {
      byPath.set(entry.file.oldPath, [...(byPath.get(entry.file.oldPath) ?? []), entry]);
    }
  }
  return byPath;
}

function changedSymbolKeys(entry: PlannedHunk): string[] {
  return cleanStrings(entry.symbolFacts.flatMap((fact) => fact.enclosingSymbol ?? []))
    .map(normalizedSymbolKey)
    .filter((key) => key.length > 0);
}

function changedLocalSymbolKeys(entry: PlannedHunk): string[] {
  return cleanStrings(
    entry.symbolFacts
      .filter(isRealSymbolFact)
      .map(symbolFactIdentity)
  );
}

function primarySymbolName(entry: PlannedHunk): string | undefined {
  return primarySymbolFact(entry.symbolFacts)?.enclosingSymbol;
}

function samePrimarySymbol(a: PlannedHunk, b: PlannedHunk): boolean {
  const aSymbol = primarySymbolName(a);
  const bSymbol = primarySymbolName(b);
  return a.file.path === b.file.path && aSymbol !== undefined && aSymbol === bSymbol;
}

function mentionBelongsToChangedSymbol(entry: PlannedHunk, result: SearchResult): boolean {
  if (entry.file.path !== result.path) {
    return false;
  }
  const resultSymbol = result.enclosingSymbol?.name;
  if (resultSymbol !== undefined && changedSymbolKeys(entry).includes(normalizedSymbolKey(resultSymbol))) {
    return true;
  }
  return entry.symbolFacts.some((fact) =>
    fact.symbolRange !== undefined &&
    result.line >= fact.symbolRange[0] &&
    result.line <= fact.symbolRange[1]
  );
}

function compareRelationshipEdges(a: HunkRelationshipEdge, b: HunkRelationshipEdge): number {
  const strength = relationshipStrengthRank(a.strength) - relationshipStrengthRank(b.strength);
  if (strength !== 0) {
    return strength;
  }
  const source = relationshipSourceRank(a.source) - relationshipSourceRank(b.source);
  if (source !== 0) {
    return source;
  }
  return (a.toPath ?? "").localeCompare(b.toPath ?? "") || (a.toSymbol ?? "").localeCompare(b.toSymbol ?? "") || (a.toHunkId ?? "").localeCompare(b.toHunkId ?? "");
}

function relationshipStrengthRank(strength: HunkRelationshipStrength): number {
  return { strong: 0, medium: 1, weak: 2 }[strength];
}

function relationshipSourceRank(source: HunkRelationshipSource): number {
  return { planner_hint: 0, symbol_mention: 1, same_symbol: 2 }[source];
}

function normalizedSymbolKey(value: string): string {
  return bareIdentifier(value).toLowerCase();
}

function bareIdentifier(value: string): string {
  const normalized = value.trim().replace(/\s+/gu, " ");
  const match = /[A-Za-z_$][\w$]*$/u.exec(normalized);
  return match?.[0] ?? normalized;
}

function normalizeNote(value: string): string {
  return truncateTail(value.trim().replace(/\s+/gu, " "), MAX_ATTENTION_NOTE_CHARS);
}

function stripLocationSuffix(value: string): string {
  return value.trim().replace(/:\d+(?:-\d+)?$/u, "");
}

function cleanStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))].sort();
}

function dedupe<T>(values: T[]): T[] {
  return [...new Set(values)];
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
  const previousRange = hunkProximityRange(previous);
  const nextRange = hunkProximityRange(next);
  if (previousRange.side !== nextRange.side) {
    return false;
  }
  return Math.abs(nextRange.start - previousRange.end) <= NEARBY_GAP_LINES;
}

function hunkProximityRange(hunk: DiffHunk): { side: "old" | "new"; start: number; end: number } {
  if (hunk.newLines === 0 && hunk.oldLines > 0) {
    return { side: "old", start: hunk.oldStart, end: hunk.oldStart + hunk.oldLines - 1 };
  }
  return { side: "new", start: hunk.newStart, end: hunk.newStart + Math.max(1, hunk.newLines) - 1 };
}

function staticSignalsForHunk(file: DiffFile, hunk: DiffHunk, signals: StaticSignal[]): StaticSignal[] {
  return signals.filter((signal) => {
    if (signal.path !== file.path || signal.line === undefined) {
      return signal.path === file.path;
    }
    const side = signal.side ?? "RIGHT";
    if (side === "LEFT") {
      return lineInRange(signal.line, hunk.oldStart, hunk.oldLines);
    }
    return lineInRange(signal.line, hunk.newStart, hunk.newLines);
  });
}

function lineInRange(line: number, start: number, lines: number): boolean {
  if (lines === 0) {
    return false;
  }
  return line >= start && line <= start + lines - 1;
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
  focusNotes?: string[];
  relatedSymbols?: string[];
  relatedFiles?: string[];
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
    return {
      coverage: "normal",
      lenses: defaultLensesForLanguage(planned.facts, enabledLenses),
      surroundingContextHints: [],
      reason: "default_coverage"
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
      lenses: defaultLensesForLanguage(planned.facts, enabledLenses),
      reason: `planner_empty_lenses: ${decision.reason}`
    };
  }
  return decision;
}

function plannerFallbackReason(reason: string | undefined): string | undefined {
  if (reason === undefined) {
    return undefined;
  }
  return reason.startsWith("planner_empty_lenses") || reason.startsWith("planner_invalid_skip")
    ? reason
    : undefined;
}

function renderPacketHunk(
  hunk: DiffHunk,
  staticSignals: StaticSignal[],
  telemetry: TelemetryRecorder,
  plannerFallback: string | undefined = undefined
): PacketHunk {
  const lines = hunk.lines.map(packetLine);
  const changedNewLineNumbers = lines.flatMap((line) => (line.kind === "add" && line.newLine !== undefined ? [line.newLine] : []));
  const changedOldLineNumbers = lines.flatMap((line) => (line.kind === "delete" && line.oldLine !== undefined ? [line.oldLine] : []));
  const window = patchWindow(lines);
  const packetSignals = staticSignals.slice(0, MAX_STATIC_SIGNALS_PER_PACKET_HUNK);
  const omittedSignalCount = Math.max(0, staticSignals.length - packetSignals.length);
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
    ...(packetSignals.length > 0 ? { staticSignals: packetSignals } : {}),
    ...(omittedSignalCount > 0 ? { omittedSignalCount } : {}),
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

type PacketContextBuildResult = {
  context: ReviewPacket["context"];
  text: string;
  relevantTests: SymbolInfo[];
  contextQuality: PacketContextQuality;
  contextDegradationReasons: string[];
  packetSymbols: SymbolInfo[];
  degradation?: string;
};

type SymbolSourceContext = {
  text: string;
  quality?: Extract<PacketContextQuality, "full" | "sliced">;
  degradation?: string;
  reasons: string[];
};

type PacketSymbolContextInput = {
  coverage: Exclude<CoverageLevel, "skip">;
  reviewPriority: ReviewPriority;
  hunkCount: number;
  patchChars: number;
  lenses: string[];
  attentionNotes: string[];
  labels: string[];
};

type SymbolContextPressure = "low" | "medium" | "high";

type SymbolContextBudgetMode = "default" | "adaptive_full" | "adaptive_sliced";

type SymbolContextBudget = PacketSymbolContextInput & {
  maxChars: number;
  reason: string;
  mode: SymbolContextBudgetMode;
  singlePrimarySymbol: boolean;
  uniqueSymbolCount: number;
  adaptive: boolean;
  adaptiveEligible: boolean;
  blockedReason?: string;
  patchPressure: SymbolContextPressure;
  hunkPressure: SymbolContextPressure;
  originalChars: number;
  defaultWouldMateriallyOmit: boolean;
  riskSignals: string[];
  hunkIds: string[];
};

type SymbolContextMetrics = {
  defaultFull: number;
  defaultSliced: number;
  adaptiveFull: number;
  adaptiveSliced: number;
  adaptiveEligible: number;
  adaptiveBlocked: number;
  adaptiveBlockedByReason: Record<string, number>;
  outlineOnly: number;
  materialOmission: number;
  defaultSlicedMaterialOmission: number;
};

function emptySymbolContextMetrics(): SymbolContextMetrics {
  return {
    defaultFull: 0,
    defaultSliced: 0,
    adaptiveFull: 0,
    adaptiveSliced: 0,
    adaptiveEligible: 0,
    adaptiveBlocked: 0,
    adaptiveBlockedByReason: {},
    outlineOnly: 0,
    materialOmission: 0,
    defaultSlicedMaterialOmission: 0
  };
}

async function buildContext(
  repoIndex: RepositoryIndex,
  file: DiffFile,
  hunks: DiffHunk[],
  symbolFacts: HunkSymbolFacts[],
  telemetry: TelemetryRecorder,
  symbolContextInput: PacketSymbolContextInput,
  symbolContextMetrics: SymbolContextMetrics
): Promise<PacketContextBuildResult> {
  if (!isToolsHost(repoIndex.tools)) {
    symbolContextMetrics.outlineOnly += 1;
    return {
      context: { path: file.path },
      text: "",
      relevantTests: [],
      contextQuality: "path_only",
      contextDegradationReasons: ["repository tools do not provide packet context"],
      packetSymbols: []
    };
  }
  try {
    const result = await repoIndex.tools.buildPacketContext(file, hunks, symbolFacts);
    const symbolSource = await readEnclosingSymbolSource(repoIndex, file, symbolFacts, telemetry, symbolContextInput, symbolContextMetrics);
    const contextText = renderContext(result, symbolSource.text);
    const reasons = [
      ...(result.degradation !== undefined ? [result.degradation] : []),
      ...symbolSource.reasons,
      ...((result.noSymbolHunkIds ?? []).length > 0 ? [`no_enclosing_symbol: ${(result.noSymbolHunkIds ?? []).join(", ")}`] : [])
    ];
    const degradation = [result.degradation, symbolSource.degradation].filter(Boolean).join("; ");
    return {
      context: result.context,
      text: contextText,
      relevantTests: result.relevantTests,
      contextQuality: contextQualityFor(result, symbolSource, contextText),
      contextDegradationReasons: reasons,
      packetSymbols: result.packetSymbols ?? (result.primarySymbol !== undefined ? [result.primarySymbol] : []),
      ...(degradation.length > 0 ? { degradation } : {})
    };
  } catch (error) {
    symbolContextMetrics.outlineOnly += 1;
    const message = error instanceof Error ? error.message : String(error);
    telemetry.event({ stage: 6, level: "warn", message: "packet_context_degraded", file: file.path, data: { error: message } });
    return {
      context: { path: file.path },
      text: "",
      relevantTests: [],
      contextQuality: "path_only",
      contextDegradationReasons: [message],
      packetSymbols: [],
      degradation: message
    };
  }
}

async function readEnclosingSymbolSource(
  repoIndex: RepositoryIndex,
  file: DiffFile,
  symbolFacts: HunkSymbolFacts[],
  telemetry: TelemetryRecorder,
  symbolContextInput: PacketSymbolContextInput,
  symbolContextMetrics: SymbolContextMetrics
): Promise<SymbolSourceContext> {
  const fact = primarySymbolFactWithMergedChanges(symbolFacts);
  const selector = fact === undefined ? undefined : symbolSourceSelector(fact);
  if (fact === undefined || selector === undefined) {
    symbolContextMetrics.outlineOnly += 1;
    return { text: "", reasons: ["no_primary_symbol"] };
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
      symbolContextMetrics.outlineOnly += 1;
      return result.meta.degraded
        ? { text: "", reasons: [result.meta.degradationReason ?? "enclosing symbol source unavailable"], degradation: result.meta.degradationReason ?? "enclosing symbol source unavailable" }
        : { text: "", reasons: ["enclosing symbol source empty"] };
    }
    const label = result.symbol?.name ?? fact.enclosingSymbol ?? `line ${String(selector.line ?? "")}`.trim();
    const block = renderFullSymbolContext(readPath, label, fact, result.text);
    const budget = computeSymbolContextBudget({
      ...symbolContextInput,
      symbolFacts,
      originalChars: block.length,
      providerTruncated: result.meta.truncated === true
    });
    recordSymbolContextBudgetMetric(symbolContextMetrics, budget);
    const forceSlicedContext = budget.mode === "adaptive_sliced";
    const truncated = forceSlicedContext || block.length > budget.maxChars;
    if (!truncated && result.meta.truncated !== true) {
      recordSymbolContextMetric(symbolContextMetrics, budget, "full");
      emitSymbolContextBudgetAudit(telemetry, file.path, readPath, fact, result.symbol?.name, budget, {
        emittedChars: block.length,
        omittedChars: 0,
        outputMode: budget.adaptive ? "adaptive_full" : "default_full",
        materialOmission: false,
        providerTruncated: false
      });
      telemetry.event({
        stage: 6,
        level: "debug",
        message: "packet_symbol_context_selected",
        file: file.path,
        data: {
          hunkId: fact.hunkId,
          symbol: result.symbol?.name ?? fact.enclosingSymbol,
          path: readPath,
          coverage: budget.coverage,
          reviewPriority: budget.reviewPriority,
          originalChars: block.length,
          selectedBudgetChars: budget.maxChars,
          emittedChars: block.length,
          omittedChars: 0,
          singlePrimarySymbol: budget.singlePrimarySymbol,
          uniqueSymbolCount: budget.uniqueSymbolCount,
          mode: budget.adaptive ? "adaptive_full" : "default_full",
          budgetMode: budget.mode,
          patchPressure: budget.patchPressure,
          hunkPressure: budget.hunkPressure,
          adaptiveEligible: budget.adaptiveEligible,
          ...(budget.blockedReason !== undefined ? { blockedReason: budget.blockedReason } : {}),
          reason: budget.reason
        }
      });
      return { text: block, quality: "full", reasons: [] };
    }
    const sliced = await readChangedLineExcerpts(repoIndex, readPath, fact, source, telemetry);
    const text = renderSlicedSymbolContext(readPath, label, fact, sliced, result.text, budget.maxChars);
    recordSymbolContextMetric(symbolContextMetrics, budget, "sliced");
    symbolContextMetrics.materialOmission += 1;
    if (!budget.adaptive) {
      symbolContextMetrics.defaultSlicedMaterialOmission += 1;
    }
    const outputMode = budget.adaptive ? "adaptive_sliced" : "default_sliced";
    emitSymbolContextBudgetAudit(telemetry, file.path, readPath, fact, result.symbol?.name, budget, {
      emittedChars: text.length,
      omittedChars: Math.max(0, block.length - text.length),
      outputMode,
      materialOmission: true,
      providerTruncated: result.meta.truncated === true
    });
    telemetry.event({
      stage: 6,
      level: "warn",
      message: "packet_symbol_source_truncated",
      file: file.path,
      data: {
        hunkId: fact.hunkId,
        symbol: result.symbol?.name ?? fact.enclosingSymbol,
        path: readPath,
        coverage: budget.coverage,
        reviewPriority: budget.reviewPriority,
        originalChars: block.length,
        selectedBudgetChars: budget.maxChars,
        emittedChars: text.length,
        omittedChars: Math.max(0, block.length - text.length),
        singlePrimarySymbol: budget.singlePrimarySymbol,
        uniqueSymbolCount: budget.uniqueSymbolCount,
        budgetReason: budget.reason,
        mode: outputMode,
        budgetMode: budget.mode,
        patchPressure: budget.patchPressure,
        hunkPressure: budget.hunkPressure,
        adaptiveEligible: budget.adaptiveEligible,
        ...(budget.blockedReason !== undefined ? { blockedReason: budget.blockedReason } : {}),
        maxChars: budget.maxChars,
        providerTruncated: result.meta.truncated === true
      }
    });
    return {
      text,
      quality: "sliced",
      reasons: ["enclosing symbol source sliced"],
      degradation: "enclosing symbol source truncated"
    };
  } catch (error) {
    symbolContextMetrics.outlineOnly += 1;
    const message = error instanceof Error ? error.message : String(error);
    telemetry.event({
      stage: 6,
      level: "warn",
      message: "packet_symbol_source_unavailable",
      file: file.path,
      data: { hunkId: fact.hunkId, path: readPath, error: message }
    });
    return { text: "", reasons: [`enclosing symbol source unavailable: ${message}`], degradation: `enclosing symbol source unavailable: ${message}` };
  }
}

function primarySymbolFact(symbolFacts: HunkSymbolFacts[]): HunkSymbolFacts | undefined {
  return rankedPrimarySymbolFacts(symbolFacts)[0];
}

function primarySymbolFactWithMergedChanges(symbolFacts: HunkSymbolFacts[]): HunkSymbolFacts | undefined {
  const primary = primarySymbolFact(symbolFacts);
  if (primary === undefined) {
    return undefined;
  }
  const primaryIdentity = symbolFactIdentity(primary);
  const sameSymbolFacts = rankedPrimarySymbolFacts(symbolFacts)
    .filter((fact) => symbolFactIdentity(fact) === primaryIdentity && fact.changedLinesSide === primary.changedLinesSide);
  if (sameSymbolFacts.length <= 1) {
    return primary;
  }
  return {
    ...primary,
    changedLines: [...new Set(sameSymbolFacts.flatMap((fact) => fact.changedLines))].sort((a, b) => a - b)
  };
}

function rankedPrimarySymbolFacts(symbolFacts: HunkSymbolFacts[]): HunkSymbolFacts[] {
  return [...symbolFacts]
    .filter(isRealSymbolFact)
    .sort((a, b) => {
      const scoreDiff = symbolFactScore(b) - symbolFactScore(a);
      const lineA = a.changedLines[0] ?? a.symbolRange?.[0] ?? Number.MAX_SAFE_INTEGER;
      const lineB = b.changedLines[0] ?? b.symbolRange?.[0] ?? Number.MAX_SAFE_INTEGER;
      return scoreDiff || lineA - lineB || a.hunkId.localeCompare(b.hunkId);
    });
}

function symbolSourceSelector(fact: HunkSymbolFacts): { symbolName?: string; line?: number } | undefined {
  if (fact.enclosingSymbol !== undefined) {
    return { symbolName: fact.enclosingSymbol };
  }
  const line = fact.symbolRange?.[0];
  return line !== undefined ? { line } : undefined;
}

function computeSymbolContextBudget(input: PacketSymbolContextInput & {
  symbolFacts: HunkSymbolFacts[];
  originalChars: number;
  providerTruncated: boolean;
}): SymbolContextBudget {
  const realFacts = rankedPrimarySymbolFacts(input.symbolFacts);
  const uniqueSymbols = new Set(realFacts.map(symbolFactIdentity));
  const hunkIds = [...new Set(realFacts.map((fact) => fact.hunkId))].sort();
  const singlePrimarySymbol = uniqueSymbols.size === 1 && realFacts.length > 0;
  const highRisk = isHighRiskPacket(input.coverage, input.reviewPriority);
  const riskSignals = symbolContextRiskSignals(input, highRisk);
  const importantPacket = riskSignals.length > 0;
  const defaultWouldMateriallyOmit = input.originalChars > DEFAULT_SYMBOL_CONTEXT_CHARS || input.providerTruncated;
  const patchPressure =
    input.patchChars > MAX_PATCH_CHARS * 0.75
      ? "high"
      : input.patchChars > MAX_PATCH_CHARS * 0.5
        ? "medium"
        : "low";
  const hunkPressure =
    input.hunkCount >= 4
      ? "high"
      : input.hunkCount >= 2
        ? "medium"
        : "low";

  let maxChars = DEFAULT_SYMBOL_CONTEXT_CHARS;
  let reason = "default_symbol_context_budget";
  let mode: SymbolContextBudgetMode = "default";
  let blockedReason: string | undefined;

  if (!singlePrimarySymbol) {
    reason = uniqueSymbols.size === 0 ? "no_primary_symbol_for_adaptive_budget" : "multiple_symbols_keep_compact";
    blockedReason = reason;
  } else if (!importantPacket) {
    reason = defaultWouldMateriallyOmit ? "ordinary_material_omission_keep_compact" : "ordinary_packet_keep_compact";
    blockedReason = reason;
  } else if (patchPressure === "high" || hunkPressure === "high") {
    if (defaultWouldMateriallyOmit) {
      maxChars = MAX_ADAPTIVE_SYMBOL_CONTEXT_CHARS;
      mode = "adaptive_sliced";
      reason = "single_important_symbol_high_pressure_adaptive_slice";
    } else {
      reason = "important_high_pressure_without_material_omission_keep_compact";
      blockedReason = reason;
    }
  } else if (patchPressure === "low" && hunkPressure === "low") {
    maxChars = MAX_ADAPTIVE_SYMBOL_CONTEXT_CHARS;
    mode = "adaptive_full";
    reason = "single_high_risk_symbol_low_pressure";
  } else if (highRisk) {
    maxChars = 5_000;
    mode = "adaptive_full";
    reason = "single_high_risk_symbol_medium_pressure";
  } else if (defaultWouldMateriallyOmit) {
    maxChars = 5_000;
    mode = "adaptive_sliced";
    reason = "single_risk_signal_material_omission_adaptive_slice";
  } else {
    reason = "risk_signal_without_material_omission_keep_compact";
    blockedReason = reason;
  }
  const adaptive = mode !== "default";

  return {
    coverage: input.coverage,
    reviewPriority: input.reviewPriority,
    hunkCount: input.hunkCount,
    patchChars: input.patchChars,
    lenses: input.lenses,
    attentionNotes: input.attentionNotes,
    labels: input.labels,
    maxChars: Math.min(maxChars, MAX_ADAPTIVE_SYMBOL_CONTEXT_CHARS, MAX_CONTEXT_CHARS),
    reason,
    mode,
    singlePrimarySymbol,
    uniqueSymbolCount: uniqueSymbols.size,
    adaptive,
    adaptiveEligible: singlePrimarySymbol && importantPacket,
    ...(blockedReason !== undefined ? { blockedReason } : {}),
    patchPressure,
    hunkPressure,
    originalChars: input.originalChars,
    defaultWouldMateriallyOmit,
    riskSignals,
    hunkIds
  };
}

function symbolContextRiskSignals(
  input: PacketSymbolContextInput & { symbolFacts: HunkSymbolFacts[] },
  highRisk: boolean
): string[] {
  const signals: string[] = [];
  if (highRisk) {
    signals.push("high_risk_coverage_or_priority");
  }
  if (input.attentionNotes.length > 0) {
    signals.push("hunk_scoped_attention");
  }
  if (input.lenses.some(isRiskLensForContext)) {
    signals.push("risk_lens");
  }
  if (input.labels.some(isRiskLabelForContext)) {
    signals.push("file_label");
  }
  return [...new Set(signals)];
}

function isRiskLensForContext(lens: string): boolean {
  const segments = lens.toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean);
  return segments.some((segment) => RISK_LENS_SEGMENTS.has(segment));
}

const RISK_LENS_SEGMENTS = new Set([
  "architecture",
  "architectural",
  "bug",
  "bugs",
  "concurrency",
  "correctness",
  "database",
  "db",
  "logic",
  "performance",
  "security",
  "test",
  "tests"
]);

function isRiskLabelForContext(label: string): boolean {
  const normalized = label.toLowerCase();
  return normalized === "critical" ||
    normalized === "high-risk" ||
    normalized === "public-api" ||
    normalized === "public-surface" ||
    normalized === "security" ||
    normalized === "database" ||
    normalized === "performance" ||
    normalized === "architecture" ||
    normalized === "testing";
}

function symbolFactIdentity(fact: HunkSymbolFacts): string {
  if (fact.enclosingSymbol !== undefined && fact.symbolRange !== undefined) {
    return `${fact.path}:${fact.enclosingSymbol}:${fact.symbolRange[0]}-${fact.symbolRange[1]}`;
  }
  if (fact.symbolRange !== undefined) {
    return `${fact.path}:${fact.symbolRange[0]}-${fact.symbolRange[1]}`;
  }
  if (fact.enclosingSymbol !== undefined) {
    return `${fact.path}:${fact.enclosingSymbol}`;
  }
  return `${fact.path}:${fact.hunkId}`;
}

function recordSymbolContextMetric(
  metrics: SymbolContextMetrics,
  budget: SymbolContextBudget,
  mode: "full" | "sliced"
): void {
  if (budget.adaptive && mode === "full") {
    metrics.adaptiveFull += 1;
    return;
  }
  if (budget.adaptive && mode === "sliced") {
    metrics.adaptiveSliced += 1;
    return;
  }
  if (mode === "full") {
    metrics.defaultFull += 1;
    return;
  }
  metrics.defaultSliced += 1;
}

function recordSymbolContextBudgetMetric(metrics: SymbolContextMetrics, budget: SymbolContextBudget): void {
  if (budget.adaptiveEligible) {
    metrics.adaptiveEligible += 1;
  }
  if (!budget.adaptive && budget.blockedReason !== undefined) {
    metrics.adaptiveBlocked += 1;
    metrics.adaptiveBlockedByReason[budget.blockedReason] = (metrics.adaptiveBlockedByReason[budget.blockedReason] ?? 0) + 1;
  }
}

function emitSymbolContextBudgetAudit(
  telemetry: TelemetryRecorder,
  filePath: string,
  readPath: string,
  fact: HunkSymbolFacts,
  resolvedSymbol: string | undefined,
  budget: SymbolContextBudget,
  outcome: {
    emittedChars: number;
    omittedChars: number;
    outputMode: "default_full" | "default_sliced" | "adaptive_full" | "adaptive_sliced";
    materialOmission: boolean;
    providerTruncated: boolean;
  }
): void {
  telemetry.event({
    stage: 6,
    level: "debug",
    message: "packet_symbol_context_budget",
    file: filePath,
    data: {
      hunkIds: budget.hunkIds,
      primaryHunkId: fact.hunkId,
      symbol: resolvedSymbol ?? fact.enclosingSymbol,
      path: readPath,
      coverage: budget.coverage,
      reviewPriority: budget.reviewPriority,
      patchChars: budget.patchChars,
      hunkCount: budget.hunkCount,
      uniqueSymbolCount: budget.uniqueSymbolCount,
      originalChars: budget.originalChars,
      selectedBudgetChars: budget.maxChars,
      selectedMode: budget.mode,
      outputMode: outcome.outputMode,
      emittedChars: outcome.emittedChars,
      omittedChars: outcome.omittedChars,
      materialOmission: outcome.materialOmission,
      defaultWouldMateriallyOmit: budget.defaultWouldMateriallyOmit,
      patchPressure: budget.patchPressure,
      hunkPressure: budget.hunkPressure,
      adaptiveEligible: budget.adaptiveEligible,
      adaptiveSelected: budget.adaptive,
      riskSignals: budget.riskSignals,
      reason: budget.reason,
      providerTruncated: outcome.providerTruncated,
      ...(budget.blockedReason !== undefined ? { blockedReason: budget.blockedReason } : {})
    }
  });
}

function renderFullSymbolContext(readPath: string, label: string, fact: HunkSymbolFacts, sourceText: string): string {
  return [
    `Primary symbol: ${readPath}:${label}`,
    fact.signature !== undefined ? `Signature: ${fact.signature}` : undefined,
    fact.symbolRange !== undefined ? `Line range: ${fact.symbolRange[0]}-${fact.symbolRange[1]}` : undefined,
    fact.changedLines.length > 0 ? `Changed ranges: ${compactLineRanges(fact.changedLines).join(", ")}` : undefined,
    "Relevant source excerpts:",
    sourceText.trimEnd()
  ].filter((part): part is string => part !== undefined && part.length > 0).join("\n");
}

function renderSlicedSymbolContext(
  readPath: string,
  label: string,
  fact: HunkSymbolFacts,
  excerpts: string[],
  fallbackSource: string,
  maxChars: number
): string {
  const header = [
    `Primary symbol: ${readPath}:${label}`,
    fact.signature !== undefined ? `Signature: ${fact.signature}` : undefined,
    fact.symbolRange !== undefined ? `Line range: ${fact.symbolRange[0]}-${fact.symbolRange[1]}` : undefined,
    fact.changedLines.length > 0 ? `Changed ranges: ${compactLineRanges(fact.changedLines).join(", ")}` : undefined,
    "Relevant source excerpts:"
  ].filter((part): part is string => part !== undefined && part.length > 0).join("\n");
  const footer = "[symbol source sliced around changed lines; source outside excerpt ranges omitted]";
  const bodyBudget = Math.max(0, maxChars - header.length - footer.length - 2);
  const excerptText = excerpts.length > 0
    ? fitSymbolExcerpts(excerpts, bodyBudget)
    : truncateToBudget(fallbackSource.trimEnd(), Math.min(MAX_SYMBOL_EXCERPT_CHARS, bodyBudget));
  return [
    header,
    excerptText,
    footer
  ].filter((part) => part.length > 0).join("\n");
}

function fitSymbolExcerpts(excerpts: string[], maxChars: number): string {
  if (maxChars <= 0) {
    return "";
  }
  const separatorChars = Math.max(0, excerpts.length - 1) * 2;
  const perExcerptBudget = Math.max(0, Math.floor((maxChars - separatorChars) / Math.max(1, excerpts.length)));
  const fitted = excerpts.map((excerpt) => truncateToBudget(excerpt, perExcerptBudget)).join("\n\n");
  return fitted.length <= maxChars ? fitted : truncateToBudget(fitted, maxChars);
}

function truncateToBudget(input: string, maxChars: number): string {
  if (input.length <= maxChars) {
    return input;
  }
  if (maxChars <= 0) {
    return "";
  }
  const marker = "\n[... content truncated to fit packet context budget ...]";
  if (maxChars <= marker.length) {
    return input.slice(0, maxChars);
  }
  return `${input.slice(0, maxChars - marker.length).trimEnd()}${marker}`;
}

async function readChangedLineExcerpts(
  repoIndex: RepositoryIndex,
  readPath: string,
  fact: HunkSymbolFacts,
  source: { kind: "base" } | { kind: "head" },
  telemetry: TelemetryRecorder
): Promise<string[]> {
  const ranges = excerptRanges(fact);
  const excerpts: string[] = [];
  for (const range of ranges) {
    const normalized = normalizeStage6ReadRange({
      startLine: range[0],
      endLine: range[1],
      ...(fact.symbolRange?.[1] !== undefined ? { maxLine: fact.symbolRange[1] } : {}),
      telemetry,
      path: readPath,
      source,
      context: "symbol_excerpt",
      hunkId: fact.hunkId
    });
    if (normalized === undefined) {
      continue;
    }
    try {
      const result = await withRepositoryToolCallContext(
        repoIndex.tools,
        { stage: 6, initiator: "harness" },
        () => repoIndex.tools.readRange(readPath, normalized.startLine, normalized.endLine, source)
      );
      if (result.text.trim().length > 0) {
        excerpts.push(`Excerpt ${readPath}:${normalized.startLine}-${normalized.endLine}\n${result.text.trimEnd()}`);
      }
    } catch {
      // Best-effort debug context; readSymbol output remains the fallback.
    }
  }
  return excerpts;
}

function excerptRanges(fact: HunkSymbolFacts): Array<[number, number]> {
  const changedLines = fact.changedLines.length > 0
    ? fact.changedLines
    : fact.symbolRange !== undefined
      ? [fact.symbolRange[0]]
      : [];
  const ranges: Array<[number, number]> = [];
  for (const line of changedLines) {
    const min = fact.symbolRange?.[0] ?? 1;
    const start = Math.max(min, line - SYMBOL_EXCERPT_WINDOW);
    const end = line + SYMBOL_EXCERPT_WINDOW;
    const previous = ranges[ranges.length - 1];
    if (previous && start <= previous[1] + 1) {
      previous[1] = Math.max(previous[1], end);
    } else {
      ranges.push([start, end]);
    }
  }
  return ranges.slice(0, 4);
}

function compactLineRanges(lines: number[]): string[] {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const ranges: string[] = [];
  let start: number | undefined;
  let previous: number | undefined;
  for (const line of sorted) {
    if (start === undefined || previous === undefined) {
      start = line;
      previous = line;
      continue;
    }
    if (line === previous + 1) {
      previous = line;
      continue;
    }
    ranges.push(start === previous ? String(start) : `${start}-${previous}`);
    start = line;
    previous = line;
  }
  if (start !== undefined && previous !== undefined) {
    ranges.push(start === previous ? String(start) : `${start}-${previous}`);
  }
  return ranges;
}

function isRealSymbolFact(fact: HunkSymbolFacts): boolean {
  return fact.enclosingSymbol !== undefined || fact.symbolRange !== undefined;
}

function symbolFactScore(fact: HunkSymbolFacts): number {
  return Math.max(1, fact.changedLines.length) +
    (fact.enclosingSymbol !== undefined ? 100 : 0) +
    (fact.confidence === "syntactic" ? 20 : 0) +
    (fact.source === "tree-sitter" ? 20 : 0) +
    (fact.symbolKind !== undefined ? 10 : 0);
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
      const resolved = await resolvePacketContextHint(repoIndex, hint, hintPath, telemetry);
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
  path: string,
  telemetry: TelemetryRecorder
): Promise<string | undefined> {
  if (hint.lineRange !== undefined) {
    const normalized = normalizeStage6ReadRange({
      startLine: hint.lineRange[0],
      endLine: Math.min(hint.lineRange[1], hint.lineRange[0] + MAX_HINT_CONTEXT_LINES - 1),
      telemetry,
      path,
      source: { kind: "head" },
      context: "planner_hint",
      reason: hint.reason
    });
    if (normalized === undefined) {
      return undefined;
    }
    const result = await withRepositoryToolCallContext(
      repoIndex.tools,
      { stage: 6, initiator: "harness" },
      () => repoIndex.tools.readRange(path, normalized.startLine, normalized.endLine, { kind: "head" })
    );
    return renderHintContextBlock(hint, path, `${normalized.startLine}-${normalized.endLine}`, result.text);
  }
  const symbol = hint.symbol;
  if (symbol !== undefined) {
    if (hint.kind === "call_site") {
      return resolveCallSiteContextHint(repoIndex, hint, path, symbol, telemetry);
    }
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

async function resolveCallSiteContextHint(
  repoIndex: RepositoryIndex,
  hint: SurroundingContextHint,
  path: string,
  symbol: string,
  telemetry: TelemetryRecorder
): Promise<string | undefined> {
  const scopedMentions = await findCallSiteMentions(repoIndex, symbol, { pathGlob: path });
  const scopedSelected = selectCallSiteCallerSymbols(scopedMentions.results, symbol, path);
  const needsRepoWideFallback = scopedSelected.length === 0;
  const mentions = needsRepoWideFallback ? await findCallSiteMentions(repoIndex, symbol) : scopedMentions;
  const selected = needsRepoWideFallback ? selectCallSiteCallerSymbols(mentions.results, symbol, path) : scopedSelected;
  if (selected.length === 0) {
    const warning = callSiteHintWarning(mentions.results, symbol, path, needsRepoWideFallback ? "repo" : "same_file") ??
      (needsRepoWideFallback ? callSiteHintWarning(scopedMentions.results, symbol, path, "same_file") : undefined);
    if (warning !== undefined) {
      telemetry.event({
        stage: 6,
        level: "warn",
        message: "planner_context_hint_warning",
        file: path,
        data: {
          path,
          symbol,
          kind: hint.kind,
          resultCount: warning.resultCount,
          searchScope: warning.searchScope,
          warning: warning.reason,
          reason: hint.reason
        }
      });
    }
    telemetry.event({
      stage: 6,
      level: "debug",
      message: "packet_context_call_site_hint_empty",
      file: path,
      data: {
        path,
        symbol,
        resultCount: mentions.results.length,
        includedCount: 0,
        searchScope: needsRepoWideFallback ? "repo" : "same_file",
        reason: "no distinct caller symbols found"
      }
    });
    return undefined;
  }

  const blocks: string[] = [];
  let failedReads = 0;
  for (const caller of selected.slice(0, CALL_SITE_CONTEXT_SYMBOL_LIMIT)) {
    const result = await withRepositoryToolCallContext(
      repoIndex.tools,
      { stage: 6, initiator: "harness" },
      () => repoIndex.tools.readSymbol(caller.path, { line: caller.lineRange[0] }, { kind: "head" })
    );
    if (result.text === undefined || result.text.trim().length === 0) {
      failedReads += 1;
      continue;
    }
    blocks.push(renderHintContextBlock(
      hint,
      caller.path,
      `${caller.name}:${caller.lineRange[0]}-${caller.lineRange[1]}`,
      result.text
    ));
  }

  if (blocks.length === 0) {
    telemetry.event({
      stage: 6,
      level: "warn",
      message: "packet_context_call_site_hint_degraded",
      file: path,
      data: {
        path,
        symbol,
        resultCount: mentions.results.length,
        includedCount: 0,
        searchScope: needsRepoWideFallback ? "repo" : "same_file",
        reason: "caller symbol mentions were found but caller bodies could not be read",
        failedReads
      }
    });
    return undefined;
  }

  telemetry.event({
    stage: 6,
    level: "debug",
    message: "packet_context_call_site_hint_resolved",
    file: path,
    data: {
      path,
      symbol,
      resultCount: mentions.results.length,
      includedCount: blocks.length,
      searchScope: needsRepoWideFallback ? "repo" : "same_file",
      reason: hint.reason
    }
  });
  if (mentions.meta.degraded || mentions.meta.truncated || selected.length > blocks.length || selected.length > CALL_SITE_CONTEXT_SYMBOL_LIMIT) {
    telemetry.event({
      stage: 6,
      level: "warn",
      message: "packet_context_call_site_hint_degraded",
      file: path,
      data: {
        path,
        symbol,
        resultCount: mentions.results.length,
        includedCount: blocks.length,
        searchScope: needsRepoWideFallback ? "repo" : "same_file",
        reason: mentions.meta.degradationReason ?? "call-site context was bounded",
        truncated: mentions.meta.truncated === true || selected.length > CALL_SITE_CONTEXT_SYMBOL_LIMIT,
        omittedCount: mentions.meta.omittedCount ?? Math.max(0, selected.length - CALL_SITE_CONTEXT_SYMBOL_LIMIT),
        failedReads
      }
    });
  }

  return truncateTail(blocks.join("\n\n"), MAX_HINT_CONTEXT_CHARS);
}

function findCallSiteMentions(
  repoIndex: RepositoryIndex,
  symbol: string,
  options: { pathGlob?: string } = {}
): Promise<{ results: SearchResult[]; meta: ToolResultMeta }> {
  return withRepositoryToolCallContext(
    repoIndex.tools,
    { stage: 6, initiator: "harness" },
    () => repoIndex.tools.findSymbolMentions(symbol, {
      source: { kind: "head" },
      contextMode: "symbols",
      maxResults: CALL_SITE_MENTION_LOOKUP_LIMIT,
      ...(options.pathGlob !== undefined ? { pathGlob: options.pathGlob } : {})
    })
  );
}

function selectCallSiteCallerSymbols(results: SearchResult[], symbol: string, hintPath: string): SymbolRef[] {
  const callers = results
    .map((result) => result.enclosingSymbol)
    .filter((caller): caller is SymbolRef => caller !== undefined)
    .filter((caller) => !isSelfSymbol(caller, symbol, hintPath));
  const deduped = new Map<string, SymbolRef>();
  for (const caller of callers.sort((a, b) => callSiteCallerScore(a, hintPath) - callSiteCallerScore(b, hintPath) || a.path.localeCompare(b.path) || a.lineRange[0] - b.lineRange[0])) {
    const key = `${caller.path}:${caller.name}:${caller.lineRange[0]}-${caller.lineRange[1]}`;
    if (!deduped.has(key)) {
      deduped.set(key, caller);
    }
  }
  return [...deduped.values()];
}

function callSiteCallerScore(caller: SymbolRef, hintPath: string): number {
  if (caller.path === hintPath) {
    return 0;
  }
  if (caller.path.split("/").slice(0, -1).join("/") === hintPath.split("/").slice(0, -1).join("/")) {
    return 1;
  }
  return 2;
}

function isSelfSymbol(caller: SymbolRef, symbol: string, hintPath: string): boolean {
  return caller.path === hintPath && bareSymbolName(caller.name) === bareSymbolName(symbol);
}

function callSiteHintWarning(
  results: SearchResult[],
  symbol: string,
  hintPath: string,
  searchScope: "same_file" | "repo"
): { reason: string; resultCount: number; searchScope: "same_file" | "repo" } | undefined {
  const enclosingSymbols = results
    .map((result) => result.enclosingSymbol)
    .filter((caller): caller is SymbolRef => caller !== undefined);
  if (enclosingSymbols.length === 0 && results.length > 0) {
    return { reason: "call_site_hint_without_enclosing_symbols", resultCount: results.length, searchScope };
  }
  if (enclosingSymbols.length > 0 && enclosingSymbols.every((caller) => isSelfSymbol(caller, symbol, hintPath))) {
    return { reason: "call_site_hint_self_only", resultCount: results.length, searchScope };
  }
  return undefined;
}

function bareSymbolName(symbol: string): string {
  const match = /[A-Za-z_$][\w$]*$/u.exec(symbol.trim());
  return match?.[0] ?? symbol.trim();
}

function normalizeStage6ReadRange(input: {
  startLine: number;
  endLine: number;
  maxLine?: number;
  telemetry: TelemetryRecorder;
  path: string;
  source: SourceSelector;
  context: "symbol_excerpt" | "planner_hint";
  hunkId?: string;
  reason?: string;
}): { startLine: number; endLine: number } | undefined {
  const invalidReason = invalidStage6RangeReason(input.startLine, input.endLine, input.maxLine);
  if (invalidReason !== undefined) {
    input.telemetry.event({
      stage: 6,
      level: "debug",
      message: "stage6_read_range_skipped",
      file: input.path,
      data: {
        context: input.context,
        path: input.path,
        source: input.source.kind,
        startLine: input.startLine,
        endLine: input.endLine,
        ...(input.maxLine !== undefined ? { maxLine: input.maxLine } : {}),
        ...(input.hunkId !== undefined ? { hunkId: input.hunkId } : {}),
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
        invalidReason
      }
    });
    return undefined;
  }
  const endLine = input.maxLine === undefined ? input.endLine : Math.min(input.endLine, input.maxLine);
  if (endLine !== input.endLine) {
    input.telemetry.event({
      stage: 6,
      level: "debug",
      message: "stage6_read_range_clamped",
      file: input.path,
      data: {
        context: input.context,
        path: input.path,
        source: input.source.kind,
        startLine: input.startLine,
        requestedEndLine: input.endLine,
        endLine,
        maxLine: input.maxLine,
        ...(input.hunkId !== undefined ? { hunkId: input.hunkId } : {}),
        ...(input.reason !== undefined ? { reason: input.reason } : {})
      }
    });
  }
  return { startLine: input.startLine, endLine };
}

function invalidStage6RangeReason(startLine: number, endLine: number, maxLine: number | undefined): string | undefined {
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) {
    return "range lines must be integers";
  }
  if (startLine < 1) {
    return "startLine must be at least 1";
  }
  if (endLine < startLine) {
    return "endLine is before startLine";
  }
  if (maxLine !== undefined && (!Number.isInteger(maxLine) || maxLine < 1)) {
    return "maxLine must be a positive integer";
  }
  if (maxLine !== undefined && startLine > maxLine) {
    return "startLine is after known range end";
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
    const outline: string[] = [`Outline for ${result.outline.path}`];
    if (result.outline.imports.length > 0) {
      outline.push(`Imports: ${result.outline.imports.join(", ")}`);
    }
    if (result.outline.topLevelSymbols.length > 0) {
      outline.push(`Top-level symbols: ${result.outline.topLevelSymbols.map((symbol) => symbol.name).join(", ")}`);
    }
    parts.push(outline.join("\n"));
  }
  if (result.relevantTests.length > 0) {
    parts.push(`Likely tests: ${result.relevantTests.map((symbol) => `${symbol.path}:${symbol.name}`).join(", ")}`);
  }
  return parts.join("\n");
}

function contextQualityFor(
  result: Awaited<ReturnType<RepositoryToolsHost["buildPacketContext"]>>,
  symbolSource: SymbolSourceContext,
  text: string
): PacketContextQuality {
  if (symbolSource.quality !== undefined) {
    return symbolSource.quality;
  }
  if (text.trim().length === 0) {
    return "path_only";
  }
  if (result.outline !== undefined) {
    return "outline_only";
  }
  return "path_only";
}

function finalContextQuality(initial: PacketContextQuality, renderedText: string, materialTruncation: boolean): PacketContextQuality {
  if (renderedText.trim().length === 0) {
    return "path_only";
  }
  if (materialTruncation && initial === "full") {
    return "sliced";
  }
  return initial;
}

function emitPacketContextQuality(
  telemetry: TelemetryRecorder,
  filePath: string,
  coverage: Exclude<CoverageLevel, "skip">,
  reviewPriority: ReviewPriority,
  quality: PacketContextQuality,
  reasons: string[]
): void {
  telemetry.event({
    stage: 6,
    level: "debug",
    message: "packet_context_quality",
    file: filePath,
    data: {
      coverage,
      reviewPriority,
      quality,
      reasons
    }
  });
  if ((quality === "outline_only" || quality === "path_only") && isHighRiskPacket(coverage, reviewPriority)) {
    telemetry.event({
      stage: 6,
      level: "warn",
      message: "packet_context_degraded_high_risk",
      file: filePath,
      data: {
        coverage,
        reviewPriority,
        quality,
        reasons
      }
    });
  }
}

function isHighRiskPacket(coverage: Exclude<CoverageLevel, "skip">, reviewPriority: ReviewPriority): boolean {
  return coverage === "deep" || reviewPriority === "critical" || reviewPriority === "high";
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

function routedPacketLenses(input: {
  lenses: string[];
  language: string;
  file: DiffFile;
  facts: FileFacts;
  planned: PlannedHunk[];
  relevantTests: SymbolInfo[];
  attentionNotes: string[];
  coverage: Exclude<CoverageLevel, "skip">;
  reviewPriority: ReviewPriority;
  reviewProfile: ReviewProfile;
  telemetry: TelemetryRecorder;
}): string[] {
  const initial = boundedLensUnion(input.lenses, input.language, input.file.path, input.telemetry);
  const kept = initial.filter((lens) => {
    if (lens === "core/tests") {
      return shouldKeepTestsLens(input);
    }
    if (lens === "core/code-review") {
      return shouldKeepCodeReviewLens(input);
    }
    return true;
  });
  if (kept.length === 0) {
    return initial.slice(0, 1);
  }
  const dropped = initial.filter((lens) => !kept.includes(lens));
  if (dropped.length > 0) {
    input.telemetry.event({
      stage: 6,
      level: "info",
      message: "packet_lenses_pruned",
      file: input.file.path,
      data: { kept, dropped, reviewProfile: input.reviewProfile }
    });
  }
  return kept;
}

function shouldKeepTestsLens(input: {
  file: DiffFile;
  facts: FileFacts;
  planned: PlannedHunk[];
  relevantTests: SymbolInfo[];
  attentionNotes: string[];
  coverage: Exclude<CoverageLevel, "skip">;
  reviewPriority: ReviewPriority;
}): boolean {
  if (input.facts.testStatus === "test") {
    return true;
  }
  if (input.planned.some((entry) => entry.staticSignals.some((signal) => signal.lensHint === "core/tests" || signal.category === "testing"))) {
    return true;
  }
  if (input.planned.some((entry) => entry.decision?.surroundingContextHints.some((hint) => hint.kind === "test"))) {
    return true;
  }
  if (input.attentionNotes.some((note) => /\btests?|coverage|regression\b/iu.test(note))) {
    return true;
  }
  const importantUntestedBehavior = input.relevantTests.length === 0 &&
    input.coverage === "deep" &&
    !isMechanicalPacket(input.planned);
  return importantUntestedBehavior || input.reviewPriority === "critical";
}

function shouldKeepCodeReviewLens(input: {
  file: DiffFile;
  facts: FileFacts;
  planned: PlannedHunk[];
  attentionNotes: string[];
  coverage: Exclude<CoverageLevel, "skip">;
  reviewPriority: ReviewPriority;
  reviewProfile: ReviewProfile;
}): boolean {
  if (input.facts.testStatus === "test" || input.file.status === "deleted") {
    return true;
  }
  if (input.reviewPriority === "critical" || input.reviewPriority === "high" || input.coverage === "deep") {
    return true;
  }
  if (input.attentionNotes.length > 0) {
    return true;
  }
  return !isMechanicalPacket(input.planned) && input.reviewProfile !== "simple";
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

function defaultLensesForLanguage(facts: FileFacts, enabled: string[]): string[] {
  const selected: string[] = [];
  const language = facts.language;
  if (language === "go" && enabled.includes("lang/go")) {
    selected.push("lang/go");
  } else if (["typescript", "javascript", "ts", "js", "tsx", "jsx"].includes(language) && enabled.includes("lang/typescript")) {
    selected.push("lang/typescript");
  }
  if (facts.testStatus === "test" && enabled.includes("core/tests")) {
    selected.push("core/tests");
  } else if (enabled.includes("core/code-review")) {
    selected.push("core/code-review");
  }
  return [...new Set(selected.length > 0 ? selected : enabled.slice(0, 1))];
}

function maxReviewPriority(priorities: ReviewPriority[]): ReviewPriority {
  const order: Record<ReviewPriority, number> = { critical: 0, high: 1, normal: 2, low: 3 };
  return [...priorities].sort((a, b) => order[a] - order[b])[0] ?? "normal";
}

function toolBudget(coverage: Exclude<CoverageLevel, "skip">, depth: CodeninjaConfig["review"]["depth"], profile: ReviewProfile): ToolBudget {
  if (profile === "simple") {
    return { maxToolCalls: 0, maxInvestigationRounds: 0, maxResultChars: 0 };
  }
  const baseByProfile = profile === "investigate"
    ? {
        light: { maxToolCalls: 2, maxInvestigationRounds: 1, maxResultChars: 4000 },
        normal: { maxToolCalls: 6, maxInvestigationRounds: 2, maxResultChars: 12000 },
        deep: { maxToolCalls: 15, maxInvestigationRounds: 5, maxResultChars: 32000 }
      }
    : {
        light: { maxToolCalls: 1, maxInvestigationRounds: 1, maxResultChars: 3000 },
        normal: { maxToolCalls: 4, maxInvestigationRounds: 2, maxResultChars: 10000 },
        deep: { maxToolCalls: 10, maxInvestigationRounds: 3, maxResultChars: 20000 }
      };
  const base = baseByProfile[coverage];
  const scale = depth === "deep" ? 1.5 : depth === "light" ? 0.5 : 1;
  const round = depth === "light" ? Math.floor : Math.ceil;
  return {
    maxToolCalls: Math.max(1, round(base.maxToolCalls * scale)),
    maxInvestigationRounds: Math.max(1, round(base.maxInvestigationRounds * scale)),
    maxResultChars: Math.max(4000, round(base.maxResultChars * scale)),
    ...(profile === "investigate"
      ? {
          sourceExtension: {
            maxToolCalls: 1,
            maxResultChars: 4_000
          }
        }
      : {})
  };
}

function packetReviewProfile(input: {
  coverage: Exclude<CoverageLevel, "skip">;
  reviewPriority: ReviewPriority;
  planned: PlannedHunk[];
  attentionNotes: string[];
  hintCount: number;
}): ReviewProfile {
  if (
    input.coverage === "deep" ||
    input.reviewPriority === "critical" ||
    input.reviewPriority === "high" ||
    input.hintCount > 0 ||
    input.attentionNotes.length > 0
  ) {
    return "investigate";
  }
  if (
    input.coverage === "light" ||
    isMechanicalPacket(input.planned)
  ) {
    return "simple";
  }
  return "standard";
}

function isMechanicalPacket(planned: PlannedHunk[]): boolean {
  const changedLines = planned.flatMap((entry) => changedCodeLines(entry.hunk));
  if (changedLines.length === 0) {
    return true;
  }
  const hasEnclosingSymbol = planned.some((entry) => entry.symbolFacts.some((fact) => fact.enclosingSymbol !== undefined));
  return !hasEnclosingSymbol && changedLines.every(isImportOrBoilerplateLine);
}

function changedCodeLines(hunk: DiffHunk): string[] {
  return hunk.lines
    .filter((line) => line.kind === "add" || line.kind === "delete")
    .map((line) => line.content.trim())
    .filter((line) => line.length > 0);
}

function isImportOrBoilerplateLine(line: string): boolean {
  return /^import(?:\s|\()/u.test(line) ||
    /^from\s+["'][^"']+["']/u.test(line) ||
    /^export\s+\{[^}]*\}\s+from\s+["'][^"']+["'];?$/u.test(line) ||
    /^require\(["'][^"']+["']\);?$/u.test(line) ||
    /^["'][^"']+["']$/u.test(line) ||
    /^\)$/u.test(line) ||
    /^\(.*\)$/u.test(line);
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
