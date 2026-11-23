import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parse } from "yaml";
import { matchExpectation } from "../src/evals/eval-scoring.js";
import type { CandidateFinding, EvalCase } from "../src/types.js";

it("recognizes resource lifetime in same-name load conflicts", () => {
  const manifest = new URL("../evals/public/goinfer/go-01/eval.yml", import.meta.url);
  const [oracle] = (parse(readFileSync(manifest, "utf8")) as EvalCase).should_find!;
  const rawMatch = (failureMode: string) => matchExpectation(oracle!, {
    id: "witness", title: "Model load conflict", category: "correctness", severity: "medium",
    path: "cmd/serve/admin.go", anchor: { line: 78 }, failureMode
  } as CandidateFinding).matched;

  expect(rawMatch("Two concurrent loads of the same name leave the losing safetensors mapping allocated until its finalizer runs; a 409 response does not release it promptly.")).toBe(true);
  expect(rawMatch("After both loaders pass the initial check, the losing insertion returns conflict and waits for GC to reclaim its mapped weights.")).toBe(true);
  expect(rawMatch("Concurrent loads return the wrong duplicate name in the conflict response.")).toBe(false);
});
