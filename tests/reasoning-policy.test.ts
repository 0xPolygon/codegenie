import { describe, expect, it } from "vitest";
import { selectReasoningEffort } from "../src/provider/reasoning.js";

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
  ])("composition steps down %s within %j to %s", (configured, supported, expected) => {
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
