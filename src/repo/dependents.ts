import type { CandidateDependent, DiffFile, DiffHunk, ParsedFile, RepositoryTools, SearchResult, SymbolInfo } from "../types.js";
import { credentialSafeCut } from "../telemetry/redaction.js";
import { isRepositoryTestPath, isProsePath } from "../util/path-roles.js";
import { stableJson } from "../util/json.js";
import { isLineInside, lineRange, treeFromParsed, type LanguageAdapterRegistry } from "./language-adapter.js";
import { valueContracts, type ContractMember, type ValueContract } from "./dependent-values.js";
import type { SourceResolver } from "./source-resolver.js";

const MAX_CONTRACTS = 20;
const MAX_QUERIES = 40;
const MAX_FILES = 200;
const MAX_MS = 5_000;
const MAX_MATCHES = 100;
const MAX_LEADS_PER_PACKET = 6;
const MAX_PACKET_CHARS = 3_000;
const MAX_DECLARATION_LINES = 12;
const MAX_LINE_CHARS = 200;

type Relation = CandidateDependent["relation"];
type Range = [number, number];
type Side = "base" | "head";
type ContractSide = { name: string; kind?: SymbolInfo["kind"]; members?: ContractMember[] };
type Contract = { path: string; hunks: Set<string>; before?: ContractSide; after?: ContractSide };
type FileView = { file: ParsedFile; symbols: SymbolInfo[]; lines: string[] };
type Lead = Omit<CandidateDependent, "hunkId">;
type Hit = { path: string; line: number; range?: Range; enclosing?: string };
type Counts = Partial<Record<Relation, number>>;
type Caps = "contracts" | "queries" | "files" | "time" | "aborted";
type Failure = "read_failed" | "parse_failed" | "grep_failed" | "usage_failed";

class TraceLimit extends Error {}
class TraceFailure extends Error {
  constructor(readonly reason: Failure) { super(reason); }
}

export type DependentTrace = {
  byHunk: Map<string, Lead[]>;
  telemetry: {
    contracts: Counts;
    queries: number;
    filesParsed: number;
    elapsedMs: number;
    scanLimitedQueries: number;
    failures: number;
    failureReasons: Partial<Record<Failure, number>>;
    caps: Caps[];
    contractsOmitted: number;
  };
};

type TraceInput = {
  resolver: SourceResolver;
  registry: LanguageAdapterRegistry;
  tools: Pick<RepositoryTools, "findUsages">;
  files: DiffFile[];
  symbolFacts?: readonly Pick<import("../types.js").HunkSymbolFacts, "path" | "symbolKind">[];
  changedFiles: DiffFile[];
  skipsPath: (path: string) => boolean;
  signal?: AbortSignal;
};

