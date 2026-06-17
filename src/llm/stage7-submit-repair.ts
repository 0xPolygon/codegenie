import { fenceUntrusted } from "../skills/prompt-builder.js";
import type { LlmSchemaRepairInput, LlmStructuredRequest, PiToolCall } from "./llm-runner.js";

export type Stage7SubmitRepairDecision = {
  classification: Stage7SchemaInvalidKind;
  compactRepair?: boolean;
  cleanupKind?: "no_findings_shape" | "candidate_payload";
  recovered?: Record<string, unknown>;
  strippedKeys?: string[];
  rejectReason?: string;
};

export type Stage7SchemaInvalidKind =
  | "xml_parameter_bleed"
  | "extra_finding_properties"
  | "extra_top_level_properties"
  | "missing_required_finding_fields"
  | "invalid_enum_value"
  | "string_too_long"
  | "empty_no_findings_missing_fields"
  | "unsafe_candidate_like_payload"
  | "invalid_tool_arguments";

type Stage7CandidateCleanup =
  | { status: "not_applicable" }
  | { status: "recovered"; arguments: Record<string, unknown>; strippedKeys: string[] }
  | { status: "rejected"; reason: string; strippedKeys: string[] };

const STAGE7_SUBMIT_ALLOWED_KEYS = new Set([
  "reviewStatus",
  "findings",
  "followUpHints",
  "uncertainties",
  "noFindingReason",
  "unresolvedQuestions"
]);

const STAGE7_FINDING_ALLOWED_KEYS = new Set([
  "title",
  "severity",
  "confidence",
  "path",
  "anchor",
  "category",
  "evidence",
  "failureMode",
  "whyThisMatters",
  "suggestedFix",
  "suggestedTest",
  "verification",
  "behaviorChange",
  "intentEvidence"
]);

const STAGE7_SEVERITY_VALUES = new Set(["critical", "high", "medium", "low"]);
const STAGE7_CONFIDENCE_VALUES = new Set(["high", "medium", "low"]);
const STAGE7_CATEGORY_VALUES = new Set([
  "logic_bug",
  "correctness",
  "security",
  "performance",
  "architecture",
  "testing",
  "maintainability"
]);

export function stage7SubmitRepairDecision(
  request: LlmStructuredRequest<unknown>,
  submitCall: PiToolCall,
  cause: unknown,
  candidateDraftedBeforeSubmit: boolean
): Stage7SubmitRepairDecision | undefined {
  if (request.stage !== 7 || submitCall.name !== "submit_review") {
    return undefined;
  }
  const classification = classifyStage7SchemaInvalid(cause instanceof Error ? cause.message : String(cause), [submitCall]);
  if (stage7PayloadLooksCandidateLike(submitCall.arguments)) {
    const cleanup = cleanupStage7CandidateSubmit(submitCall.arguments);
    if (cleanup.status === "recovered") {
      return {
        classification,
        cleanupKind: "candidate_payload",
        recovered: cleanup.arguments,
        strippedKeys: cleanup.strippedKeys
      };
    }
    if (cleanup.status === "rejected") {
      return {
        classification,
        cleanupKind: "candidate_payload",
        compactRepair: true,
        strippedKeys: cleanup.strippedKeys,
        rejectReason: cleanup.reason
      };
    }
    return { classification, compactRepair: true };
  }
  if (candidateDraftedBeforeSubmit) {
    return { classification: "unsafe_candidate_like_payload", compactRepair: true };
  }
  if (!isSafeStage7NoFindingsSalvage(submitCall.arguments)) {
    return { classification };
  }
  return {
    classification,
    cleanupKind: "no_findings_shape",
    recovered: {
      reviewStatus: "no_findings",
      findings: [],
      followUpHints: [],
      uncertainties: [],
      noFindingReason: cleanStage7NoFindingReason(submitCall.arguments.noFindingReason)
    }
  };
}

