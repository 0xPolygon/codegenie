import { StringEnum, Type, type Static } from "@earendil-works/pi-ai";
import type { ReviewStage } from "../types.js";

const SeveritySchema = StringEnum(["critical", "high", "medium", "low"] as const);

const ConfidenceSchema = StringEnum(["high", "medium", "low"] as const);

const CoverageSchema = StringEnum(["deep", "normal", "light", "skip"] as const);

const FindingCategorySchema = StringEnum(["logic_bug", "correctness", "security", "performance", "architecture", "testing", "maintainability"] as const);

const BehaviorChangeAssessmentSchema = StringEnum(["accidental_regression", "intentional_needs_confirmation", "specified_change", "unknown"] as const);

export const DiffAnchorSchema = Type.Object(
  {
    path: Type.String({ minLength: 1, maxLength: 500 }),
    line: Type.Integer({ minimum: 1 }),
    side: StringEnum(["RIGHT", "LEFT"] as const),
    hunkId: Type.String({ minLength: 1, maxLength: 200 }),
    startLine: Type.Optional(Type.Integer({ minimum: 1 })),
    startSide: Type.Optional(StringEnum(["RIGHT", "LEFT"] as const)),
    commitSha: Type.Optional(Type.String({ minLength: 1, maxLength: 80 }))
  },
  { additionalProperties: false }
);

const SurroundingContextHintSchema = Type.Object(
  {
    kind: StringEnum(["enclosing_symbol", "call_site", "test", "line_range", "other"] as const, {
      description: "Mechanical context retrieval mode: `enclosing_symbol` reads the named body, `call_site` finds caller/usage bodies for the named callee/helper, `test` targets tests, `line_range` targets explicit lines. Put semantic intent in reason."
    }),
    path: Type.Optional(Type.String({
      minLength: 1,
      maxLength: 500,
      description: "File to inspect or use as the initial scope for the hint."
    })),
    symbol: Type.Optional(Type.String({
      minLength: 1,
      maxLength: 200,
      description: "For enclosing_symbol, the symbol body to read. For call_site, the callee/helper whose callers or usages should be inspected."
    })),
    lineRange: Type.Optional(Type.Tuple([Type.Integer({ minimum: 1 }), Type.Integer({ minimum: 1 })], {
      description: "Explicit inclusive line range to include when line-based context is more precise than a symbol hint."
    })),
    reason: Type.String({ minLength: 1, maxLength: 1000 }),
    expectedUse: StringEnum(["packet_context", "tool_lookup"] as const, {
      description: "Use packet_context for context Stage 6 should attach now; use tool_lookup for guidance the reviewer can inspect later."
    })
  },
  { additionalProperties: false }
);

export const SubmitPlanSchema = Type.Object(
  {
    diffUnderstanding: Type.Object(
      {
        declaredIntent: Type.String({ minLength: 1, maxLength: 2000 }),
        inferredBehavior: Type.String({ minLength: 1, maxLength: 4000 })
      },
      { additionalProperties: false }
    ),
    coverage: Type.Array(
      Type.Object(
        {
          hunkId: Type.String({ minLength: 1, maxLength: 200 }),
          path: Type.String({ minLength: 1, maxLength: 500 }),
          coverage: CoverageSchema,
          lenses: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { maxItems: 20 }),
          surroundingContextHints: Type.Optional(Type.Array(SurroundingContextHintSchema, {
            maxItems: 20,
            default: [],
            description: "Optional mechanical context hints. Omit this field when there are no hints."
          })),
          reason: Type.String({ minLength: 1, maxLength: 1000 }),
          focusNotes: Type.Optional(Type.Array(Type.String({
            minLength: 1,
            maxLength: 300,
            description: "Short hunk-scoped advisory notes grounded in the planner dossier. Do not include bug claims or questions."
          }), { maxItems: 5 })),
          relatedSymbols: Type.Optional(Type.Array(Type.String({
            minLength: 1,
            maxLength: 200,
            description: "Concrete symbol names Stage 6 may use to attach deterministic related changed context."
          }), { maxItems: 12 })),
          relatedFiles: Type.Optional(Type.Array(Type.String({
            minLength: 1,
            maxLength: 500,
            description: "Concrete file paths Stage 6 may use to attach deterministic related changed context."
          }), { maxItems: 12 }))
        },
        { additionalProperties: false }
      )
    ),
    partialReview: Type.Optional(
      Type.Object(
        {
          isPartial: Type.Boolean(),
          reason: Type.String({ minLength: 1, maxLength: 1000 }),
          reviewedHunks: Type.Integer({ minimum: 0 }),
          totalHunks: Type.Integer({ minimum: 0 })
        },
        { additionalProperties: false }
      )
    )
  },
  { additionalProperties: false }
);

