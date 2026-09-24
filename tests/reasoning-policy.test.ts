import { describe, expect, it } from "vitest";
import { normalizeReasoningLevel, selectReasoningEffort } from "../src/provider/reasoning.js";

describe("relative reasoning policy", () => {
  it.each([
    ["max", ["max", "high", "low"], "high"],
    ["high", ["max", "high", "low"], "low"],
    ["low", ["max", "high", "low"], "low"],
    ["max", ["minimal", "low", "medium", "high", "xhigh", "max"], "xhigh"],
    ["high", ["minimal", "low", "medium", "high"], "medium"],
    ["minimal", ["off", "minimal", "high"], "minimal"],
    ["high", ["high"], "high"],
    ["high", [], "high"],
    ["high", ["off"], "high"],
    ["max", ["low", "high"], "max"]
  ])("relative policy steps down %s within %j to %s", (configured, supported, expected) => {
    expect(selectReasoningEffort(configured, supported, "one_level_lower")).toBe(expected);
    expect(selectReasoningEffort(configured, supported, "configured")).toBe(configured);
  });
  it.each([
    [["off", "minimal", "low", "high"], "minimal"],
    [["high", "low"], "low"],
    [["high"], "high"],
    [[], "max"],
    [["off"], "max"]
  ])("repair selects the lowest non-off effort within %j", (supported, expected) => {
    expect(selectReasoningEffort("max", supported, "lowest_supported")).toBe(expected);
  });
});

describe("CLI reasoning normalization", () => {
  it.each([
    ["minimal", "low"], ["low", "low"], ["medium", "high"], ["high", "high"], ["xhigh", "max"], ["max", "max"]
  ] as const)("maps %s to %s on a low/high/max model", (requested, expected) => {
    expect(normalizeReasoningLevel(requested, ["low", "high", "max"])).toBe(expected);
  });
  it("preserves native levels, handles sparse capabilities, and never chooses off", () => {
    expect(normalizeReasoningLevel("minimal", ["minimal", "low", "high"])).toBe("minimal");
    expect(normalizeReasoningLevel("medium", ["low", "medium", "high"])).toBe("medium");
    expect(normalizeReasoningLevel("xhigh", ["low", "xhigh", "max"])).toBe("xhigh");
    expect(normalizeReasoningLevel("max", ["low", "high", "xhigh"])).toBe("xhigh");
    expect(normalizeReasoningLevel("low", ["off", "high"])).toBe("high");
    expect(normalizeReasoningLevel("max", [])).toBe("max");
    expect(normalizeReasoningLevel("low", ["off"])).toBe("low");
  });
});
