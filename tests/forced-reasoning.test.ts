import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createRealPiAiAdapter } from "../src/llm/pi-runner.js";

// Forced submits must send the reasoning fields Pi's native (ordinary-path)
// mapping sends. Payloads are captured before transport with dummy keys.
const REASONING_KEYS = /^(thinking|thinkingBudget|thinkingLevel|reasoningEffort|reasoning_effort|reasoning|promptMode|prompt_mode)$/u;

function reasoningFields(payload: unknown): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const scan = (value: unknown, prefix: string): void => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      const keyPath = prefix ? `${prefix}.${key}` : key;
      // A matched key is recorded whatever its shape (objects as a JSON
      // snapshot), so reasoning sent as { effort } or { budget_tokens } is seen.
      if (REASONING_KEYS.test(key)) result[keyPath] = child !== null && typeof child === "object" ? JSON.stringify(child) : child;
      else scan(child, keyPath);
    }
  };
  scan(payload, "");
  return result;
}

function valueAt(payload: unknown, dottedPath: string): unknown {
  return dottedPath.split(".").reduce<unknown>((value, key) =>
    value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined, payload);
}

async function capture(provider: string, model: string, forced: boolean, options: { forceSubmitToolChoice?: boolean } = {}): Promise<unknown> {
  const adapter = createRealPiAiAdapter();
  const ref = await adapter.resolveModel({ provider, model });
  expect(ref).toBeDefined();
  let payload: unknown;
  await adapter.complete(ref!, {
    messages: [{ role: "user", content: "synthetic", timestamp: 0 }],
    tools: [{ name: "submit_review", description: "Submit", parameters: { type: "object", properties: {} } }]
  }, {
    submitToolName: "submit_review", reasoning: "high", maxRetries: 0,
    ...(forced ? { toolChoice: { type: "tool", name: "submit_review" } } : {}),
    ...options,
    onPayload: (body: unknown) => { payload = body; throw new Error("stop before network"); }
  }).catch(() => undefined);
  expect(payload).toBeDefined();
  return payload;
}