export const SubmittedFindingSchema = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 200 }),
    severity: SeveritySchema,
    confidence: ConfidenceSchema,
    path: Type.String({ minLength: 1, maxLength: 500 }),
    anchor: Type.Optional(DiffAnchorSchema),
    category: FindingCategorySchema,
    evidence: Type.Object(
      {
        changedCode: Type.String({ minLength: 1, maxLength: 4000 }),
        relatedCode: Type.Optional(
          Type.Array(
            Type.Object(
              {
                path: Type.String({ minLength: 1, maxLength: 500 }),
                lines: Type.String({ minLength: 1, maxLength: 4000 }),
                whyRelevant: Type.String({ minLength: 1, maxLength: 1000 })
              },
              { additionalProperties: false }
            ),
            { maxItems: 10 }
          )
        )
      },
      { additionalProperties: false }
    ),
    failureMode: Type.String({ minLength: 1, maxLength: 2000 }),
    whyThisMatters: Type.String({ minLength: 1, maxLength: 2000 }),
    suggestedFix: Type.Optional(Type.String({ maxLength: 4000 })),
    suggestedTest: Type.Optional(Type.String({ maxLength: 2000 })),
    verification: Type.String({ minLength: 1, maxLength: 2000 }),
    behaviorChange: Type.Optional(BehaviorChangeAssessmentSchema),
    intentEvidence: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 8 }))
  },
  { additionalProperties: false }
);

const FollowUpHintSchema = Type.Object(
  {
    question: Type.String({ minLength: 1, maxLength: 1000 }),
    files: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 20 }),
    symbols: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 20 }),
    suggestedLenses: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { maxItems: 20 }),
    reason: Type.String({
      minLength: 1,
      maxLength: 1000,
      description: "Concrete unresolved predicate and why it matters. Keep concise; do not include XML, markdown wrappers, or extra JSON fields."
    }),
    confidence: ConfidenceSchema
  },
  { additionalProperties: false }
);

const StructuredUncertaintySchema = Type.Object(
  {
    question: Type.String({ minLength: 1, maxLength: 1000 }),
    files: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 20 }),
    symbols: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 20 })
  },
  { additionalProperties: false }
);

export const SubmitPacketReviewSchema = Type.Object(
  {
    reviewStatus: Type.Optional(StringEnum(["findings", "no_findings", "incomplete"] as const, {
      description: "Use findings when findings are present, no_findings only after concrete local risk is resolved, and incomplete when bounded review could not finish."
    })),
    findings: Type.Array(SubmittedFindingSchema, { maxItems: 20, description: "Array of finding objects, never JSON-encoded strings or fragments. Use [] when there are no findings." }),
    followUpHints: Type.Array(FollowUpHintSchema, {
      maxItems: 20,
      description: "Concrete unresolved predicates only. Do not use broad reminders or essay-style notes."
    }),
    uncertainties: Type.Array(StructuredUncertaintySchema, { maxItems: 20 }),
    noFindingReason: Type.Optional(Type.String({
      minLength: 1,
      maxLength: 1000,
      description: "Short no-finding conclusion, preferably 2-4 sentences. Do not repeat inspected code. Do not include XML, markdown wrappers, or <parameter> tags."
    }))
  },
  {
    additionalProperties: false,
    description: "Call submit_review with JSON/tool arguments matching this schema exactly. Do not include additional properties, XML tags, <parameter> blocks, or markdown wrappers inside fields."
  }
);

