import type { ToolExecutionResult } from "./llm-runner.js";
import { numberSourceLine, renderSourceBlockHeader, withSixToolMeta } from "./repository-tool-guidance.js";
import { definitionCursor, type DefinitionPage } from "../repo/definition-page.js";
import { isTextFallbackHit } from "../repo/repository-index.js";

/** A cursor pages declaration locations; omitted bodies are recovered with read_range. */
export function packDefinitionPage(page: DefinitionPage, allowance: number): ToolExecutionResult {
  const remaining = page.hits.slice(page.offset);
  if (!remaining.length) {
    const message = page.meta.lookupStatus === "incomplete"
      ? `No declaration locations were verified in the selected ${page.sourceUsed} scope; discovery was bounded. Narrow the path and retry.`
      : `No declaration locations in the selected ${page.sourceUsed} scope.${page.meta.truncated ? " Discovery was bounded; narrow the path and retry." : ""}`;
    const text = withSixToolMeta(message, page.meta);
    if (text.length > allowance) return { text: "The definition status does not fit the result budget. No source was delivered.",
      isError: true, errorCode: "budget_exhausted", meta: { ...page.meta, deliveryStatus: "budget_rejected", degradationReason: "tool_result_budget" } };
    return { text, meta: page.meta, definitions: [] };
  }
  const render = (count: number, bodyCount: number): ToolExecutionResult => {
    const hits = remaining.slice(0, count);
    const more = page.offset + count < page.hits.length;
    const bodyIncomplete = bodyCount < count || hits.slice(0, bodyCount).some(hit => hit.nextLine !== undefined);
    const lines = [`read_definition ${JSON.stringify(page.name)} @${page.sourceUsed}: declaration locations`];
    let section: "verified" | "text" | undefined;
    for (const [i, hit] of hits.entries()) {
      const { symbol } = hit;
      const nextSection = isTextFallbackHit(hit) ? "text" : "verified";
      if (nextSection !== section) { lines.push(nextSection === "text" ? "Unverified text leads:" : "Verified declarations:"); section = nextSection; }
      const owner = symbol.ownerType ? `${symbol.ownerType}.` : "";
      lines.push(`${i + 1}. ${symbol.path}@${page.sourceUsed} ${owner}${symbol.name} (${symbol.nativeKind ?? symbol.kind}${isTextFallbackHit(hit) ? "; unverified text lead" : ""}) lines ${symbol.lineRange[0]}-${symbol.lineRange[1]}${hit.totalLines === undefined ? "" : ` of ${hit.totalLines}`}`);
    }
    for (const hit of hits.slice(0, bodyCount)) {
      if (hit.text === undefined || !hit.deliveredLineRange || hit.totalLines === undefined) continue;
      lines.push(`${isTextFallbackHit(hit) ? "Unverified text lead: " : ""}${renderSourceBlockHeader(hit.symbol.path, page.sourceUsed, hit.deliveredLineRange, hit.totalLines)}`);
      lines.push(...hit.text.split("\n").map((line, index) => numberSourceLine(line, hit.deliveredLineRange![0] + index)));
      if (hit.nextLine !== undefined) lines.push(`Body continues: read_range ${hit.symbol.path}@${page.sourceUsed}:${hit.nextLine}-${hit.symbol.lineRange[1]}.`);
    }
    const firstPartial = hits.slice(0, bodyCount).findIndex(hit => hit.nextLine !== undefined);
    const completeBodies = firstPartial < 0 ? bodyCount : firstPartial;
    lines.push(`Bodies delivered in full for rows ${completeBodies ? `1-${completeBodies}` : "none"}.${bodyCount < count ? ` For rows ${bodyCount + 1}-${count}, use read_range at their stated intervals.` : ""}`);
    if (more) {
      const next = page.hits[page.offset + count]!;
      lines.push(`More declarations: ${next.symbol.path}@${page.sourceUsed}:${next.symbol.lineRange[0]}; continue with cursor ${definitionCursor(page, page.offset + count)}.`);
    }
    const recovery = page.meta.recovery;
    const recoveryInDisplayedBody = recovery && hits.some(hit => hit.symbol.path === recovery.path
      && hit.symbol.lineRange[0] <= recovery.startLine && recovery.startLine <= hit.symbol.lineRange[1]);
    if (page.meta.truncated) lines.push(`The underlying declaration discovery was bounded; narrow the path.${recovery && !recoveryInDisplayedBody ? ` Recovery: read_range ${recovery.path}@${recovery.source}:${recovery.startLine}-${recovery.endLine}.` : ""}`);
    const truncated = Boolean(page.meta.truncated || more || bodyIncomplete);
    const { recovery: _recovery, deliveredLineRange: _range, requestedRange: _request, ...base } = page.meta;
    const meta = { ...base, ...(truncated ? { truncated: true, deliveryStatus: "truncated" as const,
      degradationReason: base.degradationReason ?? "definition_delivery_limit" } : { deliveryStatus: "full" as const }) };
    const text = withSixToolMeta(lines.join("\n"), meta);
    const single = page.hits.length === 1 && page.offset === 0 && page.meta.lookupStatus === "found"
      && count === 1 && bodyCount === 1 && !truncated && !isTextFallbackHit(hits[0]!) ? hits[0] : undefined;
    const deliveredRanges = hits.slice(0, bodyCount).flatMap(hit =>
      hit.text !== undefined && hit.deliveredLineRange && hit.totalLines !== undefined
        ? [{ path: hit.symbol.path, side: page.sourceUsed, lineRange: hit.deliveredLineRange }] : []);
    return { text, meta, deliveredRanges, definitions: hits.slice(0, bodyCount), ...(single?.text !== undefined && single.deliveredLineRange
      ? { rawSource: single.text, sourceLineRange: single.deliveredLineRange } : {}) };
  };
  if (allowance === Number.MAX_SAFE_INTEGER) {
    let bodyCount = 0;
    for (const hit of remaining) {
      if (hit.text === undefined || !hit.deliveredLineRange || hit.totalLines === undefined) break;
      bodyCount++;
      if (hit.nextLine !== undefined) break;
    }
    return render(remaining.length, bodyCount);
  }
  // Locations are selected first; optional bodies cannot evict a location row.
  for (let count = remaining.length; count > 0; count--) {
    let result = render(count, 0);
    if (result.text.length > allowance) continue;
    for (let bodies = 1; bodies <= count; bodies++) {
      const hit = remaining[bodies - 1]!;
      if (hit.text === undefined || !hit.deliveredLineRange || hit.totalLines === undefined) break;
      const candidate = render(count, bodies);
      if (candidate.text.length > allowance) break;
      result = candidate;
      if (hit.nextLine !== undefined) break;
    }
    return result;
  }
  const first = remaining[0]!;
  const cursor = definitionCursor(page, page.offset);
  return { text: `The definition location does not fit the result budget. First unread declaration: ${first.symbol.path}@${page.sourceUsed}:${first.symbol.lineRange[0]}; continue with cursor ${cursor}.`,
    isError: true, errorCode: "budget_exhausted", meta: { ...page.meta, truncated: true, deliveryStatus: "budget_rejected", degradationReason: "tool_result_budget" } };
}

export function packDefinitionToolResult(input: ToolExecutionResult, allowance: number): ToolExecutionResult {
  if (!input.definitionPage) return input;
  return { ...packDefinitionPage(input.definitionPage, allowance), definitionPage: input.definitionPage };
}
