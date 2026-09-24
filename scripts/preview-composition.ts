// Offline only: no provider calls, credentials, cache, or private eval dependency.
// Optional JSON input: { findings, sections, evidenceRefs, presentation }.
import { readFileSync } from "node:fs";
import { contractComposition } from "../tests/fixtures/composition/contract-review.js";
import { composePresentation } from "../src/pipeline/composition-content.js";

const input = process.argv[2]
  ? JSON.parse(readFileSync(process.argv[2], "utf8")) as ReturnType<typeof contractComposition>
  : contractComposition();
const result = composePresentation(input.findings, input.sections, input.evidenceRefs, undefined, input.presentation);
process.stdout.write(result.body + "\n");
process.stderr.write(JSON.stringify(result.metrics, null, 2) + "\n");
