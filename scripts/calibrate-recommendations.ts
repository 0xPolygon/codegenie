import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { loadEvalSuite } from "../src/evals/eval-runner.js";
import { judgeRecommendations, type RecommendationJudgment } from "../src/evals/recommendation-judge.js";
import { sha256Hex } from "../src/util/hashing.js";
import { resolveCodegenieRuntimeProvenance } from "../src/util/runtime-provenance.js";

const statusSchema = z.enum(["correct", "incorrect", "withheld", "uncertain"]);
export const calibrationCasesSchema = z.array(z.object({
  id: z.string().regex(/^[a-z0-9-]+$/u), report: z.string().min(1),
  expected: z.record(z.string(), statusSchema), reason: z.string().min(1)
}).strict()).min(1).refine(cases => new Set(cases.map(entry => entry.id)).size === cases.length, "Duplicate case IDs");
type CalibrationCase = z.infer<typeof calibrationCasesSchema>[number];

export function compareJudgment(fixture: CalibrationCase, judgment: RecommendationJudgment) {
  return Object.entries(fixture.expected).map(([id, expected]) => {
    const results = judgment.results.filter(result => result.id === id);
    const actual = judgment.status === "completed" && results.length === 1 ? results[0]!.status : undefined;
    return { id, expected, ...(actual ? { actual } : {}),
      outcome: actual === undefined ? "error" : actual === expected ? "match" : "mismatch" };
  });
}

export async function calibrate(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: {
    "eval-dir": { type: "string" }, cases: { type: "string" }, out: { type: "string" },
    repeats: { type: "string", default: "2" }, live: { type: "boolean", default: false }
  } });
  if (!values["eval-dir"] || !values.cases || !values.out) throw new Error("Required: --eval-dir <dir> --cases <cases.json> --out <new-dir> [--repeats 2] [--live]");
  const repeats = Number(values.repeats);
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 5) throw new Error("repeats must be 1–5");
  const suite = await loadEvalSuite(values["eval-dir"]);
  if (suite.cases.length !== 1) throw new Error("Calibration requires a suite with exactly one case");
  const config = suite.cases[0]!.evalCase.recommendationJudge;
  if (!config) throw new Error("Eval case has no recommendationJudge");
  const casesText = await readFile(values.cases, "utf8");
  const cases = calibrationCasesSchema.parse(JSON.parse(casesText));
  const ids = config.checks.map(check => check.id).sort();
  for (const entry of cases) if (JSON.stringify(Object.keys(entry.expected).sort()) !== JSON.stringify(ids)) {
    throw new Error(`Expected labels must cover exactly the rubric IDs: ${entry.id}`);
  }
  if (!values.live) {
    console.log(`Validated ${cases.length} calibration cases; ${repeats} repetitions would make ${cases.length * repeats} judge calls. Add --live to execute.`);
    return 0;
  }
  const out = path.resolve(values.out);
  await mkdir(path.dirname(out), { recursive: true });
  await mkdir(out); // Never overwrite an earlier calibration.
  const manifest = { startedAt: new Date().toISOString(), repeats, casesHash: sha256Hex(casesText),
    judgeConfigHash: sha256Hex(JSON.stringify(config)), judgeConfig: config, cases,
    runtime: resolveCodegenieRuntimeProvenance(), caseFile: suite.cases[0]!.file };
  await writeFile(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  const executions: Array<{ caseId: string; repeat: number; judgment: RecommendationJudgment; checks: ReturnType<typeof compareJudgment> }> = [];
  // Two concurrent judge calls, one report per call. Gold labels, case names
  // and explanations never enter the judge prompt. No retries or selective reruns.
  const pending = cases.flatMap(fixture => Array.from({ length: repeats }, (_, index) => ({ fixture, repeat: index + 1 })));
  async function worker() {
    for (;;) {
      const next = pending.shift();
      if (!next) return;
      const { fixture, repeat } = next;
      const result = await judgeRecommendations(config!, fixture.report);
      const checks = compareJudgment(fixture, result.judgment);
      await writeFile(path.join(out, `${fixture.id}-${repeat}.json`), JSON.stringify({ ...result, expected: fixture.expected, checks }, null, 2) + "\n");
      executions.push({ caseId: fixture.id, repeat, judgment: result.judgment, checks });
      console.log(`${fixture.id} #${repeat}: ${checks.map(check => `${check.id}=${check.actual ?? "error"} (${check.outcome})`).join(", ")}`);
    }
  }
  await Promise.all([worker(), worker()]);
  executions.sort((a,b) => a.caseId.localeCompare(b.caseId) || a.repeat - b.repeat);
  const checks = executions.flatMap(execution => execution.checks);
  const summary = { completedAt: new Date().toISOString(), executions,
    matches: checks.filter(check => check.outcome === "match").length,
    mismatches: checks.filter(check => check.outcome === "mismatch").length,
    errors: checks.filter(check => check.outcome === "error").length,
    knownCostUSD: executions.reduce((sum, execution) => sum + (execution.judgment.costUSD ?? 0), 0),
    unknownCostCalls: executions.filter(execution => execution.judgment.costUSD === undefined).length };
  await writeFile(path.join(out, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify({ matches: summary.matches, mismatches: summary.mismatches, errors: summary.errors,
    knownCostUSD: summary.knownCostUSD, unknownCostCalls: summary.unknownCostCalls, out }));
  return summary.mismatches || summary.errors ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  calibrate(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => { console.error(error); process.exitCode = 1; });
}
