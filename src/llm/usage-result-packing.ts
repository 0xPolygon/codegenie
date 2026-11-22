import type { UsageEntry, UsagePage } from "../repo/usage-search.js";
import type { ToolExecutionResult } from "./llm-runner.js";

export type UsageDelivery = { text: string; deliveredCount: number; nextCursor?: string; isError?: true; errorCode?: "budget_exhausted" };

export function packUsageToolResult(input: ToolExecutionResult, allowance: number): ToolExecutionResult {
  if (!input.usagePage) return input;
  const delivery = packUsagePage(input.usagePage.page, input.usagePage.name, allowance);
  const { isError: _previousError, errorCode: _previousCode, ...canonical } = input;
  const originalMeta = input.meta ?? { backend: "text" as const, precision: "text" as const, degraded: false };
  const meta = { ...originalMeta, deliveryStatus: delivery.isError ? "budget_rejected" as const
    : delivery.nextCursor ? "truncated" as const : delivery.deliveredCount ? "full" as const : "empty" as const,
    ...(originalMeta.usageDelivery ? { usageDelivery: { ...originalMeta.usageDelivery, deliveredRows: delivery.deliveredCount } } : {}),
    ...(delivery.nextCursor ? { truncated: true, ...(!originalMeta.degraded && delivery.deliveredCount < input.usagePage.page.entries.length
      ? { degradationReason: "tool_result_budget" } : {}) } : {}) };
  return { ...canonical, text: delivery.text, meta, ...(delivery.isError ? { isError: true as const, errorCode: "budget_exhausted" as const } : {}) };
}

