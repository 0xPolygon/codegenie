import type { Models } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyLlmApiKey, parseModelAliases, resolveModelConfig } from "../src/github-action/models.js";
import type { PiAiAdapter } from "../src/llm/llm-runner.js";
import { createPiRunner, createRealPiAiAdapter } from "../src/llm/pi-runner.js";
import { createPiCredentialStore, createPiModelRegistry, type PiAuthStorage, type ProviderAuthEntry } from "../src/provider/provider-services.js";
import {
  getAmbientCredentialNote,
  getCodegeniePiModels,
  getPiApiKeyEnvVarNames,
  getPiCredentialEnvVarNames
} from "../src/provider/pi-ai-models.js";
import { clearRegisteredSecretsForTests, stripCredentials } from "../src/telemetry/redaction.js";
import type { TelemetryRecorder } from "../src/telemetry/telemetry-recorder.js";
import type { Logger } from "../src/types.js";
import { CodegenieError } from "../src/util/errors.js";

function authStorage(entries: Record<string, ProviderAuthEntry> = {}): PiAuthStorage {
  return {
    loadAll: () => ({ ...entries }),
    get: (provider) => entries[provider],
    set: () => undefined,
    delete: () => undefined,
    clear: () => undefined
  };
}

function clearAnthropicEnv(): void {
  for (const name of ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_FEDERATION_RULE_ID"]) {
    vi.stubEnv(name, undefined);
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  clearRegisteredSecretsForTests();
});

describe("Pi credential preflight", () => {
  const createdAt = new Date(0).toISOString();
  const fixtures = [
    { name: "bearer only", provider: "anthropic", env: { ANTHROPIC_AUTH_TOKEN: "fixture-bearer-value" },
      requestAuth: { headers: { Authorization: "Bearer fixture-bearer-value" } } },
    { name: "stored key", provider: "anthropic", env: { ANTHROPIC_API_KEY: "competing-env-key" },
      stored: { type: "api_key", apiKey: "fixture-stored-key", createdAt }, requestAuth: { apiKey: "fixture-stored-key" } },
    { name: "stored OAuth", provider: "anthropic",
      stored: { type: "oauth", credentials: { access: "fixture-oauth-access", refresh: "fixture-oauth-refresh", expires: 0 }, createdAt } },
    { name: "Vertex ADC", provider: "google-vertex", env: { GOOGLE_APPLICATION_CREDENTIALS: "/fixture/adc.json", GOOGLE_CLOUD_PROJECT: "fixture-project", GOOGLE_CLOUD_LOCATION: "global" }, requestAuth: {} },
    { name: "Bedrock role", provider: "amazon-bedrock", env: { AWS_WEB_IDENTITY_TOKEN_FILE: "/fixture/aws-identity" }, requestAuth: {} }
  ] as const;

  it.each(fixtures)("resolves $name using the same Pi auth configuration as dispatch", async ({ provider, ...fixture }) => {
    const env: Record<string, string> = "env" in fixture ? fixture.env : {};
    const storage = authStorage("stored" in fixture ? { [provider]: fixture.stored } : {});
    const models = builtinModels({ credentials: createPiCredentialStore(storage), authContext: {
      env: async (name) => env[name],
      fileExists: async (file) => file === "/fixture/adc.json"
    } });
    const runtimeProvider = models.getProvider(provider)!;
    const dispatch = vi.spyOn(runtimeProvider, "streamSimple").mockImplementation(() => {
      throw new Error("stop at dispatch, before network");
    });
    const resolveAuth = vi.spyOn(models, "getAuth");
    const checkAuth = vi.spyOn(models, "checkAuth");
    const adapter = createRealPiAiAdapter({ authStorage: storage, models });
    const model = await adapter.resolveModel({ provider, model: models.getModels(provider)[0]!.id });
    expect(model).toMatchObject({ provider });
    expect(model).not.toHaveProperty("apiKey");
    expect(checkAuth).toHaveBeenCalledOnce();
    expect(resolveAuth).not.toHaveBeenCalled();
    const status = await createPiModelRegistry(storage, models).authStatus(provider);
    expect(status).toMatchObject({ configured: true, source: "stored" in fixture ? "stored" : "environment" });
    if ("requestAuth" in fixture) {
      await adapter.complete(model!, { messages: [{ role: "user", content: "fixture", timestamp: 0 }], tools: [] }, {
        submitToolName: "test"
      }).catch(() => undefined);
      expect(dispatch).toHaveBeenCalledTimes(1);
      const options = dispatch.mock.calls[0]?.[2];
      expect(options).toMatchObject(fixture.requestAuth);
      expect(options?.apiKey).toBe("apiKey" in fixture.requestAuth ? fixture.requestAuth.apiKey : undefined);
    }
  });

  it("sends an Anthropic bearer token only in Authorization and registers it for redaction", async () => {
    clearAnthropicEnv();
    const token = "fixture-anthropic-header-token";
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", token);
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 401 }));
    vi.stubGlobal("fetch", fetch);
    const adapter = createRealPiAiAdapter({ authStorage: authStorage() });
    const model = await adapter.resolveModel({ provider: "anthropic", model: "claude-opus-5" });
    expect(model).toBeDefined();
    await adapter.complete(model!, { messages: [{ role: "user", content: "fixture", timestamp: 0 }], tools: [] }, {
      submitToolName: "test", maxRetries: 0
    });
    expect(fetch).toHaveBeenCalledOnce();
    const [request, init] = fetch.mock.calls[0]!;
    const headers = new Headers(init?.headers ?? (request instanceof Request ? request.headers : undefined));
    expect(headers.get("authorization")).toBe(`Bearer ${token}`);
    expect(headers.get("x-api-key")).toBeNull();
    expect(stripCredentials(token)).toBe("[redacted:secret]");
  });
});

