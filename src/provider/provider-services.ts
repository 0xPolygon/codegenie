import { spawn } from "node:child_process";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import path from "node:path";
import {
  getEnvApiKey,
  getModels,
  getProviders,
  getSupportedThinkingLevels,
  type Api,
  type KnownProvider,
  type Model
} from "@earendil-works/pi-ai/compat";
import { getOAuthProvider, type OAuthCredentials } from "@earendil-works/pi-ai/oauth";
import { loadConfig, type LoadedConfig } from "../config/config-loader.js";
import { ensureCodegenieHome, getCodegeniePaths } from "../config/paths.js";
import { registerSecret } from "../telemetry/redaction.js";
import type { CodegeniePaths, ProviderSettings, ReasoningLevel, ReviewDepth } from "../types.js";
import { CodegenieError } from "../util/errors.js";
import { filterDeprecatedProviderModels } from "./model-policy.js";
import { loadProviderSettings, saveProviderSettings } from "./provider-settings.js";

export { ensureCodegenieHome, getCodegeniePaths, loadProviderSettings, saveProviderSettings };
export type { CodegeniePaths, ProviderSettings };

export type ProviderAuthEntry =
  | { type: "api_key"; apiKey: string; createdAt: string }
  | { type: "oauth"; credentials: OAuthCredentials; createdAt: string };

export type AuthStatus = {
  provider: string;
  configured: boolean;
  source?: "stored" | "environment";
  kind?: "api_key" | "oauth";
};

export interface PiAuthStorage {
  loadAll(): Record<string, ProviderAuthEntry>;
  get(provider: string): ProviderAuthEntry | undefined;
  set(provider: string, entry: ProviderAuthEntry): void;
  delete(provider: string): void;
  clear(): void;
}

export type ProviderModelInfo = {
  provider: string;
  id: string;
  name: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  reasoning: boolean;
  thinkingLevels: string[];
  input: string[];
};

export interface PiModelRegistry {
  listProviders(): string[];
  providerExists(provider: string): boolean;
  listModels(provider?: string): ProviderModelInfo[];
  modelExists(provider: string, modelId: string): boolean;
  authStatus(provider: string): AuthStatus;
}

export type ProviderServices = {
  paths: CodegeniePaths;
  authStorage: PiAuthStorage;
  modelRegistry: PiModelRegistry;
};

type ProviderConfigLayers = {
  defaults: LoadedConfig;
  effective: LoadedConfig;
};

type InputReader = (message: string) => Promise<string>;
type BrowserOpener = (url: string) => Promise<void> | void;
type PromptInputOptions = {
  allowEmpty?: boolean;
  readInput?: InputReader | undefined;
  signal?: AbortSignal | undefined;
};
type PreferredProviderDefault = {
  modelQuery: string;
  reasoning: ReasoningLevel;
};
type LoginCommandResult = {
  provider: string;
  preferredDefault?: {
    model: ProviderModelInfo;
    reasoning: ReasoningLevel;
  } | undefined;
};

export type RunProviderCommandOptions = {
  yes?: boolean;
  all?: boolean;
  apiKeyLogin?: boolean;
  apiKey?: string;
  homeOverride?: string;
  services?: ProviderServices;
  writeOut?: (text: string) => void;
  writeErr?: (text: string) => void;
  readInput?: InputReader;
  openBrowser?: BrowserOpener;
  env?: NodeJS.ProcessEnv;
};

export function createProviderServices(homeOverride?: string): ProviderServices {
  const paths = getCodegeniePaths(homeOverride);
  const authStorage = createFileAuthStorage(paths);
  return {
    paths,
    authStorage,
    modelRegistry: createPiModelRegistry(authStorage)
  };
}

export function createFileAuthStorage(paths: CodegeniePaths): PiAuthStorage {
  return {
    loadAll: () => loadAuthFile(paths),
    get: (provider) => loadAuthFile(paths)[provider],
    set: (provider, entry) => {
      ensureCodegenieHome(paths);
      const auth = loadAuthFile(paths);
      auth[provider] = entry;
      writeAuthFile(paths, auth);
      registerAuthEntry(entry);
    },
    delete: (provider) => {
      const auth = loadAuthFile(paths);
      delete auth[provider];
      writeAuthFile(paths, auth);
    },
    clear: () => {
      if (existsSync(paths.authPath)) {
        unlinkSync(paths.authPath);
      }
    }
  };
}

export function createPiModelRegistry(authStorage: PiAuthStorage): PiModelRegistry {
  return {
    listProviders: () => [...getProviders()].sort(),
    providerExists: (provider) => providerKnown(provider),
    listModels: (provider) => {
      const providers = provider ? [provider] : getProviders();
      return providers.flatMap((id) => modelsForProvider(id)).sort((a, b) => `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`));
    },
    modelExists: (provider, modelId) => modelsForProvider(provider).some((model) => model.id === modelId),
    authStatus: (provider) => {
      const stored = authStorage.get(provider);
      if (stored) {
        return { provider, configured: true, source: "stored", kind: stored.type };
      }
      const envKey = getEnvApiKey(provider);
      if (envKey) {
        registerSecret(envKey);
        return { provider, configured: true, source: "environment", kind: "api_key" };
      }
      return { provider, configured: false };
    }
  };
}

