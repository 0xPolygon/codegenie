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
export function renderCompositionSections(findings: CandidateFinding[], sections: CompositionSection[], evidenceRefs: string[], link?: (path: string, line?: number) => string | undefined): string {
  const sources = compositionSources(findings);
  const byId = new Map(sources.map(source => [source.id, source]));
  const seen = new Set<string>();
  const errors: string[] = [];
  for (const section of sections) {
    if (!section.text.trim() || !section.sourceRefs.length) errors.push("Empty composition section");
    for (const ref of section.sourceRefs) {
      if (byId.get(ref)?.kind !== section.kind || seen.has(ref)) {
        errors.push(`Invalid or duplicate composition source: ${ref} (expected ${section.kind}).`);
      } else seen.add(ref);
    }
  }
  for (const ref of evidenceRefs) {
    if (byId.get(ref)?.kind !== "evidence" || seen.has(ref)) errors.push(`Invalid or duplicate evidence source: ${ref}`);
    else seen.add(ref);
  }
  const missing = sources.filter(source => !seen.has(source.id));
  if (missing.length) errors.push(`Composition omitted verified source components (${missing.length}): ${missing.slice(0,25).map(source => source.id).join(", ")}`);
  if (errors.length) throw new Error(errors.slice(0,20).join("; ") + " Use only supplied source IDs in their matching kinds; absent optional fields have no source. Account for all supplied components without inventing source data.");
  const labels = { impact: "Impact", verification: "Verification and uncertainty", fix: "Suggested fix", test: "Suggested test" };
  const prose = sections.map(section => {
    // Uncertainty/proof remains verbatim even when impact/fix wording is composed.
    const originals = [...new Set(section.sourceRefs.map(ref => byId.get(ref)!.text))];
    const text = section.kind === "verification"
      ? originals[0]! + (originals.length > 1
        ? "\n\n<details>\n<summary>Additional verification evidence and caveats (retained verbatim)</summary>\n\n" + originals.slice(1).join("\n\n") + "\n\n</details>" : "")
      : section.text;
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
    const url = source.path ? link?.(source.path) : undefined;
    const location = (source.id.endsWith("/evidence/changedCode") ? "Changed code in " : "") + inlineCode(source.path ?? "") + (url ? ` ([source](${url}))` : "");
    const content = /^\d+(?:\s*[-–,:]\s*\d+)*$/u.test(source.text) ? `Lines ${source.text}` : codeBlock(source.text, fenceLanguageForPath(source.path ?? ""));
    const notes = [...explanations];
    return `${location}
${content}${notes.length ? `
${notes[0]}` : ""}${notes.length > 1 ? `

<details>
<summary>Additional source explanations</summary>

${notes.slice(1).join("\n\n")}

</details>` : ""}`;
  });
  return [...prose, `**Evidence:**

${blocks[0] ?? ""}${blocks.length > 1 ? `

<details>
<summary>Supporting evidence (${blocks.length - 1} additional locations or excerpts)</summary>

${blocks.slice(1).join("\n\n")}

</details>` : ""}`].join("\n\n");
}

// The same validation runs before model-response acceptance/cache writes and
// again during rendering. A valid JSON shape alone is not a valid composition.
export function validateCompositionSubmission(
  proposal: { composedFindings: Array<{ findingIds: string[]; sections?: CompositionSection[]; evidenceRefs?: string[] }> },
  findings: CandidateFinding[]
): void {
  const known = new Map(findings.map(finding => [finding.id, finding]));
  const used = new Set<string>();
  const errors: string[] = [];
  for (const group of proposal.composedFindings) {
    for (const id of group.findingIds) {
      if (!known.has(id) || used.has(id)) errors.push(`Unknown or repeated finding ID: ${id}. Use each supplied finding exactly once.`);
      used.add(id);
    }
    if (!group.sections || !group.evidenceRefs) {
      errors.push("Supply sections and evidenceRefs for every composed finding.");
      continue;
    }
    try {
      renderCompositionSections(group.findingIds.flatMap(id => known.has(id) ? [known.get(id)!] : []), group.sections, group.evidenceRefs);
    } catch (error) {
      errors.push(String(error));
    }
  }
  const missing = [...known.keys()].filter(id => !used.has(id));
  if (missing.length) errors.push(`Composition omitted findings: ${missing.join(", ")}`);
  if (errors.length) throw new Error(errors.slice(0, 20).join("\n"));

}

// A failed synthesis remains readable without hiding or heuristically deleting
// distinct source contributions. Complete verbatim inputs remain in artifacts.
export function renderRetainedComposition(findings: CandidateFinding[], link?: (path: string, line?: number) => string | undefined, normalizeProse: (text: string) => string = text => text): string {
  const sources = compositionSources(findings);
  const sections: CompositionSection[] = [];
  for (const kind of ["impact", "verification", "fix", "test"] as const) {
    const matching = sources.filter(source => source.kind === kind);
    if (!matching.length) continue;
    const contributions = new Map<string, string[]>();
    for (const source of matching) {
      const texts = contributions.get(source.findingId) ?? [];
      if (!texts.includes(source.text)) texts.push(source.text);
      contributions.set(source.findingId, texts);
    }
    const texts = [...new Set([...contributions.values()].map(texts => texts.join("\n")))];
    sections.push({ kind, sourceRefs: matching.map(source => source.id),
      text: normalizeProse(texts[0]!) + (texts.length > 1
        ? `\n\n<details>\n<summary>Additional retained ${kind} contributions (may overlap or disagree)</summary>\n\n${texts.slice(1).map(normalizeProse).join("\n\n")}\n\n</details>` : "") });
  }
  return "Source-based presentation; synthesis was unavailable. Distinct contributions and caveats are retained below.\n\n"
    + renderCompositionSections(findings, sections, sources.filter(source => source.kind === "evidence").map(source => source.id), link);
}
