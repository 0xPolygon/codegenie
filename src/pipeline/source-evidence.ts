import { prettyStableJson } from "../util/json.js";
import type { CandidateFinding, PacketReviewResult, RepositoryEvidence } from "../types.js";

type Scope = { question: string; files: string[]; symbols: string[] };
type Source = Pick<RepositoryEvidence, "path" | "symbols" | "text" | "lineRange">;

// Infer code-shaped names from the actual question, not a domain vocabulary.
// Plain prose words alone must not admit unrelated files.
function mentionedSymbols(text: string): string[] {
  return [...new Set((text.match(/[\p{L}_$][\p{L}\p{N}_$]*(?:\.[\p{L}_$][\p{L}\p{N}_$]*)*/gu) ?? [])
    .filter(token => /[a-z][A-Z]|[\p{L}]_[\p{L}]|\./u.test(token)))];
}

/** Avoid redelivering contained source; never conflate revisions or files. */
export function sourceEvidenceCovered(source: Pick<RepositoryEvidence, "path" | "source" | "text">,
  selected: Array<Pick<RepositoryEvidence, "path" | "source" | "text">>): boolean {
  // Raw substring matches can confuse `allow()` with `disallow()` or a
  // commented-out statement. Only identical whole source lines are covered.
  const body = (text: string) => text.replace(/\n+\[tool meta:[^\n]*\]\s*$/u, "").replace(/\n$/u, "");
  const lines = body(source.text);
  return !!source.path && lines.length > 0 && selected.some(other => other.path === source.path && other.source === source.source
    && (`\n${body(other.text)}\n`).includes(`\n${lines}\n`));
}
const words = (text: string) => new Set((text + " " + text.replace(/([a-z])([A-Z])/g, "$1 $2"))
  .toLowerCase().match(/[\p{L}\p{N}_]{4,}/gu) ?? []);

/** Rank source context, not truth: neither proximity nor word overlap proves a claim. */
export function sourceEvidenceRelevance(source: Source, scope: Scope): number {
  const pathMatch = !!source.path && (scope.files.includes(source.path) || scope.question.includes(source.path));
  // Qualified names can be separated by receiver/type syntax in the source
  // (for example Type.method versus method declared on Type). Match identifier
  // components, not a language-specific spelling or loose substrings.
  const identifiers = new Set(source.text.match(/[\p{L}_$][\p{L}\p{N}_$]*/gu) ?? []);
  const symbols = [...new Set([...scope.symbols, ...mentionedSymbols(scope.question)])];
  const matchedSymbols = symbols.filter(symbol => {
    const parts = symbol.match(/[\p{L}_$][\p{L}\p{N}_$]*/gu) ?? [];
    return source.symbols?.includes(symbol) || (parts.length > 0 && parts.every(part => identifiers.has(part)));
  });
  const symbolMatch = matchedSymbols.length > 0;
  if (!pathMatch && !symbolMatch) return 0;
  const query = words(scope.question + " " + scope.symbols.join(" "));
  const content = words(source.text);
  const overlap = [...query].filter(word => content.has(word)).length / Math.max(1, query.size);
  // A cited line near the end of a read may expose only a declaration. Prefer
  // already-read surrounding context on both sides, without inferring semantics.
  const pathOffset = source.path ? scope.question.indexOf(source.path + ":") : -1;
  const citedLine = pathOffset >= 0 ? Number(scope.question.slice(pathOffset + source.path!.length).match(/^:(\d+)/u)?.[1]) : NaN;
  const range = source.lineRange;
  const context = range && citedLine >= range[0] && citedLine <= range[1]
    ? Math.min(8, citedLine - range[0], range[1] - citedLine) / 2 : 0;
  return context + (pathMatch ? 2 : 0) + (source.path && scope.question.includes(source.path) ? 2 : 0) + (symbolMatch ? 2 + Math.min(2, matchedSymbols.length - 1) : 0) + overlap * 4;
}

export const MAX_VERIFIER_SOURCE_EVIDENCE_CHARS = 6_000;

export function selectVerifierSourceEvidence(candidate: CandidateFinding, packets: PacketReviewResult[]) {
  const scope = { question: [candidate.title, candidate.failureMode, candidate.provenance?.question ?? ""].join(" "),
    files: [candidate.path, ...(candidate.evidence.relatedCode ?? []).map(item => item.path), ...(candidate.provenance?.files ?? [])],
    symbols: candidate.provenance?.symbols ?? [] };
  const seen = new Set<string>();
  const ranked = packets.flatMap(packet =>
    (packet.repositoryEvidence ?? []).flatMap(read => {
      const key = JSON.stringify([read.source, read.path, read.text]);
      if (!read.text.trim() || seen.has(key) || read.text.includes("[tool result truncated by codegenie tool budget]")) return [];
      seen.add(key);
      const priority = sourceEvidenceRelevance(read, scope);
      return priority > 0 ? [{ read: { ...read, packetId: packet.packetId }, priority }] : [];
    })).sort((a, b) => b.priority - a.priority || a.read.text.length - b.read.text.length);
  const selected: Array<RepositoryEvidence & { packetId: string }> = [];
  const admit = (read: RepositoryEvidence & { packetId: string }) => {
    if (sourceEvidenceCovered(read, selected)) return;
    const next = [...selected.filter(other => !sourceEvidenceCovered(other, [read])), read];
    if (prettyStableJson(next).length <= MAX_VERIFIER_SOURCE_EVIDENCE_CHARS) selected.splice(0, selected.length, ...next);
  };
  // Cover relevant files/revisions before spending the cap on overlapping reads
  // of one file. Keep whole delivered excerpts and their original provenance.
  for (const { read } of ranked) {
    if (!selected.some(other => other.path === read.path && other.source === read.source)) admit(read);
  }
  for (const { read } of ranked) admit(read);
  return selected;
}