export async function runProviderCommand(args: string[], opts: RunProviderCommandOptions = {}): Promise<void> {
  const commandArgs = args[0] === "provider" ? args.slice(1) : args;
  const services = opts.services ?? createProviderServices(opts.homeOverride);
  const writeOut = opts.writeOut ?? ((text: string) => output.write(text));

  const [command, ...rawRest] = commandArgs;
  const rest = rawRest.map((arg) => arg.startsWith("-") ? arg : resolveProviderAlias(arg));
  switch (command) {
    case "list":
      writeOut(renderProviderList(services));
      return;
    case "login":
      {
        const result = await commandLogin(rest, services, opts);
        writeOut(`stored credentials for ${result.provider}\n`);
        if (result.preferredDefault !== undefined) {
          const { model, reasoning } = result.preferredDefault;
          writeOut(`default model set to ${model.provider}/${model.id} (${model.name}); reasoning set to ${reasoning}\n`);
        }
      }
      return;
    case "logout":
      {
        const parsed = parseLogoutArgs(rest, opts);
        commandLogout(parsed.args, services, { ...opts, yes: parsed.yes });
        writeOut(parsed.args[0] ? `removed credentials for ${parsed.args[0]}\n` : "removed all stored provider credentials\n");
      }
      return;
    case "auth-status":
      writeOut(renderAuthStatus(rest[0], services));
      return;
    case "models": {
      const all = opts.all || rest.includes("--all");
      const query = rest.find((item) => item !== "--all");
      writeOut(renderModels(query, all, services, opts.env));
      return;
    }
    case "use":
      commandUse(rest, services, writeOut);
      return;
    case "config":
      await commandConfig(rest, services, writeOut, opts.env);
      return;
    default:
      throw new CodegenieError("invalid_args", "expected provider command: list, login, logout, auth-status, models, use, or config");
  }
}

function parseLogoutArgs(args: string[], opts: RunProviderCommandOptions): { args: string[]; yes: boolean } {
  return {
    args: args.filter((arg) => arg !== "--yes"),
    yes: opts.yes === true || args.includes("--yes")
  };
}

function parseLoginArgs(args: string[], opts: RunProviderCommandOptions): { provider: string; apiKeyLogin: boolean } {
  const provider = args.find((arg) => arg !== "--api-key");
  return {
    provider: requireArg(provider, "provider login <provider>"),
    apiKeyLogin: opts.apiKeyLogin === true || opts.apiKey !== undefined || args.includes("--api-key")
  };
}

async function commandLogin(
  args: string[],
  services: ProviderServices,
  opts: RunProviderCommandOptions
): Promise<LoginCommandResult> {
  const { provider, apiKeyLogin } = parseLoginArgs(args, opts);
  assertProviderExists(provider, services);
  const oauthProvider = getOAuthProvider(provider);
  if (oauthProvider && !apiKeyLogin) {
    let authUrl: string | undefined;
    const manualInputController = new AbortController();
    const devicePromptControllers: AbortController[] = [];
    try {
      const credentials = await withOAuthFetchConnectionClose(() => oauthProvider.login({
        onAuth: (info) => {
          authUrl = info.url;
          (opts.writeOut ?? ((text: string) => output.write(text)))(
            `${info.url}\n${browserLoginInstruction()}\n`
          );
        },
        onDeviceCode: (info) => {
          const writeOut = opts.writeOut ?? ((text: string) => output.write(text));
          writeOut(
            `${info.verificationUri}\nEnter code: ${info.userCode}\n${deviceCodeLoginInstruction()}\n`
          );
          const controller = new AbortController();
          devicePromptControllers.push(controller);
          startDeviceCodeBrowserPrompt(info.verificationUri, opts, controller.signal);
        },
        onPrompt: async (prompt) => promptForInput(prompt.message, {
          allowEmpty: prompt.allowEmpty === true,
          readInput: opts.readInput
        }),
        ...(oauthProvider.usesCallbackServer === true
          ? {
              onManualCodeInput: async () => promptForBrowserOrManualCode(authUrl, opts, manualInputController.signal)
            }
          : {}),
        onSelect: async (prompt) => {
          const writeOut = opts.writeOut ?? ((text: string) => output.write(text));
          writeOut(`${prompt.message}\n`);
          prompt.options.forEach((option, index) => {
            writeOut(`  ${index + 1}. ${option.label}\n`);
          });
          const selected = await promptForInput(`Enter number (1-${prompt.options.length}): `, {
            readInput: opts.readInput
          });
          const index = Number.parseInt(selected, 10) - 1;
          return prompt.options[index]?.id;
        },
        onProgress: (message) => {
          (opts.writeErr ?? ((text: string) => process.stderr.write(text)))(`${message}\n`);
        }
      }));
      services.authStorage.set(provider, {
        type: "oauth",
        credentials,
        createdAt: new Date().toISOString()
      });
      return {
        provider,
        preferredDefault: applyPreferredDefaultAfterLogin(provider, services)
      };
    } finally {
      manualInputController.abort();
      devicePromptControllers.forEach((controller) => controller.abort());
    }
  }

  const apiKey = opts.apiKey ?? (await promptForInput(`API key for ${provider}: `, { readInput: opts.readInput }));
  registerSecret(apiKey);
  services.authStorage.set(provider, {
    type: "api_key",
    apiKey,
    createdAt: new Date().toISOString()
  });
  return {
    provider,
    preferredDefault: applyPreferredDefaultAfterLogin(provider, services)
  };
}

