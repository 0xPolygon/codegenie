import type { CandidateFinding, SuggestionAssessment } from "../types.js";
import { codeBlock, fenceLanguageForPath, inlineCode } from "../util/markdown.js";
import { suggestionAssessment } from "./suggestion-assessment.js";

export type CompositionSource = {
  id: string; findingId: string; kind: "impact" | "verification" | "fix" | "test" | "evidence";
  text: string; path?: string; explanation?: string; suggestionAssessment?: SuggestionAssessment;
};
export type CompositionSection = { kind: "impact" | "verification" | "fix" | "test"; text: string; sourceRefs: string[] };
export type Reconciliation = { sourceRefs: string[]; supportingRefs: string[]; disposition: "superseded" | "unresolved"; rationale: string };
export type CompositionPresentation = {
  retainedSourceRefs?: string[];
  primaryEvidenceRefs?: string[];
  reconciliations?: Reconciliation[];
};

export function compositionSources(findings: CandidateFinding[]): CompositionSource[] {
  return findings.flatMap(finding => {
    const sources: CompositionSource[] = [];
    for (const [field, kind] of [["failureMode", "impact"], ["whyThisMatters", "impact"], ["verification", "verification"], ["suggestedFix", "fix"], ["suggestedTest", "test"]] as const) {
      const text = finding[field];
      if (text) sources.push({ id: finding.id + "/" + field, findingId: finding.id, kind, text,
        ...(kind === "fix" || kind === "test" ? { suggestionAssessment: suggestionAssessment(finding, field as "suggestedFix" | "suggestedTest")! } : {}) });
    }
    if (finding.proofAssessment) sources.push({
      id: finding.id + "/proofAssessment", findingId: finding.id, kind: "verification",
      text: JSON.stringify(finding.proofAssessment)
    });
    sources.push({ id: finding.id + "/evidence/changedCode", findingId: finding.id, kind: "evidence", text: finding.evidence.changedCode, path: finding.path });
    (finding.evidence.relatedCode ?? []).forEach((evidence, index) => sources.push({
      id: finding.id + "/evidence/relatedCode/" + index, findingId: finding.id, kind: "evidence",
      text: evidence.lines, path: evidence.path, explanation: evidence.whyRelevant
    }));
    return sources;
  });
}