describe("auth header redaction", () => {
  it("registers a credential Pi resolves only into a custom auth header (Cloudflare AI Gateway)", async () => {
    const key = "short-secret";
    vi.stubEnv("CLOUDFLARE_API_KEY", key);
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "fixture-account");
    vi.stubEnv("CLOUDFLARE_GATEWAY_ID", "fixture-gateway");
    const models = getCodegeniePiModels(createPiCredentialStore(authStorage()));
    const resolved = await models.getAuth("cloudflare-ai-gateway");
    expect(resolved?.auth.headers?.["cf-aig-authorization"]).toBe("Bearer " + key);
    expect(resolved?.auth.apiKey).toBeUndefined();
    expect(stripCredentials("upstream rejected Bearer " + key)).not.toContain(key);
  });
});

describe("Action key routing and credential documentation", () => {
  it("covers every registry provider with env var names or an ambient note", () => {
    const registry = createPiModelRegistry(authStorage());
    const providers = registry.listProviders();
    expect(providers.length).toBeGreaterThan(30);
    const uncovered = providers.filter((provider) => (
      getPiApiKeyEnvVarNames(provider).length === 0 && getAmbientCredentialNote(provider) === undefined
    ));
    expect(uncovered).toEqual([]);
  });

  it("maps the previously missing providers and keeps the bearer-token exclusion", () => {
    expect(getPiApiKeyEnvVarNames("qwen-token-plan")).toEqual(["QWEN_TOKEN_PLAN_API_KEY"]);
    expect(getPiApiKeyEnvVarNames("qwen-token-plan-cn")).toEqual(["QWEN_TOKEN_PLAN_CN_API_KEY"]);
    expect(getPiApiKeyEnvVarNames("qwen-token-plan-individual")).toEqual(["QWEN_TOKEN_PLAN_API_KEY"]);
    expect(getPiApiKeyEnvVarNames("anthropic")).not.toContain("ANTHROPIC_AUTH_TOKEN");
    expect(getPiCredentialEnvVarNames("anthropic")).toEqual(["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"]);
  });
});

