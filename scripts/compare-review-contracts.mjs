// Usage: node scripts/compare-review-contracts.mjs <baseline-dist> <candidate-dist>
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { validateToolCall } from "@earendil-works/pi-ai";

const [baseline, candidate] = process.argv.slice(2);
assert(baseline && candidate, "Supply the two compiled dist directories.");
globalThis.fetch = async () => { throw new Error("This comparison must run offline."); };

const rawDiff = [
  "diff --git a/src/example.ts b/src/example.ts", "--- a/src/example.ts", "+++ b/src/example.ts",
  "@@ -1 +1 @@", "-export const retries = 3;", "+export const retries = 0;", ""
].join("\n");
const plan = { diffUnderstanding: { declaredIntent: "Update retries", inferredBehavior: "Removes retries" }, coverage: [] };
const coverage = { totalHunks: 1, reviewedHunks: 1, skippedHunks: 0, failedHunks: 0, verificationIncompleteCount: 0,
  coverageByLevel: { deep: 0, normal: 1, light: 0, skip: 0 }, degradedPlanning: false, budgetStopped: false, partial: false, reasons: [] };
const noFindings = { reviewStatus: "no_findings", noFindingReason: "Fixture review complete.", findings: [], followUpHints: [], uncertainties: [] };
const call = (id, name, args) => ({ type: "toolCall", id, name, arguments: args,
  ...(name.startsWith("submit_") ? { argumentParse: { state: "strict" } } : {}) });
