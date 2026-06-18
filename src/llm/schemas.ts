import { Type, type Static } from "@earendil-works/pi-ai";
import type { ReviewStage } from "../types.js";

const SeveritySchema = Type.Union([
  Type.Literal("critical"),
  Type.Literal("high"),
  Type.Literal("medium"),
  Type.Literal("low")
]);

const ConfidenceSchema = Type.Union([
  Type.Literal("high"),
  Type.Literal("medium"),
  Type.Literal("low")
]);

const CoverageSchema = Type.Union([
  Type.Literal("deep"),
  Type.Literal("normal"),
  Type.Literal("light"),
  Type.Literal("skip")
]);

const FindingCategorySchema = Type.Union([
  Type.Literal("logic_bug"),
  Type.Literal("correctness"),
  Type.Literal("security"),
  Type.Literal("performance"),
  Type.Literal("architecture"),
  Type.Literal("testing"),
  Type.Literal("maintainability")
]);

const BehaviorChangeAssessmentSchema = Type.Union([
  Type.Literal("accidental_regression"),
  Type.Literal("intentional_needs_confirmation"),
  Type.Literal("specified_change"),
  Type.Literal("unknown")
]);

const DiffAnchorSchema = Type.Object(
  {
    path: Type.String({ minLength: 1, maxLength: 500 }),
    line: Type.Integer({ minimum: 1 }),
    side: Type.Union([Type.Literal("RIGHT"), Type.Literal("LEFT")]),
    hunkId: Type.String({ minLength: 1, maxLength: 200 }),
    startLine: Type.Optional(Type.Integer({ minimum: 1 })),
    startSide: Type.Optional(Type.Union([Type.Literal("RIGHT"), Type.Literal("LEFT")])),
    commitSha: Type.Optional(Type.String({ minLength: 1, maxLength: 80 }))
  },
  { additionalProperties: false }
);

const SurroundingContextHintSchema = Type.Object(
  {
    kind: Type.Union([
      Type.Literal("enclosing_symbol"),
      Type.Literal("call_site"),
      Type.Literal("test"),
      Type.Literal("line_range"),
      Type.Literal("other")
    ], {
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
    expectedUse: Type.Union([Type.Literal("packet_context"), Type.Literal("tool_lookup")], {
      description: "Use packet_context for context Stage 6 should attach now; use tool_lookup for guidance the reviewer can inspect later."
    })
  },
  { additionalProperties: false }
);

const ReviewQuestionSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 120 }),
    question: Type.String({ minLength: 1, maxLength: 1000 }),
    whyItMatters: Type.String({ minLength: 1, maxLength: 1000 }),
    files: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 20 }),
    symbols: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 20 }),
    evidenceHint: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 }))
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
    riskAreas: Type.Array(
      Type.Object(
        {
          area: Type.String({ minLength: 1, maxLength: 200 }),
          reason: Type.String({ minLength: 1, maxLength: 1000 }),
          files: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 50 }),
          suggestedLenses: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { maxItems: 20 })
        },
        { additionalProperties: false }
      ),
      { maxItems: 50 }
    ),
    reviewQuestions: Type.Optional(Type.Array(ReviewQuestionSchema, { maxItems: 12 })),
    coverage: Type.Array(
      Type.Object(
        {
          hunkId: Type.String({ minLength: 1, maxLength: 200 }),
          path: Type.String({ minLength: 1, maxLength: 500 }),
          coverage: CoverageSchema,
          lenses: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { maxItems: 20 }),
          surroundingContextHints: Type.Array(SurroundingContextHintSchema, { maxItems: 20 }),
          reason: Type.String({ minLength: 1, maxLength: 1000 })
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

const SubmittedFindingSchema = Type.Object(
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
    reviewQuestionIds: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 120 }), { maxItems: 10 })),
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
    reason: Type.String({ minLength: 1, maxLength: 1000 }),
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

const AnsweredReviewQuestionSchema = Type.Object(
  {
    questionId: Type.String({ minLength: 1, maxLength: 120 }),
    answer: Type.String({ minLength: 1, maxLength: 1000 }),
    confidence: ConfidenceSchema,
    outcome: Type.Union([
      Type.Literal("answered_no_issue"),
      Type.Literal("candidate_finding"),
      Type.Literal("partial"),
      Type.Literal("not_applicable")
    ]),
    evidence: Type.Array(
      Type.Object(
        {
          path: Type.String({ minLength: 1, maxLength: 500 }),
          lines: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
          whyRelevant: Type.String({ minLength: 1, maxLength: 1000 })
        },
        { additionalProperties: false }
      ),
      { maxItems: 8 }
    ),
    evidenceTrace: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 }))
  },
  { additionalProperties: false }
);

export const SubmitPacketReviewSchema = Type.Object(
  {
    reviewStatus: Type.Optional(Type.Union([
      Type.Literal("findings"),
      Type.Literal("no_findings"),
      Type.Literal("incomplete")
    ])),
    findings: Type.Array(SubmittedFindingSchema, { maxItems: 20 }),
    followUpHints: Type.Array(FollowUpHintSchema, { maxItems: 20 }),
    uncertainties: Type.Array(StructuredUncertaintySchema, { maxItems: 20 }),
    answeredQuestions: Type.Optional(Type.Array(AnsweredReviewQuestionSchema, { maxItems: 10 })),
    noFindingReason: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
    unresolvedQuestions: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 10 }))
  },
  { additionalProperties: false }
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

export const SubmitVerificationVerdictSchema = Type.Object(
  {
    verdict: Type.Union([Type.Literal("keep"), Type.Literal("reject"), Type.Literal("revise")]),
    reason: Type.String({ minLength: 1, maxLength: 2000 }),
    requiredEvidencePresent: Type.Boolean(),
    falsePositiveRisk: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
    finalFinding: Type.Optional(SubmittedFindingSchema),
    revisedAnchor: Type.Optional(DiffAnchorSchema),
    behaviorChange: Type.Optional(BehaviorChangeAssessmentSchema),
    intentEvidence: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 8 }))
  },
  { additionalProperties: false }
);

export const SubmitCompositionSchema = Type.Object(
  {
    summary: Type.String({ maxLength: 4000 }),
    composedFindings: Type.Array(
      Type.Object(
        {
          findingIds: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { minItems: 1, maxItems: 100 }),
          finalBody: Type.String({ minLength: 1, maxLength: 20000 }),
          publication: Type.Union([Type.Literal("inline"), Type.Literal("summary-only")])
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
  submit_plan: 2,
  submit_review: 3,
  submit_system_review: 1,
  submit_verdict: 1,
  submit_composition: 1
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
