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
      Type.Literal("sibling_pattern"),
      Type.Literal("call_site"),
      Type.Literal("test"),
      Type.Literal("config"),
      Type.Literal("lifecycle"),
      Type.Literal("resource_management"),
      Type.Literal("authorization"),
      Type.Literal("other")
    ]),
    path: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    symbol: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    lineRange: Type.Optional(Type.Tuple([Type.Integer({ minimum: 1 }), Type.Integer({ minimum: 1 })])),
    reason: Type.String({ minLength: 1, maxLength: 1000 }),
    expectedUse: Type.Union([Type.Literal("packet_context"), Type.Literal("tool_lookup")])
  },
  { additionalProperties: false }
);

export const SubmitPlanSchema = Type.Object(
  {
    diffUnderstanding: Type.Object(
      {
        summary: Type.String({ minLength: 1, maxLength: 4000 }),
        intent: Type.Optional(Type.String({ maxLength: 2000 }))
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
    verification: Type.String({ minLength: 1, maxLength: 2000 })
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

export const SubmitPacketReviewSchema = Type.Object(
  {
    findings: Type.Array(SubmittedFindingSchema, { maxItems: 20 }),
    followUpHints: Type.Array(FollowUpHintSchema, { maxItems: 20 }),
    uncertainties: Type.Array(StructuredUncertaintySchema, { maxItems: 20 })
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
    revisedAnchor: Type.Optional(DiffAnchorSchema)
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
export type SubmitVerificationVerdict = Static<typeof SubmitVerificationVerdictSchema>;
export type SubmitComposition = Static<typeof SubmitCompositionSchema>;

export const SCHEMA_VERSIONS = {
  submit_plan: 1,
  submit_review: 1,
  submit_verdict: 1,
  submit_composition: 1
} as const;

export function submitToolNameForStage(stage: ReviewStage): keyof typeof SCHEMA_VERSIONS {
  switch (stage) {
    case 5:
      return "submit_plan";
    case 7:
      return "submit_review";
    case 9:
      return "submit_verdict";
    case 10:
      return "submit_composition";
    default:
      throw new Error(`stage ${stage} does not have a submit schema`);
  }
}
