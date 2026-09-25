import type { Models } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyLlmApiKey, parseModelAliases, resolveModelConfig } from "../src/github-action/models.js";
import type { PiAiAdapter } from "../src/llm/llm-runner.js";
import { createPiRunner, createRealPiAiAdapter, modelResolutionMessage } from "../src/llm/pi-runner.js";
import { createPiModelRegistry, type PiAuthStorage, type ProviderAuthEntry } from "../src/provider/provider-services.js";
import {
  describeProviderCredentials,
  getAmbientCredentialNote,
  getPiApiKeyEnvVarNames,
  getPiCredentialEnvVarNames
} from "../src/provider/pi-ai-models.js";
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

// providerEnvValue falls back to process.env, so every credential var a test
// relies on being absent is stubbed empty (falsy) rather than assumed unset.
function clearProviderEnv(provider: string): void {
  for (const name of getPiCredentialEnvVarNames(provider)) {
    vi.stubEnv(name, "");
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("provider credential table", () => {
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

  it("describes how to authenticate each kind of provider", () => {
    expect(describeProviderCredentials("google")).toBe("set GEMINI_API_KEY (or run `codegenie provider login google`)");
    expect(describeProviderCredentials("amazon-bedrock")).toContain("AWS_ACCESS_KEY_ID");
    expect(describeProviderCredentials("google-vertex")).toContain("GOOGLE_CLOUD_API_KEY or Application Default Credentials");
    expect(describeProviderCredentials("openai-codex")).toContain("self-hosted runner");
  });
});

describe("model resolution failure reasons", () => {
  it("distinguishes unknown, deprecated, and credential-less models", () => {
    clearProviderEnv("anthropic");
    const adapter = createRealPiAiAdapter({ authStorage: authStorage() });
    expect(adapter.resolveModel({ provider: "anthropic", model: "claude-opus-5" })).toBeUndefined();

    const missing = adapter.explainUnresolvedModel?.({ provider: "anthropic", model: "claude-opus-5" });
    expect(missing).toEqual({ kind: "missing_credentials", provider: "anthropic", model: "claude-opus-5" });
    expect(modelResolutionMessage(missing!)).toBe(
      "no credentials for provider anthropic: set ANTHROPIC_API_KEY (or run `codegenie provider login anthropic`)"
    );

    const unknown = adapter.explainUnresolvedModel?.({ provider: "anthropic", model: "claude-opus-5:hgh" });
    expect(unknown).toEqual({ kind: "unknown_model", provider: "anthropic", model: "claude-opus-5:hgh" });
    expect(modelResolutionMessage(unknown!)).toContain("unknown model anthropic/claude-opus-5:hgh");

    const deprecated = adapter.explainUnresolvedModel?.({ provider: "anthropic", model: "claude-3-opus-20240229" });
    expect(deprecated).toMatchObject({ kind: "deprecated_model" });
    expect(modelResolutionMessage(deprecated!)).toBe("model anthropic/claude-3-opus-20240229 is deprecated; choose a current model");
  });

  it("does not report a nonexistent provider as missing credentials", () => {
    const adapter = createRealPiAiAdapter({ authStorage: authStorage() });
    expect(adapter.explainUnresolvedModel?.({ provider: "opnerouter" })).toEqual({ kind: "unresolved", provider: "opnerouter" });
    expect(adapter.explainUnresolvedModel?.({ provider: "opnerouter", model: "x" })).toMatchObject({ kind: "unknown_model" });
    clearProviderEnv("anthropic");
    expect(adapter.explainUnresolvedModel?.({ provider: "anthropic" })).toEqual({ kind: "missing_credentials", provider: "anthropic" });
  });

  it("never labels an unexpected lookup error as missing credentials", () => {
    const throwing = {
      getModel: () => {
        throw new Error("registry exploded");
      },
      getModels: () => [],
      getProviders: () => [],
      getProvider: () => undefined
    } as unknown as Models;
    const adapter = createRealPiAiAdapter({ authStorage: authStorage(), models: throwing });
    const failure = adapter.explainUnresolvedModel?.({ provider: "anthropic", model: "claude-opus-5" });
    expect(failure).toMatchObject({ kind: "unresolved" });
    expect(modelResolutionMessage(failure!)).toContain("no usable LLM model could be resolved");
  });

  it("resolves normally when credentials exist, leaving no failure to explain", () => {
    clearProviderEnv("anthropic");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test-only");
    const adapter = createRealPiAiAdapter({ authStorage: authStorage() });
    expect(adapter.resolveModel({ provider: "anthropic", model: "claude-opus-5" })?.apiKey).toBe("sk-ant-test-only");
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
      message: expect.stringContaining("no credentials for provider anthropic: set ANTHROPIC_API_KEY"),
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
  it("wins over competing env vars", () => {
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "bearer-token-competing");
    vi.stubEnv("ANTHROPIC_OAUTH_TOKEN", "oauth-token-competing");
    vi.stubEnv("ANTHROPIC_API_KEY", "stale-native-key");
    vi.stubEnv("LLM_API_KEY", "explicit-llm-api-key");
    const config = resolveModelConfig("opus", parseModelAliases("opus: anthropic/claude-opus-5\nsonnet: anthropic/claude-sonnet-5"));

    expect(applyLlmApiKey(process.env, config)).toEqual(["anthropic"]);

    expect(process.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(process.env.ANTHROPIC_OAUTH_TOKEN).toBeUndefined();
    expect(process.env.ANTHROPIC_API_KEY).toBe("explicit-llm-api-key");
    const model = createRealPiAiAdapter({ authStorage: authStorage() }).resolveModel({ provider: "anthropic", model: "claude-opus-5" });
    expect(model?.apiKey).toBe("explicit-llm-api-key");
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