// Model prose never owns HTML containers. Close unbalanced Markdown fences so
// they cannot swallow renderer-owned provenance. Original bytes stay in sources.
export function safeReportProse(text: string): string {
  const ticks = String.fromCharCode(96);
  let fence: { char: string; length: number } | undefined;
  const lines = text.replace(/\r\n/g, "\n").split("\n").map(line => {
    const match = /^ {0,3}([`~]{3,})(.*)$/u.exec(line);
    if (match && [...match[1]!].every(char => char === match[1]![0])) {
      const run = match[1]!;
      if (!fence) fence = { char: run[0]!, length: run.length };
      else if (fence.char === run[0] && run.length >= fence.length && !match[2]!.trim()) fence = undefined;
    }
    // Escape HTML starts; immutable source bytes are rendered separately in code blocks.
    return line.replace(/<(\/?[A-Za-z!])/gu, "&lt;$1");
  });
  if (fence) lines.push((fence.char === ticks ? ticks : "~").repeat(fence.length));
  return lines.join("\n");
}

function validateSources(findings: CandidateFinding[], sections: CompositionSection[], evidenceRefs: string[], presentation: CompositionPresentation) {
  const sources = compositionSources(findings);
  const byId = new Map(sources.map(source => [source.id, source]));
  const seen = new Set<string>();
  const kinds = new Set<string>();
  const errors: string[] = [];
  const account = (ref: string, kind?: string) => {
    if (!byId.has(ref) || (kind && byId.get(ref)?.kind !== kind) || seen.has(ref)) {
      errors.push("Invalid or duplicate composition source: " + ref + (kind ? " (expected " + kind + ")." : "."));
    } else seen.add(ref);
  };
  for (const section of sections) {
    if (!section.text.trim() || !section.sourceRefs.length) errors.push("Empty composition section");
    if (kinds.has(section.kind)) errors.push("Duplicate section kind: " + section.kind + ". Combine its conclusions into one section.");
    kinds.add(section.kind);
    for (const ref of section.sourceRefs) {
      account(ref, section.kind);
      if (byId.get(ref)?.suggestionAssessment?.status === "incompatible") errors.push("Incompatible suggestion must be retained only in provenance: " + ref);
    }
  }
  for (const ref of evidenceRefs) account(ref, "evidence");
  for (const ref of presentation.retainedSourceRefs ?? []) account(ref);
  const missing = sources.filter(source => !seen.has(source.id));
  if (missing.length) errors.push("Composition omitted verified source components (" + missing.length + "): " + missing.slice(0, 25).map(source => source.id).join(", "));
  for (const kind of ["impact", "verification"]) {
    if (sources.some(source => source.kind === kind) && !kinds.has(kind)) errors.push("Supply one current " + kind + " conclusion; provenance alone is insufficient.");
  }
  const primary = presentation.primaryEvidenceRefs ?? evidenceRefs.slice(0, 1);
  if (primary.length > 3 || new Set(primary).size !== primary.length) errors.push("Select up to three distinct primary evidence references.");
  for (const ref of primary) if (!evidenceRefs.includes(ref)) errors.push("Primary evidence must be an accounted evidence reference: " + ref);
  if (sources.some(source => source.kind === "evidence") && !primary.length) errors.push("Select at least one decisive primary evidence reference.");
  const reconciled = new Set<string>();
  for (const record of presentation.reconciliations ?? []) {
    if (!record.sourceRefs.length || !record.rationale.trim()) errors.push("Reconciliation needs affected sources and a rationale.");
    for (const ref of record.sourceRefs) {
      if (byId.get(ref)?.kind !== "verification" || reconciled.has(ref)) errors.push("Invalid or repeated reconciliation source: " + ref);
      reconciled.add(ref);
      if (record.disposition === "superseded" && ref.endsWith("/proofAssessment")) {
        const finding = findings.find(finding => finding.id === byId.get(ref)?.findingId);
        if (finding?.proofAssessment?.status === "unresolved" || finding?.proofAssessment?.assumptions.some(a => a.essential)) {
          errors.push("Composition cannot supersede an unresolved essential proof assessment: " + ref);
        }
      }
    }
    if (record.disposition === "superseded" && !record.supportingRefs.length) errors.push("Supersession requires supporting source evidence.");
    for (const ref of record.supportingRefs) {
      if (!byId.has(ref) || record.sourceRefs.includes(ref)) errors.push("Invalid independent reconciliation support: " + ref);
    }
  }
  if (errors.length) throw new Error(errors.slice(0, 20).join("; ") + " Use only supplied source IDs in their matching kinds; absent optional fields have no source. Account for all supplied components without inventing source data.");
  return { sources, byId, primary };
}

function renderEvidence(source: CompositionSource, link?: (path: string, line?: number) => string | undefined): string {
  const url = source.path ? link?.(source.path) : undefined;
  const location = inlineCode(source.path ?? "") + (url ? " ([source](" + url + "))" : "");
  const content = /^\d+(?:\s*[-–,:]\s*\d+)*$/u.test(source.text)
    ? "Lines " + source.text : codeBlock(source.text, fenceLanguageForPath(source.path ?? ""));
  return location + "\n" + content + (source.explanation ? "\n" + safeReportProse(source.explanation) : "");
}

export function composePresentation(findings: CandidateFinding[], sections: CompositionSection[], evidenceRefs: string[], link?: (path: string, line?: number) => string | undefined, presentation: CompositionPresentation = {}) {
  const { sources, byId, primary } = validateSources(findings, sections, evidenceRefs, presentation);
  const labels = { impact: "Impact", verification: "Verification and uncertainty", fix: "Suggested fix", test: "Suggested test" };
  const prose = sections.map(section => {
    const unverified = (section.kind === "fix" || section.kind === "test")
      && section.sourceRefs.some(ref => byId.get(ref)?.suggestionAssessment?.status !== "supported");
    return "**" + labels[section.kind] + (unverified ? " (unverified)" : "") + ":** "
      + (unverified ? "Caller-contract compatibility has not been established. " : "") + safeReportProse(section.text);
  });
  const concerns = [...new Set(findings.flatMap(finding => {
    const proof = finding.proofAssessment;
    if (!proof) return [];
    return [
      ...(proof.status === "unresolved" ? [proof.evidence] : []),
      ...proof.assumptions.map(assumption => (assumption.essential ? "Essential assumption: " : "") + assumption.question)
    ];
  }))];
  const severities = [...new Set(findings.map(finding => finding.severity))];
  if (severities.length > 1) concerns.push("Original severity assessments differ: " + severities.join(", ") + ". The published severity reflects the combined finding.");
  const unresolved = (presentation.reconciliations ?? []).filter(record => record.disposition === "unresolved").map(record => record.rationale);
  if (concerns.length || unresolved.length) prose.push("**Open conditions:**\n\n" + [...new Set([...concerns, ...unresolved])].map(text => "- " + safeReportProse(text)).join("\n"));
  prose.push("**Evidence:**\n\n" + primary.map(ref => renderEvidence(byId.get(ref)!, link)).join("\n\n"));

  // Every source remains attributable, including sources omitted from prominent
  // prose. Dedup only identical records, retaining every originating reference.
  const originals = new Map<string, { source: CompositionSource; refs: string[] }>();
  for (const source of sources) {
    const key = JSON.stringify([source.kind, source.path, source.text, source.explanation, source.suggestionAssessment]);
    const entry = originals.get(key) ?? { source, refs: [] };
    entry.refs.push(source.id);
    originals.set(key, entry);
  }
  const provenance = [...originals.values()].map(({ source, refs }) => {
    const dispositions = (presentation.reconciliations ?? []).filter(record => record.sourceRefs.some(ref => refs.includes(ref)));
    const attribution = refs.map(ref => inlineCode(ref)).join(", ");
    const assessment = source.suggestionAssessment;
    return "**Original " + source.kind + ":** " + attribution
      + (dispositions.length ? "\n\n" + dispositions.map(record => "**" + record.disposition + ":** " + safeReportProse(record.rationale) + " Supporting sources: " + record.supportingRefs.map(inlineCode).join(", ")).join("\n\n") : "")
      + (source.path ? "\n\n" + inlineCode(source.path) : "")
      + "\n\n" + codeBlock(source.text, source.kind === "evidence" ? fenceLanguageForPath(source.path ?? "") : "text")
      + (source.explanation ? "\n\n" + codeBlock(source.explanation, "text") : "")
      + (assessment ? "\n\n**Suggestion assessment:** " + assessment.status + "\n\n" + codeBlock(JSON.stringify(assessment, null, 2), "json") : "");
  }).join("\n\n");
  const primaryBody = prose.join("\n\n");
  const body = primaryBody + "\n\n<details>\n<summary>Original assessments and supporting evidence (may overlap or disagree)</summary>\n\n"
    + "Original source material is retained for audit. The current conclusion is above; superseded assessments are labeled where supplied. Attribution does not prove semantic equivalence.\n\n"
    + provenance + "\n\n</details>";
  return { body, metrics: {
    narrativeWords: sections.reduce((count, section) => count + section.text.trim().split(/\s+/u).length, 0),
    primaryWords: primaryBody.trim().split(/\s+/u).length,
    provenanceWords: provenance.trim().split(/\s+/u).length,
    sourceComponents: sources.length, accountedSourceComponents: sources.length,
    primaryEvidenceComponents: primary.length,
    suggestionAssessments: sources.filter(source => source.suggestionAssessment).map(source => ({ sourceRef: source.id, status: source.suggestionAssessment!.status })),
    semanticPreservation: "not_machine_proven"
  } };
}

export function renderCompositionSections(findings: CandidateFinding[], sections: CompositionSection[], evidenceRefs: string[], link?: (path: string, line?: number) => string | undefined, presentation: CompositionPresentation = {}): string {
  return composePresentation(findings, sections, evidenceRefs, link, presentation).body;
}

export function validateCompositionSubmission(
  proposal: { composedFindings: Array<CompositionPresentation & { findingIds: string[]; sections?: CompositionSection[]; evidenceRefs?: string[] }> },
  findings: CandidateFinding[]
): void {
  const known = new Map(findings.map(finding => [finding.id, finding]));
  const used = new Set<string>();
  const errors: string[] = [];
  for (const group of proposal.composedFindings) {
    for (const id of group.findingIds) {
      if (!known.has(id) || used.has(id)) errors.push("Unknown or repeated finding ID: " + id + ". Use each supplied finding exactly once.");
      used.add(id);
    }
    if (!group.sections || !group.evidenceRefs) {
      errors.push("Supply sections and evidenceRefs for every composed finding.");
      continue;
    }
    try { validateSources(group.findingIds.flatMap(id => known.has(id) ? [known.get(id)!] : []), group.sections, group.evidenceRefs, group); }
    catch (error) { errors.push(String(error)); }
  }
  const missing = [...known.keys()].filter(id => !used.has(id));
  if (missing.length) errors.push("Composition omitted findings: " + missing.join(", "));
  if (errors.length) throw new Error(errors.slice(0, 20).join("\n"));
}

export type CompositionMetrics = ReturnType<typeof composePresentation>["metrics"];

export function renderRetainedComposition(findings: CandidateFinding[], link?: (path: string, line?: number) => string | undefined, normalizeProse: (text: string) => string = text => text, onMetrics?: (metrics: CompositionMetrics) => void): string {
  const sources = compositionSources(findings);
  const sections: CompositionSection[] = [];
  const retainedSourceRefs: string[] = [];
  for (const kind of ["impact", "verification", "fix", "test"] as const) {
    const matching = sources.filter(source => source.kind === kind);
    if (!matching.length) continue;
    const eligible = matching.filter(source => source.suggestionAssessment?.status !== "incompatible");
    const chosen = eligible[0];
    if (!chosen) { retainedSourceRefs.push(...matching.map(source => source.id)); continue; }
    const selected = kind === "impact" ? eligible.filter(source => source.findingId === chosen.findingId) : [chosen];
    const texts = [...new Set(selected.map(source => source.text))];
    const equivalent = eligible.filter(source => texts.includes(source.text));
    sections.push({ kind, sourceRefs: equivalent.map(source => source.id), text: texts.map(normalizeProse).join("\n\n") });
    retainedSourceRefs.push(...matching.filter(source => !equivalent.includes(source)).map(source => source.id));
  }
  const differingVerification = new Set(sources.filter(source => source.kind === "verification").map(source => source.text)).size > 1;
  const presentation: CompositionPresentation = { retainedSourceRefs };
  if (differingVerification) presentation.reconciliations = [{
    sourceRefs: sources.filter(source => source.kind === "verification").map(source => source.id),
    supportingRefs: [], disposition: "unresolved",
    rationale: "Synthesis was unavailable. Original verification assessments differ and have not been reconciled; treat the representative conclusion as provisional."
  }];
  const rendered = composePresentation(findings, sections, sources.filter(source => source.kind === "evidence").map(source => source.id), link, presentation);
  onMetrics?.(rendered.metrics);
  return "Source-based presentation; synthesis was unavailable. Original assessments may overlap or disagree.\n\n" + rendered.body;
}
