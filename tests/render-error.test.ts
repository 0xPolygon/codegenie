import { describe, expect, it } from "vitest";

import { renderCodegenieError } from "../src/cli/render-error.js";

describe("renderCodegenieError", () => {
  it("prints the provider explanation under a usage-limit failure", () => {
    const providerMessage =
      "You have reached your specified API usage limits. You will regain access on 2026-09-01 at 00:00 UTC.";
    expect(
      renderCodegenieError({
        code: "llm_call_failed",
        message: "LLM provider usage limit reached",
        context: { reason: "usage_limit", providerMessage }
      })
    ).toBe(`llm_call_failed: LLM provider usage limit reached\n${providerMessage}\n`);
  });

  it("falls back to code and message when the provider said nothing", () => {
    expect(renderCodegenieError({ code: "llm_call_failed", message: "LLM provider call failed" })).toBe(
      "llm_call_failed: LLM provider call failed\n"
    );
    expect(
      renderCodegenieError({
        code: "llm_call_failed",
        message: "LLM provider call failed",
        context: { providerMessage: "   " }
      })
    ).toBe("llm_call_failed: LLM provider call failed\n");
  });

  it("keeps help text taking precedence over a provider message", () => {
    expect(
      renderCodegenieError({
        code: "invalid_args",
        message: "bad flag",
        context: { helpText: "usage: codegenie review\n", hint: "try --help", providerMessage: "ignored" }
      })
    ).toBe("bad flag\n\nusage: codegenie review\n\ntry --help\n");
  });
});