describe("model resolution failure reasons", () => {
  it("distinguishes unknown, deprecated, and credential-less models", async () => {
    clearAnthropicEnv();
    const adapter = createRealPiAiAdapter({ authStorage: authStorage() });
    await expect(adapter.resolveModel({ provider: "anthropic", model: "claude-opus-5" })).resolves.toBeUndefined();

    await expect(adapter.resolveModelWithReason({ provider: "anthropic", model: "claude-opus-5" })).resolves.toEqual({
      failure: { kind: "missing_credentials", provider: "anthropic", model: "claude-opus-5" }
    });

    await expect(adapter.resolveModelWithReason({ provider: "anthropic", model: "claude-opus-5:hgh" })).resolves.toEqual({
      failure: { kind: "unknown_model", provider: "anthropic", model: "claude-opus-5:hgh" }
    });

    await expect(adapter.resolveModelWithReason({ provider: "anthropic", model: "claude-3-opus-20240229" })).resolves.toMatchObject({
      failure: { kind: "deprecated_model" }
    });
  });

  it("does not report a nonexistent provider as missing credentials", async () => {
    const adapter = createRealPiAiAdapter({ authStorage: authStorage() });
    await expect(adapter.resolveModelWithReason({ provider: "opnerouter" })).resolves.toEqual({ failure: { kind: "unresolved", provider: "opnerouter" } });
    await expect(adapter.resolveModelWithReason({ provider: "opnerouter", model: "x" })).resolves.toMatchObject({ failure: { kind: "unknown_model" } });
    clearAnthropicEnv();
    await expect(adapter.resolveModelWithReason({ provider: "anthropic" })).resolves.toEqual({ failure: { kind: "missing_credentials", provider: "anthropic" } });
  });

  it("never labels an unexpected lookup error as missing credentials", async () => {
    const throwing = {
      getModel: () => {
        throw new Error("registry exploded");
      },
      getModels: () => [],
      getProviders: () => [],
      getProvider: () => undefined
    } as unknown as Models;
    const adapter = createRealPiAiAdapter({ authStorage: authStorage(), models: throwing });
    await expect(adapter.resolveModelWithReason({ provider: "anthropic", model: "claude-opus-5" })).resolves.toMatchObject({ failure: { kind: "unresolved" } });
  });

  it("throws config_error with the specific message and a modelResolution marker", () => {
    function build(adapter: PiAiAdapter): void {
      createPiRunner({
        llmConfig: { provider: "anthropic", model: "claude-opus-5", maxConcurrentCalls: 1 },
        telemetry: telemetry(),
        logger: logger(),
        runSignal: new AbortController().signal,
        adapter,
        hooks: { checkpoint: () => "ok", onUsage: vi.fn() }
      });
    }
    const base = { resolveModel: () => undefined, complete: vi.fn(), validateToolCall: vi.fn() };

    let caught: unknown;
    try {
      build({ ...base, explainUnresolvedModel: () => ({ kind: "missing_credentials", provider: "anthropic", model: "claude-opus-5" }) });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CodegenieError);
    expect(caught).toMatchObject({
      code: "config_error",
      message: "no credentials for provider anthropic: configure native credentials or run `codegenie provider login anthropic`",
      context: { modelResolution: "missing_credentials" }
    });

    // Adapters without an explanation, or whose explanation throws, keep the
    // generic message — never a guessed "missing credentials".
    expect(() => build(base)).toThrow(/no usable LLM model could be resolved/u);
    expect(() => build({ ...base, explainUnresolvedModel: () => { throw new Error("boom"); } }))
      .toThrow(/no usable LLM model could be resolved/u);
  });
});

describe("llm-api-key routing reaches codegenie's resolver", () => {
  // A stored login is refused by the Action instead (pi-ai lets it own the
  // provider ahead of env vars); see the github-action entrypoint tests.
  it("wins over competing env vars", async () => {
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "bearer-token-competing");
    vi.stubEnv("ANTHROPIC_OAUTH_TOKEN", "oauth-token-competing");
    vi.stubEnv("ANTHROPIC_API_KEY", "stale-native-key");
    vi.stubEnv("LLM_API_KEY", "explicit-llm-api-key");
    const config = resolveModelConfig("opus", parseModelAliases("opus: anthropic/claude-opus-5\nsonnet: anthropic/claude-sonnet-5"));

    expect(applyLlmApiKey(process.env, config)).toEqual(["anthropic"]);

    expect(process.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(process.env.ANTHROPIC_OAUTH_TOKEN).toBeUndefined();
    expect(process.env.ANTHROPIC_API_KEY).toBe("explicit-llm-api-key");
    const models = builtinModels();
    const model = await createRealPiAiAdapter({ models }).resolveModel({ provider: "anthropic", model: "claude-opus-5" });
    expect(model).toMatchObject({ id: "claude-opus-5" });
    await expect(models.getAuth("anthropic")).resolves.toMatchObject({ auth: { apiKey: "explicit-llm-api-key" } });
  });
});

function telemetry(): TelemetryRecorder {
  return {
    runId: "model-resolution",
    runDir: undefined,
    event: vi.fn(),
    recordModelCall: vi.fn(),
    recordToolCall: vi.fn(() => "tc-1"),
    writeArtifact: vi.fn(async () => undefined),
    writeDebug: vi.fn(async () => undefined),
    flush: vi.fn(async () => undefined)
  } as unknown as TelemetryRecorder;
}

function logger(): Logger {
  const sink = vi.fn();
  return { debug: sink, info: sink, warn: sink, error: sink };
}
