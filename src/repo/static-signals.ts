import type { DiffFile, FileFacts, HunkSymbolFacts, StaticSignal, SymbolInfo } from "../types.js";
import type { TelemetryRecorder } from "../telemetry/telemetry-recorder.js";
import type { SourceResolver } from "./source-resolver.js";
import type { LanguageAdapterRegistry } from "./language-adapter.js";

const MAX_SIGNALS_PER_FILE = 20;
const MAX_SIGNALS_PER_RUN = 200;

export async function extractStaticSignals(
  resolver: SourceResolver,
  registry: LanguageAdapterRegistry,
  kept: DiffFile[],
  facts: FileFacts[],
  symbolFacts: HunkSymbolFacts[],
  telemetry: TelemetryRecorder
): Promise<StaticSignal[]> {
  const signals: StaticSignal[] = [];
  let runOmitted = 0;
  const factByPath = new Map(facts.map((fact) => [fact.path, fact]));
  const factsByHunk = groupFactsByHunk(symbolFacts);

  for (const file of kept) {
    const perFile: StaticSignal[] = [];
    const fact = factByPath.get(file.path);
    if (file.status === "deleted" && fact?.testStatus === "test") {
      perFile.push({
        ruleId: "core/deleted-test-file",
        path: file.path,
        ...(file.hunks[0]?.oldStart !== undefined ? { line: file.hunks[0].oldStart } : {}),
        side: "LEFT",
        category: "testing",
        lensHint: "core/tests",
        confidence: "high",
        explanation: "A test file was deleted."
      });
    }

    perFile.push(...(await exportedApiSignals(resolver, registry, file, factsByHunk)));
    const uniquePerFile = dedupeSignals(perFile);
    const perFileOmitted = Math.max(0, uniquePerFile.length - MAX_SIGNALS_PER_FILE);
    if (perFileOmitted > 0) {
      telemetry.event({
        stage: 4,
        level: "warn",
        message: "static_signal_cap_hit",
        file: file.path,
        data: {
          scope: "file",
          cap: MAX_SIGNALS_PER_FILE,
          omittedCount: perFileOmitted
        }
      });
    }
    const fileSignals = uniquePerFile.slice(0, MAX_SIGNALS_PER_FILE);
    const remainingRunSlots = Math.max(0, MAX_SIGNALS_PER_RUN - signals.length);
    signals.push(...fileSignals.slice(0, remainingRunSlots));
    runOmitted += Math.max(0, fileSignals.length - remainingRunSlots);
  }

  if (runOmitted > 0) {
    telemetry.event({
      stage: 4,
      level: "warn",
      message: "static_signal_cap_hit",
      data: {
        scope: "run",
        cap: MAX_SIGNALS_PER_RUN,
        omittedCount: runOmitted
      }
    });
  }
  return signals;
}

async function exportedApiSignals(
  resolver: SourceResolver,
  registry: LanguageAdapterRegistry,
  file: DiffFile,
  factsByHunk: Map<string, HunkSymbolFacts[]>
): Promise<StaticSignal[]> {
  const output: StaticSignal[] = [];
  for (const hunk of file.hunks) {
    if (hasAddedLines(file, hunk)) {
      output.push(...(await exportedSignatureSignalsForHunk(resolver, registry, file, hunk)));
    }
    if (hasDeletedLines(file, hunk)) {
      output.push(...(await deletedExportSignalsForChangedHunk(resolver, registry, file, hunk)));
    }
    for (const hunkFacts of factsByHunk.get(hunk.id) ?? []) {
      output.push(...(await exportedApiSignalsForFact(resolver, registry, file, hunk, hunkFacts)));
    }
  }
  return output;
}

