import type {
  DiffFile,
  DiffHunk,
  DiffLine,
  FileFacts,
  HunkSymbolFacts,
  StaticSignal,
  TestCoverageDelta,
  TestCoverageDeltaSymbol
} from "../types.js";

const MAX_SYMBOLS = 12;
const MAX_IMPORTS = 12;
const MAX_REFS = 16;
const MAX_INDICATORS = 10;

const BOUNDARY_TERMS = [
  "adapter",
  "api",
  "abi",
  "client",
  "contract",
  "database",
  "db",
  "event",
  "filesystem",
  "file",
  "grpc",
  "http",
  "io",
  "json",
  "log",
  "network",
  "protocol",
  "provider",
  "request",
  "response",
  "rpc",
  "serialization",
  "serialize",
  "socket",
  "sql",
  "transport",
  "websocket",
  "xml",
  "yaml"
];

const TEST_FRAMEWORK_REFS = new Set([
  "after",
  "afterall",
  "aftereach",
  "assert",
  "before",
  "beforeall",
  "beforeeach",
  "context",
  "describe",
  "equal",
  "expect",
  "it",
  "require",
  "should",
  "suite",
  "t",
  "test",
  "toequal",
  "tobe",
  "true"
]);

type SideLine = {
  content: string;
  line?: number;
};

export function buildTestCoverageDelta(
  file: DiffFile,
  hunks: DiffHunk[],
  facts: FileFacts,
  symbolFacts: HunkSymbolFacts[] = []
): TestCoverageDelta | undefined {
  if (!isTestFile(file, facts)) {
    return undefined;
  }

  const deletedLines = sideLines(hunks, "delete");
  const addedLines = sideLines(hunks, "add");
  if (deletedLines.length === 0 && addedLines.length === 0) {
    return undefined;
  }

  const deletedSymbols = mergeSymbols([
    ...symbolsFromFacts(symbolFacts, "old", "LEFT"),
    ...symbolsFromDiffLines(deletedLines, "LEFT")
  ]);
  const addedSymbols = mergeSymbols([
    ...symbolsFromFacts(symbolFacts, "new", "RIGHT"),
    ...symbolsFromDiffLines(addedLines, "RIGHT")
  ]);
  const deletedImports = uniqueStrings(deletedLines.flatMap((line) => importTargets(line.content))).slice(0, MAX_IMPORTS);
  const addedImports = uniqueStrings(addedLines.flatMap((line) => importTargets(line.content))).slice(0, MAX_IMPORTS);
  const deletedProductionRefs = productionRefs(deletedLines).slice(0, MAX_REFS);
  const addedProductionRefs = productionRefs(addedLines).slice(0, MAX_REFS);
  const deletedTestSymbols = deletedSymbols.filter((symbol) => symbol.kind === "test").slice(0, MAX_SYMBOLS);
  const addedTestSymbols = addedSymbols.filter((symbol) => symbol.kind === "test").slice(0, MAX_SYMBOLS);
  const deletedHelperSymbols = deletedSymbols.filter(isHelperLikeSymbol).slice(0, MAX_SYMBOLS);
  const addedHelperSymbols = addedSymbols.filter(isHelperLikeSymbol).slice(0, MAX_SYMBOLS);
  const boundaryIndicators = uniqueStrings([
    ...deletedBoundaryIndicators(deletedLines, deletedSymbols, deletedImports, deletedProductionRefs)
  ]).slice(0, MAX_INDICATORS);
  const addedHelperRefs = addedProductionRefs.filter((ref) => isHelperLikeName(ref));
  const replacementRisk = boundaryIndicators.length > 0 &&
    deletedLines.length > 0 &&
    addedLines.length > 0 &&
    (addedHelperSymbols.length > 0 || addedHelperRefs.length > 0)
    ? "specialized_boundary_to_helper" as const
    : undefined;

  const summary = summarizeDelta({
    deletedTestCount: deletedTestSymbols.length,
    addedTestCount: addedTestSymbols.length,
    deletedHelperCount: deletedHelperSymbols.length,
    addedHelperCount: addedHelperSymbols.length,
    boundaryCount: boundaryIndicators.length,
    replacementRisk
  });

  return {
    deletedTestSymbols,
    addedTestSymbols,
    deletedHelperSymbols,
    addedHelperSymbols,
    deletedImports,
    addedImports,
    deletedProductionRefs,
    addedProductionRefs,
    boundaryIndicators,
    ...(replacementRisk !== undefined ? { replacementRisk } : {}),
    summary
  };
}

