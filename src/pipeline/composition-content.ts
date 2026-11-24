import type { CandidateFinding, SuggestionAssessment } from "../types.js";
import { codeBlock, fenceLanguageForPath, inlineCode } from "../util/markdown.js";
import { isRepositoryTestPath } from "../util/path-roles.js";
import { conflictingSuggestions, suggestionAssessment } from "./suggestion-assessment.js";

export type CompositionSource = {
  id: string; findingId: string; kind: "impact" | "verification" | "fix" | "test" | "evidence";
  text: string; path?: string; explanation?: string; suggestionAssessment?: SuggestionAssessment; provenanceOnly?: boolean;
  testFileFix?: true;
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
      if (text) {
        const source: CompositionSource = { id: finding.id + "/" + field, findingId: finding.id, kind, text,
          ...(effective ? { suggestionAssessment: effective } : {}) };
        // Host-only placement metadata must not alter the model's source inventory.
        if (field === "suggestedFix" && finding.category === "testing" && isRepositoryTestPath(finding.path)) {
          Object.defineProperty(source, "testFileFix", { value: true });
        }
        sources.push(source);
      }
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

// Placement is broader than source selection only for supported test-file fixes.
export function compatibleCompositionPlacement(source: CompositionSource, kind?: string): boolean {
  return kind === undefined || source.kind === kind || (kind === "test" && source.kind === "fix" && source.testFileFix === true);
}

export function eligibleCompositionPlacement(source: CompositionSource, kind?: string): boolean {
  if (!compatibleCompositionPlacement(source, kind)) return false;
  return kind === "test" && source.kind === "fix"
    ? eligibleCompositionSource(source, "fix") : eligibleCompositionSource(source, kind);
}

// Model prose never owns HTML containers. Close unbalanced Markdown fences so
// they cannot swallow later report sections. Original bytes stay in sources.
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
  code: "unknown_source" | "wrong_section" | "duplicate_reference" | "missing_source" | "unsupported_suggestion" | "proof_not_visible";
  // Omitted for unknown references: model-supplied text is not echoed into
  // persisted diagnostics; the path locates it.
  path: string; reference?: string; actualKind?: CompositionSource["kind"] | undefined; expectedKind?: string | undefined;
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
    if (source && eligibleCompositionPlacement(source, list.kind) && !accounted.has(ref)) accounted.set(ref, `${list.path}.${index}`);
  });
  const diagnostics: AttributionDiagnostic[] = [];
  for (const list of lists) list.refs.forEach((ref, index) => {
    const path = `${list.path}.${index}`;
    const source = byId.get(ref);
    const common = { path, ...(source ? { reference: ref } : {}), expectedKind: list.kind, actualKind: source?.kind, accountedAt: accounted.get(ref) };
    if (!source) diagnostics.push({ ...common, code: "unknown_source", correction: "This ID is not in this finding's source inventory. Use only supplied IDs; do not invent a replacement." });
    else if (!compatibleCompositionPlacement(source, list.kind)) diagnostics.push({ ...common, code: "wrong_section", correction: accounted.has(ref)
      ? "Remove this extra occurrence; preserve the correctly accounted occurrence."
      : "Move this reference to a matching-kind section or retainedSourceRefs; preserve its source." });
    else if (!eligibleCompositionPlacement(source, list.kind)) diagnostics.push({ ...common, code: "unsupported_suggestion",
      allowedPaths: [prefix + "retainedSourceRefs"],
      correction: "Only supported current suggestions may appear in fix/test sections. Retain this source in provenance and rewrite or omit the unsupported advice section; changing attribution alone cannot endorse its prose." });
    else if (accounted.get(ref) !== path) diagnostics.push({ ...common, code: "duplicate_reference", correction: "Remove the extra occurrence; preserve the correctly accounted occurrence." });
  });
  for (const source of sources) if (!accounted.has(source.id)) diagnostics.push({
    code: "missing_source", path: prefix + "retainedSourceRefs", reference: source.id, actualKind: source.kind,
    allowedPaths: lists.filter(list => eligibleCompositionPlacement(source, list.kind)).map(list => list.path),
    correction: "Account for this source exactly once in a matching-kind section, evidenceRefs for evidence, or retainedSourceRefs. Visible proof and primary-evidence requirements still apply."
  });
  return diagnostics;
}