describe("forced submits keep Pi's native reasoning mapping", () => {
  it("observes reasoning fields sent as objects, not only scalars (#75)", () => {
    expect(reasoningFields({ options: { reasoning: { effort: "high" } }, thinking: { type: "enabled", budget_tokens: 1024 } })).toEqual({
      "options.reasoning": JSON.stringify({ effort: "high" }),
      thinking: JSON.stringify({ type: "enabled", budget_tokens: 1024 })
    });
  });

  it.each([
    { issue: "#74", provider: "google", model: "gemini-2.5-flash", env: "GEMINI_API_KEY", ordinary: { "config.thinkingConfig.thinkingBudget": 24576 },
      forcedChoice: ["config.toolConfig.functionCallingConfig.mode", "ANY"] },
    { issue: "#75", provider: "mistral", model: "codestral-2508", env: "MISTRAL_API_KEY", ordinary: {},
      forcedChoice: ["toolChoice", { type: "function", function: { name: "submit_review" } }] },
    { issue: "#76", provider: "radius", model: "balanced", env: "RADIUS_API_KEY", ordinary: { "options.reasoning": "high" },
      forcedChoice: ["options.toolChoice", "required"] }
  ])("$issue $provider/$model sends the ordinary reasoning fields when forcing submit", async ({ provider, model, env, ordinary, forcedChoice }) => {
    const home = mkdtempSync(path.join(tmpdir(), "codegenie-forced-reasoning-"));
    vi.stubEnv("CODEGENIE_HOME", home);
    vi.stubEnv(env, "test-only-key");
    try {
      const plain = await capture(provider, model, false);
      const forced = await capture(provider, model, true);
      expect(reasoningFields(plain)).toEqual(ordinary);
      expect(reasoningFields(forced)).toEqual(reasoningFields(plain));
      // The forced request carries the provider-native forcing choice.
      const [choicePath, choice] = forcedChoice as [string, unknown];
      expect(valueAt(forced, choicePath)).toEqual(choice);
      expect(valueAt(plain, choicePath)).not.toEqual(choice);
    } finally {
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("forced submits over Vercel's Anthropic Messages API", () => {
  it.each([
    { model: "openai/gpt-6-astra", alwaysOn: true },
    { model: "openai/gpt-6.1-sol", alwaysOn: true },
    { model: "openai/gpt-6.2-sol", alwaysOn: true },
    { model: "openai/gpt-6.2-astra", alwaysOn: true },
    { model: "openai/gpt-6.2-sol-fast", alwaysOn: true },
    { model: "openai/gpt-6-luna", alwaysOn: false }
  ])("uses a supported thinking mode for $model", async ({ model, alwaysOn }) => {
    const home = mkdtempSync(path.join(tmpdir(), "codegenie-vercel-thinking-"));
    vi.stubEnv("CODEGENIE_HOME", home);
    vi.stubEnv("AI_GATEWAY_API_KEY", "test-only-key");
    try {
      const forced = await capture("vercel-ai-gateway", model, true);
      if (alwaysOn) {
        const ordinary = await capture("vercel-ai-gateway", model, false);
        const reasoning = reasoningFields(ordinary);
        expect(reasoning).toHaveProperty("thinking");
        expect(reasoningFields(forced)).toEqual(reasoning);
        expect(valueAt(forced, "tool_choice")).toEqual({ type: "auto" });
      } else {
        expect(valueAt(forced, "thinking")).toEqual({ type: "disabled" });
        expect(valueAt(forced, "tool_choice")).toEqual({ type: "tool", name: "submit_review" });
      }
    } finally {
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("forced submits over Amazon Bedrock (#47)", () => {
  it.each([
    { model: "us.anthropic.claude-opus-5-5", thinking: "adaptive" },
    { model: "global.anthropic.claude-sonnet-5-5", thinking: "adaptive" },
    { model: "us.anthropic.claude-fable-5-2", thinking: "adaptive" },
    { model: "us.anthropic.claude-opus-4-5-20251101-v1:0", thinking: "enabled" },
    { model: "amazon.nova-2-lite-v1:0", thinking: undefined }
  ])("uses supported tool choice and keeps native reasoning for $model", async ({ model, thinking }) => {
    const home = mkdtempSync(path.join(tmpdir(), "codegenie-bedrock-submit-"));
    vi.stubEnv("CODEGENIE_HOME", home);
    vi.stubEnv("AWS_REGION", "us-east-1");
    vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "test-only-key");
    try {
      const ordinary = await capture("amazon-bedrock", model, false);
      const forced = await capture("amazon-bedrock", model, true);
      const optedOut = await capture("amazon-bedrock", model, true, { forceSubmitToolChoice: false });
      expect(valueAt(ordinary, "additionalModelRequestFields.thinking.type")).toBe(thinking);
      const nativeFields = valueAt(ordinary, "additionalModelRequestFields");
      expect(valueAt(forced, "additionalModelRequestFields")).toEqual(nativeFields);
      expect(valueAt(optedOut, "additionalModelRequestFields")).toEqual(nativeFields);
      expect(valueAt(forced, "toolConfig.toolChoice")).toEqual(thinking === undefined
        ? { tool: { name: "submit_review" } }
        : { auto: {} });
      expect(valueAt(optedOut, "toolConfig.toolChoice")).toEqual({ auto: {} });
    } finally {
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// OpenAI-family Responses APIs get the forced choice injected by
// withToolChoicePayload after Pi's own onPayload hooks, so the request body is
// captured at a blocked fetch instead (Codex compresses it with zstd).
describe("forced submits on Responses APIs carry the native tool_choice", () => {
  it.each([
    { provider: "openai", model: "gpt-4" },
    { provider: "azure", model: "gpt-4" },
    { provider: "openai-codex", model: "gpt-5.6-sol" }
  ])("$provider/$model sends tool_choice for the submit tool", async ({ provider, model }) => {
    const home = mkdtempSync(path.join(tmpdir(), "codegenie-forced-responses-"));
    vi.stubEnv("CODEGENIE_HOME", home);
    vi.stubEnv("OPENAI_API_KEY", "test-only-key");
    vi.stubEnv("AZURE_OPENAI_API_KEY", "test-only-key");
    vi.stubEnv("AZURE_OPENAI_BASE_URL", "https://example.openai.azure.com/openai/v1");
    // A fake, unexpired Codex login so the adapter resolves without network.
    const access = `x.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, "https://api.openai.com/auth": { chatgpt_account_id: "acct" } })).toString("base64url")}.y`;
    writeFileSync(path.join(home, "auth.json"), JSON.stringify({ "openai-codex": { type: "oauth", createdAt: new Date().toISOString(),
      credentials: { access, refresh: "test-only-refresh", expires: Date.now() + 3_600_000, accountId: "acct" } } }));
    let body: unknown;
    vi.stubGlobal("fetch", async (_url: unknown, init?: { body?: unknown }) => {
      body = init?.body;
      throw new Error("transport blocked");
    });
    try {
      const adapter = createRealPiAiAdapter();
      const ref = await adapter.resolveModel({ provider, model });
      expect(ref).toBeDefined();
      await adapter.complete(ref!, {
        messages: [{ role: "user", content: "synthetic", timestamp: 0 }],
        tools: [{ name: "submit_review", description: "Submit", parameters: { type: "object", properties: {} } }]
      }, { submitToolName: "submit_review", reasoning: "high", maxRetries: 0, toolChoice: { type: "tool", name: "submit_review" } }).catch(() => undefined);
      const bytes = body instanceof Uint8Array ? (body[0] === 0x28 && body[1] === 0xb5 ? zstdDecompressSync(body) : body) : undefined;
      const text = typeof body === "string" ? body : bytes !== undefined ? new TextDecoder().decode(bytes) : undefined;
      expect(text).toBeDefined();
      expect((JSON.parse(text!) as { tool_choice?: unknown }).tool_choice).toEqual({ type: "function", name: "submit_review" });
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
