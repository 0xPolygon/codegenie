const DEPRECATED_MODEL_PATTERNS: Array<{ provider?: string; id: RegExp }> = [
  { provider: "anthropic", id: /^claude-3(?:-|$)/u },
  { provider: "anthropic", id: /^claude-(?:opus|sonnet)-4(?:-0|-20250514)$/u },
  { provider: "amazon-bedrock", id: /^anthropic\.claude-3(?:[-.]|$)/u },
  { provider: "amazon-bedrock", id: /^anthropic\.claude-(?:opus|sonnet)-4-20250514/u },
  { provider: "openrouter", id: /^anthropic\/claude-3(?:[.-]|$)/u },
  { provider: "openrouter", id: /^anthropic\/claude-(?:opus|sonnet)-4$/u },
  { provider: "vercel-ai-gateway", id: /^anthropic\/claude-3(?:[.-]|$)/u },
  { provider: "vercel-ai-gateway", id: /^anthropic\/claude-(?:opus|sonnet)-4$/u }
];

export function isDeprecatedProviderModel(provider: string, modelId: string): boolean {
  const normalizedProvider = provider.toLowerCase();
  const normalizedModelId = modelId.toLowerCase();
  return DEPRECATED_MODEL_PATTERNS.some((pattern) =>
    (pattern.provider === undefined || pattern.provider === normalizedProvider) &&
    pattern.id.test(normalizedModelId)
  );
}

export function filterDeprecatedProviderModels<T extends { provider: string; id: string }>(models: T[]): T[] {
  return models.filter((model) => !isDeprecatedProviderModel(model.provider, model.id));
}
