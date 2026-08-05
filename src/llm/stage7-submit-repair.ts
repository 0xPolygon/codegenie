import { fenceUntrusted } from "../skills/prompt-builder.js";
import { truncateDiagnostic } from "../util/errors.js";
import { stableJson } from "../util/json.js";
import type {
  LlmInvalidSubmitRecovery,
  LlmSchemaInvalidSubmitRecoveryInput,
  LlmSchemaRepairInput,
  LlmStructuredRequest,
  LlmSubmitFailureClassification,
  PiToolCall
} from "./llm-runner.js";
import type { TelemetryRecorder } from "../telemetry/telemetry-recorder.js";

export type Stage7SubmitRepairDecision = {
  classification: Stage7SchemaInvalidKind;
  compactRepair?: boolean;
  cleanupKind?: "no_findings_shape" | "candidate_payload" | "no_finding_reason_truncated";
  recovered?: Record<string, unknown>;
  strippedKeys?: string[];
  cleanedFields?: string[];
  truncatedFields?: string[];
  rejectReason?: string;
  truncatedNoFindingReason?: boolean;
};

export type Stage7SchemaInvalidKind = Extract<LlmSubmitFailureClassification,
  | "xml_parameter_bleed"
  | "extra_finding_properties"
  | "extra_top_level_properties"
  | "missing_required_finding_fields"
  | "invalid_enum_value"
  | "string_too_long"
  | "empty_no_findings_missing_fields"
  | "unsafe_candidate_like_payload"
  | "invalid_tool_arguments">;

const STAGE7_SCHEMA_INVALID_KINDS: ReadonlySet<LlmSubmitFailureClassification> = new Set([
  "xml_parameter_bleed",
  "extra_finding_properties",
  "extra_top_level_properties",
  "missing_required_finding_fields",
  "invalid_enum_value",
  "string_too_long",
  "empty_no_findings_missing_fields",
  "unsafe_candidate_like_payload",
  "invalid_tool_arguments"
]);

export function isStage7SchemaInvalidKind(value: LlmSubmitFailureClassification | undefined): value is Stage7SchemaInvalidKind {
  return value !== undefined && STAGE7_SCHEMA_INVALID_KINDS.has(value);
}

type Stage7CandidateCleanup =
  | { status: "not_applicable" }
  | { status: "recovered"; arguments: Record<string, unknown>; strippedKeys: string[] }
  | { status: "rejected"; reason: string; strippedKeys: string[] };

type Stage7NoFindingsCleanup =
  | { status: "not_applicable" }
  | {
      status: "recovered";
      arguments: Record<string, unknown>;
      cleanupKind: "no_findings_shape" | "no_finding_reason_truncated";
      strippedKeys: string[];
      cleanedFields: string[];
      truncatedFields: string[];
      truncatedNoFindingReason: boolean;
    };