const ResolvedFollowUpHintSchema = Type.Object(
  {
    question: Type.String({ minLength: 1, maxLength: 1000 }),
    files: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 20 }),
    symbols: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 20 }),
    resolution: Type.String({ minLength: 1, maxLength: 2000 })
  },
  { additionalProperties: false }
);

export const SubmitSystemReviewSchema = Type.Object(
  {
    findings: Type.Array(SubmittedFindingSchema, { maxItems: 5 }),
    resolvedHints: Type.Array(ResolvedFollowUpHintSchema, { maxItems: 5 })
  },
  { additionalProperties: false }
);

export const VERIFIER_REASON_TARGET_CHARS = 2_000;
export const VERIFIER_REASON_HARD_MAX_CHARS = 4_000;

const VerificationVerdictSharedProperties = {
  reason: Type.String({ minLength: 1, maxLength: VERIFIER_REASON_HARD_MAX_CHARS }),
  requiredEvidencePresent: Type.Boolean(),
  falsePositiveRisk: StringEnum(["low", "medium", "high"] as const),
  behaviorChange: Type.Optional(BehaviorChangeAssessmentSchema),
  intentEvidence: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 8 }))
};

export const FindingUpdatesSchema = Type.Partial(
  Type.Omit(SubmittedFindingSchema, ["path", "anchor", "behaviorChange", "intentEvidence"]),
  { additionalProperties: false, minProperties: 1,
    description: "Only changed finding fields. Omitted fields stay unchanged. Nested evidence is replaced as a whole. Use revisedAnchor for placement." }
);

export const ProofAssessmentSchema = Type.Object({
  status: StringEnum(["established", "refuted", "unresolved"] as const),
  evidence: Type.String({ minLength: 1, maxLength: 4000, description: "Concrete source evidence establishing or refuting the failure predicate, or what remains missing." }),
  assumptions: Type.Array(Type.Object({
    question: Type.String({ minLength: 1, maxLength: 1000 }),
    essential: Type.Boolean({ description: "True when the defect exists only if this unresolved assumption holds; false for uncertainty limited to magnitude or secondary reach." })
  }, { additionalProperties: false }), { maxItems: 8 })
}, { additionalProperties: false });

export const SuggestionAssessmentSchema = Type.Object({
  contractCheck: Type.Optional(Type.Object({
    status: StringEnum(["established", "unresolved"] as const),
    requirement: Type.String({ maxLength: 2000, description: "Observable behavioral requirement the suggestion must preserve; existing evidence explains its source and relevance." })
  }, { additionalProperties: false })),
  status: StringEnum(["supported", "incompatible", "unverified"] as const),
  suggestionText: Type.Optional(Type.String({ minLength: 1, maxLength: 4000, description: "Omit to assess the named final suggestedFix/suggestedTest after findingUpdates. If supplied, must match that text exactly; this field never revises the suggestion." })),
  rationale: Type.String({ minLength: 1, maxLength: 2000, description: "Why this exact proposal preserves or violates the established requirement. For tests, explain reachability and before/after expectations without excluding other requirement-preserving implementations." }),
  evidence: Type.Array(Type.Object({
    path: Type.String({ maxLength: 500 }),
    lines: Type.String({ maxLength: 2000 }),
    whyRelevant: Type.String({ maxLength: 2000 })
  }, { additionalProperties: false }), { maxItems: 8 })
}, { additionalProperties: false });