function commandLogout(args: string[], services: ProviderServices, opts: RunProviderCommandOptions): void {
  if (!args[0]) {
    if (!opts.yes) {
      throw new CodegenieError("invalid_args", "provider logout without a provider requires --yes confirmation");
    }
    services.authStorage.clear();
    return;
  }
  services.authStorage.delete(args[0]);
}

function commandUse(args: string[], services: ProviderServices, writeOut: (text: string) => void): void {
  const query = requireArg(args[0], "provider use <model>");
  const match = findUsableModel(query, services);
  if (!match) {
    throw new CodegenieError(
      "invalid_args",
      `sorry cannot find model ${query}. please check codegenie provider models for complete list`
    );
  }
  const settings = loadProviderSettings(services.paths);
  saveProviderSettings({ ...settings, defaultProvider: match.provider, defaultModel: match.id, defaultReasoning: "high" }, services.paths);
  writeOut(`default model set to ${match.provider}/${match.id} (${match.name}); reasoning set to high\n`);
}

function findUsableModel(query: string, services: ProviderServices, opts: { provider?: string } = {}): ProviderModelInfo | undefined {
  const normalizedQuery = normalizeModelSearch(query);
  if (normalizedQuery.length === 0) {
    return undefined;
  }
  const candidateProviders = opts.provider !== undefined ? [opts.provider] : services.modelRegistry.listProviders();
  const candidates = candidateProviders
    .filter((provider) => services.modelRegistry.authStatus(provider).configured)
    .flatMap((provider) => services.modelRegistry.listModels(provider));
  const ranked = candidates
    .map((model, index) => ({ model, index, rank: modelMatchRank(normalizedQuery, model.id) }))
    .filter((item): item is { model: ProviderModelInfo; index: number; rank: number } => item.rank !== undefined)
    .sort((a, b) => a.rank - b.rank || b.index - a.index);
  return ranked[0]?.model;
}

function modelMatchRank(normalizedQuery: string, modelId: string): number | undefined {
  const normalizedModelId = normalizeModelSearch(modelId);
  if (normalizedModelId === normalizedQuery) {
    return 0;
  }
  if (normalizedModelId.startsWith(normalizedQuery)) {
    return 1;
  }
  return normalizedModelId.includes(normalizedQuery) ? 2 : undefined;
}

function normalizeModelSearch(value: string): string {
  return value.toLowerCase().replace(/[-.]/gu, "");
}

const PREFERRED_PROVIDER_DEFAULTS: Record<string, PreferredProviderDefault> = {
  "anthropic": { modelQuery: "opus", reasoning: "high" },
  "openai-codex": { modelQuery: "gpt", reasoning: "high" }
};

function applyPreferredDefaultAfterLogin(
  provider: string,
  services: ProviderServices
): LoginCommandResult["preferredDefault"] | undefined {
  const preference = PREFERRED_PROVIDER_DEFAULTS[provider];
  if (preference === undefined) {
    return undefined;
  }

  const settings = loadProviderSettings(services.paths);
  if (settings.defaultProvider !== undefined && settings.defaultProvider !== provider) {
    return undefined;
  }
  if (settings.defaultModel !== undefined) {
    return undefined;
  }

  const model = findUsableModel(preference.modelQuery, services, { provider });
  if (model === undefined) {
    return undefined;
  }

  saveProviderSettings(
    {
      ...settings,
      defaultProvider: provider,
      defaultModel: model.id,
      defaultReasoning: preference.reasoning
    },
    services.paths
  );
  return { model, reasoning: preference.reasoning };
}

