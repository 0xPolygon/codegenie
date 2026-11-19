import { mkdtempSync, rmSync } from "node:fs";
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

async function capture(provider: string, model: string, forced: boolean): Promise<unknown> {
  const adapter = createRealPiAiAdapter();
  const ref = adapter.resolveModel({ provider, model });
  expect(ref).toBeDefined();
  let payload: unknown;
  await adapter.complete(ref!, {
    messages: [{ role: "user", content: "synthetic", timestamp: 0 }],
    tools: [{ name: "submit_review", description: "Submit", parameters: { type: "object", properties: {} } }]
  }, {
    submitToolName: "submit_review", reasoning: "high", maxRetries: 0,
    ...(forced ? { toolChoice: { type: "tool", name: "submit_review" } } : {}),
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
    { issue: "#74", provider: "google", model: "gemini-2.5-flash", env: "GEMINI_API_KEY", ordinary: { "config.thinkingConfig.thinkingBudget": 24576 } },
    { issue: "#75", provider: "mistral", model: "codestral-2508", env: "MISTRAL_API_KEY", ordinary: {} },
    { issue: "#76", provider: "radius", model: "balanced", env: "RADIUS_API_KEY", ordinary: { "options.reasoning": "high" } }
  ])("$issue $provider/$model sends the ordinary reasoning fields when forcing submit", async ({ provider, model, env, ordinary }) => {
    const home = mkdtempSync(path.join(tmpdir(), "codegenie-forced-reasoning-"));
    vi.stubEnv("CODEGENIE_HOME", home);
    vi.stubEnv(env, "test-only-key");
    try {
      const plain = await capture(provider, model, false);
      const forced = await capture(provider, model, true);
      expect(reasoningFields(plain)).toEqual(ordinary);
      expect(reasoningFields(forced)).toEqual(reasoningFields(plain));
      // The forced request still forces the submit tool.
      expect(JSON.stringify(forced)).not.toEqual(JSON.stringify(plain));
    } finally {
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
