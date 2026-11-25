export function validateReviewOverride(override) {
  if (!override || typeof override !== 'object' || Array.isArray(override) || Object.keys(override).length !== 1 ||
      !Object.hasOwn(override, 'adaptiveThinking') || typeof override.adaptiveThinking !== 'boolean') throw new Error('invalid campaign review override');
}
