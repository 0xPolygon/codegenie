import { Type, type TSchema } from "@earendil-works/pi-ai";
import type { SubmitCompositionSchema } from "../llm/schemas.js";
import type { FieldRepair } from "../llm/field-repair.js";
import { focusedRepairDiagnostics, submissionIssues } from "../llm/submit-preservation.js";
import type { CandidateFinding } from "../types.js";
import { fenceUntrusted } from "../skills/prompt-builder.js";
import { eligibleCompositionSource, compositionCompletionDiagnostics, compositionAttributionDiagnostics, compositionReferenceLists, compositionSources, validateCompositionSubmission, type CompositionPresentation, type CompositionSection } from "./composition-content.js";

type Group = CompositionPresentation & { findingIds: string[]; sections: CompositionSection[]; evidenceRefs: string[] };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string");
function groups(value: unknown): Group[] | undefined {
  if (!object(value) || !Array.isArray(value.composedFindings)) return;
  if (!value.composedFindings.every(group => object(group) && strings(group.findingIds) && strings(group.evidenceRefs)
    && (group.retainedSourceRefs === undefined || strings(group.retainedSourceRefs)) && Array.isArray(group.sections)
    && group.sections.every(section => object(section) && typeof section.kind === "string" && typeof section.text === "string" && strings(section.sourceRefs)))) return;
  return value.composedFindings as Group[];
}

// Pure bookkeeping: remove redundant occurrences and retain omitted sources
// belonging to explicitly, uniquely assigned findings. Never infer prose links.
export function normalizeCompositionReferences(value: unknown, findings: CandidateFinding[]) {
  const draft = structuredClone(value);
  const entries = groups(draft);
  if (!entries) return;
  const removedFields: string[] = [];
  const addedFields: string[] = [];
  const assignments = entries.flatMap(group => group.findingIds);
  const unambiguous = assignments.length === new Set(assignments).size
    && assignments.every(id => findings.some(finding => finding.id === id));
  entries.forEach((group, index) => {
    const sources = compositionSources(findings.filter(finding => group.findingIds.includes(finding.id)), findings);
    const byId = new Map(sources.map(source => [source.id, source]));
    const lists = compositionReferenceLists(group.sections, group.evidenceRefs, group, `composedFindings.${index}.`);
    for (const list of lists) {
      const seen = new Set<string>();
      const kept = list.refs.filter((ref, item) => {
        const source = byId.get(ref);
        if (!source) return true;
        const redundant = seen.has(ref) || (list.kind !== undefined && source.kind !== list.kind
          && lists.some(other => other !== list && (other.kind === source.kind || other.kind === undefined) && other.refs.includes(ref)));
        seen.add(ref);
        if (redundant) removedFields.push(`${list.path}.${item}`);
        return !redundant;
      });
      list.refs.splice(0, list.refs.length, ...kept);
    }
    if (unambiguous) {
      // A misplaced occurrence still needs repair; do not duplicate it into
      // provenance to conceal an invalid reference or a missing visible proof.
      const referenced = new Set(entries.flatMap(entry => compositionReferenceLists(entry.sections, entry.evidenceRefs, entry)
        .flatMap(list => list.refs)));
      for (const source of sources) {
        if (referenced.has(source.id)) continue;
        group.retainedSourceRefs ??= [];
        addedFields.push(`composedFindings.${index}.retainedSourceRefs.${group.retainedSourceRefs.length}`);
        group.retainedSourceRefs.push(source.id);
        referenced.add(source.id);
      }
    }
  });
  return removedFields.length || addedFields.length ? { value: draft, removedFields, addedFields,
    reason: "Removed redundant references and retained omitted sources under their explicit finding ownership without changing prose. Full validation is still required." } : undefined;
}