export async function traceDependents(input: TraceInput): Promise<DependentTrace> {
  const started = performance.now();
  const deadlineSignal = AbortSignal.timeout(MAX_MS);
  const signal = input.signal ? AbortSignal.any([input.signal, deadlineSignal]) : deadlineSignal;
  const caps = new Set<Caps>();
  const byHunk = new Map<string, Lead[]>();
  const telemetry: DependentTrace["telemetry"] = {
    contracts: {}, queries: 0, filesParsed: 0, elapsedMs: 0, scanLimitedQueries: 0, failures: 0, failureReasons: {}, caps: [], contractsOmitted: 0
  };
  let filesScanned = 0;
  const changed = new Map(input.changedFiles.map(file => [file.path, file.hunks]));
  const acceptsPath = (path: string) => !isRepositoryTestPath(path) && !isProsePath(path) && !input.skipsPath(path);
  const memo = new Map<string, FileView | undefined>();
  const saturate = (kind: Caps) => { caps.add(kind); throw new TraceLimit(kind); };
  const checkTime = () => {
    if (input.signal?.aborted) saturate("aborted");
    if (signal.aborted || performance.now() - started >= MAX_MS) saturate("time");
  };
  const checkFiles = () => {
    if (filesScanned >= MAX_FILES) saturate("files");
  };
  const query = () => {
    checkTime();
    if (telemetry.queries >= MAX_QUERIES) saturate("queries");
    telemetry.queries++;
  };
  const withinTime = async <T>(pending: Promise<T>): Promise<T> => {
    let onAbort: (() => void) | undefined;
    try {
      const value = await Promise.race([pending, new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason);
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      })]);
      checkTime();
      return value;
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  };
  const recordFailure = (error: unknown) => {
    if (input.signal?.aborted) caps.add("aborted");
    else if (signal.aborted || performance.now() - started >= MAX_MS) caps.add("time");
    else if (error instanceof TraceFailure) {
      telemetry.failures++;
      telemetry.failureReasons[error.reason] = (telemetry.failureReasons[error.reason] ?? 0) + 1;
    } else if (!(error instanceof TraceLimit)) throw error;
  };
  const view = async (path: string, side: Side): Promise<FileView | undefined> => {
    const key = `${side}:${path}`;
    if (memo.has(key)) return memo.get(key);
    checkTime();
    checkFiles();
    filesScanned++;
    const content = await withinTime(input.resolver.readFile(path, { kind: side }).catch(() => { throw new TraceFailure("read_failed"); }));
    if (!content) { memo.set(key, undefined); return undefined; }
    const adapter = input.registry.forPath(path);
    const file = await withinTime(adapter.parse({ ...content, language: adapter.id }).catch(() => { throw new TraceFailure("parse_failed"); }));
    if (file.tree) telemetry.filesParsed++;
    if (file.hasErrors && !file.tree) throw new TraceFailure("parse_failed");
    const symbols = adapter.listSymbols(file);
    const result = { file, symbols, lines: file.content.split("\n") };
    memo.set(key, result);
    return result;
  };
  const grep = async (pattern: string): Promise<SearchResult[]> => {
    query();
    const results = await withinTime(input.resolver.grep(pattern, {
      maxResults: MAX_MATCHES, timeoutMs: Math.max(1, Math.floor(MAX_MS - (performance.now() - started)))
    }).catch(() => { throw new TraceFailure("grep_failed"); }));
    if (results.length >= MAX_MATCHES || results.omittedLines) telemetry.scanLimitedQueries++;
    return results.filter(hit => acceptsPath(hit.path) && !overlaps([hit.line, hit.line], changed.get(hit.path) ?? []));
  };

  const contracts: Contract[] = [];
  const valuePaths = new Set(input.symbolFacts?.filter(fact => fact.symbolKind === "type" || fact.symbolKind === "value").map(fact => fact.path));
  const seeds = input.files.filter(file => acceptsPath(file.path) && !input.skipsPath(file.oldPath ?? file.path))
    .sort((a, b) => Number(valuePaths.has(b.path)) - Number(valuePaths.has(a.path)));
  for (const [index, file] of seeds.entries()) {
    if (caps.size) break;
    try {
      const base = file.status === "added" ? undefined : await view(file.oldPath ?? file.path, "base");
      const head = file.status === "deleted" ? undefined : await view(file.path, "head");
      checkTime();
      for (const contract of fileContracts(file, base, head, input.registry)) {
        if (contracts.length < MAX_CONTRACTS) contracts.push(contract);
        else telemetry.contractsOmitted++;
      }
    } catch (error) {
      recordFailure(error);
    }
    if (telemetry.contractsOmitted > 0 || (contracts.length === MAX_CONTRACTS && index + 1 < seeds.length)) {
      caps.add("contracts");
      break;
    }
  }

  const attach = async (hits: Hit[], relation: Relation, contract: Contract, name: string): Promise<Lead[]> => {
    const leads: Lead[] = [];
    for (const hit of hits) {
      if (!acceptsPath(hit.path) || overlaps([hit.line, hit.line], changed.get(hit.path) ?? [])) continue;
      const head = hit.range ? undefined : await view(hit.path, "head");
      const declaration = head && enclosingSymbol(head, hit.line);
      const enclosing = hit.enclosing ?? declaration?.name;
      const at = hit.range ?? declaration?.lineRange;
      const range: Range = at && span(at) < MAX_DECLARATION_LINES && !overlaps(at, changed.get(hit.path) ?? [])
        ? at : [hit.line, hit.line];
      if (head) assertParsedRange(head.file, range);
      const lines = head?.lines ?? (await withinTime(input.resolver.readFile(hit.path, { kind: "head" })
        .catch(() => { throw new TraceFailure("read_failed"); })))?.content.split("\n");
      if (!lines || range[1] > lines.length) continue;
      const text = lines.slice(range[0] - 1, range[1])
        .map(line => line.slice(0, credentialSafeCut(line, MAX_LINE_CHARS))).join("\n");
      if (!text.trim()) continue;
      leads.push({ path: hit.path, lineRange: range, text, ...(enclosing ? { enclosing } : {}), relation,
        match: relation === "caller" || relation === "stale_reference" ? "syntactic_use" : "lexical",
        contract: name, contractPath: contract.path });
    }
    return leads;
  };

  for (const [index, contract] of contracts.entries()) {
    if ([...caps].some(cap => cap !== "contracts")) {
      telemetry.contractsOmitted += contracts.length - index;
      break;
    }
    const leads: Lead[] = [];
    const count = (relation: Relation) => { telemetry.contracts[relation] = (telemetry.contracts[relation] ?? 0) + 1; };
    const name = contract.after?.name ?? contract.before!.name;
    try {
      const before = contract.before?.members;
      const after = contract.after?.members;
      if (before && after && before.length >= 2 && differentMembers(before, after)) {
        count("value_set");
        const hits = await findValueSetHits(before, after, grep, view);
        leads.push(...await attach(hits, "value_set", contract, name));
      }
      const relation = !contract.after ? "stale_reference"
        : contract.after.kind === "function" || contract.after.kind === "method" ? "caller" : undefined;
      if (relation && input.tools.findUsages) {
        count(relation);
        query();
        checkFiles();
        const { page } = await withinTime(input.tools.findUsages(name, {
          source: { kind: "head" }, signal, maxFilesScanned: MAX_FILES - filesScanned, acceptsPath
        }).catch(() => { throw new TraceFailure("usage_failed"); }));
        filesScanned += page.filesScanned;
        telemetry.filesParsed += page.filesParsed;
        if (!page.scanComplete) telemetry.scanLimitedQueries++;
        if (page.stopReason === "file_scan_limit") caps.add("files");
        if (page.omissions.length > 0) throw new TraceFailure("parse_failed");
        const seen = new Set<string>();
        const hits = page.rows.flatMap((row): Hit[] => {
          if (overlaps([row.line, row.line], changed.get(row.path) ?? [])) return [];
          if (relation === "caller" && !["call", "member_call", "construct"].includes(row.role)) return [];
          const { name: enclosing, lineRange: range } = row.enclosing;
          const key = `${row.path}:${range[0]}:${range[1]}`;
          if (seen.has(key)) return [];
          seen.add(key);
          return [{ path: row.path, line: row.line, range, ...(enclosing ? { enclosing } : {}) }];
        });
        leads.push(...await attach(hits, relation, contract, name));
      }
      for (const hunk of contract.hunks) byHunk.set(hunk, [...(byHunk.get(hunk) ?? []), ...leads]);
    } catch (error) {
      recordFailure(error);
      telemetry.contractsOmitted++;
    }
  }

  return { byHunk, telemetry: { ...telemetry, caps: [...caps], elapsedMs: Math.round(performance.now() - started) } };
}

