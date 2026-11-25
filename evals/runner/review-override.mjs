export function validateReviewOverride(override) {
  if (!override || Object.keys(override).length !== 1 || !Object.hasOwn(override, 'adaptiveSecondPass') ||
      typeof override.adaptiveSecondPass !== 'boolean') throw new Error('invalid campaign review override');
}