export function classifyStage7SchemaInvalid(error: string, submitCalls: PiToolCall[]): Stage7SchemaInvalidKind {
  const text = `${error}\n${submitCalls.map((call) => safeStringify(call.arguments)).join("\n")}`.toLowerCase();
  if (/<\/?\s*parameter\b/u.test(text) || /&lt;\/?\s*parameter\b/u.test(text)) {
    return "xml_parameter_bleed";
  }
  if (submitCalls.some((call) => stage7PayloadLooksCandidateLike(call.arguments))) {
    if (submitCalls.some((call) => extraStage7TopLevelKeys(call.arguments).length > 0)) {
      return "extra_top_level_properties";
    }
    if (submitCalls.some((call) => extraStage7FindingKeys(call.arguments).length > 0)) {
      return "extra_finding_properties";
    }
    if (submitCalls.some((call) => hasInvalidStage7FindingEnum(call.arguments))) {
      return "invalid_enum_value";
    }
    if (/\b(required|missing)\b/u.test(text)) {
      return "missing_required_finding_fields";
    }
    if (/\b(enum|literal|union|allowed value|one of|expected.*(?:critical|high|medium|low|logic_bug|correctness|security|performance|architecture|testing|maintainability))\b/u.test(text)) {
      return "invalid_enum_value";
    }
    if (/\b(maxlength|max length|too long|more than|greater than|at most)\b/u.test(text)) {
      return "string_too_long";
    }
    return "unsafe_candidate_like_payload";
  }
  if (/\b(maxlength|max length|too long|more than|greater than|at most)\b/u.test(text)) {
    return "string_too_long";
  }
  if (submitCalls.some((call) => call.arguments.reviewStatus === "no_findings")) {
    return "empty_no_findings_missing_fields";
  }
  return "invalid_tool_arguments";
}

export function stage7CompactSchemaRepairPrompt(
  submitToolName: string,
  error: string,
  classification: Stage7SchemaInvalidKind,
  repairInput: LlmSchemaRepairInput
): string {
  const invalidSubmitArgs = repairInput.submitCalls.map((call) => ({
    id: call.id,
    arguments: call.arguments
  }));
  return [
    "Repair only the structured Stage 7 packet-review submit payload for codeninja.",
    "",
    `Validation problem: ${error}`,
    `Classification: ${classification}`,
    "",
    "Invalid submit arguments:",
    fenceUntrusted(truncateStage7RepairPayload(stableJson(invalidSubmitArgs)), "stage7-invalid-submit-arguments"),
    "",
    "Required action:",
    `- Call \`${submitToolName}\` exactly once with schema-valid arguments.`,
    "- Preserve the substance of any submitted findings; fix only schema shape.",
    "- Do not convert a malformed finding into no_findings.",
    "- Do not invent new evidence, line numbers, severity, confidence, or categories.",
    "- If an enum value is invalid, choose the closest value only when it is directly implied by the original payload; otherwise keep the finding conservative.",
    "- Do not call repository tools or ask for more context; this is JSON repair, not code review.",
    "- Do not output XML.",
    "- Do not write `<parameter>` tags.",
    "- Do not describe the schema.",
    "- Do not answer in plain text."
  ].join("\n");
}

export function stage7SubmitPayloadKind(submitCalls: PiToolCall[]): "candidate" | "no_findings" | "unknown" {
  if (submitCalls.some((call) => stage7PayloadLooksCandidateLike(call.arguments))) {
    return "candidate";
  }
  if (submitCalls.some((call) => call.arguments.reviewStatus === "no_findings")) {
    return "no_findings";
  }
  return "unknown";
}

function cleanupStage7CandidateSubmit(args: Record<string, unknown>): Stage7CandidateCleanup {
  const findings = args.findings;
  if (!Array.isArray(findings) || findings.length === 0) {
    return { status: "not_applicable" };
  }
  const strippedKeys: string[] = [];
  const unsafeKeys: string[] = [];
  const cleaned = cloneRecord(args);

  for (const key of extraStage7TopLevelKeys(cleaned)) {
    const value = cleaned[key];
    if (!isSafeUnknownStage7SubmitField(value)) {
      unsafeKeys.push(key);
      continue;
    }
    strippedKeys.push(key);
    delete cleaned[key];
  }

  const cleanedFindings = cleaned.findings;
  if (Array.isArray(cleanedFindings)) {
    cleanedFindings.forEach((finding, index) => {
      if (!isRecord(finding)) {
        return;
      }
      for (const key of extraStage7FindingKeysForFinding(finding)) {
        const value = finding[key];
        const label = `findings.${index}.${key}`;
        if (!isSafeUnknownStage7SubmitField(value)) {
          unsafeKeys.push(label);
          continue;
        }
        strippedKeys.push(label);
        delete finding[key];
      }
    });
  }

  if (strippedKeys.length === 0 && unsafeKeys.length === 0) {
    return { status: "not_applicable" };
  }
  if (unsafeKeys.length > 0) {
    return { status: "rejected", reason: `unsafe_unknown_fields:${unsafeKeys.slice(0, 10).join(",")}`, strippedKeys };
  }
  return { status: "recovered", arguments: cleaned, strippedKeys };
}