function fileContracts(file: DiffFile, base: FileView | undefined, head: FileView | undefined, registry: LanguageAdapterRegistry): Contract[] {
  const byName = new Map<string, Contract>();
  const adapter = registry.forPath(file.path);
  const add = (key: string, id: string, before?: ContractSide, after?: ContractSide) => {
    const entry = byName.get(key) ?? { path: file.path, hunks: new Set(), ...(before ? { before } : {}), ...(after ? { after } : {}) };
    entry.hunks.add(id);
    byName.set(key, entry);
  };
  const identity = (symbol: SymbolInfo) => `${symbol.ownerType ?? ""}:${symbol.name}`;
  const baseValues = base && valueContracts(base.file, base.symbols);
  const headValues = head && valueContracts(head.file, head.symbols);
  const contractSide = (symbol: SymbolInfo | undefined, sets: Map<string, ValueContract> | undefined): ContractSide | undefined => {
    if (!symbol) return undefined;
    const values = sets?.get(`${symbol.name}:${symbol.lineRange[0]}`);
    return { name: symbol.name, kind: symbol.kind, ...(values ? { members: values.members } : {}) };
  };
  const oldByName = new Map(base?.symbols.map(symbol => [identity(symbol), symbol]));
  const newByName = new Map(head?.symbols.map(symbol => [identity(symbol), symbol]));
  for (const hunk of file.hunks) {
    const touched = [
      ...(base ? adapter.getChangedSymbols(base.file, hunk) : []),
      ...(head ? adapter.getChangedSymbols(head.file, hunk) : [])
    ];
    for (const symbol of touched) {
      const key = identity(symbol);
      const before = oldByName.get(key);
      const after = newByName.get(key);
      if (base && before) assertParsedRange(base.file, before.lineRange);
      if (head && after) assertParsedRange(head.file, after.lineRange);
      add(key, hunk.id, contractSide(before, baseValues), contractSide(after, headValues));
    }

    // The Go adapter projects each constant as a symbol. A named const
    // block's value set belongs to the shared type rather than one member.
    if (file.language !== "go") continue;
    const oldSets = baseValues ? [...baseValues.values()] : [];
    const newSets = headValues ? [...headValues.values()] : [];
    for (const [key, sets, side] of [["old", oldSets, "delete"], ["new", newSets, "add"]] as const) {
      for (const values of sets) {
        if (!hunk.lines.some(line => {
          const at = key === "old" ? line.oldLineNumber : line.newLineNumber;
          return line.kind === side && at !== undefined && at >= values.range[0] && at <= values.range[1];
        })) continue;
        const corresponding = (key === "old" ? newSets : oldSets).filter(set => set.name === values.name);
        if (corresponding.length !== 1 || sets.filter(set => set.name === values.name).length !== 1) continue;
        const before = key === "old" ? values : corresponding[0]!;
        const after = key === "new" ? values : corresponding[0]!;
        if (base) assertParsedRange(base.file, before.range);
        if (head) assertParsedRange(head.file, after.range);
        add(`const-set:${values.name}`, hunk.id, before, after);
      }
    }
  }
  return [...byName.values()];
}