// Proofs with open conditions, and sources of unresolved reconciliations, must
// be cited in the visible verification section unless validly superseded. The
// diagnostic names the editable lists so attribution repair can move the
// reference; with no verification section there is nothing to move it to.
export function proofVisibilityDiagnostics(findings: CandidateFinding[], sections: CompositionSection[], evidenceRefs: string[], presentation: CompositionPresentation, prefix = ""): AttributionDiagnostic[] {
  const lists = compositionReferenceLists(sections, evidenceRefs, presentation, prefix);
  const visibleVerification = new Set(sections.filter(section => section.kind === "verification").flatMap(section => section.sourceRefs));
  const superseded = new Set((presentation.reconciliations ?? []).filter(record => record.disposition === "superseded").flatMap(record => record.sourceRefs));
  const required = findings.filter(finding => finding.proofAssessment &&
    (finding.proofAssessment.status === "unresolved" || finding.proofAssessment.assumptions.length > 0))
    .map(finding => finding.id + "/proofAssessment");
  // Only inventory verification sources, as validateSources requires; it rejects
  // any other reconciliation reference without echoing it.
  const verificationIds = new Set(compositionSources(findings).filter(source => source.kind === "verification").map(source => source.id));
  required.push(...(presentation.reconciliations ?? []).filter(record => record.disposition === "unresolved").flatMap(record => record.sourceRefs)
    .filter(ref => verificationIds.has(ref)));
  const targets = lists.filter(list => list.kind === "verification").map(list => list.path);
  return [...new Set(required)].filter(ref => !visibleVerification.has(ref) && !superseded.has(ref)).map(ref => ({
    code: "proof_not_visible" as const,
    path: lists.flatMap(list => list.refs.flatMap((item, index) => item === ref ? [list.path + "." + index] : []))[0] ?? prefix + "retainedSourceRefs",
    reference: ref, actualKind: "verification" as const, expectedKind: "verification",
    allowedPaths: targets.length ? [...targets, prefix + "retainedSourceRefs"] : [],
    correction: targets.length
      ? "Unresolved conditions must be attributed to the visible verification section: cite this source there and remove it from retainedSourceRefs. Keep it accounted exactly once."
      : "Unresolved conditions must be attributed to a visible verification section; this composed finding has none."
  }));
}

export const MAX_PRIMARY_EVIDENCE_REFS = 3;

function validateSources(findings: CandidateFinding[], sections: CompositionSection[], evidenceRefs: string[], presentation: CompositionPresentation, prefix = "", assessmentFindings = findings) {
  const sources = compositionSources(findings, assessmentFindings);
  const byId = new Map(sources.map(source => [source.id, source]));
  const kinds = new Set<string>();
  // Name only inventory IDs; other references are model text and stay out of errors.
  const shown = (ref: string) => byId.has(ref) ? ref : "an unknown reference";
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
  if (primary.length > MAX_PRIMARY_EVIDENCE_REFS || new Set(primary).size !== primary.length) errors.push("Select up to three distinct primary evidence references.");
  for (const ref of primary) if (!evidenceRefs.includes(ref)) errors.push("Primary evidence must be an accounted evidence reference: " + shown(ref));
  if (sources.some(source => source.kind === "evidence") && !primary.length) errors.push("Select at least one decisive primary evidence reference.");
  const reconciled = new Set<string>();
  for (const record of presentation.reconciliations ?? []) {
    if (!record.sourceRefs.length || !record.rationale.trim()) errors.push("Reconciliation needs affected sources and a rationale.");
    for (const ref of record.sourceRefs) {
      if (byId.get(ref)?.kind !== "verification" || reconciled.has(ref)) errors.push("Invalid or repeated reconciliation source: " + shown(ref));
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
      if (!byId.has(ref) || record.sourceRefs.includes(ref)) errors.push("Invalid independent reconciliation support: " + shown(ref));
    }
  }
  errors.push(...proofVisibilityDiagnostics(findings, sections, evidenceRefs, presentation, prefix).map(issue => JSON.stringify(issue)));
  if (completion.length || errors.length) throw new Error([...completion.map(issue => JSON.stringify(issue)), ...errors.slice(0, 20)].join("; ") + " Use only supplied source IDs in their matching kinds; absent optional fields have no source. Account for all supplied components without inventing source data.");
  return { sources, byId, primary };
}

