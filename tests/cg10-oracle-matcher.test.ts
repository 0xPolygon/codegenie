import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parse } from "yaml";
import { matchExpectation } from "../src/evals/eval-scoring.js";
import type { CandidateFinding, EvalCase } from "../src/types.js";

it("recognizes artifact I/O wording at both anchors without conflating primitive rejections", () => {
  const manifest = new URL("../evals/public/codegenie/cg-10/eval.yml", import.meta.url);
  const [composer, runner, primitive] = (parse(readFileSync(manifest, "utf8")) as EvalCase).should_find!;
  const finding = (failureMode: string, path = "src/pipeline/composer.ts", line = 404) => ({
    id: "witness", title: "Composer error handling", category: "correctness", severity: "medium",
    path, anchor: { line }, failureMode
  } as CandidateFinding);
  for (const failureMode of [
    "An I/O error writing final-findings.json replaces the composer exception and drops all retained verified findings.",
    "Disk full while saving final-findings.json replaces the composer exception and discards the retained verified findings.",
    "If saving final-findings.json returns ENOSPC after the composer rejects, the disk exception supersedes the original and the reporter returns no validated results.",
    "An artifact write failure replaces the composer exception and drops verified findings."
  ]) {
    expect(matchExpectation(composer!, finding(failureMode)).matched).toBe(true);
    expect(matchExpectation(runner!, finding(failureMode, "src/pipeline/review-runner.ts", 409)).matched).toBe(true);
    expect(matchExpectation(primitive!, finding(failureMode)).matched).toBe(false);
  }

  const primitiveRejection = finding("A primitive composer rejection drops the verified findings.");
  expect(matchExpectation(composer!, primitiveRejection).matched).toBe(false);
  expect(matchExpectation(primitive!, primitiveRejection).matched).toBe(true);
  expect(matchExpectation(composer!, finding("An I/O error opening a plan file stops the composer.")).matched).toBe(false);
});
