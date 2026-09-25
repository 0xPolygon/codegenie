import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { CredentialStore, Models, ProviderEnv } from "@earendil-works/pi-ai";

const piModels = builtinModels();

// Hand copy of pi-ai's env-api-keys table (not a public export). Keep in sync
// on pi-ai upgrades; the registry coverage test fails when a provider is added
// upstream without a key mapping here or an ambient note below.
// ANTHROPIC_AUTH_TOKEN is deliberately absent: pi's getEnvApiKey skips it too,
// because it is sent as a Bearer header rather than an API key.
const API_KEY_ENV_VARS: Record<string, string[]> = {
  "ant-ling": ["ANT_LING_API_KEY"],
  "anthropic": ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
  "azure-openai-responses": ["AZURE_OPENAI_API_KEY"],
  "baseten": ["BASETEN_API_KEY"],
  "cerebras": ["CEREBRAS_API_KEY"],
  "cloudflare-ai-gateway": ["CLOUDFLARE_API_KEY"],
  "cloudflare-workers-ai": ["CLOUDFLARE_API_KEY"],
  "deepseek": ["DEEPSEEK_API_KEY"],
  "fireworks": ["FIREWORKS_API_KEY"],
  "github-copilot": ["COPILOT_GITHUB_TOKEN"],
  "google": ["GEMINI_API_KEY"],
  "google-vertex": ["GOOGLE_CLOUD_API_KEY"],
  "groq": ["GROQ_API_KEY"],
  "huggingface": ["HF_TOKEN"],
  "kimi-coding": ["KIMI_API_KEY"],
  "meta": ["META_API_KEY"],
  "minimax": ["MINIMAX_API_KEY"],
  "minimax-cn": ["MINIMAX_CN_API_KEY"],
  "mistral": ["MISTRAL_API_KEY"],
  "moonshotai": ["MOONSHOT_API_KEY"],
  "moonshotai-cn": ["MOONSHOT_API_KEY"],
  "nvidia": ["NVIDIA_API_KEY"],
  "opencode": ["OPENCODE_API_KEY"],
  "opencode-go": ["OPENCODE_API_KEY"],
  "openai": ["OPENAI_API_KEY"],
  "openrouter": ["OPENROUTER_API_KEY"],
  "qwen-token-plan": ["QWEN_TOKEN_PLAN_API_KEY"],
  "qwen-token-plan-cn": ["QWEN_TOKEN_PLAN_CN_API_KEY"],
  "qwen-token-plan-individual": ["QWEN_TOKEN_PLAN_API_KEY"],
  "radius": ["RADIUS_API_KEY"],
  "together": ["TOGETHER_API_KEY"],
  "vercel-ai-gateway": ["AI_GATEWAY_API_KEY"],
  "xai": ["XAI_API_KEY"],
  "xiaomi": ["XIAOMI_API_KEY"],
  "xiaomi-token-plan-ams": ["XIAOMI_TOKEN_PLAN_AMS_API_KEY"],
  "xiaomi-token-plan-cn": ["XIAOMI_TOKEN_PLAN_CN_API_KEY"],
  "xiaomi-token-plan-sgp": ["XIAOMI_TOKEN_PLAN_SGP_API_KEY"],
  "zai": ["ZAI_API_KEY"],
  "zai-coding-cn": ["ZAI_CODING_CN_API_KEY"]
};

// Bearer-token vars pi reads outside the API-key lookup above. Only used to
// clear competing credentials when the Action's llm-api-key is authoritative.
const BEARER_TOKEN_ENV_VARS: Record<string, string[]> = {
  "anthropic": ["ANTHROPIC_AUTH_TOKEN"]
};

// Providers whose credentials are not (only) a single API-key env var.
const AMBIENT_CREDENTIAL_NOTES: Record<string, string> = {
  "amazon-bedrock": "AWS credentials: `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`, `AWS_BEARER_TOKEN_BEDROCK`, `AWS_PROFILE`, or an OIDC web identity (e.g. aws-actions/configure-aws-credentials)",
  "google-vertex": "or Application Default Credentials plus `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION` (e.g. google-github-actions/auth)",
  "openai-codex": "stored ChatGPT-plan login only (`codegenie provider login openai-codex`); in CI this needs a self-hosted runner with that login"
};