async function exportedSignatureSignalsForHunk(
  resolver: SourceResolver,
  registry: LanguageAdapterRegistry,
  file: DiffFile,
  hunk: DiffFile["hunks"][number]
): Promise<StaticSignal[]> {
  const headContent = await resolver.readFile(file.path, { kind: "head" });
  const baseContent = await resolver.readFile(file.oldPath ?? file.path, { kind: "base" });
  if (!headContent || !baseContent) {
    return [];
  }
  const adapter = registry.forPath(file.path);
  const headParsed = await adapter.parse({
    path: file.path,
    language: registry.languageForPath(file.path),
    content: headContent.content,
    source: { kind: "head" },
    contentSha: headContent.contentSha
  });
  if (headParsed.tree === undefined) {
    return [];
  }
  const baseParsed = await adapter.parse({
    path: file.path,
    language: registry.languageForPath(file.path),
    content: baseContent.content,
    source: { kind: "base" },
    contentSha: baseContent.contentSha
  });
  const baseSymbols = adapter.listSymbols(baseParsed);
  return adapter
    .getChangedSymbols(headParsed, hunk)
    .filter((symbol) => symbol.exported)
    .flatMap((symbol) => {
      const baseSymbol = findMatchingSymbol(baseSymbols, symbol);
      if (!baseSymbol || normalizeSignature(baseSymbol.signature) === normalizeSignature(symbol.signature)) {
        return [];
      }
      return [signal(file.path, symbol.changedLines[0] ?? hunk.newStart, "RIGHT", symbol, "An exported symbol signature changed.")];
    });
}

async function deletedExportSignalsForChangedHunk(
  resolver: SourceResolver,
  registry: LanguageAdapterRegistry,
  file: DiffFile,
  hunk: DiffFile["hunks"][number]
): Promise<StaticSignal[]> {
  if (typeof resolver.readFile !== "function") {
    return [];
  }
  const baseContent = await resolver.readFile(file.oldPath ?? file.path, { kind: "base" });
  if (!baseContent) {
    return [];
  }
  const adapter = registry.forPath(file.path);
  const baseParsed = await adapter.parse({
    path: file.path,
    language: registry.languageForPath(file.path),
    content: baseContent.content,
    source: { kind: "base" },
    contentSha: baseContent.contentSha
  });
  if (baseParsed.tree === undefined) {
    return [];
  }
  const oldSymbols = adapter.getChangedSymbols(baseParsed, hunk).filter((symbol) => symbol.exported);
  if (oldSymbols.length === 0) {
    return [];
  }
  const headContent = await resolver.readFile(file.path, { kind: "head" });
  if (!headContent) {
    return oldSymbols.map((symbol) =>
      signal(file.path, symbol.changedLines[0] ?? hunk.oldStart, "LEFT", symbol, "An exported symbol was deleted.")
    );
  }
  const headParsed = await adapter.parse({
    path: file.path,
    language: registry.languageForPath(file.path),
    content: headContent.content,
    source: { kind: "head" },
    contentSha: headContent.contentSha
  });
  const headSymbols = adapter.listSymbols(headParsed);
  return oldSymbols
    .filter((symbol) => !findMatchingSymbol(headSymbols, symbol))
    .map((symbol) => signal(file.path, symbol.changedLines[0] ?? hunk.oldStart, "LEFT", symbol, "An exported symbol was deleted."));
}

function hasAddedLines(file: DiffFile, hunk: DiffFile["hunks"][number]): boolean {
  return file.status !== "added" && hunk.lines.some((line) => line.kind === "add");
}

function hasDeletedLines(file: DiffFile, hunk: DiffFile["hunks"][number]): boolean {
  return file.status !== "added" && hunk.lines.some((line) => line.kind === "delete");
}