export function testCoverageRewriteSignals(file: DiffFile, facts: FileFacts): StaticSignal[] {
  const delta = buildTestCoverageDelta(file, file.hunks, facts);
  if (delta?.replacementRisk !== "specialized_boundary_to_helper") {
    return [];
  }
  const firstAdded = firstLine(file.hunks, "add");
  const firstDeleted = firstLine(file.hunks, "delete");
  const anchor = firstAdded ?? firstDeleted;
  return [{
    ruleId: "core/test-boundary-coverage-rewrite",
    path: file.path,
    ...(anchor?.line !== undefined ? { line: anchor.line } : {}),
    side: firstAdded !== undefined ? "RIGHT" : "LEFT",
    category: "testing",
    lensHint: "core/tests",
    confidence: "medium",
    explanation: "Deleted tests appear to exercise an integration or adapter boundary while replacement tests appear helper-level. Verify the same boundary wiring remains covered.",
    snippet: [
      delta.summary,
      delta.boundaryIndicators.length > 0 ? `Boundary indicators: ${delta.boundaryIndicators.join(", ")}` : undefined,
      delta.addedHelperSymbols.length > 0 ? `Added helper symbols: ${delta.addedHelperSymbols.map((symbol) => symbol.name).join(", ")}` : undefined
    ].filter((line): line is string => line !== undefined).join("\n")
  }];
}

function isTestFile(file: DiffFile, facts: FileFacts): boolean {
  if (facts.testStatus === "test") {
    return true;
  }
  return /(?:^|[./_-])(?:test|tests|spec|specs)(?:[./_-]|$)|\.(?:test|spec)\.[^.]+$/iu.test(file.path);
}

function sideLines(hunks: DiffHunk[], kind: DiffLine["kind"]): SideLine[] {
  return hunks.flatMap((hunk) =>
    hunk.lines
      .filter((line) => line.kind === kind)
      .map((line) => ({
        content: line.content,
        ...(kind === "delete" && line.oldLineNumber !== undefined ? { line: line.oldLineNumber } : {}),
        ...(kind === "add" && line.newLineNumber !== undefined ? { line: line.newLineNumber } : {})
      }))
  );
}

function firstLine(hunks: DiffHunk[], kind: "add" | "delete"): SideLine | undefined {
  return sideLines(hunks, kind)[0];
}

function symbolsFromFacts(
  facts: HunkSymbolFacts[],
  changedLinesSide: HunkSymbolFacts["changedLinesSide"],
  side: TestCoverageDeltaSymbol["side"]
): TestCoverageDeltaSymbol[] {
  return facts
    .filter((fact) => fact.changedLinesSide === changedLinesSide && fact.enclosingSymbol !== undefined)
    .map((fact) => symbolFromName(fact.enclosingSymbol ?? "", side, "symbol", fact.changedLines[0], fact.symbolRange));
}

function symbolsFromDiffLines(lines: SideLine[], side: TestCoverageDeltaSymbol["side"]): TestCoverageDeltaSymbol[] {
  const output: TestCoverageDeltaSymbol[] = [];
  for (const line of lines) {
    for (const name of declaredNames(line.content)) {
      output.push(symbolFromName(name, side, "diff", line.line));
    }
  }
  return output;
}