export function getCodegeniePiModels(credentials?: CredentialStore): Models {
  return credentials === undefined ? piModels : builtinModels({ credentials });
}

// The API-key env var a provider reads (OAuth-token vars are skipped when an
// _API_KEY-named var exists). The github-action adapter uses this to route a
// generic LLM_API_KEY to the right provider variable.
export function getPiApiKeyEnvVarName(provider: string): string | undefined {
  const envVars = API_KEY_ENV_VARS[provider];
  if (envVars === undefined || envVars.length === 0) {
    return undefined;
  }
  return envVars.find((name) => name.endsWith("_API_KEY")) ?? envVars[envVars.length - 1];
}

// Every API-key env var pi reads for a provider, in lookup order.
export function getPiApiKeyEnvVarNames(provider: string): string[] {
  return [...(API_KEY_ENV_VARS[provider] ?? [])];
}

// Every env var that can authenticate a provider: the API-key lookup names
// plus bearer-token vars. Clearing these leaves only an explicitly routed key.
export function getPiCredentialEnvVarNames(provider: string): string[] {
  return [...(BEARER_TOKEN_ENV_VARS[provider] ?? []), ...(API_KEY_ENV_VARS[provider] ?? [])];
}

export function getAmbientCredentialNote(provider: string): string | undefined {
  return AMBIENT_CREDENTIAL_NOTES[provider];
}

// One-line "how to authenticate" hint for error messages.
export function describeProviderCredentials(provider: string): string {
  const envVar = getPiApiKeyEnvVarName(provider);
  const note = getAmbientCredentialNote(provider);
  if (envVar !== undefined) {
    return `set ${envVar}${note !== undefined ? ` ${note}` : ""} (or run \`codegenie provider login ${provider}\`)`;
  }
  return note ?? `run \`codegenie provider login ${provider}\``;
}

export function getPiEnvApiKey(provider: string, env?: ProviderEnv): string | undefined {
  const envVars = API_KEY_ENV_VARS[provider];
  const firstKey = envVars?.find((name) => providerEnvValue(name, env) !== undefined);
  if (firstKey !== undefined) {
    return providerEnvValue(firstKey, env);
  }

  if (provider === "google-vertex" && hasVertexAdcCredentials(env)) {
    return "<authenticated>";
  }
  if (provider === "amazon-bedrock" && hasBedrockAmbientCredentials(env)) {
    return "<authenticated>";
  }
  return undefined;
}

function providerEnvValue(name: string, env?: ProviderEnv): string | undefined {
  return env?.[name] || process.env[name] || undefined;
}

function hasVertexAdcCredentials(env?: ProviderEnv): boolean {
  const credentialsPath = providerEnvValue("GOOGLE_APPLICATION_CREDENTIALS", env) ?? path.join(homedir(), ".config", "gcloud", "application_default_credentials.json");
  const hasCredentials = existsSync(credentialsPath);
  const hasProject = providerEnvValue("GOOGLE_CLOUD_PROJECT", env) !== undefined || providerEnvValue("GCLOUD_PROJECT", env) !== undefined;
  const hasLocation = providerEnvValue("GOOGLE_CLOUD_LOCATION", env) !== undefined;
  return hasCredentials && hasProject && hasLocation;
}

function hasBedrockAmbientCredentials(env?: ProviderEnv): boolean {
  return providerEnvValue("AWS_PROFILE", env) !== undefined ||
    (providerEnvValue("AWS_ACCESS_KEY_ID", env) !== undefined && providerEnvValue("AWS_SECRET_ACCESS_KEY", env) !== undefined) ||
    providerEnvValue("AWS_BEARER_TOKEN_BEDROCK", env) !== undefined ||
    providerEnvValue("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", env) !== undefined ||
    providerEnvValue("AWS_CONTAINER_CREDENTIALS_FULL_URI", env) !== undefined ||
    providerEnvValue("AWS_WEB_IDENTITY_TOKEN_FILE", env) !== undefined;
}
