import type { TSchema } from "@earendil-works/pi-ai";
import type { ReviewStage } from "../types.js";
import type { LlmRole, LlmSubmitFailureClassification } from "./llm-runner.js";
import {
  SubmitCompositionSchema,
  SubmitPacketReviewSchema,
  SubmitPlanSchema,
  SubmitSystemReviewSchema,
  SubmitVerificationVerdictSchema
} from "./schemas.js";

export type StructuredSubmitFailureRule =
  | "required"
  | "additionalProperties"
  | "type"
  | "minLength"
  | "maxLength"
  | "minItems"
  | "maxItems"
  | "enum"
  | "const"
  | "semantic"
  | "schema";

export type StructuredSubmitFailureDiagnostic = {
  schemaVersion: 1;
  stage: ReviewStage;
  role: LlmRole;
  submitTool: string;
  submitSchemaVersion: number;
  attempt: "primary" | "repair";
  classification: LlmSubmitFailureClassification;
  issues: Array<{
    path: string;
    rule: StructuredSubmitFailureRule;
    expectedLimit?: number;
  }>;
};

const RECEIVED_ARGUMENTS_DELIMITER = "\n\nReceived arguments:\n";
const MAX_ISSUES = 12;
const MAX_PATH_CHARS = 200;
const MAX_LABEL_CHARS = 64;

const CLASSIFICATIONS: ReadonlySet<LlmSubmitFailureClassification> = new Set([
  "schema_invalid",
  "missing_submit",
  "multiple_submits",
  "revise_without_revision_payload",
  "length_stopped",
  "final_arguments_partial",
  "final_arguments_invalid",
  "event_capture_missing",
  "event_final_mismatch",
  "xml_parameter_bleed",
  "extra_finding_properties",
  "extra_top_level_properties",
  "missing_required_finding_fields",
  "invalid_enum_value",
  "string_too_long",
  "empty_no_findings_missing_fields",
  "unsafe_candidate_like_payload",
  "invalid_tool_arguments",
  "unknown"
]);
const RULES: ReadonlySet<StructuredSubmitFailureRule> = new Set([
  "required",
  "additionalProperties",
  "type",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "enum",
  "const",
  "semantic",
  "schema"
]);
const PUBLIC_SUBMITS: Readonly<Record<string, { schema: TSchema; stage: ReviewStage; role: LlmRole }>> = {
  submit_plan: { schema: SubmitPlanSchema, stage: 5, role: "planner" },
  submit_review: { schema: SubmitPacketReviewSchema, stage: 7, role: "packetReview" },
  submit_system_review: { schema: SubmitSystemReviewSchema, stage: 8, role: "systemReview" },
  submit_verdict: { schema: SubmitVerificationVerdictSchema, stage: 9, role: "verifier" },
  submit_composition: { schema: SubmitCompositionSchema, stage: 10, role: "composer" }
};
const ROLES: ReadonlySet<LlmRole> = new Set(["planner", "packetReview", "systemReview", "verifier", "composer"]);

export function normalizeStructuredSubmitFailureClassification(
  value: string | undefined
): LlmSubmitFailureClassification {
  if (value === undefined || value.length > MAX_LABEL_CHARS) {
    return "unknown";
  }
  return CLASSIFICATIONS.has(value as LlmSubmitFailureClassification)
    ? value as LlmSubmitFailureClassification
    : "unknown";
}

export function buildStructuredSubmitFailureDiagnostic(input: {
  stage: ReviewStage;
  role: LlmRole;
  submitTool: string;
  submitSchemaVersion: number;
  attempt: "primary" | "repair";
  classification?: string;
  schema: TSchema;
  validationMessage?: string;
}): StructuredSubmitFailureDiagnostic {
  const classification = normalizeStructuredSubmitFailureClassification(input.classification ?? "schema_invalid");
  return {
    schemaVersion: 1,
    stage: input.stage,
    role: input.role,
    submitTool: input.submitTool.slice(0, MAX_LABEL_CHARS),
    submitSchemaVersion: input.submitSchemaVersion,
    attempt: input.attempt,
    classification,
    issues: classification === "revise_without_revision_payload"
      ? [{ path: "root", rule: "semantic" }]
      : parseSafeValidationIssues(input.validationMessage, input.schema)
  };
}

export function structuredSubmitFailureDiagnosticFromError(
  error: unknown
): StructuredSubmitFailureDiagnostic | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }
  const context = (error as { context?: unknown }).context;
  if (!isRecord(context)) {
    return undefined;
  }
  const diagnostic = context.structuredSubmitFailure;
  return isStructuredSubmitFailureDiagnostic(diagnostic) ? sanitizePublicDiagnostic(diagnostic) : undefined;
}

function sanitizePublicDiagnostic(
  diagnostic: StructuredSubmitFailureDiagnostic
): StructuredSubmitFailureDiagnostic | undefined {
  const identity = PUBLIC_SUBMITS[diagnostic.submitTool];
  if (
    identity === undefined ||
    !ROLES.has(diagnostic.role) ||
    diagnostic.stage !== identity.stage ||
    diagnostic.role !== identity.role ||
    !Number.isSafeInteger(diagnostic.submitSchemaVersion) ||
    diagnostic.submitSchemaVersion < 0 ||
    diagnostic.submitSchemaVersion > 1_000_000
  ) {
    return undefined;
  }
  const allowedProperties = collectSchemaPropertyNames(identity.schema);
  return {
    schemaVersion: 1,
    stage: diagnostic.stage,
    role: diagnostic.role,
    submitTool: diagnostic.submitTool,
    submitSchemaVersion: diagnostic.submitSchemaVersion,
    attempt: diagnostic.attempt,
    classification: normalizeStructuredSubmitFailureClassification(diagnostic.classification),
    issues: diagnostic.issues.slice(0, MAX_ISSUES).map((issue) => {
      const rule = RULES.has(issue.rule) ? issue.rule : "schema";
      const expectedLimit = issue.expectedLimit;
      return {
        path: normalizeSchemaPath(issue.path, allowedProperties),
        rule,
        ...(expectedLimit !== undefined && Number.isSafeInteger(expectedLimit) && expectedLimit >= 0 && expectedLimit <= 1_000_000_000
          ? { expectedLimit }
          : {})
      };
    })
  };
}