function renderEvidence(source: CompositionSource, link?: (path: string, line?: number) => string | undefined, anchor?: CandidateFinding["anchor"]): string {
  const url = source.path && anchor?.side !== "LEFT" ? link?.(source.path, anchor?.line) : undefined;
  const label = anchor === undefined ? source.path ?? "" : `${source.path}:${anchor.line}${anchor.side === "LEFT" ? " (base)" : ""}`;
  const location = inlineCode(label) + (url ? " ([source](" + url + "))" : "");
  const content = /^\d+(?:\s*[-–,:]\s*\d+)*$/u.test(source.text)
    ? "Lines " + source.text : codeBlock(source.text, fenceLanguageForPath(source.path ?? ""));
  return location + "\n" + content + (source.explanation ? "\n" + safeReportProse(source.explanation) : "");
}

export function composePresentation(
  findings: CandidateFinding[],
  sections: CompositionSection[],
  evidenceRefs: string[],
  link?: (path: string, line?: number) => string | undefined,
  presentation: CompositionPresentation = {},
  assessmentFindings = findings,
  {
    unreconciledSuggestionKinds = [],
    normalizeRecordedVerification = text => text,
    showChangedAnchorLines = false
  }: {
    unreconciledSuggestionKinds?: ReadonlyArray<"fix" | "test">;
    normalizeRecordedVerification?: (text: string) => string;
    showChangedAnchorLines?: boolean;
  } = {}
) {
  const { sources, byId, primary } = validateSources(findings, sections, evidenceRefs, presentation, "", assessmentFindings);
  const labels = { impact: "Impact", verification: "Verification and uncertainty", fix: "Suggested fix", test: "Suggested test" };
  const prose = sections.map(section => "**" + labels[section.kind] + ":** " + safeReportProse(section.text));
  for (const [kind, label] of [["fix", "Remediation"], ["test", "Regression-test guidance"]] as const) {
    const proposals = sources.filter(source => source.kind === kind && !source.provenanceOnly);
    if (proposals.length && !proposals.some(source => eligibleCompositionSource(source, kind))) {
      prose.push(label + " remains unverified.");
    } else if (unreconciledSuggestionKinds.includes(kind)) {
      prose.push(label + " remains unreconciled because multiple supported proposals differ.");
    }
  }
  const superseded = new Set((presentation.reconciliations ?? [])
    .filter(record => record.disposition === "superseded").flatMap(record => record.sourceRefs));
  const unresolvedReconciliations = (presentation.reconciliations ?? []).filter(record => record.disposition === "unresolved");
  const unresolved = new Set(unresolvedReconciliations.flatMap(record => record.sourceRefs));
  const assumptions = new Map<string, boolean>();
  const proofConditions: string[] = [];
  const disputedProofEvidence: string[] = [];
  for (const { id, proofAssessment: proof } of findings) {
    const ref = id + "/proofAssessment";
    if (!proof || superseded.has(ref)) continue;
    if (proof.status === "unresolved") proofConditions.push(proof.evidence);
    else if (unresolved.has(ref)) disputedProofEvidence.push(proof.evidence);
    for (const { question, essential } of proof.assumptions) {
      assumptions.set(question, essential || assumptions.get(question) === true);
    }
  }
  const concerns = [...new Set([
    ...unresolvedReconciliations.map(record => record.rationale.trim()),
    ...proofConditions,
    ...[...assumptions].map(([question, essential]) => (essential ? "Essential assumption: " : "Secondary assumption: ") + question)
  ])];
  const uncertaintyBody = concerns.length ? "**Open conditions:**\n\n" + concerns.map(text => "- " + safeReportProse(text)).join("\n") : "";
  // Legacy verification has no structured assumptions. Keep its recorded
  // wording, and the wording of any explicitly unresolved reconciliation.
  const verification = sections.find(section => section.kind === "verification")?.text.trim() ?? "";
  // A substring match can hide a caveat that was quoted inside a different claim.
  const verificationBlock = `\n\n${verification}\n\n`;
  const recordedVerification = [...new Set([
    ...disputedProofEvidence,
    ...findings.flatMap(finding => {
      const ref = finding.id + "/verification";
      const text = finding.verification;
      if (!text || superseded.has(ref)) return [];
      return !finding.proofAssessment || unresolved.has(ref) ? [text] : [];
    })
  ].map(text => normalizeRecordedVerification(text).trim())
    .filter(text => text.length > 0 && !verificationBlock.includes(`\n\n${text}\n\n`)))];
  const recordedBody = recordedVerification.length ? "**Recorded verification:**\n\n" + recordedVerification.map(safeReportProse).join("\n\n") : "";
  const evidenceBody = primary.map(ref => {
    const source = byId.get(ref)!;
    const anchor = showChangedAnchorLines && ref === source.findingId + "/evidence/changedCode"
      ? findings.find(finding => finding.id === source.findingId)?.anchor : undefined;
    return renderEvidence(source, link, anchor);
  }).join("\n\n");
  prose.push("**Evidence:**\n\n" + evidenceBody);

  const body = [uncertaintyBody, recordedBody, ...prose].filter(Boolean).join("\n\n");
  return { body, metrics: {
    narrativeWords: sections.reduce((count, section) => count + section.text.trim().split(/\s+/u).length, 0),
    primaryWords: body.trim().split(/\s+/u).length,
    // Keep this measurement comparable with artifacts from older versions.
    provenanceWords: 0,
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
    for (const [item, id] of group.findingIds.entries()) {
      if (!known.has(id) || used.has(id)) errors.push("Unknown or repeated finding ID: " + (known.has(id) ? id : `composedFindings.${index}.findingIds.${item}`) + ". Use each supplied finding exactly once.");
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

export function renderRetainedComposition(findings: CandidateFinding[], link?: (path: string, line?: number) => string | undefined, normalizeProse: (text: string) => string = text => text, onMetrics?: (metrics: CompositionMetrics) => void, assessmentFindings = findings, showChangedAnchorLines = false): string {
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
    }
    if (kind === "verification" && conflictingSuggestions(assessmentFindings).size) renderedTexts.push("Compatibility assessments conflict for an identical proposal. The disputed recommendation remains unverified.");
    sections.push({ kind, sourceRefs: equivalent.map(source => source.id), text: renderedTexts.join("\n\n") });
    retainedSourceRefs.push(...matching.filter(source => !equivalent.includes(source)).map(source => source.id));
  }
  const presentation: CompositionPresentation = {
    retainedSourceRefs,
    ...(showChangedAnchorLines ? { primaryEvidenceRefs: findings.map(finding => finding.id + "/evidence/changedCode") } : {})
  };
  const rendered = composePresentation(findings, sections, sources.filter(source => source.kind === "evidence").map(source => source.id), link, presentation, assessmentFindings, {
    unreconciledSuggestionKinds,
    normalizeRecordedVerification: normalizeProse,
    showChangedAnchorLines
  });
  onMetrics?.(rendered.metrics);
  return "Source-based presentation because synthesis was unavailable.\n\n" + rendered.body;
}