async function commandConfig(
  args: string[],
  services: ProviderServices,
  writeOut: (text: string) => void,
  env?: NodeJS.ProcessEnv
): Promise<void> {
  const [subcommand, ...rest] = args;
  if (!subcommand) {
    const settings = loadProviderSettings(services.paths);
    writeOut(renderProviderConfig(services, settings, loadResolvedUserConfig(services.paths, env)));
    return;
  }

  const settings = loadProviderSettings(services.paths);
  switch (subcommand) {
    case "set-provider": {
      const provider = requireArg(rest[0], "provider config set-provider <provider>");
      assertProviderExists(provider, services);
      const next = { ...settings, defaultProvider: provider };
      if (next.defaultModel !== undefined && !services.modelRegistry.modelExists(provider, next.defaultModel)) {
        delete next.defaultModel;
      }
      saveProviderSettings(next, services.paths);
      writeOut(`default provider set to ${provider}\n`);
      return;
    }
    case "set-model": {
      const provider = requireArg(rest[0], "provider config set-model <provider> <model>");
      const model = requireArg(rest[1], "provider config set-model <provider> <model>");
      assertProviderExists(provider, services);
      if (!services.modelRegistry.modelExists(provider, model)) {
        throw new CodegenieError("invalid_args", `unknown model ${provider}/${model}`);
      }
      saveProviderSettings({ ...settings, defaultProvider: provider, defaultModel: model, defaultReasoning: "high" }, services.paths);
      writeOut(`default model set to ${provider}/${model}; reasoning set to high\n`);
      return;
    }
    case "set-depth": {
      const depth = parseDepth(requireArg(rest[0], "provider config set-depth <light|normal|deep>"));
      saveProviderSettings({ ...settings, defaultDepth: depth }, services.paths);
      writeOut(`default depth set to ${depth}\n`);
      return;
    }
    case "set-reasoning": {
      const value = requireArg(rest[0], "provider config set-reasoning <low|medium|high|xhigh|auto>");
      if (value === "auto") {
        const next = { ...settings };
        delete next.defaultReasoning;
        saveProviderSettings(next, services.paths);
        writeOut("default reasoning override cleared\n");
        return;
      }
      const reasoning = parseReasoning(value);
      saveProviderSettings({ ...settings, defaultReasoning: reasoning }, services.paths);
      writeOut(`default reasoning set to ${reasoning}\n`);
      return;
    }
    default:
      throw new CodegenieError("invalid_args", `unknown provider config command ${subcommand}`);
  }
}

function renderProviderList(services: ProviderServices): string {
  const rows = services.modelRegistry.listProviders().map((provider) => {
    const status = services.modelRegistry.authStatus(provider);
    return {
      provider,
      status: renderProviderAuthStatus(status),
      description: providerDescription(provider)
    };
  });
  const providerWidth = Math.max(22, ...rows.map((row) => row.provider.length));
  const statusWidth = Math.max("not authenticated".length + 2, ...rows.map((row) => row.status.length));
  const byProvider = new Map(rows.map((row) => [row.provider, row]));
  const popularRows = POPULAR_PROVIDER_IDS
    .map((provider) => byProvider.get(provider))
    .filter((row): row is (typeof rows)[number] => row !== undefined);
  const renderRow = (row: (typeof rows)[number]): string =>
    `  ${row.provider.padEnd(providerWidth)}  ${row.status.padEnd(statusWidth)}  ${row.description}`;
  const lines = [];
  if (popularRows.length > 0) {
    lines.push("Popular providers:", ...popularRows.map(renderRow), "");
  }
  lines.push(
    "All available providers:",
    ...rows.map(renderRow),
    "",
    "Run `codegenie provider login <provider>` to authenticate.",
    "Use `codegenie provider login <provider> --api-key` to store an API key instead of OAuth.",
    ""
  );
  return lines.join("\n");
}

const POPULAR_PROVIDER_IDS = [
  "anthropic",
  "openai",
  "openai-codex",
  "opencode",
  "opencode-go",
  "openrouter"
] as const;

function renderProviderAuthStatus(status: AuthStatus): string {
  if (!status.configured) {
    return "✗ not authenticated";
  }
  return status.source === "environment" ? "✓ env configured" : "✓ logged in";
}

function providerDescription(provider: string): string {
  return KNOWN_PROVIDER_DESCRIPTIONS[provider] ?? titleCaseProvider(provider);
}

