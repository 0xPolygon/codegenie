import { CodegenieError } from "../util/errors.js";
import { sha256Hex } from "../util/hashing.js";

export function toolCursorBinding(parts: readonly unknown[]): string {
  return sha256Hex(JSON.stringify(parts));
}

export function encodeToolCursor(binding: string, position: unknown): string {
  return Buffer.from(JSON.stringify({ version: 1, binding, position })).toString("base64url");
}

export function decodeToolCursor(cursor: string, binding: string): unknown {
  let reason: "malformed" | "binding_mismatch" = "malformed";
  if (/^[\w-]{1,4096}$/u.test(cursor)) {
    try {
      const payload: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
      if (payload && typeof payload === "object" && "version" in payload && payload.version === 1 &&
          "binding" in payload && typeof payload.binding === "string" && "position" in payload) {
        if (payload.binding === binding) return payload.position;
        reason = "binding_mismatch";
      }
    } catch {
      // Keep malformed cursors distinct from a valid cursor for another query.
    }
  }
  const detail = reason === "malformed" ? " The cursor is malformed or incomplete." : "";
  throw new CodegenieError("invalid_args", `Cursor does not match the pinned revision and tool query.${detail} ` +
    "Cursors are opaque: copy the entire cursor verbatim and reuse the original arguments and revision, or omit the cursor to restart.",
  { context: { reason } });
}
