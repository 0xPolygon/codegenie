import { describe, expect, it } from "vitest";
import { decodeToolCursor, encodeToolCursor, toolCursorBinding } from "../src/repo/tool-cursor.js";

describe("bound tool cursor recovery", () => {
  const binding = toolCursorBinding(["read_change", "head", "src/a.ts"]);
  const cursor = encodeToolCursor(binding, { row: 4 });

  it("identifies a truncated cursor and explains how to recover without echoing it", () => {
    const truncated = cursor.slice(0, -3);
    expect(() => decodeToolCursor(truncated, binding)).toThrowError(/malformed or incomplete/u);
    try {
      decodeToolCursor(truncated, binding);
    } catch (error) {
      expect(error).toMatchObject({ code: "invalid_args", context: { reason: "malformed" } });
      expect((error as Error).message).toContain("copy the entire cursor verbatim");
      expect((error as Error).message).toContain("omit the cursor to restart");
      expect((error as Error).message).not.toContain(truncated);
    }
  });

  it("distinguishes a valid cursor for a different query and preserves binding", () => {
    const otherBinding = toolCursorBinding(["read_change", "head", "src/b.ts"]);
    expect(decodeToolCursor(cursor, binding)).toEqual({ row: 4 });
    try {
      decodeToolCursor(cursor, otherBinding);
      expect.fail("a different query must not accept the cursor");
    } catch (error) {
      expect(error).toMatchObject({ code: "invalid_args", context: { reason: "binding_mismatch" } });
      expect((error as Error).message).toContain("reuse the original arguments and revision");
      expect((error as Error).message).not.toContain(cursor);
      expect((error as Error).message).not.toContain(binding);
    }
  });
});