async function exportedApiSignalsForFact(
  resolver: SourceResolver,
  registry: LanguageAdapterRegistry,
  file: DiffFile,
  hunk: DiffFile["hunks"][number],
  hunkFacts: HunkSymbolFacts
): Promise<StaticSignal[]> {
  const output: StaticSignal[] = [];
  if (!hunkFacts.enclosingSymbol) {
    return output;
  }
  if (hunkFacts.source === "fallback") {
    return exportedApiSignalsForFallbackFact(resolver, file, hunk, hunkFacts);
  }
  const source = hunkFacts.changedLinesSide === "old" ? { kind: "base" as const } : { kind: "head" as const };
  const readPath = source.kind === "base" ? file.oldPath ?? file.path : file.path;
  const content = await resolver.readFile(readPath, source);
  if (!content) {
    return output;
  }
  const adapter = registry.forPath(file.path);
  const parsed = await adapter.parse({
    path: file.path,
    language: registry.languageForPath(file.path),
    content: content.content,
    source,
    contentSha: content.contentSha
  });
  const line = hunkFacts.changedLines[0] ?? (source.kind === "base" ? hunk.oldStart : hunk.newStart);
  const symbol = adapter.getEnclosingSymbol(parsed, line);
  if (!symbol?.exported) {
    return output;
  }
  if (source.kind === "base") {
    const headContent = await resolver.readFile(file.path, { kind: "head" });
    if (!headContent) {
      output.push(signal(file.path, line, "LEFT", symbol, "An exported symbol was deleted."));
      return output;
    }
    const headParsed = await adapter.parse({
      path: file.path,
      language: registry.languageForPath(file.path),
      content: headContent.content,
      source: { kind: "head" },
      contentSha: headContent.contentSha
    });
    const headSymbol = findMatchingSymbol(adapter.listSymbols(headParsed), symbol);
    if (!headSymbol) {
      output.push(signal(file.path, line, "LEFT", symbol, "An exported symbol was deleted."));
    } else if (normalizeSignature(headSymbol.signature) !== normalizeSignature(symbol.signature)) {
      output.push(signal(file.path, line, "LEFT", symbol, "An exported symbol signature changed."));
    }
    return output;
  }
  const baseContent = await resolver.readFile(file.oldPath ?? file.path, { kind: "base" });
  if (!baseContent) {
    return output;
  }
  const baseParsed = await adapter.parse({
    path: file.path,
    language: registry.languageForPath(file.path),
    content: baseContent.content,
    source: { kind: "base" },
    contentSha: baseContent.contentSha
  });
  const baseSymbol = findMatchingSymbol(adapter.listSymbols(baseParsed), symbol);
  if (baseSymbol && normalizeSignature(baseSymbol.signature) !== normalizeSignature(symbol.signature)) {
    output.push(signal(file.path, line, "RIGHT", symbol, "An exported symbol signature changed."));
  }
  return output;
}

async function exportedApiSignalsForFallbackFact(
  resolver: SourceResolver,
  file: DiffFile,
  hunk: DiffFile["hunks"][number],
  hunkFacts: HunkSymbolFacts
): Promise<StaticSignal[]> {
  if (!hunkFacts.signature || !isFallbackExported(file.language, hunkFacts)) {
    return [];
  }
  const line = hunkFacts.changedLines[0] ?? (hunkFacts.changedLinesSide === "old" ? hunk.oldStart : hunk.newStart);
  const side = hunkFacts.changedLinesSide === "old" ? "LEFT" : "RIGHT";
  const symbol = fallbackSymbol(file.path, line, hunkFacts);
  const oppositeSignature =
    hunkFacts.changedLinesSide === "old"
      ? await findFallbackSignatureInContent(resolver, file, hunkFacts, { kind: "head" })
      : fallbackSignatureInHunk(hunk, file.language, "old", hunkFacts) ??
        (await findFallbackSignatureInContent(resolver, file, hunkFacts, { kind: "base" }));

  if (oppositeSignature === undefined) {
    return [signal(file.path, line, side, symbol, "An exported symbol was deleted.")];
  }
  if (normalizeSignature(oppositeSignature) !== normalizeSignature(hunkFacts.signature)) {
    return [signal(file.path, line, side, symbol, "An exported symbol signature changed.")];
  }
  return [];
}

async function findFallbackSignatureInContent(
  resolver: SourceResolver,
  file: DiffFile,
  hunkFacts: HunkSymbolFacts,
  source: { kind: "base" | "head" }
): Promise<string | undefined> {
  const content = await resolver.readFile(source.kind === "base" ? file.oldPath ?? file.path : file.path, source);
  if (!content) {
    return undefined;
  }
  for (const line of content.content.split(/\n/u)) {
    const declaration = fallbackDeclaration(line.trim(), file.language);
    if (declaration && fallbackNamesMatch(declaration.name, hunkFacts.enclosingSymbol ?? "")) {
      return declaration.signature;
    }
  }
  return undefined;
}

function fallbackSignatureInHunk(
  hunk: DiffFile["hunks"][number],
  language: string,
  side: "old" | "new",
  hunkFacts: HunkSymbolFacts
): string | undefined {
  const wantedKind = side === "old" ? "delete" : "add";
  for (const line of hunk.lines) {
    if (line.kind !== wantedKind) {
      continue;
    }
    const declaration = fallbackDeclaration(line.content.trim(), language);
    if (declaration && fallbackNamesMatch(declaration.name, hunkFacts.enclosingSymbol ?? "")) {
      return declaration.signature;
    }
  }
  return undefined;
}

