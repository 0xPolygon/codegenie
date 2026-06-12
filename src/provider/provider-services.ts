import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
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
import { ensureCodeninjaHome, getCodeninjaPaths } from "../config/paths.js";
import { rawConfigSchema } from "../config/schema.js";
import { registerSecret } from "../telemetry/redaction.js";
import type { CodeninjaPaths, ProviderSettings, ReasoningLevel, ReviewDepth } from "../types.js";
import { CodeninjaError } from "../util/errors.js";
import { loadProviderSettings, saveProviderSettings } from "./provider-settings.js";

export { ensureCodeninjaHome, getCodeninjaPaths, loadProviderSettings, saveProviderSettings };
export type { CodeninjaPaths, ProviderSettings };

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
  paths: CodeninjaPaths;
  authStorage: PiAuthStorage;
  modelRegistry: PiModelRegistry;
};

export type RunProviderCommandOptions = {
  yes?: boolean;
  all?: boolean;
  apiKey?: string;
  homeOverride?: string;
  services?: ProviderServices;
  writeOut?: (text: string) => void;
  writeErr?: (text: string) => void;
};

export function createProviderServices(homeOverride?: string): ProviderServices {
  const paths = getCodeninjaPaths(homeOverride);
  const authStorage = createFileAuthStorage(paths);
  return {
    paths,
    authStorage,
    modelRegistry: createPiModelRegistry(authStorage)
  };
}

export function createFileAuthStorage(paths: CodeninjaPaths): PiAuthStorage {
  return {
    loadAll: () => loadAuthFile(paths),
    get: (provider) => loadAuthFile(paths)[provider],
    set: (provider, entry) => {
      ensureCodeninjaHome(paths);
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
      await commandConfig(rest, services, writeOut);
      return;
    default:
      throw new CodeninjaError("invalid_args", "expected provider command: list, login, logout, auth-status, models, or config");
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
      onPrompt: async (prompt) => promptForSecret(prompt.message),
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
      throw new CodeninjaError("invalid_args", "provider logout without a provider requires --yes confirmation");
    }
    services.authStorage.clear();
    return;
  }
  services.authStorage.delete(args[0]);
}

async function commandConfig(
  args: string[],
  services: ProviderServices,
  writeOut: (text: string) => void
): Promise<void> {
  const [subcommand, ...rest] = args;
  if (!subcommand) {
    const settings = loadProviderSettings(services.paths);
    writeOut(`${JSON.stringify(providerConfigJson(services, settings, loadUserConfigDefaults(services.paths)), null, 2)}\n`);
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
        throw new CodeninjaError("invalid_args", `unknown model ${provider}/${model}`);
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
      throw new CodeninjaError("invalid_args", `unknown provider config command ${subcommand}`);
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
  userConfigDefaults: ProviderSettings = {}
): Record<string, unknown> {
  const provider = settings.defaultProvider ?? userConfigDefaults.defaultProvider;
  return {
    home: services.paths.home,
    authPath: services.paths.authPath,
    modelsPath: services.paths.modelsPath,
    settingsPath: services.paths.settingsPath,
    configTomlPath: services.paths.configTomlPath,
    sessionsDir: services.paths.sessionsDir,
    defaultProvider: settings.defaultProvider ?? userConfigDefaults.defaultProvider ?? null,
    defaultModel: settings.defaultModel ?? userConfigDefaults.defaultModel ?? null,
    defaultDepth: settings.defaultDepth ?? userConfigDefaults.defaultDepth ?? null,
    defaultReasoning: settings.defaultReasoning ?? userConfigDefaults.defaultReasoning ?? null,
    effectiveDepth: settings.defaultDepth ?? userConfigDefaults.defaultDepth ?? "normal",
    effectiveReasoning: settings.defaultReasoning ?? userConfigDefaults.defaultReasoning ?? "high",
    auth: provider ? services.modelRegistry.authStatus(provider) : null
  };
}

function loadUserConfigDefaults(paths: CodeninjaPaths): ProviderSettings {
  if (!existsSync(paths.configTomlPath)) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = parseToml(readFileSync(paths.configTomlPath, "utf8"));
  } catch (cause) {
    throw new CodeninjaError("config_error", `failed to parse config file at ${paths.configTomlPath}`, {
      context: { path: paths.configTomlPath },
      cause
    });
  }
  const result = rawConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new CodeninjaError("config_error", `invalid config file at ${paths.configTomlPath}`, {
      context: { path: paths.configTomlPath, issues: result.error.issues }
    });
  }

  const defaults: ProviderSettings = {};
  if (result.data.llm?.provider !== undefined) {
    defaults.defaultProvider = result.data.llm.provider;
  }
  if (result.data.llm?.model !== undefined) {
    defaults.defaultModel = result.data.llm.model;
  }
  if (result.data.llm?.reasoning !== undefined) {
    defaults.defaultReasoning = result.data.llm.reasoning;
  }
  if (result.data.review?.depth !== undefined) {
    defaults.defaultDepth = result.data.review.depth;
  }
  return defaults;
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
    throw new CodeninjaError("invalid_args", `unknown provider ${provider}`, {
      context: { available: services.modelRegistry.listProviders() }
    });
  }
}

function loadAuthFile(paths: CodeninjaPaths): Record<string, ProviderAuthEntry> {
  if (!existsSync(paths.authPath)) {
    return {};
  }
  const parsed = JSON.parse(readFileSync(paths.authPath, "utf8")) as Record<string, ProviderAuthEntry>;
  for (const entry of Object.values(parsed)) {
    registerAuthEntry(entry);
  }
  return parsed;
}

function writeAuthFile(paths: CodeninjaPaths, auth: Record<string, ProviderAuthEntry>): void {
  ensureCodeninjaHome(paths);
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
      throw new CodeninjaError("invalid_args", "credential value cannot be empty");
    }
    return value.trim();
  } finally {
    rl.close();
  }
}

function requireArg(value: string | undefined, usage: string): string {
  if (!value) {
    throw new CodeninjaError("invalid_args", `usage: codeninja ${usage}`);
  }
  return value;
}

function parseDepth(value: string): ReviewDepth {
  if (value === "light" || value === "normal" || value === "deep") {
    return value;
  }
  throw new CodeninjaError("invalid_args", "depth must be one of: light, normal, deep");
}

function parseReasoning(value: string): ReasoningLevel {
  if (value === "low" || value === "medium" || value === "high" || value === "xhigh") {
    return value;
  }
  throw new CodeninjaError("invalid_args", "reasoning must be one of: low, medium, high, xhigh, auto");
}