export const SubmitVerificationVerdictSchema = Type.Object(
  {
    verdict: StringEnum(["keep", "reject", "revise"] as const),
    ...VerificationVerdictSharedProperties,
    proofAssessment: Type.Optional(ProofAssessmentSchema),
    suggestionAssessments: Type.Optional(Type.Object({
      suggestedFix: Type.Optional(SuggestionAssessmentSchema),
      suggestedTest: Type.Optional(SuggestionAssessmentSchema)
    }, { additionalProperties: false, description: "Assess final fix/test suggestions independently when inspected evidence permits. Optional: omission means unverified advice, not a failed defect. Support requires an established contractCheck and relevant evidence." })),
    findingUpdates: Type.Optional(FindingUpdatesSchema),
    finalFinding: Type.Optional(SubmittedFindingSchema),
    revisedAnchor: Type.Optional(DiffAnchorSchema)
  },
  {
    additionalProperties: false,
    description: "Submit one verifier verdict. Prefer findingUpdates containing only changed fields, plus revisedAnchor for placement. Do not combine findingUpdates with finalFinding. A revise verdict must include findingUpdates, revisedAnchor, or a legacy complete finalFinding; this semantic requirement is enforced after provider-safe schema validation."
  }
);

export const SubmitCompositionSchema = Type.Object(
  {
    summary: Type.String({ maxLength: 4000 }),
    attentionResolutions: Type.Optional(Type.Array(Type.Object({
      concernId: Type.String({ minLength: 1, maxLength: 300 }),
      disposition: StringEnum(["resolved", "narrowed"] as const),
      supportingRefs: Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { minItems: 1, maxItems: 20 }),
      rationale: Type.String({ minLength: 1, maxLength: 2000 }),
      remainingQuestion: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 }))
    }, { additionalProperties: false }), { maxItems: 30, description: "Optional resolutions of supplied verifier concerns only. Omission leaves concerns unchanged. Attention-only references cannot account for finding sources." })),
    composedFindings: Type.Array(
      Type.Object(
        {
          findingIds: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { minItems: 1, maxItems: 100 }),
          finalBody: Type.Optional(Type.String({ minLength: 1, maxLength: 20000, description: "Legacy artifact field; live composition uses sections." })),
          sections: Type.Optional(Type.Array(Type.Object({
            kind: StringEnum(["impact", "verification", "fix", "test"] as const),
            text: Type.String({ minLength: 1, maxLength: 12000 }),
            sourceRefs: Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { minItems: 1, maxItems: 500 })
          }, { additionalProperties: false }), { minItems: 1, maxItems: 100 })),
          evidenceRefs: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { maxItems: 1000 })),
          retainedSourceRefs: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { maxItems: 1000 })),
          primaryEvidenceRefs: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { maxItems: 3 })),
          reconciliations: Type.Optional(Type.Array(Type.Object({
            sourceRefs: Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { minItems: 1, maxItems: 100 }),
            supportingRefs: Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { maxItems: 100 }),
            disposition: StringEnum(["superseded", "unresolved"] as const),
            rationale: Type.String({ minLength: 1, maxLength: 2000 })
          }, { additionalProperties: false }), { maxItems: 100 })),
          publication: StringEnum(["inline", "summary-only"] as const)
        },
        { additionalProperties: false }
      ),
      { maxItems: 100 }
    )
  },
  { additionalProperties: false }
);

export type SubmitPlan = Static<typeof SubmitPlanSchema>;
export type SubmitPacketReview = Static<typeof SubmitPacketReviewSchema>;
export type SubmitSystemReview = Static<typeof SubmitSystemReviewSchema>;
export type SubmitVerificationVerdict = Static<typeof SubmitVerificationVerdictSchema>;
export type SubmitComposition = Static<typeof SubmitCompositionSchema>;

export const SCHEMA_VERSIONS = {
  submit_plan: 6,
  submit_review: 5,
  submit_system_review: 2,
  submit_verdict: 11,
  submit_composition: 7
} as const;

export function submitToolNameForStage(stage: ReviewStage): keyof typeof SCHEMA_VERSIONS {
  switch (stage) {
    case 5:
      return "submit_plan";
    case 7:
      return "submit_review";
    case 8:
      return "submit_system_review";
    case 9:
      return "submit_verdict";
    case 10:
      return "submit_composition";
    default:
      throw new Error(`stage ${stage} does not have a submit schema`);
  }
}
