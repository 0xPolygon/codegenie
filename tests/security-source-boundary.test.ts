import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config/schema.js";
import { buildSixSearchTool } from "../src/llm/tool-definitions.js";
import { createRunTelemetry } from "../src/telemetry/run-artifacts.js";
import { clearRegisteredSecretsForTests, registerSecret } from "../src/telemetry/redaction.js";
import { textRepository } from "./helpers/text-repository.js";

describe("source excerpt credential boundaries", () => {
  afterEach(clearRegisteredSecretsForTests);
  it("redacts registered multiline components across persisted page boundaries", async () => {
    registerSecret("BEGIN\nshort-key-123\nEND");
    registerSecret("-----BEGIN PRIVATE KEY-----\nYWJjZGVmZ2hpamtsbW5vcA==\n-----END PRIVATE KEY-----");
    registerSecret("BEGIN\nX\nlong-secret-line");
    const dir = mkdtempSync(path.join(tmpdir(), "codegenie-multiline-pages-"));
    try {
      const run = createRunTelemetry({ telemetryConfig: { ...defaultConfig.telemetry, enabled: true, debugTrace: true } });
      const attached = await run.attachRunDirectory(dir);
      await run.recorder.writeDebug("tool-calls", "page-one", { source: "BEGIN\nshort-key-123" });
      await run.recorder.writeDebug("tool-calls", "page-two", { source: "YWJjZGVmZ2hpamtsbW5vcA==\nEND\nX\nlong-secret-line" });
      await run.finalize({ status: "completed_full", exitCode: 0 });
      const folder = path.join(attached.runDir, "debug", "tool-calls");
      const stored = readdirSync(folder).map(file => readFileSync(path.join(folder, file), "utf8")).join("\n");
      expect(stored).not.toContain("short-key-123");
      expect(stored).not.toContain("YWJjZGVmZ2hpamtsbW5vcA==");
      expect(stored).not.toContain("long-secret-line");
      expect(stored).toContain("X"); // An individual component shorter than six remains a documented residual.
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("keeps a whole source example visible to the model while the debug writer redacts it", async () => {
    const secret = "sk-" + "AB12cd34".repeat(4);
    const fixture = await textRepository({ "src/example.ts": `const NEEDLE = "${secret}";\n` });
    const dir = mkdtempSync(path.join(tmpdir(), "codegenie-source-intact-"));
    try {
      const result = await buildSixSearchTool(fixture.tools).execute({ query: "NEEDLE", mode: "literal", pathGlob: "src/example.ts" }, new AbortController().signal);
      expect(result.text).toContain(secret);
      const run = createRunTelemetry({ telemetryConfig: { ...defaultConfig.telemetry, enabled: true, debugTrace: true } });
      const attached = await run.attachRunDirectory(dir);
      await run.recorder.writeDebug("tool-calls", "source-intact", { modelVisible: result.text });
      await run.finalize({ status: "completed_full", exitCode: 0 });
      const folder = path.join(attached.runDir, "debug", "tool-calls");
      const stored = readdirSync(folder).map(file => readFileSync(path.join(folder, file), "utf8")).join("\n");
      expect(stored).not.toContain(secret);
      expect(stored).toContain("[redacted:pattern]");
    } finally { fixture.dispose(); rmSync(dir, { recursive: true, force: true }); }
  });

  it.each(["start", "end"] as const)("preserves the match and does not persist an unregistered secret fragment at the %s cut", async side => {
    const secret = "sk-" + "AB12cd34".repeat(4);
    const line = side === "start" ? "x ".repeat(35) + secret + " x".repeat(47) + " NEEDLE " + "z ".repeat(300)
      : "x ".repeat(100) + "NEEDLE " + "x ".repeat(186) + secret + " z".repeat(100);
    const fixture = await textRepository({ "src/example.ts": line + "\n" });
    const dir = mkdtempSync(path.join(tmpdir(), "codegenie-source-boundary-"));
    try {
      const tool = buildSixSearchTool(fixture.tools);
      const result = await tool.execute({ query: "NEEDLE", mode: "literal", pathGlob: "src/example.ts" }, new AbortController().signal);
      const hit = result.searchResults?.[0];
      expect(hit).toBeDefined(); expect(hit?.matchText).toContain("NEEDLE");
      expect(hit?.matchText).not.toContain(secret.slice(0, 13));
      expect(hit?.matchText).not.toContain(secret.slice(-13));
      const start = (hit?.excerptStartColumn ?? 0) - 1;
      expect(line.slice(start, start + hit!.matchText.length)).toBe(hit!.matchText);
      expect(hit?.excerptEndColumn).toBe(start + hit!.matchText.length);
      expect(result.text).toContain(`ends at ${hit?.excerptEndColumn}`);
      const run = createRunTelemetry({ telemetryConfig: { ...defaultConfig.telemetry, enabled: true, debugTrace: true } });
      const attached = await run.attachRunDirectory(dir);
      await run.recorder.writeDebug("tool-calls", `source-${side}`, { modelVisible: result.text });
      await run.finalize({ status: "completed_full", exitCode: 0 });
      const folder = path.join(attached.runDir, "debug", "tool-calls");
      const stored = readdirSync(folder).map(file => readFileSync(path.join(folder, file), "utf8")).join("\n");
      expect(stored).not.toContain(secret.slice(0, 13));
      expect(stored).not.toContain(secret.slice(-13));
      expect(stored).toContain("NEEDLE");
    } finally { fixture.dispose(); rmSync(dir, { recursive: true, force: true }); }
  });
});