export function isStructuredSubmitFailureDiagnostic(value: unknown): value is StructuredSubmitFailureDiagnostic {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.issues)) {
    return false;
  }
  return typeof value.stage === "number" &&
    typeof value.role === "string" &&
    typeof value.submitTool === "string" &&
    typeof value.submitSchemaVersion === "number" &&
    (value.attempt === "primary" || value.attempt === "repair") &&
    typeof value.classification === "string" &&
    value.issues.every((issue) => isRecord(issue) && typeof issue.path === "string" && typeof issue.rule === "string");
}

function parseSafeValidationIssues(message: string | undefined, schema: TSchema): StructuredSubmitFailureDiagnostic["issues"] {
  if (message === undefined) {
    return [];
  }
  const delimiter = message.indexOf(RECEIVED_ARGUMENTS_DELIMITER);
  if (delimiter < 0) {
    return [];
  }
  const safePrefix = message.slice(0, delimiter);
  const allowedProperties = collectSchemaPropertyNames(schema);
  const issues: StructuredSubmitFailureDiagnostic["issues"] = [];
  for (const line of safePrefix.split(/\r?\n/u)) {
    const match = /^\s*-\s+([^:]{1,400}):\s+(.{1,500})$/u.exec(line);
    if (match === null) {
      continue;
    }
    const path = normalizeSchemaPath(match[1] ?? "root", allowedProperties);
    const parsed = classifyRule(match[2] ?? "");
    issues.push({ path, rule: parsed.rule, ...(parsed.expectedLimit !== undefined ? { expectedLimit: parsed.expectedLimit } : {}) });
    if (issues.length >= MAX_ISSUES) {
      break;
    }
  }
  return issues;
}

function collectSchemaPropertyNames(schema: TSchema): Set<string> {
  const names = new Set<string>();
  const seen = new Set<object>();
  const visit = (node: unknown): void => {
    if (!isRecord(node) || seen.has(node)) {
      return;
    }
    seen.add(node);
    if (isRecord(node.properties)) {
      for (const [name, child] of Object.entries(node.properties)) {
        names.add(name);
        visit(child);
      }
    }
    if (Array.isArray(node.items)) {
      node.items.forEach(visit);
    } else {
      visit(node.items);
    }
    for (const branch of [node.anyOf, node.oneOf, node.allOf]) {
      if (Array.isArray(branch)) {
        branch.forEach(visit);
      }
    }
  };
  visit(schema);
  return names;
}

function normalizeSchemaPath(path: string, allowedProperties: ReadonlySet<string>): string {
  const normalized = path.trim().replace(/^\//u, "").replaceAll("/", ".") || "root";
  if (normalized.length > MAX_PATH_CHARS) {
    return "root";
  }
  const segments = normalized.split(".").filter(Boolean);
  if (segments.length === 0 || segments.some((segment) => segment !== "root" && !/^\d+$/u.test(segment) && !allowedProperties.has(segment))) {
    return "root";
  }
  return normalized;
}

function classifyRule(message: string): { rule: StructuredSubmitFailureRule; expectedLimit?: number } {
  const lower = message.toLowerCase();
  const expectedLimit = boundedNumber(message);
  if (/required propert|is required/u.test(lower)) return { rule: "required" };
  if (/unexpected propert|additional propert/u.test(lower)) return { rule: "additionalProperties" };
  if (/string length.*(?:greater|minimum|minlength)|(?:at least|fewer than).*characters/u.test(lower)) return withLimit("minLength", expectedLimit);
  if (/string length.*(?:less|maximum|maxlength)|(?:more than|at most).*characters|too long/u.test(lower)) return withLimit("maxLength", expectedLimit);
  if (/array length.*(?:greater|minimum|minitems)|(?:at least|fewer than).*items/u.test(lower)) return withLimit("minItems", expectedLimit);
  if (/array length.*(?:less|maximum|maxitems)|(?:more than|at most).*items/u.test(lower)) return withLimit("maxItems", expectedLimit);
  if (/literal|const/u.test(lower)) return { rule: "const" };
  if (/union|enum|allowed value|one of/u.test(lower)) return { rule: "enum" };
  if (/expected/u.test(lower)) return { rule: "type" };
  return { rule: "schema" };
}

function withLimit(
  rule: Extract<StructuredSubmitFailureRule, "minLength" | "maxLength" | "minItems" | "maxItems">,
  expectedLimit: number | undefined
): { rule: StructuredSubmitFailureRule; expectedLimit?: number } {
  return { rule, ...(expectedLimit !== undefined ? { expectedLimit } : {}) };
}

function boundedNumber(message: string): number | undefined {
  const values = [...message.matchAll(/\b(\d{1,9})\b/gu)]
    .map((match) => Number(match[1]))
    .filter((value) => Number.isSafeInteger(value) && value >= 0);
  return values.length > 0 ? values[values.length - 1] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
