import type { CandidateFinding } from "../types.js";
import { codeBlock, fenceLanguageForPath, inlineCode } from "../util/markdown.js";

export type CompositionSource = { id: string; findingId: string; kind: "impact" | "verification" | "fix" | "test" | "evidence"; text: string; path?: string; explanation?: string };
export type CompositionSection = { kind: "impact" | "verification" | "fix" | "test"; text: string; sourceRefs: string[] };

export function compositionSources(findings: CandidateFinding[]): CompositionSource[] {
  return findings.flatMap(finding => {
    const sources: CompositionSource[] = [];
    for (const [field, kind] of [["failureMode", "impact"], ["whyThisMatters", "impact"], ["verification", "verification"], ["suggestedFix", "fix"], ["suggestedTest", "test"]] as const) {
      const text = finding[field];
      if (text) sources.push({ id: `${finding.id}/${field}`, findingId: finding.id, kind, text });
    }
    sources.push({ id: `${finding.id}/evidence/changedCode`, findingId: finding.id, kind: "evidence", text: finding.evidence.changedCode, path: finding.path });
    (finding.evidence.relatedCode ?? []).forEach((evidence, index) => sources.push({ id: `${finding.id}/evidence/relatedCode/${index}`, findingId: finding.id, kind: "evidence", text: evidence.lines, path: evidence.path, explanation: evidence.whyRelevant }));
    return sources;
  });
}

// References account for contributions; they do not prove prose equivalence.
// Evidence is rendered from immutable verified inputs, never model-written code.
export function renderCompositionSections(findings: CandidateFinding[], sections: CompositionSection[], evidenceRefs: string[]): string {
  const sources = compositionSources(findings);
  const byId = new Map(sources.map(source => [source.id, source]));
  const seen = new Set<string>();
  for (const section of sections) {
    if (!section.text.trim() || !section.sourceRefs.length) throw new Error("Empty composition section");
    for (const ref of section.sourceRefs) {
      if (byId.get(ref)?.kind !== section.kind || seen.has(ref)) throw new Error(`Invalid or duplicate composition source: ${ref}`);
      seen.add(ref);
    }
  }
  for (const ref of evidenceRefs) {
    if (byId.get(ref)?.kind !== "evidence" || seen.has(ref)) throw new Error(`Invalid or duplicate evidence source: ${ref}`);
    seen.add(ref);
  }
  if (sources.some(source => !seen.has(source.id))) throw new Error("Composition omitted verified source components");
  const labels = { impact: "Impact", verification: "Verification and uncertainty", fix: "Suggested fix", test: "Suggested test" };
  const prose = sections.map(section => {
    // Uncertainty/proof remains verbatim even when impact/fix wording is composed.
    const text = section.kind === "verification"
      ? [...new Set(section.sourceRefs.map(ref => byId.get(ref)!.text))].join("\n") : section.text;
    return `**${labels[section.kind]}:** ${text}`;
  });
  const evidence = new Map<string, { source: CompositionSource; explanations: Set<string> }>();
  for (const ref of evidenceRefs) {
    const source = byId.get(ref)!;
    // Only normalize line endings/trailing whitespace, not operators or literals.
    const text = source.text.replace(/\r\n/g, "\n").split("\n").map(line => line.trimEnd()).join("\n");
    const key = JSON.stringify([source.path, text]);
    const entry = evidence.get(key) ?? { source, explanations: new Set<string>() };
    if (source.explanation) entry.explanations.add(source.explanation);
    evidence.set(key, entry);
  }
  const blocks = [...evidence.values()].map(({ source, explanations }) => {
    const location = inlineCode(source.path ?? "");
    const content = /^\d+(?:\s*[-–,:]\s*\d+)*$/u.test(source.text) ? `Lines ${source.text}` : codeBlock(source.text, fenceLanguageForPath(source.path ?? ""));
    return `${location}\n${content}${explanations.size ? `\n${[...explanations].join("\n")}` : ""}`;
  });
  return [...prose, `**Evidence:**\n\n${blocks.join("\n\n")}`].join("\n\n");
}
