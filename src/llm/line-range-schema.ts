import { Type } from "typebox";

/** A provider-portable representation of the existing [start, end] wire shape. */
export const LineRangeSchema = Type.Unsafe<[number, number]>({
  type: "array", items: { type: "integer", minimum: 1 }, minItems: 2, maxItems: 2,
  description: "Inclusive [startLine, endLine]; startLine must not exceed endLine."
});
