import { describe, expect, it } from "vitest";
import { textRepository } from "./helpers/text-repository.js";

describe("find_symbol_mentions with dotted names", () => {
  it("recognizes TypeScript and Go member expressions without substring or text-only matches", async () => {
    const fixture = await textRepository({
      "src/consumer.ts": [
        "function run(sessions: any, mysessions: any, other: any) {",
        "  sessions.load();",
        "  this.sessions.load();",
        "  mysessions.load();",
        "  other.load();",
        '  console.log("sessions.load");',
        "  // sessions.load",
        "  load();",
        "}"
      ].join("\n") + "\n",
      "src/consumer.go": [
        "package consumer",
        "func run(sessions *Store, mysessions *Store) {",
        "  sessions.Load()",
        "  mysessions.Load()",
        "}"
      ].join("\n") + "\n"
    });
    try {
      const ts = await fixture.tools.findSymbolMentions("sessions.load");
      expect(ts.results.map(row => `${row.path}:${row.line}`)).toEqual(["src/consumer.ts:2", "src/consumer.ts:3"]);
      const go = await fixture.tools.findSymbolMentions("sessions.Load");
      expect(go.results.map(row => `${row.path}:${row.line}`)).toEqual(["src/consumer.go:3"]);
      const plain = await fixture.tools.findSymbolMentions("load");
      expect(plain.results.some(row => row.path === "src/consumer.ts" && row.line === 8)).toBe(true);
    } finally { fixture.dispose(); }
  });
});