function declaredNames(content: string): string[] {
  const trimmed = content.trim();
  const names: string[] = [];
  const patterns = [
    /\bfunc\s+\([^)]*\)\s*([A-Za-z_$][\w$]*)\b/u,
    /\b(?:func|function|def|fn)\s+([A-Za-z_$][\w$]*)\b/u,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/u,
    /\b(?:class|interface|struct|type)\s+([A-Za-z_$][\w$]*)\b/u
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(trimmed);
    if (match?.[1]) {
      names.push(match[1]);
    }
  }
  const namedTest = /\b(?:it|test|describe|context|suite)\s*\(\s*["'`]([^"'`]+)["'`]/u.exec(trimmed);
  if (namedTest?.[1]) {
    names.push(`test: ${namedTest[1]}`);
  }
  return names;
}

function symbolFromName(
  name: string,
  side: TestCoverageDeltaSymbol["side"],
  source: TestCoverageDeltaSymbol["source"],
  line?: number,
  lineRange?: [number, number]
): TestCoverageDeltaSymbol {
  const kind = classifyName(name);
  return {
    name,
    side,
    kind,
    source,
    ...(line !== undefined ? { line } : {}),
    ...(lineRange !== undefined ? { lineRange } : {})
  };
}

function classifyName(name: string): TestCoverageDeltaSymbol["kind"] {
  const lower = name.toLowerCase();
  if (/^(?:test:|test|should|spec)/u.test(lower) || /\b(?:test|should|spec)\b/u.test(lower)) {
    return "test";
  }
  const split = splitName(name);
  if (/\b(?:mock|fake|stub|spy)\b/u.test(split)) {
    return "mock";
  }
  if (/\b(?:fixture|factory|seed)\b/u.test(split)) {
    return "fixture";
  }
  if (hasBoundaryTerm(name)) {
    return "boundary";
  }
  if (isHelperLikeName(name)) {
    return "helper";
  }
  return "other";
}

function mergeSymbols(symbols: TestCoverageDeltaSymbol[]): TestCoverageDeltaSymbol[] {
  const byKey = new Map<string, TestCoverageDeltaSymbol>();
  for (const symbol of symbols) {
    const key = `${symbol.side}:${symbol.name}:${symbol.lineRange?.join("-") ?? symbol.line ?? ""}`;
    if (!byKey.has(key)) {
      byKey.set(key, symbol);
    }
  }
  return [...byKey.values()];
}

function importTargets(content: string): string[] {
  if (!/\b(?:from|import|include|require|use)\b/iu.test(content)) {
    return [];
  }
  const quoted = [...content.matchAll(/["'`]([^"'`]+)["'`]/gu)].flatMap((match) => match[1] ? [match[1]] : []);
  if (quoted.length > 0) {
    return quoted;
  }
  const bare = /\b(?:from|import|include|require|use)\s+([@A-Za-z0-9_./:-]+)/iu.exec(content);
  return bare?.[1] ? [bare[1]] : [];
}

function productionRefs(lines: SideLine[]): string[] {
  const refs = new Set<string>();
  for (const line of lines) {
    const content = stripStringLiterals(line.content);
    for (const match of content.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/gu)) {
      addRef(refs, match[1]);
    }
    for (const match of content.matchAll(/\.([A-Za-z_$][\w$]*)\s*\(/gu)) {
      addRef(refs, match[1]);
    }
  }
  return [...refs].sort();
}

function addRef(refs: Set<string>, value: string | undefined): void {
  if (!value) {
    return;
  }
  const normalized = value.trim();
  if (normalized.length < 3 || TEST_FRAMEWORK_REFS.has(normalized.toLowerCase())) {
    return;
  }
  refs.add(normalized);
}

function deletedBoundaryIndicators(
  deletedLines: SideLine[],
  deletedSymbols: TestCoverageDeltaSymbol[],
  deletedImports: string[],
  deletedProductionRefs: string[]
): string[] {
  const indicators: string[] = [];
  for (const symbol of deletedSymbols) {
    if (symbol.kind === "boundary" || symbol.kind === "mock" || symbol.kind === "fixture") {
      indicators.push(`deleted_symbol:${symbol.name}`);
    }
  }
  for (const target of deletedImports) {
    if (hasBoundaryTerm(target)) {
      indicators.push(`deleted_import:${target}`);
    }
  }
  for (const ref of deletedProductionRefs) {
    if (hasBoundaryTerm(ref)) {
      indicators.push(`deleted_ref:${ref}`);
    }
  }
  for (const term of BOUNDARY_TERMS) {
    if (deletedLines.some((line) => wordIncludes(line.content, term))) {
      indicators.push(`deleted_boundary_term:${term}`);
    }
  }
  return indicators;
}

function summarizeDelta(input: {
  deletedTestCount: number;
  addedTestCount: number;
  deletedHelperCount: number;
  addedHelperCount: number;
  boundaryCount: number;
  replacementRisk?: TestCoverageDelta["replacementRisk"];
}): string {
  if (input.replacementRisk === "specialized_boundary_to_helper") {
    return "Deleted tests contain boundary/adaptor coverage indicators while added tests or helpers look more helper-level; verify the replacement still exercises the same production boundary.";
  }
  return [
    `Deleted test symbols: ${String(input.deletedTestCount)}`,
    `added test symbols: ${String(input.addedTestCount)}`,
    `deleted helper symbols: ${String(input.deletedHelperCount)}`,
    `added helper symbols: ${String(input.addedHelperCount)}`,
    `boundary indicators: ${String(input.boundaryCount)}`
  ].join("; ");
}

function isHelperLikeSymbol(symbol: TestCoverageDeltaSymbol): boolean {
  return symbol.kind === "helper" || symbol.kind === "mock" || symbol.kind === "fixture" || symbol.kind === "boundary";
}

function isHelperLikeName(name: string): boolean {
  const normalized = splitName(name);
  return /\b(?:assert|build|check|create|expect|fixture|helper|make|mock|prepare|setup|stub|verify)\b/u.test(normalized);
}

function hasBoundaryTerm(value: string): boolean {
  return BOUNDARY_TERMS.some((term) => wordIncludes(value, term));
}

function wordIncludes(value: string, term: string): boolean {
  return splitName(value).split(/\s+/u).includes(term);
}

function splitName(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/[^a-z0-9]+/giu, " ")
    .toLowerCase()
    .trim();
}

function stripStringLiterals(value: string): string {
  return value.replace(/(["'`])(?:\\.|(?!\1).)*\1/gu, "");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))].sort();
}
