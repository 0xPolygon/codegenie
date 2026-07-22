import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { CredentialStore, Models, ProviderEnv } from "@earendil-works/pi-ai";

const piModels = builtinModels();

const API_KEY_ENV_VARS: Record<string, string[]> = {
  "ant-ling": ["ANT_LING_API_KEY"],
  "anthropic": ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
  "azure-openai-responses": ["AZURE_OPENAI_API_KEY"],
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

export function getCodegeniePiModels(credentials?: CredentialStore): Models {
  return credentials === undefined ? piModels : builtinModels({ credentials });
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