function titleCaseProvider(provider: string): string {
  return provider
    .split(/[-_]/u)
    .filter(Boolean)
    .map((part) => part.length <= 3 ? part.toUpperCase() : `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

const KNOWN_PROVIDER_DESCRIPTIONS: Record<string, string> = {
  "amazon-bedrock": "Amazon Bedrock",
  "ant-ling": "Ant Ling",
  "anthropic": "Anthropic (Claude Pro/Max OAuth or API key)",
  "antling": "Ant Ling",
  "azure-openai-responses": "Azure OpenAI (Responses)",
  "cerebras": "Cerebras",
  "cloudflare-ai-gateway": "Cloudflare AI Gateway",
  "cloudflare-workers-ai": "Cloudflare Workers AI",
  "deepseek": "DeepSeek",
  "fireworks": "Fireworks",
  "github-copilot": "GitHub Copilot",
  "google": "Google Gemini",
  "google-antigravity": "Antigravity (Gemini, Claude, GPT-OSS)",
  "google-gemini-cli": "Google Cloud Code Assist (Gemini CLI)",
  "google-vertex": "Vertex AI (Gemini via Google Cloud)",
  "groq": "Groq",
  "huggingface": "Hugging Face",
  "kimi-coding": "Kimi For Coding",
  "kimi-for-coding": "Kimi For Coding",
  "mistral": "Mistral",
  "minimax": "MiniMax",
  "minimax-cn": "MiniMax China",
  "mimo": "Xiaomi MiMo",
  "moonshotai": "Moonshot AI",
  "moonshotai-cn": "Moonshot AI China",
  "nvidia": "NVIDIA NIM",
  "nvidia-nim": "NVIDIA NIM",
  "opencode": "OpenCode",
  "opencode-go": "OpenCode Go",
  "opencode-zen": "OpenCode Zen",
  "openai": "OpenAI (API key)",
  "openai-codex": "OpenAI Codex (ChatGPT Plus/Pro OAuth)",
  "openrouter": "OpenRouter",
  "together": "Together AI",
  "together-ai": "Together AI",
  "vercel-ai-gateway": "Vercel AI Gateway",
  "xai": "xAI",
  "xiaomi": "Xiaomi MiMo",
  "xiaomi-token-plan-ams": "Xiaomi MiMo Token Plan (Amsterdam)",
  "xiaomi-token-plan-cn": "Xiaomi MiMo Token Plan (China)",
  "xiaomi-token-plan-sgp": "Xiaomi MiMo Token Plan (Singapore)",
  "zai": "ZAI",
  "zai-coding-cn": "ZAI Coding China"
};

function renderAuthStatus(provider: string | undefined, services: ProviderServices): string {
  const providers = provider ? [provider] : services.modelRegistry.listProviders();
  for (const id of providers) {
    assertProviderExists(id, services);
  }
  const statuses = providers.map((id) => services.modelRegistry.authStatus(id));
  return `${JSON.stringify(provider ? statuses[0] : statuses, null, 2)}\n`;
}

function renderModels(query: string | undefined, all: boolean, services: ProviderServices, env?: NodeJS.ProcessEnv): string {
  const providers = services.modelRegistry.listProviders();
  const current = currentModelSelection(services, env);
  const providerQuery = query && services.modelRegistry.providerExists(query) ? query : undefined;
  const needle = providerQuery ? undefined : query?.toLowerCase();
  const rows = services.modelRegistry
    .listModels(providerQuery)
    .filter((model) => {
      const status = services.modelRegistry.authStatus(model.provider);
      const available = all || status.configured;
      const matches = !needle || `${model.provider}/${model.id} ${model.name}`.toLowerCase().includes(needle);
      return available && matches;
    });

  if (rows.length === 0) {
    if (providerQuery) {
      return `No models available for ${providerQuery}${all ? "" : " with current authentication"}.\n`;
    }
    if (query) {
      return `No models matched ${query}${all ? "" : " among authenticated providers"}.\n`;
    }
    return [
      "No models available for authenticated providers.",
      "Run `codegenie provider login <provider>` to authenticate, or `codegenie provider models --all` to include unauthenticated providers.",
      ""
    ].join("\n");
  }

  const renderedRows = rows.map((model) => ({
    model,
    name: model.name,
    id: model.id,
    context: formatContextWindow(model.contextWindow),
    thinking: formatThinkingLevels(model),
    current: isCurrentModel(model, current)
  }));
  const nameWidth = Math.max(...renderedRows.map((row) => row.name.length));
  const idWidth = Math.max(...renderedRows.map((row) => row.id.length));
  const contextWidth = Math.max(...renderedRows.map((row) => row.context.length));
  const thinkingWidth = Math.max(...renderedRows.map((row) => row.thinking.length));

  const grouped = new Map<string, typeof renderedRows>();
  for (const provider of providers) {
    const providerRows = renderedRows.filter((row) => row.model.provider === provider);
    if (providerRows.length > 0) {
      grouped.set(provider, providerRows);
    }
  }
  const lines: string[] = [];
  for (const [provider, models] of grouped) {
    if (lines.length > 0) {
      lines.push("");
    }
    lines.push(provider);
    for (const row of models) {
      const base = `* ${row.name.padEnd(nameWidth)}  ${row.id.padEnd(idWidth)}  ${row.context.padEnd(contextWidth)}  ${row.thinking.padEnd(thinkingWidth)}`;
      lines.push(row.current ? `${base}  [✓ currently in use]` : base.trimEnd());
    }
  }
  lines.push("");
  return lines.join("\n");
}

function renderProviderConfig(
  services: ProviderServices,
  settings: ProviderSettings,
  layers: ProviderConfigLayers
): string {
  const effectiveProvider = layers.effective.config.llm.provider;
  const effectiveModel = layers.effective.config.llm.model;
  const effectiveReasoning = layers.effective.config.llm.reasoning ?? "high";
  const effectiveReasoningSource = layers.effective.sources["llm.reasoning"] ?? "built-in";
  const auth = effectiveProvider !== undefined ? services.modelRegistry.authStatus(effectiveProvider) : undefined;
  const lines = [
    renderProviderConfigSummary(effectiveProvider, effectiveModel, effectiveReasoning),
    "",
    "Provider configuration:",
    "",
    "Paths:",
    `  home       ${services.paths.home}`,
    `  settings   ${services.paths.settingsPath}`,
    `  auth       ${services.paths.authPath}`,
    "",
    "Stored defaults:",
    `  provider   ${settings.defaultProvider ?? "unset"}`,
    `  model      ${settings.defaultModel ?? "unset"}`,
    `  reasoning  ${settings.defaultReasoning ?? "unset"}`,
    `  depth      ${settings.defaultDepth ?? "unset"}`,
    "",
    "Effective for reviews:",
    `  provider   ${formatConfigValue(effectiveProvider, layers.effective.sources["llm.provider"])}`,
    `  model      ${formatConfigValue(effectiveModel, layers.effective.sources["llm.model"])}`,
    `  reasoning  ${formatConfigValue(effectiveReasoning, effectiveReasoningSource)}`,
    `  depth      ${formatConfigValue(layers.effective.config.review.depth, layers.effective.sources["review.depth"])}`,
    `  auth       ${auth ? formatProviderAuth(auth) : "not checked; no provider selected"}`,
    "",
    "Commands:",
    "  codegenie provider use <model>",
    "  codegenie provider config set-provider <provider>",
    "  codegenie provider config set-model <provider> <model>",
    "  codegenie provider config set-reasoning <low|medium|high|xhigh|auto>",
    "  codegenie provider config set-depth <light|normal|deep>",
    "",
    "Depth controls review budget and investigation intensity. Reasoning controls model thinking effort.",
    ""
  ];
  return lines.join("\n");
}

function renderProviderConfigSummary(provider: string | undefined, model: string | undefined, reasoning: ReasoningLevel): string {
  return `⭐ 🧞 You're using ${provider ?? "unset"} ${model ?? "unset"} ${reasoning}`;
}

function formatConfigValue(value: string | undefined, source: string | undefined): string {
  if (value === undefined) {
    return "unset";
  }
  return source === undefined ? value : `${value} (${sourceLabel(source)})`;
}

function sourceLabel(source: string): string {
  switch (source) {
    case "provider-settings":
      return "settings";
    case "user-config":
      return "user config";
    case "repo-config":
      return "repo config";
    case "environment":
      return "environment";
    case "cli":
      return "cli";
    case "defaults":
      return "default";
    case "built-in":
      return "built in";
    default:
      return source;
  }
}

function formatProviderAuth(status: AuthStatus): string {
  if (!status.configured) {
    return `not authenticated (${status.provider})`;
  }
  return status.source === "environment"
    ? `environment api key (${status.provider})`
    : `logged in (${status.provider})`;
}

function currentModelSelection(
  services: ProviderServices,
  env?: NodeJS.ProcessEnv
): { provider?: string; model?: string } {
  const effective = loadResolvedUserConfig(services.paths, env).effective.config.llm;
  return {
    ...(effective.provider !== undefined ? { provider: effective.provider } : {}),
    ...(effective.model !== undefined ? { model: effective.model } : {})
  };
}

function isCurrentModel(model: ProviderModelInfo, current: { provider?: string; model?: string }): boolean {
  return current.provider === model.provider && current.model === model.id;
}

function formatContextWindow(contextWindow: number | undefined): string {
  return `${contextWindow === undefined ? "unknown" : formatTokenCount(contextWindow)} context`;
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) {
    return `${formatCompactNumber(value / 1_000_000)}M`;
  }
  if (value >= 1_000) {
    return `${formatCompactNumber(value / 1_000)}k`;
  }
  return value.toLocaleString("en-US");
}

function formatCompactNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/u, "");
}

function formatThinkingLevels(model: ProviderModelInfo): string {
  if (model.thinkingLevels.length > 0) {
    return model.thinkingLevels.join(", ");
  }
  return model.reasoning ? "reasoning supported" : "no reasoning";
}

function providerConfigJson(
  services: ProviderServices,
  settings: ProviderSettings,
  layers: ProviderConfigLayers
): Record<string, unknown> {
  const provider = layers.effective.config.llm.provider;
  return {
    home: services.paths.home,
    authPath: services.paths.authPath,
    modelsPath: services.paths.modelsPath,
    settingsPath: services.paths.settingsPath,
    configTomlPath: services.paths.configTomlPath,
    sessionsDir: services.paths.sessionsDir,
    defaultProvider: configuredDefault(settings.defaultProvider, layers.defaults.config.llm.provider, layers.defaults.sources["llm.provider"]),
    defaultModel: configuredDefault(settings.defaultModel, layers.defaults.config.llm.model, layers.defaults.sources["llm.model"]),
    defaultDepth: configuredDefault(settings.defaultDepth, layers.defaults.config.review.depth, layers.defaults.sources["review.depth"]),
    defaultReasoning: configuredDefault(settings.defaultReasoning, layers.defaults.config.llm.reasoning, layers.defaults.sources["llm.reasoning"]),
    effectiveProvider: layers.effective.config.llm.provider ?? null,
    effectiveModel: layers.effective.config.llm.model ?? null,
    effectiveDepth: layers.effective.config.review.depth,
    effectiveReasoning: layers.effective.config.llm.reasoning ?? "high",
    auth: provider ? services.modelRegistry.authStatus(provider) : null
  };
}