function fallbackSymbol(path: string, line: number, hunkFacts: HunkSymbolFacts): SymbolInfo {
  return {
    path,
    name: hunkFacts.enclosingSymbol ?? "",
    kind: hunkFacts.symbolKind ?? "other",
    ...(hunkFacts.symbolNativeKind !== undefined ? { nativeKind: hunkFacts.symbolNativeKind } : {}),
    lineRange: [line, line],
    exported: true,
    signature: hunkFacts.signature ?? ""
  };
}

function isFallbackExported(language: string, hunkFacts: HunkSymbolFacts): boolean {
  const signature = hunkFacts.signature ?? "";
  if (language === "go") {
    const match = /[A-Za-z_]\w*$/u.exec(hunkFacts.enclosingSymbol ?? "");
    return /^[A-Z]/u.test(match?.[0] ?? "");
  }
  if (language === "typescript" || language === "tsx" || language === "javascript") {
    return /^\s*export\b/u.test(signature) || hunkFacts.enclosingSymbol === "default";
  }
  return false;
}

function fallbackDeclaration(
  text: string,
  language: string
): { name: string; signature: string } | undefined {
  if (language === "go") {
    const method = /^func\s+\(\s*\w+\s+(\*?)([A-Za-z_]\w*)[^)]*\)\s*([A-Za-z_]\w*)/u.exec(text);
    if (method) {
      const owner = method[2] ?? "";
      const name = method[3] ?? "";
      return { name: method[1] === "*" ? `(*${owner}).${name}` : `${owner}.${name}`, signature: text };
    }
    const fn = /^func\s+([A-Za-z_]\w*)/u.exec(text);
    if (fn?.[1]) {
      return { name: fn[1], signature: text };
    }
  }

  if (language === "typescript" || language === "tsx" || language === "javascript") {
    const fn = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_]\w*)/u.exec(text);
    if (fn?.[1]) {
      return { name: fn[1], signature: text };
    }
    const klass = /^(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_]\w*)/u.exec(text);
    if (klass?.[1]) {
      return { name: klass[1], signature: text };
    }
    const arrow = /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_]\w*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_]\w*)\s*=>/u.exec(text);
    if (arrow?.[1]) {
      return { name: arrow[1], signature: text };
    }
  }

  return undefined;
}

function fallbackNamesMatch(left: string, right: string): boolean {
  return left === right || left.replace(/^\(\*/u, "").replace(/^\*/u, "").replace(/\)/gu, "") === right;
}

function groupFactsByHunk(symbolFacts: HunkSymbolFacts[]): Map<string, HunkSymbolFacts[]> {
  const grouped = new Map<string, HunkSymbolFacts[]>();
  for (const fact of symbolFacts) {
    const bucket = grouped.get(fact.hunkId);
    if (bucket) {
      bucket.push(fact);
    } else {
      grouped.set(fact.hunkId, [fact]);
    }
  }
  return grouped;
}

function signal(path: string, line: number, side: "RIGHT" | "LEFT", symbol: SymbolInfo, explanation: string): StaticSignal {
  return {
    ruleId: "core/exported-api-change",
    path,
    line,
    side,
    category: "architecture",
    lensHint: "core/code-review",
    confidence: "medium",
    explanation,
    ...(symbol.signature !== undefined ? { snippet: symbol.signature } : {})
  };
}

function findMatchingSymbol(symbols: SymbolInfo[], target: SymbolInfo): SymbolInfo | undefined {
  return symbols.find((symbol) => symbol.name === target.name && symbol.ownerType === target.ownerType && symbol.kind === target.kind);
}

function normalizeSignature(signature: string | undefined): string {
  return (signature ?? "").replace(/\s+/gu, " ").trim();
}

function dedupeSignals(signals: StaticSignal[]): StaticSignal[] {
  const seen = new Set<string>();
  const output: StaticSignal[] = [];
  for (const signal of signals) {
    const key = `${signal.ruleId}:${signal.path}:${signal.line ?? 0}:${signal.side ?? ""}`;
    if (!seen.has(key)) {
      seen.add(key);
      output.push(signal);
    }
  }
  return output;
}
