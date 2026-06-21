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
} from "@earendil-works/pi-ai";
import { getOAuthProvider, type OAuthCredentials } from "@earendil-works/pi-ai/oauth";
import { loadConfig, type LoadedConfig } from "../config/config-loader.js";
import { ensureCodegenieHome, getCodegeniePaths } from "../config/paths.js";
import { registerSecret } from "../telemetry/redaction.js";
import type { CodegeniePaths, ProviderSettings, ReasoningLevel, ReviewDepth } from "../types.js";
import { CodegenieError } from "../util/errors.js";
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

export type RunProviderCommandOptions = {
  yes?: boolean;
  all?: boolean;
  apiKey?: string;
  homeOverride?: string;
  services?: ProviderServices;
  writeOut?: (text: string) => void;
  writeErr?: (text: string) => void;
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

  const [command, ...rest] = commandArgs;
  switch (command) {
    case "list":
      writeOut(renderProviderList(services));
      return;
    case "login":
      await commandLogin(rest, services, opts);
      writeOut(`stored credentials for ${requireArg(rest[0], "provider login <provider>")}\n`);
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
      writeOut(renderModels(query, all, services));
      return;
    }
    case "config":
      await commandConfig(rest, services, writeOut, opts.env);
      return;
    default:
      throw new CodegenieError("invalid_args", "expected provider command: list, login, logout, auth-status, models, or config");
  }
}

function parseLogoutArgs(args: string[], opts: RunProviderCommandOptions): { args: string[]; yes: boolean } {
  return {
    args: args.filter((arg) => arg !== "--yes"),
    yes: opts.yes === true || args.includes("--yes")
  };
}

async function commandLogin(
  args: string[],
  services: ProviderServices,
  opts: RunProviderCommandOptions
): Promise<void> {
  const provider = requireArg(args[0], "provider login <provider>");
  assertProviderExists(provider, services);
  const oauthProvider = getOAuthProvider(provider);
  if (oauthProvider && !opts.apiKey) {
    const credentials = await oauthProvider.login({
      onAuth: (info) => {
        (opts.writeOut ?? ((text: string) => output.write(text)))(`${info.url}\n${info.instructions ?? ""}\n`);
      },
      onDeviceCode: (info) => {
        const writeOut = opts.writeOut ?? ((text: string) => output.write(text));
        writeOut(`${info.verificationUri}\nEnter code: ${info.userCode}\n`);
      },
      onPrompt: async (prompt) => promptForSecret(prompt.message),
      onSelect: async (prompt) => {
        const writeOut = opts.writeOut ?? ((text: string) => output.write(text));
        writeOut(`${prompt.message}\n`);
        prompt.options.forEach((option, index) => {
          writeOut(`  ${index + 1}. ${option.label}\n`);
        });
        const selected = await promptForSecret(`Enter number (1-${prompt.options.length}): `);
        const index = Number.parseInt(selected, 10) - 1;
        return prompt.options[index]?.id;
      },
      onProgress: (message) => {
        (opts.writeErr ?? ((text: string) => process.stderr.write(text)))(`${message}\n`);
      }
    });
    services.authStorage.set(provider, {
      type: "oauth",
      credentials,
      createdAt: new Date().toISOString()
    });
    return;
  }

  const apiKey = opts.apiKey ?? (await promptForSecret(`API key for ${provider}: `));
  registerSecret(apiKey);
  services.authStorage.set(provider, {
    type: "api_key",
    apiKey,
    createdAt: new Date().toISOString()
  });
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

async function commandConfig(
  args: string[],
  services: ProviderServices,
  writeOut: (text: string) => void,
  env?: NodeJS.ProcessEnv
): Promise<void> {
  const [subcommand, ...rest] = args;
  if (!subcommand) {
    const settings = loadProviderSettings(services.paths);
    writeOut(`${JSON.stringify(providerConfigJson(services, settings, loadResolvedUserConfig(services.paths, env)), null, 2)}\n`);
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
      saveProviderSettings({ ...settings, defaultProvider: provider, defaultModel: model }, services.paths);
      writeOut(`default model set to ${provider}/${model}\n`);
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
      auth: status.configured ? status.source : "missing"
    };
  });
  return `${JSON.stringify(rows, null, 2)}\n`;
}

function renderAuthStatus(provider: string | undefined, services: ProviderServices): string {
  const providers = provider ? [provider] : services.modelRegistry.listProviders();
  for (const id of providers) {
    assertProviderExists(id, services);
  }
  const statuses = providers.map((id) => services.modelRegistry.authStatus(id));
  return `${JSON.stringify(provider ? statuses[0] : statuses, null, 2)}\n`;
}

function renderModels(query: string | undefined, all: boolean, services: ProviderServices): string {
  const providers = services.modelRegistry.listProviders();
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

  if (query && !providerQuery && rows.length === 0 && providers.includes(query)) {
    return "[]\n";
  }
  return `${JSON.stringify(rows, null, 2)}\n`;
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
  return getModels(provider as KnownProvider).map((model) => modelInfo(model as Model<Api>));
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

async function promptForSecret(message: string): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    const value = await rl.question(message);
    if (!value.trim()) {
      throw new CodegenieError("invalid_args", "credential value cannot be empty");
    }
    return value.trim();
  } finally {
    rl.close();
  }
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