function configuredDefault<T>(settingsValue: T | undefined, resolvedValue: T | undefined, source: string | undefined): T | null {
  if (settingsValue !== undefined) {
    return settingsValue;
  }
  return source === "defaults" ? null : resolvedValue ?? null;
}

function loadResolvedUserConfig(paths: CodegeniePaths, env?: NodeJS.ProcessEnv): ProviderConfigLayers {
  const base = {
    repoRoot: process.cwd(),
    homeOverride: paths.home,
    loadRepoConfig: false
  } as const;
  return {
    defaults: loadConfig({ ...base, env: {} }),
    effective: loadConfig({
      ...base,
      ...(env !== undefined ? { env } : {})
    })
  };
}

function modelsForProvider(provider: string): ProviderModelInfo[] {
  if (!providerKnown(provider)) {
    return [];
  }
  return filterDeprecatedProviderModels(getModels(provider as KnownProvider)).map((model) => modelInfo(model as Model<Api>));
}

function modelInfo(model: Model<Api>): ProviderModelInfo {
  return {
    provider: model.provider,
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxTokens,
    reasoning: model.reasoning,
    thinkingLevels: getSupportedThinkingLevels(model).filter((level) => level !== "off"),
    input: [...model.input]
  };
}

const PROVIDER_ALIASES: Record<string, string> = {
  "codex": "openai-codex",
  "copilot": "github-copilot",
  "bedrock": "amazon-bedrock",
  "vertex": "google-vertex",
  "gemini": "google",
};

function resolveProviderAlias(provider: string): string {
  return PROVIDER_ALIASES[provider] ?? provider;
}

function providerKnown(provider: string): boolean {
  return getProviders().includes(provider as KnownProvider);
}

function assertProviderExists(provider: string, services: ProviderServices): void {
  if (!services.modelRegistry.providerExists(provider)) {
    throw new CodegenieError("invalid_args", `unknown provider ${provider}`, {
      context: { available: services.modelRegistry.listProviders() }
    });
  }
}

function loadAuthFile(paths: CodegeniePaths): Record<string, ProviderAuthEntry> {
  if (!existsSync(paths.authPath)) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(paths.authPath, "utf8"));
  } catch (cause) {
    throw new CodegenieError("config_error", `failed to parse provider auth file at ${paths.authPath}`, {
      context: { path: paths.authPath },
      cause
    });
  }
  const auth = validateAuthFile(parsed, paths.authPath);
  for (const entry of Object.values(auth)) {
    registerAuthEntry(entry);
  }
  return auth;
}

function validateAuthFile(input: unknown, filePath: string): Record<string, ProviderAuthEntry> {
  if (!isPlainObject(input)) {
    throw invalidAuthFile(filePath, "auth file must contain an object keyed by provider id");
  }
  const output: Record<string, ProviderAuthEntry> = {};
  for (const [provider, value] of Object.entries(input)) {
    if (!isPlainObject(value)) {
      throw invalidAuthFile(filePath, `auth entry for ${provider} must be an object`);
    }
    if (value.type === "api_key") {
      if (typeof value.apiKey !== "string" || value.apiKey.trim() === "" || typeof value.createdAt !== "string") {
        throw invalidAuthFile(filePath, `api key auth entry for ${provider} is malformed`);
      }
      output[provider] = { type: "api_key", apiKey: value.apiKey, createdAt: value.createdAt };
      continue;
    }
    if (value.type === "oauth") {
      if (!isPlainObject(value.credentials) || typeof value.createdAt !== "string") {
        throw invalidAuthFile(filePath, `OAuth auth entry for ${provider} is malformed`);
      }
      const credentials = value.credentials;
      if (
        typeof credentials.access !== "string" ||
        typeof credentials.refresh !== "string" ||
        typeof credentials.expires !== "number"
      ) {
        throw invalidAuthFile(filePath, `OAuth credentials for ${provider} are malformed`);
      }
      output[provider] = {
        type: "oauth",
        credentials: credentials as OAuthCredentials,
        createdAt: value.createdAt
      };
      continue;
    }
    throw invalidAuthFile(filePath, `auth entry for ${provider} must have type api_key or oauth`);
  }
  return output;
}