function enclosingSymbol(view: FileView, line: number): SymbolInfo | undefined {
  return view.symbols.filter(symbol => isLineInside(symbol, line)).sort((a, b) => span(a.lineRange) - span(b.lineRange))[0];
}

function assertParsedRange(file: ParsedFile, [from, to]: Range): void {
  if (!file.hasErrors) return;
  const root = treeFromParsed(file)?.rootNode;
  if (!root) throw new TraceFailure("parse_failed");
  // A recovering parser can produce a sound declaration in a file whose
  // error is outside that declaration. Fail only when the range touches it.
  const pending = [root];
  while (pending.length) {
    const node = pending.pop()!;
    const [start, end] = lineRange(node);
    if (end < from || start > to || !(node.hasError || node.isMissing)) continue;
    if (node.isError || node.isMissing) throw new TraceFailure("parse_failed");
    pending.push(...node.children);
  }
}

function overlaps([from, to]: Range, hunks: DiffHunk[]): boolean {
  return hunks.some(hunk => hunk.newLines > 0 && from < hunk.newStart + hunk.newLines && to >= hunk.newStart);
}

function span([from, to]: Range): number {
  return to - from;
}

function differentMembers(before: ContractMember[], after: ContractMember[]): boolean {
  const keys = (rows: ContractMember[]) => JSON.stringify([...new Set(rows.map(row => row.key))].sort());
  return keys(before) !== keys(after);
}