const STAGE7_SUBMIT_ALLOWED_KEYS = new Set([
  "reviewStatus",
  "findings",
  "followUpHints",
  "uncertainties",
  "noFindingReason"
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
const STAGE7_CANDIDATE_FIELD_NAMES = new Set([
  "title",
  "failureMode",
  "whyThisMatters",
  "suggestedFix",
  "suggestedTest",
  "category",
  "severity",
  "evidence",
  "anchor"
]);
const STAGE7_NO_FINDING_REASON_MAX_CHARS = 1000;
const STAGE7_FIELD_TRUNCATION_SUFFIX = " [truncated by codegenie]";

export function stage7SubmitRepairDecision(
  request: LlmStructuredRequest<unknown>,
  submitCall: PiToolCall,
  cause: unknown,
  candidateDraftedBeforeSubmit: boolean
): Stage7SubmitRepairDecision | undefined {
  if (request.stage !== 7) {
    return undefined;
  }
  return stage7SubmitRepairDecisionFromParts(
    submitCall,
    cause instanceof Error ? cause.message : String(cause),
    candidateDraftedBeforeSubmit
  );
}

export function stage7SubmitRepairDecisionFromParts(
  submitCall: PiToolCall,
  errorText: string,
  candidateDraftedBeforeSubmit: boolean
): Stage7SubmitRepairDecision | undefined {
  if (submitCall.name !== "submit_review") {
    return undefined;
  }
  const classification = classifyStage7SchemaInvalid(errorText, [submitCall]);
  if (!candidateDraftedBeforeSubmit) {
    const noFindingsCleanup = cleanupStage7NoFindingsSubmit(submitCall.arguments);
    if (noFindingsCleanup.status === "recovered") {
      return {
        classification,
        cleanupKind: noFindingsCleanup.cleanupKind,
        recovered: noFindingsCleanup.arguments,
        strippedKeys: noFindingsCleanup.strippedKeys,
        cleanedFields: noFindingsCleanup.cleanedFields,
        truncatedFields: noFindingsCleanup.truncatedFields,
        truncatedNoFindingReason: noFindingsCleanup.truncatedNoFindingReason
      };
    }
  }
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
  const noFindingReason = cleanStage7NoFindingReason(submitCall.arguments.noFindingReason);
  return {
    classification,
    cleanupKind: noFindingReason.truncated ? "no_finding_reason_truncated" : "no_findings_shape",
    recovered: {
      reviewStatus: "no_findings",
      findings: [],
      followUpHints: [],
      uncertainties: [],
      noFindingReason: noFindingReason.value
    },
    ...(noFindingReason.changed ? { cleanedFields: ["noFindingReason"] } : {}),
    ...(noFindingReason.truncated ? { truncatedFields: ["noFindingReason"] } : {}),
    truncatedNoFindingReason: noFindingReason.truncated
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
    "Repair only the structured Stage 7 packet-review submit payload for codegenie.",
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
        if (!isSafeUnknownStage7SubmitField(value) && !isRedundantStage7FindingField(key, value, finding)) {
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

function cleanupStage7NoFindingsSubmit(args: Record<string, unknown>): Stage7NoFindingsCleanup {
  if (!isSafeStage7NoFindingsSalvage(args)) {
    return { status: "not_applicable" };
  }
  const cleaned = cloneRecord(args);
  const strippedKeys: string[] = [];
  for (const key of extraStage7TopLevelKeys(cleaned)) {
    const value = cleaned[key];
    if (!isSafeUnknownStage7SubmitField(value)) {
      return { status: "not_applicable" };
    }
    strippedKeys.push(key);
    delete cleaned[key];
  }
  const reason = cleanStage7NoFindingReason(cleaned.noFindingReason);
  const changedReason = cleaned.noFindingReason !== reason.value;
  const cleanedFields = [
    ...(reason.changed ? ["noFindingReason"] : [])
  ];
  const truncatedFields = [
    ...(reason.truncated ? ["noFindingReason"] : [])
  ];
  const findings = Array.isArray(cleaned.findings) ? cleaned.findings : [];
  if (findings.length > 0) {
    return { status: "not_applicable" };
  }
  const recovered: Record<string, unknown> = {
    reviewStatus: "no_findings",
    findings: [],
    followUpHints: Array.isArray(cleaned.followUpHints) ? cleaned.followUpHints : [],
    uncertainties: Array.isArray(cleaned.uncertainties) ? cleaned.uncertainties : [],
    noFindingReason: reason.value
  };
  const shapeChanged =
    strippedKeys.length > 0 ||
    !Array.isArray(cleaned.findings) ||
    !Array.isArray(cleaned.followUpHints) ||
    !Array.isArray(cleaned.uncertainties);
  if (!shapeChanged && !changedReason) {
    return { status: "not_applicable" };
  }
  return {
    status: "recovered",
    arguments: recovered,
    cleanupKind: reason.truncated ? "no_finding_reason_truncated" : "no_findings_shape",
    strippedKeys,
    cleanedFields,
    truncatedFields,
    truncatedNoFindingReason: reason.truncated
  };
}

function cleanBoundedString(value: unknown, maxChars: number, suffixWhenTruncated = false): { value: string; changed: boolean; truncated: boolean } {
  if (typeof value !== "string") {
    return { value: "", changed: true, truncated: false };
  }
  const stripped = stripStage7Markup(value);
  const cleaned = stripped.replace(/\s+/gu, " ").trim();
  if (cleaned.length <= maxChars) {
    return { value: cleaned, changed: cleaned !== value, truncated: false };
  }
  if (suffixWhenTruncated && maxChars > STAGE7_FIELD_TRUNCATION_SUFFIX.length) {
    return {
      value: `${cleaned.slice(0, maxChars - STAGE7_FIELD_TRUNCATION_SUFFIX.length).trimEnd()}${STAGE7_FIELD_TRUNCATION_SUFFIX}`,
      changed: true,
      truncated: true
    };
  }
  return { value: cleaned.slice(0, maxChars).trimEnd(), changed: true, truncated: true };
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

function isRedundantStage7FindingField(key: string, value: unknown, finding: Record<string, unknown>): boolean {
  if (key === "changedLine" && typeof value === "boolean") {
    return true;
  }
  if ((key === "line" || key === "lineNumber" || key === "anchorLine" || key === "changedLineNumber") && typeof value === "number") {
    const anchor = finding.anchor;
    return isRecord(anchor) && anchor.line === value;
  }
  if (key === "hunkId" && typeof value === "string") {
    const anchor = finding.anchor;
    return isRecord(anchor) && anchor.hunkId === value;
  }
  if ((key === "file" || key === "filePath") && typeof value === "string") {
    return typeof finding.path === "string" && normalizeStage7Path(value) === normalizeStage7Path(finding.path);
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
  if (Object.keys(args).some((key) => STAGE7_CANDIDATE_FIELD_NAMES.has(key))) {
    return true;
  }
  const finding = args.finding;
  if (isRecord(finding) && Object.keys(finding).some((key) => STAGE7_CANDIDATE_FIELD_NAMES.has(key))) {
    return true;
  }
  const text = safeStringify(args).toLowerCase();
  return /<\s*parameter\b[^>]*name=["']?(?:title|failuremode|whythismatters|suggestedfix|suggestedtest|category|severity|evidence|anchor)["']?/iu.test(text);
}

function cleanStage7NoFindingReason(value: unknown): { value: string; changed: boolean; truncated: boolean } {
  const raw = typeof value === "string" ? value : "Reviewed the packet and found no concrete failure mode.";
  const reason = cleanBoundedString(raw, STAGE7_NO_FINDING_REASON_MAX_CHARS, true);
  const fallback = "Reviewed the packet and found no concrete failure mode.";
  return { value: reason.value || fallback, changed: reason.changed || reason.value.length === 0, truncated: reason.truncated };
}

function stripStage7Markup(value: string): string {
  return value
    .replace(/<\s*\/?\s*parameter\b[^>]*>/giu, " ")
    .replace(/&lt;\s*\/?\s*parameter\b[^&]*(?:&gt;)?/giu, " ")
    .replace(/<\s*\/?\s*(?:answer|evidencetrace|nofindingreason|findings|followuphints|uncertainties|answeredquestions|unresolvedquestions)\b[^>]*>/giu, " ");
}

function normalizeStage7Path(value: string): string {
  return value.trim().replace(/\\/gu, "/");
}

function truncateStage7RepairPayload(input: string): string {
  const maxChars = 40_000;
  if (input.length <= maxChars) {
    return input;
  }
  return `${input.slice(0, maxChars).trimEnd()}\n[invalid submit arguments truncated by codegenie]`;
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

// Plan 95: the stage-7 cleanup engine expressed as the shared
// recoverInvalidSubmit seam. Behavior and telemetry are byte-compatible with
// the former pi-runner inline block: same event names, payload fields, and
// ordering (repair_attempted -> cleanup_attempted -> [runner revalidates] ->
// cleanup_recovered/no_finding_reason_truncated/repair_recovered on success,
// cleanup_rejected on failure). The runner owns revalidation and invokes the
// outcome callbacks; the repair hints steer the model-repair queue when
// deterministic recovery declines.
export function stage7RecoverInvalidSubmit(
  input: LlmSchemaInvalidSubmitRecoveryInput,
  telemetry: TelemetryRecorder,
  context: { workerId?: string; packetId?: string }
): LlmInvalidSubmitRecovery | undefined {
  const submit = input.submitCalls[0];
  if (input.stage !== 7 || input.submitTool !== "submit_review" || submit === undefined) {
    return undefined;
  }
  const submitCall: PiToolCall = { type: "toolCall", id: submit.id, name: input.submitTool, arguments: submit.arguments };
  const decision = stage7SubmitRepairDecisionFromParts(
    submitCall,
    input.fullError ?? input.error,
    input.candidateDrafted === true
  );
  if (decision === undefined) {
    return undefined;
  }
  const event = (level: "info" | "warn", message: string, data: Record<string, unknown>): void => {
    telemetry.event(definedEventRecord({
      stage: 7,
      level,
      message,
      workerId: context.workerId,
      packetId: context.packetId,
      data: definedEventRecord(data)
    }) as Parameters<TelemetryRecorder["event"]>[0]);
  };
  const cleanupData = (submitTool: string | undefined): Record<string, unknown> => definedEventRecord({
    submitTool,
    cleanupKind: decision.cleanupKind,
    classification: decision.classification,
    strippedKeys: decision.strippedKeys,
    cleanedFields: decision.cleanedFields,
    truncatedFields: decision.truncatedFields,
    rejectReason: decision.rejectReason
  });
  event("warn", "stage7_schema_repair_attempted", {
    submitTool: input.submitTool,
    invalidSubmitCallCount: input.submitCalls.length,
    originalCallIds: input.submitCalls.map((call) => call.id),
    extraToolNames: input.extraToolNames,
    payloadKind: stage7SubmitPayloadKind([submitCall]),
    classification: decision.classification,
    error: truncateDiagnostic(input.fullError ?? input.error)
  });
  const hints: LlmInvalidSubmitRecovery = {
    kind: "recovery",
    repairClassification: decision.classification,
    ...(decision.compactRepair === true ? { replaceConversationOverride: true } : {})
  };
  if (decision.recovered !== undefined) {
    event("info", "stage7_schema_cleanup_attempted", cleanupData(input.submitTool));
    const recoveredCallId = `${submit.id || input.submitTool}-stage7-recovered`;
    return {
      ...hints,
      arguments: decision.recovered,
      recoveredCallId,
      onRecovered: (callId) => {
        event("info", "stage7_schema_cleanup_recovered", { ...cleanupData(undefined), recoveredCallId: callId });
        if (decision.truncatedNoFindingReason) {
          event("info", "stage7_no_finding_reason_truncated", {
            cleanupKind: decision.cleanupKind,
            classification: decision.classification,
            cleanedFields: decision.cleanedFields,
            truncatedFields: decision.truncatedFields,
            recoveredCallId: callId
          });
        }
        event("info", "stage7_schema_repair_recovered", { classification: decision.classification });
      },
      onRejected: (error) => {
        event("warn", "stage7_schema_cleanup_rejected", { ...cleanupData(input.submitTool), error });
      }
    };
  }
  if (decision.cleanupKind !== undefined) {
    event("info", "stage7_schema_cleanup_attempted", cleanupData(input.submitTool));
    event("warn", "stage7_schema_cleanup_rejected", {
      ...cleanupData(input.submitTool),
      error: truncateDiagnostic(input.fullError ?? input.error)
    });
  }
  return hints;
}

function definedEventRecord<T extends Record<string, unknown>>(input: T): T {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) {
      output[key] = value;
    }
  }
  return output as T;
}