function invalidAuthFile(filePath: string, reason: string): CodegenieError {
  return new CodegenieError("config_error", `invalid provider auth file at ${filePath}`, {
    context: { path: filePath, reason }
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function writeAuthFile(paths: CodegeniePaths, auth: Record<string, ProviderAuthEntry>): void {
  ensureCodegenieHome(paths);
  const tmpPath = path.join(paths.home, `.auth-${process.pid}-${Date.now()}.tmp`);
  writeFileSync(tmpPath, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmpPath, paths.authPath);
}

function registerAuthEntry(entry: ProviderAuthEntry): void {
  if (entry.type === "api_key") {
    registerSecret(entry.apiKey);
    return;
  }
  registerSecret(entry.credentials.access);
  registerSecret(entry.credentials.refresh);
}

async function promptForInput(
  message: string,
  opts: PromptInputOptions = {}
): Promise<string> {
  const rawValue = opts.readInput !== undefined ? await opts.readInput(message) : await defaultPromptInput(message, opts.signal);
  const value = rawValue.trim();
  if (!value && opts.allowEmpty !== true) {
    throw new CodegenieError("invalid_args", "credential value cannot be empty");
  }
  return value;
}

async function defaultPromptInput(message: string, signal?: AbortSignal): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    return signal !== undefined ? await rl.question(message, { signal }) : await rl.question(message);
  } finally {
    rl.close();
  }
}

async function promptForBrowserOrManualCode(authUrl: string | undefined, opts: RunProviderCommandOptions, signal?: AbortSignal): Promise<string> {
  const inputValue = await promptForInput("> ", { allowEmpty: true, readInput: opts.readInput });
  if (inputValue) {
    return inputValue;
  }
  if (!authUrl) {
    throw new CodegenieError("config_error", "OAuth login did not provide an authorization URL");
  }
  try {
    await openBrowserUrl(authUrl, opts);
  } catch (error) {
    const writeErr = opts.writeErr ?? ((text: string) => process.stderr.write(text));
    writeErr(`failed to open browser: ${errorMessage(error)}\n`);
    return promptForInput("Paste the final redirect URL or authorization code: ", { readInput: opts.readInput });
  }
  return waitForManualInputCleanup(signal);
}

async function withOAuthFetchConnectionClose<T>(operation: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  const wrappedFetch: typeof fetch = (request, init) =>
    originalFetch(request, fetchInitWithConnectionClose(request, init));
  globalThis.fetch = wrappedFetch;
  try {
    return await operation();
  } finally {
    if (globalThis.fetch === wrappedFetch) {
      globalThis.fetch = originalFetch;
    }
  }
}

function fetchInitWithConnectionClose(request: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]): RequestInit {
  const headers = typeof Request !== "undefined" && request instanceof Request
    ? new Headers(request.headers)
    : new Headers();
  new Headers(init?.headers).forEach((value, key) => {
    headers.set(key, value);
  });
  headers.set("connection", "close");
  return { ...init, headers };
}

function waitForManualInputCleanup(signal: AbortSignal | undefined): Promise<string> {
  return new Promise((resolve) => {
    if (signal === undefined) {
      return;
    }
    if (signal.aborted) {
      resolve("");
      return;
    }
    signal.addEventListener("abort", () => resolve(""), { once: true });
  });
}

function browserLoginInstruction(): string {
  return "\n⭐ 🧞 Press enter to open the URL above in your local browser. If the browser is on another machine, copy manually and paste the final redirect URL here.";
}

function deviceCodeLoginInstruction(): string {
  return "\n⭐ 🧞 Press enter to open the URL above in your local browser. If the browser is on another machine, copy the URL and code manually to complete login there.";
}

function startDeviceCodeBrowserPrompt(url: string, opts: RunProviderCommandOptions, signal: AbortSignal): void {
  void promptForInput("> ", { allowEmpty: true, readInput: opts.readInput, signal })
    .then(async (inputValue) => {
      if (!inputValue) {
        await openBrowserUrl(url, opts);
      }
    })
    .catch((error) => {
      if (isAbortError(error)) {
        return;
      }
      const writeErr = opts.writeErr ?? ((text: string) => process.stderr.write(text));
      writeErr(`failed to open browser: ${errorMessage(error)}\n`);
    });
}

async function openBrowserUrl(url: string, opts: RunProviderCommandOptions): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new CodegenieError("invalid_args", "OAuth authorization URL must use http or https");
  }
  await (opts.openBrowser ?? openUrlInBrowser)(parsed.href);
}

function openUrlInBrowser(url: string): Promise<void> {
  const { command, args } = browserOpenCommand(process.platform, url);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function browserOpenCommand(platform: NodeJS.Platform, url: string): { command: string; args: string[] } {
  if (platform === "darwin") {
    return { command: "open", args: [url] };
  }
  if (platform === "win32") {
    return { command: "rundll32", args: ["url.dll,FileProtocolHandler", url] };
  }
  return { command: "xdg-open", args: [url] };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function requireArg(value: string | undefined, usage: string): string {
  if (!value) {
    throw new CodegenieError("invalid_args", `usage: codegenie ${usage}`);
  }
  return value;
}

function parseDepth(value: string): ReviewDepth {
  if (value === "light" || value === "normal" || value === "deep") {
    return value;
  }
  throw new CodegenieError("invalid_args", "depth must be one of: light, normal, deep");
}

function parseReasoning(value: string): ReasoningLevel {
  if (value === "low" || value === "medium" || value === "high" || value === "xhigh") {
    return value;
  }
  throw new CodegenieError("invalid_args", "reasoning must be one of: low, medium, high, xhigh, auto");
}