// Literal path patches replace reference lists. Unsupported recommendation
// prose additionally permits replacing advice sections, with diagnosis locked.
export function createCompositionAttributionRepair(schema: TSchema, original: unknown, findings: CandidateFinding[]): FieldRepair | undefined {
  const entries = groups(original);
  if (!entries || !object(original)) return;
  // Attribution/advice repair locks diagnosis prose. Use general sparse repair
  // when that prose itself needs completion, including mixed failures.
  if (entries.some(group => compositionCompletionDiagnostics(group.sections).length)) return;
  // Missing prose/containers and unrelated schema errors need the normal repair.
  if (submissionIssues(schema, original).some(issue => !/\.(sourceRefs|evidenceRefs|retainedSourceRefs)(\.\d+)?$/u.test(issue.path))) return;
  const contexts = entries.map((group, index) => {
    const sources = compositionSources(findings.filter(finding => group.findingIds.includes(finding.id)), findings);
    const prefix = `composedFindings.${index}.`;
    const needsAdviceRepair = group.sections.some(section => (section.kind === "fix" || section.kind === "test")
      && !sources.some(source => eligibleCompositionSource(source, section.kind)));
    return { group, sources, needsAdviceRepair, lists: compositionReferenceLists(group.sections, group.evidenceRefs, group, prefix),
      diagnostics: compositionAttributionDiagnostics(sources, group.sections, group.evidenceRefs, group, prefix) };
  }).filter(context => context.diagnostics.length || context.needsAdviceRepair);
  if (!contexts.length) return;
  const properties: Record<string, TSchema> = {};
  const adviceGroups = new Map<string, Group>();
  const contextData = contexts.map(({ group, sources, needsAdviceRepair, lists, diagnostics }) => {
    const paths = new Set(diagnostics.flatMap(issue => issue.allowedPaths ?? [issue.path.replace(/\.\d+$/u, "")]));
    if (needsAdviceRepair || diagnostics.some(issue => issue.code === "unsupported_suggestion")) {
      const sectionPath = lists[0]!.path.replace(/sections\.\d+\.sourceRefs$/u, "sections");
      adviceGroups.set(sectionPath, group);
      // Only recommendation sections may change; merge enforces diagnosis
      // preservation and the caller validates complete source accounting.
      const sectionSchema = (schema as typeof SubmitCompositionSchema).properties.composedFindings.items.properties.sections;
      properties[sectionPath] = Type.Optional(structuredClone(sectionSchema));
      paths.add(lists.find(list => list.path.endsWith("retainedSourceRefs"))!.path);
    }
    for (const list of lists.filter(list => paths.has(list.path))) {
      // Whole-section replacement and index-based edits must not coexist.
      if ([...adviceGroups.keys()].some(path => list.path.startsWith(path + "."))) continue;
      const ids = sources.filter(source => eligibleCompositionSource(source, list.kind)).map(source => source.id);
      properties[list.path] = Type.Optional(Type.Array(Type.String(ids.length ? { enum: ids } : {}), {
        ...(ids.length ? {} : { maxItems: 0 }), uniqueItems: true,
        description: "Complete replacement reference list. Remove incorrect entries; keep all correct entries. Omit this property to retain its current list."
      }));
    }
    return { findingIds: group.findingIds, diagnostics,
      primaryEvidenceRefs: group.primaryEvidenceRefs, reconciliations: group.reconciliations,
      sections: group.sections.map(({ kind, text }, index) => ({ kind, text, path: lists[index]!.path })),
      referenceLists: lists, sources };
  });
  const patchSchema = Type.Object(properties, { additionalProperties: false, minProperties: 1 });
  const paths = Object.keys(properties);
  const baseline = structuredClone(original);
  const exampleEntry = Object.entries(properties as Record<string, TSchema & { type?: string; items?: { type?: string; enum?: string[] } }>).find(([, shape]) => shape.type === "array" && shape.items?.type === "string" && shape.items.enum?.length);
  const example = exampleEntry ? { [exampleEntry[0]]: [exampleEntry[1].items!.enum![0]] } : undefined;
  return {
    schema: patchSchema, paths, baseline, diagnostics: focusedRepairDiagnostics(schema, original),
    prompt: (adviceGroups.size
      ? "Repair unsupported composition advice. Replace the permitted sections array to omit fix/test sections with no eligible supporting sources, or rewrite advice using only supported current suggestions. Keep every impact/verification section's kind, text and order unchanged; correct their sourceRefs as needed, including placing proof assessments in visible verification. An empty sourceRefs list cannot support a section. Do not strengthen or combine assessed proposals. Replace retainedSourceRefs to retain every omitted proposal; no finding or evidence may be lost. Only the literal path keys in this tool schema are accepted. No repository tools. Full schema and source accounting validation follows.\n"
      : "Repair composition source attribution. Call submit_composition exactly once with only the literal field-path keys permitted by the tool schema. Each supplied string array REPLACES that entire reference list: remove incorrect entries and retain correct ones. Omitted lists remain unchanged. You may remove reference entries, but must not delete or reorder findings or sections, change prose, or invent source IDs. Each supplied source must remain accounted for exactly once in its matching section, evidenceRefs, or retainedSourceRefs. Primary evidence and visible proof requirements still apply. This is an attribution correction, not a request for missing prose. Do not call repository tools. The complete assembled submission will undergo schema and semantic validation.\n")
      + fenceUntrusted(JSON.stringify(contextData), "attribution-repair-context")
      + (example ? "\nSyntax example only; not a complete attribution solution. Dotted keys are literal JSON property names, arrays are JSON arrays (not strings). Omitted update keys retain their current values.\n"
        + fenceUntrusted(JSON.stringify(example), "patch-format-example") : ""),
    replaceConversation: true,
    merge(values) {
      if (submissionIssues(patchSchema, values).length || !Object.keys(values).length || Object.keys(values).some(key => !paths.includes(key))) throw new Error("Invalid attribution patch");
      const result = structuredClone(baseline);
      for (const [path, refs] of Object.entries(values)) {
        const adviceGroup = adviceGroups.get(path);
        if (adviceGroup) {
          const diagnosis = (sections: CompositionSection[]) => sections.filter(section => section.kind !== "fix" && section.kind !== "test")
            .map(({ kind, text }) => ({ kind, text }));
          if (JSON.stringify(diagnosis(refs as CompositionSection[])) !== JSON.stringify(diagnosis(adviceGroup.sections))) {
            throw new Error("Advice repair must preserve impact and verification sections");
          }
        } else if (!strings(refs)) throw new Error("Attribution updates must be reference lists");
        const parts = path.split(".");
        const key = parts.pop()!;
        let parent: unknown = result;
        for (const part of parts) parent = (parent as Record<string, unknown>)[part];
        (parent as Record<string, unknown>)[key] = structuredClone(refs);
      }
      if (adviceGroups.size) {
        // Accept section replacements atomically. Generic recovery progress
        // merges object arrays by index and would otherwise restore removed
        // sections after a partially valid advice patch.
        if (submissionIssues(schema, result).length) throw new Error("Advice repair must produce a schema-valid submission");
        validateCompositionSubmission(result as unknown as { composedFindings: Group[] }, findings);
      }
      return result;
    }
  };
}
