/** Inclusive one-based source lines. */
export function isOrderedLineRange(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length === 2 && value.every(line => Number.isSafeInteger(line) && line >= 1) && value[0] <= value[1];
}