const review = call("review", "submit_review", noFindings);
const invalidReview = call("invalid-review", "submit_review", { findings: "unexpected shape" });
const read = call("read", "read_range", { path: "src/example.ts", startLine: 1, endLine: 1, source: { kind: "head" } });
const meta = { backend: "text", precision: "exact", degraded: false, sourceUsed: "head" };
const repository = {
  readRange: async () => ({ text: "export const retries = 0;", meta }),
  readChangePromptDirectory: () => "src/example.ts, changed retry default",
  searchFilesPage() {}, listFilesPage() {}
};
const logger = { debug() {}, info() {}, warn() {}, error() {} };
const registry = { skillsForLens: () => [], skillsById: () => [] };
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function capture(dist) {
  const load = (relative) => import(pathToFileURL(path.resolve(dist, relative)));
  const [{ defaultConfig }, { parseDiff }, { createPromptBuilder }, { createPiRunner }, { runLensPackets },
    { clarifyFindingLocations }, { verifyFindings }, { dedupeRankAndComposeReview }] = await Promise.all([
    load("config/schema.js"), load("git/diff-parser.js"), load("skills/prompt-builder.js"), load("llm/pi-runner.js"),
    load("pipeline/lens-runner.js"), load("pipeline/finding-location.js"), load("pipeline/verifier.js"), load("pipeline/composer.js")
  ]);
  const diff = parseDiff(rawDiff), hunk = diff.files[0].hunks[0];
  const packet = {
    id: "packet-1", dispatchRank: [0, -1], kind: "hunk", prSummary: "Update retries", path: "src/example.ts", fileStatus: "modified",
    isDeletedContent: false, language: "typescript", reviewPriority: "normal", coverage: "normal", reviewProfile: "standard",
    hunks: [{ hunkId: hunk.id, oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, contentWithLineNumbers: "    1 +export const retries = 0;",
      lines: [{ kind: "add", content: "export const retries = 0;", newLine: 1 }], changedNewLineNumbers: [1], changedOldLineNumbers: [1] }],
    symbolFacts: [], context: { path: "src/example.ts" }, contextText: "", relevantTests: [], surroundingContextHints: [], labels: [],
    attentionNotes: [], relatedChangedContext: [], lenses: ["core/code-review"],
    toolBudget: { maxToolCalls: 3, maxInvestigationRounds: 3, maxResultChars: 4000 }
  };
  assert(hunk.id, "Expected a pinned fixture hunk.");
  const finding = {
    id: "finding-1", title: "Transient failures lose retries", severity: "medium", confidence: "high", category: "correctness",
    path: packet.path, changedLine: true, anchor: { path: packet.path, line: 1, side: "RIGHT", hunkId: hunk.id },
    evidence: { changedCode: "export const retries = 0;" }, failureMode: "A transient failure is returned immediately.",
    whyThisMatters: "Callers lose retry protection.", verification: "The retry limit is zero.",
    producedBy: { kind: "packet", stage: 7, packetId: packet.id, lensId: "core/code-review", skillIds: [] }
  };
  const captures = {};
  async function exercise(name, responses, expected, run) {
    const drafts = [...responses], calls = [], contexts = [];
    const telemetry = {
      runId: "contract-fixture", event() {}, recordModelCall() {}, recordToolCall() {}, async writeArtifact() {},
      async writeDebug(kind, _id, row) {
        if (kind === "llm-calls" && row.artifactKind === "llm_call_request") calls.push(row);
      }
    };
    const runner = createPiRunner({
      telemetry, logger, runSignal: new AbortController().signal,
      llmConfig: { provider: "fixture", model: "fixture", maxConcurrentCalls: 1 },
      hooks: { checkpoint: () => "ok", onUsage() {} },
      adapter: {
        resolveModel: () => ({ provider: "fixture", id: "fixture", raw: { id: "fixture", api: "fixture" } }),
        validateToolCall,
        async complete(_model, context, { submitToolName }) {
          contexts.push({ submitToolName, ...structuredClone(context) });
          assert(drafts.length, `Unexpected call for ${name}`);
          return { role: "assistant", provider: "fixture", model: "fixture", content: [drafts.shift()], stopReason: "toolUse", timestamp: 0 };
        }
      }
    });
    await run(runner, telemetry);
    assert.equal(drafts.length, 0, name);
    assert.deepEqual(calls.map(({ kind }) => kind), expected, name);
    assert.equal(calls.length, contexts.length, name);
    for (const [index, { request, kind, stage }] of calls.entries()) {
      const { messages, tools, submitToolName } = contexts[index];
      const schema = tools.find(tool => tool.name === submitToolName)?.parameters;
      assert(schema, `Missing submit schema in ${name} ${kind}`);
      captures[`${name}/${kind}`] = {
        stage, version: request.promptTemplateVersion, schemaVersion: request.schemaVersion, promptHash: request.promptHash,
        messages: JSON.stringify(messages.map(({ timestamp: _timestamp, ...message }) => message)),
        submit: JSON.stringify(schema), tools: JSON.stringify(tools),
        toolSchemas: JSON.stringify(tools.map(({ name, parameters }) => ({ name, parameters })))
      };
    }
  }
  for (const toolSurface of ["current", "six"]) {
    const baseConfig = structuredClone(defaultConfig);
    const config = { ...baseConfig, review: { ...baseConfig.review, toolSurface, verify: true, concurrency: 1 } };
    const promptBuilder = createPromptBuilder(registry, { toolSurface });
    const packetRun = (selected) => async (runner, telemetry) => {
      const [result] = await runLensPackets(plan, [selected], repository, config, telemetry, { runner, promptBuilder, lensRegistry: registry, diff });
      assert.equal(result?.status, "completed");
    };

    for (const shortened of [false, true]) {
      const selected = { ...packet, hunks: packet.hunks.map(item => ({ ...item, ...(shortened ? { truncated: true, omittedChangedLineCount: 1 } : {}) })) };
      const label = `packet/${toolSurface}/${shortened ? "shortened" : "ordinary"}`;
      const budget = { maxToolCalls: 1, maxInvestigationRounds: 1, maxResultChars: 3 };
      await exercise(label, [read, invalidReview, review], ["initial", "tool-continuation", "repair"], packetRun(selected));
      await exercise(`${label}/bound`, [read, { ...read, id: "read-again" }, review], ["initial", "tool-continuation", "finalize"], packetRun({ ...selected, toolBudget: budget }));
    }
    await exercise(`packet/${toolSurface}/simple`, [review], ["initial"], packetRun({ ...packet, reviewProfile: "simple" }));
    await exercise(`packet/${toolSurface}/investigate`, [review], ["initial"], packetRun({ ...packet, reviewProfile: "investigate", labels: ["tests"] }));

    const packets = [packet], packetResults = [{ packetId: packet.id, lenses: packet.lenses, findings: [finding], followUpHints: [], uncertainties: [], status: "completed" }];
    const verdict = call("verdict", "submit_verdict", { verdict: "keep", reason: finding.verification, requiredEvidencePresent: true, falsePositiveRisk: "low",
      proofAssessment: { status: "established", evidence: finding.evidence.changedCode, assumptions: [] } });
    const { proofAssessment, ...unprovenVerdict } = verdict.arguments;
    await exercise(`verify/${toolSurface}`, [read, call("unproven", "submit_verdict", unprovenVerdict), call("proof", "submit_verdict", { proofAssessment })],
      ["initial", "tool-continuation", "repair"], async (runner, telemetry) => {
        const result = await verifyFindings({ packetResults, packets }, repository, config, telemetry, { runner, diff, promptBuilder, lensRegistry: registry });
        assert.equal(result.verdicts[0]?.verdict, "keep");
      });
    const composition = { summary: "Retry protection is gone.", composedFindings: [{
      findingIds: [finding.id], publication: "summary-only",
      sections: [
        { kind: "impact", text: finding.failureMode + " " + finding.whyThisMatters, sourceRefs: [finding.id + "/failureMode", finding.id + "/whyThisMatters"] },
        { kind: "verification", text: finding.verification, sourceRefs: [finding.id + "/verification"] }
      ],
      evidenceRefs: [finding.id + "/evidence/changedCode"]
    }] };
    await exercise(`compose/${toolSurface}`, [
      call("composition", "submit_composition", { ...composition, composedFindings: [] }),
      call("composition-repair", "submit_composition", composition)
    ], ["initial", "repair"], async (runner, telemetry) => {
      const result = await dedupeRankAndComposeReview({ verified: [finding], verdicts: [] }, plan,
        { mode: "branch", repoRoot: "/fixture", commits: [], rawDiff, headSha: "head" }, structuredClone(coverage), config, telemetry, { runner, diff, packets, promptBuilder });
      assert.equal(result.summaryOnlyFindings.length, 1);
    });
  }
  await exercise("location", [call("location", "submit_review", { status: "unavailable" })], ["initial"], (runner, telemetry) =>
    clarifyFindingLocations([{ ...finding, anchor: undefined, locationResolution: { status: "unresolved", rejectedAnchor: finding.anchor } }],
      structuredClone(defaultConfig), telemetry, { runner, diff, packets: [packet] }));
  return captures;
}

const before = await capture(baseline);
const after = await capture(candidate);
assert.deepEqual(after, before, "The default model contract changed.");
console.log(JSON.stringify(Object.fromEntries(Object.entries(after).map(([name, { messages, submit, tools, toolSchemas, ...identity }]) =>
  [name, { ...identity, messageSHA256: sha(messages), submitSchemaSHA256: sha(submit), toolSchemaSHA256: sha(toolSchemas), toolDefinitionsSHA256: sha(tools) }])), null, 2));
