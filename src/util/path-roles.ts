// Shared path-role classifiers live here first. Stage-local path regex copies
// are a review flag unless a plan records why the dialect must stay separate.
export function isRepositoryTestPath(filePath: string): boolean {
  const normalized = normalizePathRoleInput(filePath);
  return normalized.endsWith("_test.go") ||
    /(?:^|\/)(?:__tests__|tests?|test)\//u.test(normalized) ||
    /\.(?:test|spec)\.[cm]?[tj]sx?$/u.test(normalized) ||
    /(?:^|\/)test_[^/]+\.py$/u.test(normalized) ||
    /_test\.(?:py|rs)$/u.test(normalized) ||
    /\.t\.sol$/u.test(normalized);
}

export function isCompositionTestPath(filePath: string): boolean {
  const normalized = normalizePathRoleInput(filePath);
  return /(?:^|\/)(?:__tests__|tests?|spec)(?:\/|$)|(?:\.test|\.spec)\.[^/]+$/u.test(normalized) ||
    /(?:^|\/)test_[^/]+\.py$/u.test(normalized) ||
    /_test\.(?:py|rs)$/u.test(normalized) ||
    /\.t\.sol$/u.test(normalized);
}

export function isCoverageEscalationTestPath(filePath: string): boolean {
  const normalized = normalizePathRoleInput(filePath);
  return /(?:^|\/)(?:__tests__|tests?|spec)(?:\/|$)|(?:\.test|\.spec|_test)\.[^/]+$/u.test(normalized) ||
    /(?:^|\/)test_[^/]+\.py$/u.test(normalized) ||
    /\.t\.sol$/u.test(normalized);
}

export function isPacketReviewTestPath(filePath: string): boolean {
  const normalized = normalizePathRoleInput(filePath);
  return /(^|\/)(__tests__|tests?|specs?)(\/|$)/u.test(normalized) ||
    /(^|[._-])(test|spec)(?=\.[^/]+$)/u.test(normalized) ||
    /(?:^|\/)test_[^/]+\.py$/u.test(normalized) ||
    /_test\.(?:py|rs)$/u.test(normalized) ||
    /\.t\.sol$/u.test(normalized);
}

export function isPromotionTestPath(filePath: string): boolean {
  const normalized = normalizePathRoleInput(filePath);
  return /(^|[/_.-])(test|tests|spec|specs)([/_.-]|$)|(_test|\.test|\.spec)\.[^.]+$/u.test(normalized) ||
    /\.t\.sol$/u.test(normalized);
}

export function isDocsPath(filePath: string): boolean {
  const normalized = normalizePathRoleInput(filePath);
  return /(?:^|\/)(?:docs?|documentation|postmortems?)(?:\/|$)|\.(?:md|mdx|rst|txt)$/u.test(normalized);
}

function normalizePathRoleInput(filePath: string): string {
  return filePath.toLowerCase().replace(/\\/gu, "/");
}