/** Render only complete usage rows. A cut resumes with the first unread row's cursor. */
export function packUsagePage(page: UsagePage, name: string, allowance: number): UsageDelivery {
  const render = (count: number): UsageDelivery => {
    const entries = page.entries.slice(0, count);
    const nextCursor = count < page.entries.length ? page.entries[count]!.cursor : page.nextCursor;
    const unread = count < page.entries.length ? { ...page.entries[count]!.row, kind: "row" as const } : page.nextLocation;
    const result: string[] = [
      `find_usages ${JSON.stringify(name)} @${page.revision}; scope ${page.scope}${page.pathGlob ? `; pathGlob ${JSON.stringify(page.pathGlob)}` : ""}; delivered ${count} of ${page.entries.length} discovered rows; visited through candidate file ${page.candidateProgress} of ${page.candidateFiles} (last may be partial); parsed ${page.filesParsed} on this page.`,
      "Columns are 1-based UTF-16 code units. Bindings are not resolved; aliases and re-exports are lexical evidence. Renamed re-exports in other files may be missed. Binary files are excluded."
    ];
    let previousPath: string | undefined;
    let previousGroup: string | undefined;
    for (const [index, entry] of entries.entries()) {
      const { row } = entry;
      if (row.path !== previousPath) {
        const fileEntries = entries.slice(index).filter(next => next.row.path === row.path);
        const lineNumbers = [...new Set(fileEntries.map(next => next.row.line))];
        result.push(`${JSON.stringify(row.path)}@${row.revision}: ${row.fileLines} lines; delivered hit lines ${lineNumbers.join(", ")}.`);
        const seenImports = new Set<string>();
        for (const next of fileEntries) {
          if (next.kind !== "syntactic" || !next.row.bindingEvidence) continue;
          const evidence = next.row.bindingEvidence;
          const key = JSON.stringify(evidence);
          if (seenImports.has(key)) continue;
          seenImports.add(key);
          result.push(`${evidence.kind === "re_export_spelling" ? "re-exports" : "imports"} ${JSON.stringify(evidence.importedName)} as ${JSON.stringify(evidence.localName)} from ${JSON.stringify(evidence.moduleSpecifier)} (line ${evidence.line}${evidence.candidateModulePath ? `; candidate ${JSON.stringify(evidence.candidateModulePath)}` : ""}).`);
        }
        previousPath = row.path;
        previousGroup = undefined;
      }
      const group = entry.kind === "syntactic" ? JSON.stringify(entry.row.enclosing) : "text-only";
      if (group !== previousGroup) { result.push(entry.kind === "text" ? "Text-only mentions:"
        : formatEnclosing(entry.row.enclosing)); previousGroup = group; }
      result.push(renderEntry(entry));
    }
    if (page.omissions.length) result.push(`Incomplete evidence: ${page.omissions.join("; ")}${page.omittedDiagnostics ? `; ${page.omittedDiagnostics} additional files` : ""}.`);
    if (nextCursor) {
      const reason = count < page.entries.length ? "Result budget stopped delivery"
        : page.stopReason === "file_scan_limit" ? `Scan incomplete after visiting ${page.candidateProgress} of ${page.candidateFiles} candidate files`
          : "Page row limit reached";
      const location = unread ? `${unread.kind === "file" ? " Next candidate file" : " Next row"} ${JSON.stringify(unread.path)}@${page.revision}${unread.kind === "row" ? `:${unread.line}:${unread.column}` : ""}.` : "";
      result.push(`${reason}.${location} Continue with cursor ${nextCursor}.`);
    }
    else if (!page.coverageComplete) result.push("Scan ended with unverified text or incomplete files; absence of a syntax row does not prove absence of a use.");
    else result.push("Scan complete for the selected scope; binding and dynamic dispatch remain unresolved.");
    return { text: result.join("\n"), deliveredCount: count, ...(nextCursor ? { nextCursor } : {}) };
  };
  for (let count = page.entries.length; count > 0; count--) {
    const result = render(count);
    if (result.text.length <= allowance) return result;
  }
  if (page.entries.length === 0 && !page.nextCursor) {
    const empty = render(0);
    if (empty.text.length <= allowance) return empty;
  }
  const nextCursor = page.entries[0]?.cursor ?? page.nextCursor;
  const unread = page.entries[0] ? { ...page.entries[0].row, kind: "row" as const } : page.nextLocation;
  const reason = page.entries.length === 0 && page.nextCursor
    ? "Usage search reached its file-scan limit before delivering a row."
    : "Usage search cannot deliver a complete row within the result budget.";
  const location = unread ? `${unread.kind === "file" ? " Next candidate file" : " Next row"} ${JSON.stringify(unread.path)}@${page.revision}${unread.kind === "row" ? `:${unread.line}:${unread.column}` : ""}.` : "";
  return { text: `${reason}${location}${nextCursor ? ` Continue with cursor ${nextCursor}.` : " Narrow the request."}`,
    deliveredCount: 0, ...(nextCursor ? { nextCursor } : {}), isError: true, errorCode: "budget_exhausted" };
}

function renderEntry(entry: UsageEntry): string {
  const { row } = entry;
  const location = `${row.line}:${row.column}`;
  const details = entry.kind === "text" ? "text-only mention" : [entry.row.role,
    `spelling=${JSON.stringify(entry.row.spelling)}`,
    ...(entry.row.receiver ? [`receiver=${JSON.stringify(entry.row.receiver)}`] : []),
    ...(entry.row.packageName ? [`package=${JSON.stringify(entry.row.packageName)}`] : [])].join("; ");
  return `${location} ${details}\n${row.line}\t${row.excerpt === undefined
    ? `[source line omitted: too long to deliver; inspect ${JSON.stringify(row.path)}@${row.revision} line ${row.line}]` : row.excerpt}`;
}

function formatEnclosing(enclosing: Extract<UsageEntry, { kind: "syntactic" }>["row"]["enclosing"]): string {
  if (enclosing.kind === "module") return "At module level:";
  const range = `lines ${enclosing.lineRange[0]}-${enclosing.lineRange[1]}`;
  if (enclosing.kind === "anonymous") return `In anonymous callback (${range})${enclosing.nearestNamed
    ? ` inside ${JSON.stringify(enclosing.nearestNamed.name)} (lines ${enclosing.nearestNamed.lineRange.join("-")})` : ""}:`;
  return `In ${JSON.stringify(enclosing.name)} (${range})${enclosing.searchName && enclosing.searchName !== enclosing.name
    ? `; next-hop name ${JSON.stringify(enclosing.searchName)}` : ""}:`;
}
