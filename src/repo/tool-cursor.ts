import { CodegenieError } from "../util/errors.js";
import { sha256Hex } from "../util/hashing.js";

export function toolCursorBinding(parts: readonly unknown[]): string {
  return sha256Hex(JSON.stringify(parts));
}

export function encodeToolCursor(binding: string, position: unknown): string {
  return Buffer.from(JSON.stringify({ version: 1, binding, position })).toString("base64url");
}

export function decodeToolCursor(cursor: string, binding: string): unknown {
  if (/^[\w-]{1,4096}$/u.test(cursor)) {
    try {
      const payload: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
      if (payload && typeof payload === "object" && "version" in payload && payload.version === 1 &&
          "binding" in payload && payload.binding === binding && "position" in payload) return payload.position;
    } catch {
      // Report the same typed error for malformed and mismatched cursors.
    }
  }
  throw new CodegenieError("invalid_args", "Cursor does not match the pinned revision and tool query.");
}
