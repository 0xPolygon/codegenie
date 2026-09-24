import type { CandidateFinding, SuggestionAssessment } from "../types.js";
import { codeBlock, fenceLanguageForPath, inlineCode } from "../util/markdown.js";
import { conflictingSuggestions, suggestionAssessment } from "./suggestion-assessment.js";

export type CompositionSource = {
  id: string; findingId: string; kind: "impact" | "verification" | "fix" | "test" | "evidence";
  text: string; path?: string; explanation?: string; suggestionAssessment?: SuggestionAssessment; provenanceOnly?: boolean;
};
export type CompositionSection = { kind: "impact" | "verification" | "fix" | "test"; text: string; sourceRefs: string[] };
export type Reconciliation = { sourceRefs: string[]; supportingRefs: string[]; disposition: "superseded" | "unresolved"; rationale: string };
export type CompositionPresentation = {
  retainedSourceRefs?: string[];
  primaryEvidenceRefs?: string[];
  reconciliations?: Reconciliation[];
};

// Only explicit whole-value scaffolding, not mentions inside real prose or
// quoted evidence. This is a completion check, not a semantic quality score.
const SECTION_SCAFFOLDS = new Set(["placeholder", "todo", "tbd"]);
export function compositionCompletionDiagnostics(sections: CompositionSection[], prefix = "") {
  return sections.flatMap((section, index) => {
    const text = section.text.trim().toLowerCase();
    return !text || SECTION_SCAFFOLDS.has(text) ? [{
      code: "unfinished_section", path: `${prefix}sections.${index}.text`,
      correction: "Replace this unfinished section with a complete conclusion supported by its supplied sources. Preserve other completed sections and all source accounting."
    }] : [];
  });
}