function escapeEre(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function memberPattern(member: ContractMember): string {
  if (member.qualified) return `(^|[^[:alnum:]_$])${escapeEre(member.qualified)}([^[:alnum:]_$]|$)`;
  if (member.key.startsWith("string:")) {
    return `["']${escapeEre(member.spelling.slice(1, -1))}["']`;
  }
  return `(^|[^[:alnum:]_$.])${escapeEre(member.spelling)}([^[:alnum:]_$.]|$)`;
}

async function findValueSetHits(
  before: ContractMember[], after: ContractMember[],
  grep: (pattern: string) => Promise<SearchResult[]>, view: (path: string, side: Side) => Promise<FileView | undefined>
): Promise<SearchResult[]> {
  if (before.every(member => member.number !== undefined) && after.every(member => member.number !== undefined)) {
    const old = [...new Set(before.map(member => member.number!))].sort((a, b) => a - b);
    const next = new Set(after.map(member => member.number!));
    const min = old[0]!, max = old.at(-1)!;
    if (old.length >= 2 && max - min + 1 === old.length && (old.length !== next.size || old.some(value => !next.has(value)))) {
      const lower = `(>=[[:space:]]*${min}|>[[:space:]]*${min - 1}|<[[:space:]]*${min}|<=[[:space:]]*${min - 1})([^[:alnum:]_.]|$)`;
      const upper = `(<=[[:space:]]*${max}|<[[:space:]]*${max + 1}|>[[:space:]]*${max}|>=[[:space:]]*${max + 1})([^[:alnum:]_.]|$)`;
      const leftLower = `(^|[^[:alnum:]_.])(${min}[[:space:]]*(<=|>)|${min - 1}[[:space:]]*(<|>=))`;
      const leftUpper = `(^|[^[:alnum:]_.])(${max}[[:space:]]*(>=|<)|${max + 1}[[:space:]]*(>|<=))`;
      const l = `(${lower}|${leftLower})`, u = `(${upper}|${leftUpper})`;
      return grep(`${l}.*${u}|${u}.*${l}`);
    }
  }

  const afterKeys = new Set(after.map(member => member.key));
  const beforeKeys = new Set(before.map(member => member.key));
  const hits: SearchResult[] = [];
  for (const member of before.filter(member => !afterKeys.has(member.key)).slice(0, 2)) {
    if (member.qualified || member.number === undefined) hits.push(...await grep(memberPattern(member)));
  }
  if (after.some(member => !beforeKeys.has(member.key))) {
    const candidates: SearchResult[][] = [];
    for (const member of before.slice(0, 3)) candidates.push(await grep(memberPattern(member)));
    for (const hit of candidates.filter(rows => rows.length > 0).sort((a, b) => a.length - b.length)[0] ?? []) {
      const head = await view(hit.path, "head");
      if (!head) continue;
      const outer = enclosingSymbol(head, hit.line);
      if (!outer) continue;
      assertParsedRange(head.file, outer.lineRange);
      const text = head.lines.slice(outer.lineRange[0] - 1, outer.lineRange[1]).join("\n");
      // POSIX ERE's identifier class is used by Git. The equivalent here
      // checks member spellings over the bounded candidate declaration.
      const inText = before.filter(member => new RegExp(memberPattern(member).replaceAll("[:alnum:]", "A-Za-z0-9"), "u").test(text));
      if (new Set(inText.map(member => member.spelling)).size >= 2) hits.push(hit);
    }
  }
  return hits;
}

const ranks: Record<Relation, number> = { value_set: 0, stale_reference: 1, caller: 2 };

export function selectPacketDependents(trace: DependentTrace, hunkIds: string[]) {
  const ranked = hunkIds.flatMap(hunkId => (trace.byHunk.get(hunkId) ?? []).map(lead => ({ ...lead, hunkId })))
    .sort((a, b) => ranks[a.relation] - ranks[b.relation]
      || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || a.lineRange[0] - b.lineRange[0]);
  const seen = new Set<string>();
  const counts: Record<"preCap" | "attached" | "omitted", Record<string, number>> = { preCap: {}, attached: {}, omitted: {} };
  const candidates: CandidateDependent[] = [];
  for (const lead of ranked) {
    const key = `${lead.hunkId}:${lead.contract}:${lead.path}:${lead.lineRange.join(":")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const kind = `${lead.relation}:${lead.match}`;
    counts.preCap[kind] = (counts.preCap[kind] ?? 0) + 1;
    const fits = candidates.length < MAX_LEADS_PER_PACKET && stableJson([...candidates, lead]).length <= MAX_PACKET_CHARS;
    const bucket = fits ? counts.attached : counts.omitted;
    bucket[kind] = (bucket[kind] ?? 0) + 1;
    if (fits) candidates.push(lead);
  }
  return { candidates, counts };
}
