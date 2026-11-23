import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadEvalArtifacts } from "../src/evals/eval-artifacts.js";
import { loadEvalSuite } from "../src/evals/eval-runner.js";
import { matchExpectation } from "../src/evals/eval-scoring.js";
import type { EvalArtifacts, EvalCase, EvalMatchOutcome } from "../src/types.js";

type Lead = {
  expectationId: string;
  list: "should_find" | "should_find_candidate";
  artifact: "candidate-findings" | "final-findings";
  findingId: string;
  reason: "machine-match" | "location-lexical-mismatch";
  rawMatch: EvalMatchOutcome;
};

export function buildEvalAdjudicationQueue(evalCase: EvalCase, artifacts: EvalArtifacts) {
  const allFinals = artifacts.finalFindings.filter(finding => finding.publication === "inline" || finding.publication === "summary-only");
  const sources = [
    { list: "should_find", artifact: "final-findings", expectations: evalCase.should_find ?? [], findings: allFinals },
    { list: "should_find", artifact: "candidate-findings", expectations: evalCase.should_find ?? [], findings: artifacts.candidates },
    { list: "should_find_candidate", artifact: "candidate-findings", expectations: evalCase.should_find_candidate ?? [], findings: artifacts.candidates }
  ] as const;
  const leads: Lead[] = [];
  for (const { list, artifact, expectations, findings } of sources) {
    for (const expectation of expectations) {
      for (const finding of findings) {
        const rawMatch = matchExpectation(expectation, finding, artifacts);
        const missed = rawMatch.fields.filter(field => !field.matched);
        const locationScoped = expectation.path !== undefined || expectation.lineRange !== undefined;
        const lexicalMissAtLocation = locationScoped && missed.length > 0
          && missed.every(field => field.field === "titlePattern" || field.field === "failureModePattern");
        if (rawMatch.matched || lexicalMissAtLocation) {
          leads.push({ list, artifact, findingId: finding.id, expectationId: expectation.id,
            reason: rawMatch.matched ? "machine-match" : "location-lexical-mismatch", rawMatch });
        }
      }
    }
  }
  return { caseName: evalCase.name, leads };
}

async function main(args: string[]) {
  if (args.length !== 2) throw new Error("Use <pinned case directory> <telemetry directory>.");
  const suite = await loadEvalSuite(args[0]!);
  const entry = suite.cases[0];
  if (suite.cases.length !== 1 || entry === undefined) throw new Error("Provide one eval case.");
  const artifacts = await loadEvalArtifacts(args[1]!);
  if (artifacts.missingArtifacts?.length) {
    throw new Error(`Missing finding artifacts: ${artifacts.missingArtifacts.join(", ")}`);
  }
  return buildEvalAdjudicationQueue(entry.evalCase, artifacts);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(JSON.stringify(await main(process.argv.slice(2)), null, 2));
}