function cloneRecord(input: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(safeStringify(input) || "{}") as Record<string, unknown>;
}

function extraStage7TopLevelKeys(args: Record<string, unknown>): string[] {
  return Object.keys(args).filter((key) => !STAGE7_SUBMIT_ALLOWED_KEYS.has(key)).sort();
}

function extraStage7FindingKeys(args: Record<string, unknown>): string[] {
  const findings = args.findings;
  if (!Array.isArray(findings)) {
    return [];
  }
  return [...new Set(findings.flatMap((finding) => isRecord(finding) ? extraStage7FindingKeysForFinding(finding) : []))].sort();
}

function extraStage7FindingKeysForFinding(finding: Record<string, unknown>): string[] {
  return Object.keys(finding).filter((key) => !STAGE7_FINDING_ALLOWED_KEYS.has(key)).sort();
}

function hasInvalidStage7FindingEnum(args: Record<string, unknown>): boolean {
  const findings = args.findings;
  if (!Array.isArray(findings)) {
    return false;
  }
  return findings.some((finding) => {
    if (!isRecord(finding)) {
      return false;
    }
    const severity = finding.severity;
    const confidence = finding.confidence;
    const category = finding.category;
    return (typeof severity === "string" && !STAGE7_SEVERITY_VALUES.has(severity)) ||
      (typeof confidence === "string" && !STAGE7_CONFIDENCE_VALUES.has(confidence)) ||
      (typeof category === "string" && !STAGE7_CATEGORY_VALUES.has(category));
  });
}

function isSafeUnknownStage7SubmitField(value: unknown): boolean {
  if (value === undefined || value === null || value === "" || value === false) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  if (isRecord(value)) {
    return Object.keys(value).length === 0;
  }
  return false;
}

function isSafeStage7NoFindingsSalvage(args: Record<string, unknown>): boolean {
  if (args.reviewStatus !== "no_findings") {
    return false;
  }
  if (stage7PayloadLooksCandidateLike(args)) {
    return false;
  }
  const findings = args.findings;
  if (findings !== undefined && (!Array.isArray(findings) || findings.length > 0)) {
    return false;
  }
  return true;
}

function stage7PayloadLooksCandidateLike(args: Record<string, unknown>): boolean {
  const findings = args.findings;
  if (Array.isArray(findings) && findings.length > 0) {
    return true;
  }
  const text = safeStringify(args).toLowerCase();
  return /"(?:title|failuremode|whythismatters|suggestedfix|suggestedtest|category|severity|confidence|evidence)"\s*:/u.test(text) ||
    /<\s*parameter\b[^>]*name=["']?(?:title|failuremode|whythismatters|suggestedfix|suggestedtest|category|severity|confidence|evidence)["']?/iu.test(text) ||
    /\bcandidate\b/u.test(text);
}

function cleanStage7NoFindingReason(value: unknown): string {
  const raw = typeof value === "string" ? value : "Reviewed the packet and found no concrete failure mode.";
  const cleaned = raw
    .replace(/<\s*\/?\s*parameter\b[^>]*>/giu, " ")
    .replace(/&lt;\s*\/?\s*parameter\b[^&]*(?:&gt;)?/giu, " ")
    .replace(/<[^>]{1,200}>/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return cleaned.slice(0, 1000) || "Reviewed the packet and found no concrete failure mode.";
}

function truncateStage7RepairPayload(input: string): string {
  const maxChars = 40_000;
  if (input.length <= maxChars) {
    return input;
  }
  return `${input.slice(0, maxChars).trimEnd()}\n[invalid submit arguments truncated by codeninja]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function safeStringify(input: unknown): string {
  try {
    return JSON.stringify(input) ?? "";
  } catch {
    return "";
  }
}

function stableJson(input: unknown): string {
  return JSON.stringify(sortJson(input));
}

function sortJson(input: unknown): unknown {
  if (Array.isArray(input)) {
    return input.map(sortJson);
  }
  if (input && typeof input === "object") {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort()) {
      output[key] = sortJson((input as Record<string, unknown>)[key]);
    }
    return output;
  }
  return input;
}
