import type { ReviewPacket, TestCoverageDeltaSymbol } from "../types.js";

type PacketPromptBlock = { label: string; content: string };

export function packetFirstBlocks(packet: ReviewPacket): {
  evidence: PacketPromptBlock[];
  author: PacketPromptBlock;
  harness: PacketPromptBlock;
  withheldPlannerProse: boolean;
} {
  const symbolsByHunk = new Map(packet.symbolFacts.filter(fact => fact.enclosingSymbol).map(fact => [fact.hunkId, fact]));
  const file = `File ${packet.path} (${packet.fileStatus}, ${packet.language}), packet ${packet.id.slice(0, 12)}`
    + (packet.oldPath ? `; renamed from ${packet.oldPath}` : "");
  const hunks = packet.hunks.map(hunk => {
    const fact = symbolsByHunk.get(hunk.hunkId);
    const symbol = fact?.enclosingSymbol ? `in ${fact.enclosingSymbol}${fact.symbolRange ? ` (lines ${fact.symbolRange.join("-")})` : ""}` : "";
    const header = `hunk ${hunk.hunkId} base ${hunkSpan(hunk.oldStart, hunk.oldLines)} head ${hunkSpan(hunk.newStart, hunk.newLines)}`;
    return [
      [header, hunk.header && `in ${hunk.header}`, symbol].filter(Boolean).join(" "),
      hunk.contentWithLineNumbers,
      ...(hunk.staticSignals ?? []).map(signal => `signal ${signal.ruleId}${signal.line !== undefined
        ? ` at ${signal.side === "LEFT" ? "base " : signal.side === "RIGHT" ? "head " : ""}line ${signal.line}` : ""}: ${signal.explanation}`),
      hunk.omittedSignalCount ? `${hunk.omittedSignalCount} more signals omitted` : ""
    ].filter(Boolean).join("\n");
  });
  const evidence = [
    { label: "changed-code", content: [file, ...(hunks.length ? hunks : ["no changed lines in this packet"])].join("\n\n") },
    { label: "surrounding-code", content: [packet.contextText, packet.packetSymbols?.length
      ? `Symbols touched: ${packet.packetSymbols.map(item => `${item.name} (${item.lineRange.join("-")})`).join(", ")}` : ""].filter(Boolean).join("\n") },
    { label: "related-changes", content: packet.relatedChangedContext.map(related => [
      [related.path, related.hunkId && `hunk ${related.hunkId}`, related.symbol,
        related.lineRange && `lines ${related.lineRange.join("-")}`,
        [related.relationshipSource, related.relationshipStrength].filter(Boolean).join("/")].filter(Boolean).join(" "),
      related.relationshipSource === "planner_hint" ? "" : related.reason,
      related.patchExcerpt,
      related.sourceSnippet
    ].filter(Boolean).join("\n")).join("\n\n") },
    { label: "tests", content: renderTests(packet) }
  ];
  const intent = packet.intentSignals;
  const author = { label: "author-claims", content: [
    "What the author says this change does. Each statement is a claim to check against the code above, not a fact.",
    packet.prSummary, packet.intentText, intent?.summary,
    ...(intent?.signals.map(signal => `${signal.kind} (${signal.source}): ${signal.snippet} — ${signal.reason}`) ?? [])
  ].filter(Boolean).join("\n") };
  const relationshipNotes = packet.relationshipAttentionNotes ?? [];
  const reasons = (packet.contextDegradationReasons ?? []).map(reason => reason.startsWith("planner packet_context hint(s) unresolved")
    ? "Planner context hints could not be resolved" : reason);
  const harness = { label: "harness-notes", content: [
    ...relationshipNotes,
    ...packet.surroundingContextHints.map(hint => [
      "look up", hint.kind, hint.symbol ?? (hint.lineRange ? `lines ${hint.lineRange.join("-")}` : ""),
      hint.path && `in ${hint.path}`
    ].filter(Boolean).join(" ")),
    packet.contextQuality && packet.contextQuality !== "full" ? `Context quality: ${packet.contextQuality}` : "",
    ...reasons,
    packet.degraded && !reasons.length ? "Packet context degraded." : ""
  ].filter(Boolean).join("\n") };
  return {
    evidence,
    author,
    harness,
    withheldPlannerProse: packet.attentionNotes.some(note => !relationshipNotes.includes(note))
      || packet.hunks.some(hunk => Boolean(hunk.plannerFallbackReason))
      || packet.surroundingContextHints.some(hint => Boolean(hint.reason))
      || packet.relatedChangedContext.some(related => related.relationshipSource === "planner_hint" && Boolean(related.reason))
      || reasons.some((reason, index) => reason !== packet.contextDegradationReasons?.[index])
  };
}

function hunkSpan(start: number, count: number): string {
  return count ? `${start}-${start + count - 1}` : `none (start ${start})`;
}

function renderTests(packet: ReviewPacket): string {
  const delta = packet.testCoverageDelta;
  const lists: Array<[string, readonly (string | TestCoverageDeltaSymbol)[]]> = delta ? [
    ["Deleted tests", delta.deletedTestSymbols], ["Added tests", delta.addedTestSymbols],
    ["Deleted helpers", delta.deletedHelperSymbols], ["Added helpers", delta.addedHelperSymbols],
    ["Deleted imports", delta.deletedImports], ["Added imports", delta.addedImports],
    ["Deleted production references", delta.deletedProductionRefs], ["Added production references", delta.addedProductionRefs],
    ["Boundary indicators", delta.boundaryIndicators]
  ] : [];
  return [
    delta?.summary,
    ...lists.filter(([, entries]) => entries.length).map(([label, entries]) =>
      `${label}: ${entries.map(entry => typeof entry === "string" ? entry : `${entry.name} (${entry.side}, ${entry.lineRange?.join("-") ?? entry.line ?? "location unavailable"})`).join(", ")}`),
    packet.relevantTests.length ? `Likely tests: ${packet.relevantTests.map(test => `${test.path}:${test.name} (${test.lineRange.join("-")})`).join(", ")}` : ""
  ].filter(Boolean).join("\n");
}
