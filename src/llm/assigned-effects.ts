import { isDeepStrictEqual } from "node:util";
import { Type, type TSchema } from "typebox";
import { createFieldRepair, type FieldRepair } from "./field-repair.js";
import { AssignedEffectSchema, SubmitPacketReviewSchema, type AssignedEffect, type SubmitPacketReview } from "./schemas.js";
import { cleanupSubmitShape, focusedRepairDiagnostics, submissionIssues } from "./submit-preservation.js";

export type PacketReviewWithEffects = SubmitPacketReview & { assignedEffects?: AssignedEffect[] };

export function checkAssignedEffects(value: PacketReviewWithEffects, assigned: readonly string[]) {
  const rows = value.assignedEffects;
  const covered = new Set(Array.isArray(rows) ? rows.map(row => row.hunkId) : []);
  const uncovered = assigned.filter(id => !covered.has(id));
  const errors: string[] = [];
  if (!Array.isArray(rows)) errors.push("Include the required assignedEffects array.");
  else {
    for (const [index, row] of rows.entries()) {
      if (!assigned.includes(row.hunkId)) errors.push(`assignedEffects.${index}.hunkId must name an assigned hunk.`);
      if (row.kind === "none" && row.disposition !== "safe") errors.push(`assignedEffects.${index} uses kind none, which requires disposition safe.`);
    }
    if (value.reviewStatus !== "incomplete" && uncovered.length > 0) {
      errors.push(`Missing assignedEffects for hunks ${uncovered.join(", ")}.`);
    }
  }
  return { uncovered, errors };
}

export function createAssignedEffectsFieldRepair(schema: TSchema, original: unknown, assigned: readonly string[]): FieldRepair | undefined {
  const cleaned = cleanupSubmitShape(schema, original);
  if (cleaned.unusablePaths.length || !cleaned.arguments || typeof cleaned.arguments !== "object" || Array.isArray(cleaned.arguments)) return;
  const baseline = cleaned.arguments as Record<string, unknown>;
  const { assignedEffects: rows, ...legacy } = baseline;
  const effectsSchema = (schema as { properties: { assignedEffects: TSchema } }).properties.assignedEffects;
  const validRows = Array.isArray(rows) ? rows.filter((row): row is AssignedEffect =>
    submissionIssues(AssignedEffectSchema, row).length === 0 && assigned.includes(row.hunkId)
    && (row.kind !== "none" || row.disposition === "safe")) : [];
  const ensureEffectsPreserved = (result: Record<string, unknown>) => {
    const next = result.assignedEffects;
    let retained = 0;
    if (Array.isArray(next)) for (const row of next) {
      if (retained < validRows.length && isDeepStrictEqual(row, validRows[retained])) retained++;
    }
    if (retained !== validRows.length) throw new Error("Repair must preserve the valid original assignedEffects rows in order.");
    return result;
  };
  const structurallyValid = submissionIssues(effectsSchema, rows).length === 0;
  const effectErrors = structurallyValid
    ? checkAssignedEffects(baseline as PacketReviewWithEffects, assigned).errors : [];
  if ((!structurallyValid || effectErrors.length > 0)
    && submissionIssues(SubmitPacketReviewSchema, legacy).length === 0
    && (legacy.reviewStatus !== "findings" || (legacy.findings as unknown[]).length > 0)
    && (legacy.reviewStatus !== "no_findings" || (legacy.findings as unknown[]).length === 0)) {
    const repairSchema = Type.Object({ assignedEffects: effectsSchema }, { additionalProperties: false });
    return {
      schema: repairSchema,
      paths: ["assignedEffects"],
      baseline,
      diagnostics: focusedRepairDiagnostics(schema, original),
      replaceConversation: false,
      prompt: [
        "Repair only assignedEffects with a complete replacement array. Keep every valid existing row in order and add or correct only the required rows.",
        "Use only assigned hunk IDs. Use none only with safe. Use question for an unresolved effect. For an incomplete review, report the hunks you evaluated.",
        "Keep the submitted findings, hints and uncertainties unchanged. Do not call repository tools.",
        ...effectErrors,
        `Assigned hunks: ${assigned.join(", ")}.`
      ].join("\n"),
      merge(values) {
        if (submissionIssues(repairSchema, values).length) throw new Error("Invalid assignedEffects repair.");
        return ensureEffectsPreserved({ ...baseline, assignedEffects: values.assignedEffects });
      }
    };
  }
  const repair = createFieldRepair(schema, original, true);
  return repair && { ...repair, replaceConversation: false, merge(values) {
    const result = repair.merge(values);
    for (const key of ["findings", "followUpHints", "uncertainties"] as const) {
      if (submissionIssues(SubmitPacketReviewSchema.properties[key], baseline[key]).length === 0
        && !isDeepStrictEqual(result[key], baseline[key])) {
        throw new Error(`Repair must preserve the valid original ${key}.`);
      }
    }
    return ensureEffectsPreserved(result);
  } };
}
