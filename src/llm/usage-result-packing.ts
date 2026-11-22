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
    ...(delivery.nextCursor ? { truncated: true, ...(!originalMeta.degraded && delivery.deliveredCount < input.usagePage.page.entries.length
      ? { degradationReason: "tool_result_budget" } : {}) } : {}) };
  return { ...canonical, text: delivery.text, meta, ...(delivery.isError ? { isError: true as const, errorCode: "budget_exhausted" as const } : {}) };
}

/** Render only complete usage rows. A cut resumes with the first unread row's cursor. */
export function packUsagePage(page: UsagePage, name: string, allowance: number): UsageDelivery {
  const render = (count: number): UsageDelivery => {
    const entries = page.entries.slice(0, count);
    const nextCursor = count < page.entries.length ? page.entries[count]!.cursor : page.nextCursor;
    const result: string[] = [
      `find_usages ${JSON.stringify(name)} @${page.revision}; scope ${page.scope}${page.pathGlob ? `; pathGlob ${JSON.stringify(page.pathGlob)}` : ""}; delivered ${count} of ${page.entries.length} discovered rows; candidate files ${page.candidateFiles}; scanned ${page.filesScanned}; parsed ${page.filesParsed}.`,
      "Bindings are not resolved; aliases and re-exports are lexical evidence. Renamed re-exports in other files may be missed."
    ];
    let previousPath: string | undefined;
    for (const [index, entry] of entries.entries()) {
      const { row } = entry;
      if (row.path !== previousPath) {
        const lineNumbers = [...new Set(entries.slice(index).filter(next => next.row.path === row.path).map(next => next.row.line))];
        result.push(`${JSON.stringify(row.path)}@${row.revision}: ${row.fileLines} lines; delivered hit lines ${lineNumbers.join(", ")}.`);
        previousPath = row.path;
      }
      result.push(renderEntry(entry));
    }
    if (page.omissions.length) result.push(`Incomplete evidence: ${page.omissions.join("; ")}${page.omittedDiagnostics ? `; ${page.omittedDiagnostics} additional files` : ""}.`);
    if (nextCursor) result.push(`Scan or delivery incomplete. Continue with cursor ${nextCursor}.`);
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
  const reason = page.entries.length === 0 && page.nextCursor
    ? "Usage search reached its file-scan limit before delivering a row."
    : "Usage search cannot deliver a complete row within the result budget.";
  return { text: `${reason}${nextCursor ? ` Continue with cursor ${nextCursor}.` : " Narrow the request."}`,
    deliveredCount: 0, ...(nextCursor ? { nextCursor } : {}), isError: true, errorCode: "budget_exhausted" };
}

function renderEntry(entry: UsageEntry): string {
  const { row } = entry;
  const location = `${JSON.stringify(row.path)}@${row.revision}:${row.line}:${row.column}`;
  const details = entry.kind === "text" ? "text-only mention" : [entry.row.role,
    `spelling=${JSON.stringify(entry.row.spelling)}`,
    ...(entry.row.receiver ? [`receiver=${JSON.stringify(entry.row.receiver)}`] : []),
    `enclosing=${JSON.stringify(entry.row.enclosing)}`,
    ...(entry.row.bindingEvidence ? [`import=${JSON.stringify(entry.row.bindingEvidence)}`] : [])].join("; ");
  return `${location} ${details}\n${row.line}\t${row.excerpt === undefined ? "[source line omitted: too long to deliver]" : row.excerpt}`;
}