export function compositionSources(findings: CandidateFinding[], assessmentFindings = findings): CompositionSource[] {
  const conflicts = conflictingSuggestions(assessmentFindings);
  return findings.flatMap(finding => {
    const sources: CompositionSource[] = [];
    for (const [field, kind] of [["failureMode", "impact"], ["whyThisMatters", "impact"], ["verification", "verification"], ["suggestedFix", "fix"], ["suggestedTest", "test"]] as const) {
      const text = finding[field];
      const assessment = kind === "fix" || kind === "test" ? suggestionAssessment(finding, field as "suggestedFix" | "suggestedTest") : undefined;
      const effective = assessment?.status === "supported" && conflicts.has(field + "\0" + text)
        ? { ...assessment, status: "unverified" as const, rationale: "Conflicting compatibility assessments for this exact proposal remain unresolved. " + assessment.rationale }
        : assessment;
      if (text) sources.push({ id: finding.id + "/" + field, findingId: finding.id, kind, text,
        ...(effective ? { suggestionAssessment: effective } : {}) });
    }
    for (const [field, kind] of [["suggestedFix", "fix"], ["suggestedTest", "test"]] as const) {
      const original = finding.originalSuggestions?.[field];
      if (original && original.suggestionText !== finding[field]) sources.push({
        id: finding.id + "/originalSuggestions/" + field, findingId: finding.id, kind,
        text: original.suggestionText, suggestionAssessment: original, provenanceOnly: true
      });
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

// Shared by validation, live schemas, repair schemas and fallback. Historical
// assessments remain auditable but never authorize current recommendations.
export function eligibleCompositionSource(source: CompositionSource, kind?: string): boolean {
  if (kind === undefined) return true;
  return source.kind === kind && !source.provenanceOnly
    && ((kind !== "fix" && kind !== "test") || source.suggestionAssessment?.status === "supported");
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

export type AttributionDiagnostic = {
  code: "unknown_source" | "wrong_section" | "duplicate_reference" | "missing_source" | "unsupported_suggestion";
  path: string; reference: string; actualKind?: CompositionSource["kind"] | undefined; expectedKind?: string | undefined;
  accountedAt?: string | undefined; allowedPaths?: string[]; correction: string;
};

export function compositionReferenceLists(sections: CompositionSection[], evidenceRefs: string[], presentation: CompositionPresentation, prefix = "") {
  return [
    ...sections.map((section, index) => ({ path: `${prefix}sections.${index}.sourceRefs`, refs: section.sourceRefs, kind: section.kind as string | undefined })),
    { path: prefix + "evidenceRefs", refs: evidenceRefs, kind: "evidence" as string | undefined },
    { path: prefix + "retainedSourceRefs", refs: presentation.retainedSourceRefs ?? [], kind: undefined }
  ];
}

export function compositionAttributionDiagnostics(sources: CompositionSource[], sections: CompositionSection[], evidenceRefs: string[], presentation: CompositionPresentation, prefix = ""): AttributionDiagnostic[] {
  const lists = compositionReferenceLists(sections, evidenceRefs, presentation, prefix);
  const byId = new Map(sources.map(source => [source.id, source]));
  const accounted = new Map<string, string>();
  // Discover valid placements first so even an earlier wrong-kind occurrence
  // can name the correct, retained occurrence in the diagnostic.
  for (const list of lists) list.refs.forEach((ref, index) => {
    const source = byId.get(ref);
    if (source && eligibleCompositionSource(source, list.kind) && !accounted.has(ref)) accounted.set(ref, `${list.path}.${index}`);
  });
  const diagnostics: AttributionDiagnostic[] = [];
  for (const list of lists) list.refs.forEach((ref, index) => {
    const path = `${list.path}.${index}`;
    const source = byId.get(ref);
    const common = { path, reference: ref, expectedKind: list.kind, actualKind: source?.kind, accountedAt: accounted.get(ref) };
    if (!source) diagnostics.push({ ...common, code: "unknown_source", correction: "This ID is not in this finding's source inventory. Use only supplied IDs; do not invent a replacement." });
    else if (list.kind && source.kind !== list.kind) diagnostics.push({ ...common, code: "wrong_section", correction: accounted.has(ref)
      ? "Remove this extra occurrence; preserve the correctly accounted occurrence."
      : "Move this reference to a matching-kind section or retainedSourceRefs; preserve its source." });
    else if (!eligibleCompositionSource(source, list.kind)) diagnostics.push({ ...common, code: "unsupported_suggestion",
      allowedPaths: [prefix + "retainedSourceRefs"],
      correction: "Only supported current suggestions may appear in fix/test sections. Retain this source in provenance and rewrite or omit the unsupported advice section; changing attribution alone cannot endorse its prose." });
    else if (accounted.get(ref) !== path) diagnostics.push({ ...common, code: "duplicate_reference", correction: "Remove the extra occurrence; preserve the correctly accounted occurrence." });
  });
  for (const source of sources) if (!accounted.has(source.id)) diagnostics.push({
    code: "missing_source", path: prefix + "retainedSourceRefs", reference: source.id, actualKind: source.kind,
    allowedPaths: lists.filter(list => eligibleCompositionSource(source, list.kind)).map(list => list.path),
    correction: "Account for this source exactly once in a matching-kind section, evidenceRefs for evidence, or retainedSourceRefs. Visible proof and primary-evidence requirements still apply."
  });
  return diagnostics;
}

function validateSources(findings: CandidateFinding[], sections: CompositionSection[], evidenceRefs: string[], presentation: CompositionPresentation, prefix = "", assessmentFindings = findings) {
  const sources = compositionSources(findings, assessmentFindings);
  const byId = new Map(sources.map(source => [source.id, source]));
  const kinds = new Set<string>();
  const diagnostics = compositionAttributionDiagnostics(sources, sections, evidenceRefs, presentation, prefix);
  const errors: string[] = diagnostics.map(issue => JSON.stringify(issue));
  const completion = compositionCompletionDiagnostics(sections, prefix);
  for (const section of sections) {
    if (!section.text.trim() || !section.sourceRefs.length) errors.push("Empty composition section");
    if (kinds.has(section.kind)) errors.push("Duplicate section kind: " + section.kind + ". Combine its conclusions into one section.");
    kinds.add(section.kind);
  }
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
  const visibleVerification = new Set(sections.filter(section => section.kind === "verification").flatMap(section => section.sourceRefs));
  const superseded = new Set((presentation.reconciliations ?? []).filter(record => record.disposition === "superseded").flatMap(record => record.sourceRefs));
  const required = findings.filter(finding => finding.proofAssessment &&
    (finding.proofAssessment.status === "unresolved" || finding.proofAssessment.assumptions.length > 0))
    .map(finding => finding.id + "/proofAssessment");
  required.push(...(presentation.reconciliations ?? []).filter(record => record.disposition === "unresolved").flatMap(record => record.sourceRefs));
  for (const ref of new Set(required)) if (!visibleVerification.has(ref) && !superseded.has(ref)) {
    errors.push("Unresolved conditions must be attributed to the visible verification section: " + ref);
  }
  if (completion.length || errors.length) throw new Error([...completion.map(issue => JSON.stringify(issue)), ...errors.slice(0, 20)].join("; ") + " Use only supplied source IDs in their matching kinds; absent optional fields have no source. Account for all supplied components without inventing source data.");
  return { sources, byId, primary };
}

function proofText(proof: NonNullable<CandidateFinding["proofAssessment"]>): string {
  return "**Proof status:** " + proof.status + "\n\n" + safeReportProse(proof.evidence)
    + (proof.assumptions.length ? "\n\n" + proof.assumptions.map(assumption =>
      "- " + (assumption.essential ? "Essential" : "Secondary") + " assumption: " + safeReportProse(assumption.question)).join("\n") : "");
}

function assessmentText(assessment: SuggestionAssessment): string {
  return "**Suggestion assessment:** " + assessment.status + "\n\n" + safeReportProse(assessment.rationale)
    + (assessment.contractCheck ? "\n\n**Behavioral requirement (" + assessment.contractCheck.status + "):** " + safeReportProse(assessment.contractCheck.requirement) : "")
    + assessment.evidence.map(item => "\n\n" + inlineCode(item.path) + "\n\n" + codeBlock(item.lines, "text") + "\n\n" + safeReportProse(item.whyRelevant)).join("");
}

function renderEvidence(source: CompositionSource, link?: (path: string, line?: number) => string | undefined): string {
  const url = source.path ? link?.(source.path) : undefined;
  const location = inlineCode(source.path ?? "") + (url ? " ([source](" + url + "))" : "");
  const content = /^\d+(?:\s*[-–,:]\s*\d+)*$/u.test(source.text)
    ? "Lines " + source.text : codeBlock(source.text, fenceLanguageForPath(source.path ?? ""));
  return location + "\n" + content + (source.explanation ? "\n" + safeReportProse(source.explanation) : "");
}

export function composePresentation(findings: CandidateFinding[], sections: CompositionSection[], evidenceRefs: string[], link?: (path: string, line?: number) => string | undefined, presentation: CompositionPresentation = {}, assessmentFindings = findings, unreconciledSuggestionKinds: ReadonlyArray<"fix" | "test"> = []) {
  const { sources, byId, primary } = validateSources(findings, sections, evidenceRefs, presentation, "", assessmentFindings);
  const labels = { impact: "Impact", verification: "Verification and uncertainty", fix: "Suggested fix", test: "Suggested test" };
  const prose = sections.map(section => "**" + labels[section.kind] + ":** " + safeReportProse(section.text));
  for (const [kind, label] of [["fix", "Remediation"], ["test", "Regression-test guidance"]] as const) {
    const proposals = sources.filter(source => source.kind === kind && !source.provenanceOnly);
    if (proposals.length && !proposals.some(source => eligibleCompositionSource(source, kind))) {
      prose.push(label + " remains unverified; original proposals and assessments are retained below.");
    } else if (unreconciledSuggestionKinds.includes(kind)) {
      prose.push(label + " remains unreconciled: multiple supported proposals differ; all proposals and assessments are retained below.");
    }
  }
  const concerns = [...new Set(findings.flatMap(finding => {
    const proof = finding.proofAssessment;
    if (!proof) return [];
    return [
      ...(proof.status === "unresolved" ? [proof.evidence] : []),
      ...proof.assumptions.filter(assumption => assumption.essential).map(assumption => "Essential assumption: " + assumption.question)
    ];
  }))];
  const uncertaintyBody = concerns.length ? "**Open conditions:**\n\n" + concerns.map(text => "- " + safeReportProse(text)).join("\n") : "";
  if (uncertaintyBody) prose.push(uncertaintyBody);
  const evidenceBody = primary.map(ref => renderEvidence(byId.get(ref)!, link)).join("\n\n");
  prose.push("**Evidence:**\n\n" + evidenceBody);

  // Every source remains attributable, including sources omitted from prominent
  // prose. Dedup only identical records, retaining every originating reference.
  const originals = new Map<string, { source: CompositionSource; refs: string[] }>();
  for (const source of sources) {
    const key = JSON.stringify([source.kind, source.path, source.text, source.explanation, source.suggestionAssessment, source.provenanceOnly]);
    const entry = originals.get(key) ?? { source, refs: [] };
    entry.refs.push(source.id);
    originals.set(key, entry);
  }
  const metadata = findings.map(finding => "- " + inlineCode(finding.id) + ": severity " + finding.severity + ", confidence " + finding.confidence).join("\n");
  const provenance = "**Original candidate metadata:**\n\n" + metadata + "\n\n" + [...originals.values()].map(({ source, refs }) => {
    const dispositions = (presentation.reconciliations ?? []).filter(record => record.sourceRefs.some(ref => refs.includes(ref)));
    const attribution = refs.map(ref => inlineCode(ref)).join(", ");
    const assessment = source.suggestionAssessment;
    const finding = findings.find(finding => finding.id === source.findingId);
    const proof = source.id.endsWith("/proofAssessment") ? finding?.proofAssessment : undefined;
    const submittedAssessment = source.provenanceOnly ? undefined : source.kind === "fix" ? finding?.suggestionAssessments?.suggestedFix
      : source.kind === "test" ? finding?.suggestionAssessments?.suggestedTest : undefined;
    const originalStatus = submittedAssessment?.suggestionText === source.text && submittedAssessment.status !== assessment?.status
      ? "\n\n**Submitted assessment status:** " + submittedAssessment.status + "; the effective qualification is shown below." : "";
    return "**Original " + source.kind + (source.provenanceOnly ? " (before verification revision; provenance only)" : "") + ":** " + attribution
      + (dispositions.length ? "\n\n" + dispositions.map(record => "**" + record.disposition + ":** " + safeReportProse(record.rationale) + " Supporting sources: " + record.supportingRefs.map(inlineCode).join(", ")).join("\n\n") : "")
      + (source.path ? "\n\n" + inlineCode(source.path) : "")
      + "\n\n" + (proof ? proofText(proof) : codeBlock(source.text, source.kind === "evidence" ? fenceLanguageForPath(source.path ?? "") : "text"))
      + (source.explanation ? "\n\n" + codeBlock(source.explanation, "text") : "")
      + originalStatus + (assessment ? "\n\n" + assessmentText(assessment) : "");
  }).join("\n\n");
  const primaryBody = prose.join("\n\n");
  const body = primaryBody + "\n\n<details>\n<summary>Original assessments and supporting evidence (may overlap or disagree)</summary>\n\n"
    + "Original source material is retained for audit. The current conclusion is above; superseded assessments are labeled where supplied. Attribution does not prove semantic equivalence.\n\n"
    + provenance + "\n\n</details>";
  return { body, metrics: {
    narrativeWords: sections.reduce((count, section) => count + section.text.trim().split(/\s+/u).length, 0),
    primaryWords: primaryBody.trim().split(/\s+/u).length,
    provenanceWords: provenance.trim().split(/\s+/u).length,
    verificationWords: sections.filter(section => section.kind === "verification").reduce((count, section) => count + section.text.trim().split(/\s+/u).length, 0),
    uncertaintyWords: uncertaintyBody ? uncertaintyBody.trim().split(/\s+/u).length : 0,
    evidenceWords: evidenceBody ? evidenceBody.trim().split(/\s+/u).length : 0,
    sourceComponents: sources.length, accountedSourceComponents: sources.length,
    primaryEvidenceComponents: primary.length,
    publishedSuggestionSources: sections.filter(section => section.kind === "fix" || section.kind === "test").flatMap(section => section.sourceRefs),
    retainedSuggestionSources: sources.filter(source => (source.kind === "fix" || source.kind === "test")
      && !sections.some(section => section.sourceRefs.includes(source.id))).map(source => source.id),
    suggestionAssessments: sources.filter(source => source.suggestionAssessment).map(source => ({ sourceRef: source.id, status: source.suggestionAssessment!.status, rationale: source.suggestionAssessment!.rationale })),
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
  for (const [index, group] of proposal.composedFindings.entries()) {
    for (const id of group.findingIds) {
      if (!known.has(id) || used.has(id)) errors.push("Unknown or repeated finding ID: " + id + ". Use each supplied finding exactly once.");
      used.add(id);
    }
    if (!group.sections || !group.evidenceRefs) {
      errors.push("Supply sections and evidenceRefs for every composed finding.");
      continue;
    }
    try { validateSources(group.findingIds.flatMap(id => known.has(id) ? [known.get(id)!] : []), group.sections, group.evidenceRefs, group, `composedFindings.${index}.`, findings); }
    catch (error) { errors.push(String(error)); }
  }
  const missing = [...known.keys()].filter(id => !used.has(id));
  if (missing.length) errors.push("Composition omitted findings: " + missing.join(", "));
  if (errors.length) throw new Error(errors.join("\n"));
}

export type CompositionMetrics = ReturnType<typeof composePresentation>["metrics"];

export function renderRetainedComposition(findings: CandidateFinding[], link?: (path: string, line?: number) => string | undefined, normalizeProse: (text: string) => string = text => text, onMetrics?: (metrics: CompositionMetrics) => void, assessmentFindings = findings): string {
  const sources = compositionSources(findings, assessmentFindings);
  const sections: CompositionSection[] = [];
  const retainedSourceRefs: string[] = [];
  const unreconciledSuggestionKinds: Array<"fix" | "test"> = [];
  for (const kind of ["impact", "verification", "fix", "test"] as const) {
    const matching = sources.filter(source => source.kind === kind);
    if (!matching.length) continue;
    const eligible = matching.filter(source => eligibleCompositionSource(source, kind));
    // Exact duplicates may share one presentation. Without synthesis, neither
    // ordering nor a supported label reconciles differently worded proposals.
    if ((kind === "fix" || kind === "test") && new Set(eligible.map(source => source.text)).size > 1) {
      retainedSourceRefs.push(...matching.map(source => source.id));
      unreconciledSuggestionKinds.push(kind);
      continue;
    }
    const chosen = eligible[0];
    if (!chosen) { retainedSourceRefs.push(...matching.map(source => source.id)); continue; }
    const selected = kind === "impact" ? eligible.filter(source => source.findingId === chosen.findingId)
      : kind === "verification" ? eligible.filter(source => source === chosen || findings.some(finding =>
        source.id === finding.id + "/proofAssessment" && finding.proofAssessment &&
        (finding.proofAssessment.status === "unresolved" || finding.proofAssessment.assumptions.length > 0))) : [chosen];
    const texts = [...new Set(selected.map(source => source.text))];
    const equivalent = eligible.filter(source => texts.includes(source.text));
    const renderedTexts = [...new Set(selected.filter(source => !source.id.endsWith("/proofAssessment"))
      .map(source => normalizeProse(source.text)))];
    if (kind === "verification") {
      const proofs = findings.flatMap(finding => selected.some(source => source.id === finding.id + "/proofAssessment")
        && finding.proofAssessment ? [finding.proofAssessment] : []);
      if (proofs.length) renderedTexts.push("Retained proof status (not synthesized): " + [...new Set(proofs.map(proof => proof.status))].join(", ") + ".");
      // Essential conditions and unresolved evidence are rendered once by
      // composePresentation's Open conditions. Full proofs remain in provenance.
      const essential = new Set(proofs.flatMap(proof => proof.assumptions.filter(a => a.essential).map(a => a.question)));
      const secondary = [...new Set(proofs.flatMap(proof => proof.assumptions.filter(a => !a.essential && !essential.has(a.question)).map(a => a.question)))];
      if (secondary.length) renderedTexts.push(secondary.map(question => "Secondary assumption: " + question).join("\n\n"));
    }
    if (kind === "verification" && conflictingSuggestions(assessmentFindings).size) renderedTexts.push("Compatibility assessments conflict for an identical proposal; the disputed recommendation remains unverified. See original assessments below.");
    sections.push({ kind, sourceRefs: equivalent.map(source => source.id), text: renderedTexts.join("\n\n") });
    retainedSourceRefs.push(...matching.filter(source => !equivalent.includes(source)).map(source => source.id));
  }
  const presentation: CompositionPresentation = { retainedSourceRefs };
  const rendered = composePresentation(findings, sections, sources.filter(source => source.kind === "evidence").map(source => source.id), link, presentation, assessmentFindings, unreconciledSuggestionKinds);
  onMetrics?.(rendered.metrics);
  return "Source-based presentation; synthesis was unavailable. Original assessments may overlap or disagree.\n\n" + rendered.body;
}
