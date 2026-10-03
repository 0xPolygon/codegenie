#!/usr/bin/env node
/**
 * Lighthouse gate for the built site.
 *
 * Asserts the acceptance thresholds from PLAN.md §13:
 *   Performance >= 95, Accessibility / Best Practices / SEO == 100
 *
 * Usage: node scripts/lighthouse.mjs
 */

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { serveDist, baseUrl } from "./lib/serve-dist.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const reportDir = join(root, ".lighthouse");
const PORT = 4488;

const THRESHOLDS = {
  performance: 95,
  accessibility: 100,
  "best-practices": 100,
  seo: 100,
};

const server = await serveDist(dist, { port: PORT });
const url = baseUrl(PORT);

function runLighthouse() {
  return new Promise((resolve, reject) => {
    mkdirSync(reportDir, { recursive: true });
    const out = join(reportDir, "report.json");
    const proc = spawn(
      "npx",
      [
        "--yes",
        "lighthouse",
        url,
        "--output=json",
        `--output-path=${out}`,
        "--chrome-flags=--headless=new --no-sandbox",
        "--quiet",
        `--only-categories=${Object.keys(THRESHOLDS).join(",")}`,
      ],
      { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
    );
    let err = "";
    proc.stderr.on("data", (d) => (err += d.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`lighthouse exited ${code}\n${err}`));
      resolve(out);
    });
  });
}

let failures = 0;
try {
  const reportPath = await runLighthouse();
  const report = JSON.parse(readFileSync(reportPath, "utf8"));

  for (const [category, min] of Object.entries(THRESHOLDS)) {
    const score = Math.round((report.categories[category]?.score ?? 0) * 100);
    const ok = score >= min;
    if (!ok) failures++;
    console.log(
      `${ok ? "  ok" : "FAIL"}  ${category.padEnd(15)} ${score}  (min ${min})`,
    );
  }

  // Surface any remaining accessibility audit that is not perfect.
  const a11y = report.categories.accessibility;
  const imperfect = a11y.auditRefs
    .map((ref) => report.audits[ref.id])
    .filter((audit) => audit && audit.score !== null && audit.score < 1);
  if (imperfect.length) {
    console.log("\nImperfect accessibility audits:");
    for (const audit of imperfect) {
      console.log(`  - ${audit.id}: ${audit.title}`);
      for (const item of (audit.details?.items ?? []).slice(0, 3)) {
        console.log(`      ${(item.node?.snippet ?? "").slice(0, 120)}`);
        if (item.node?.explanation) {
          console.log(
            `      ${item.node.explanation.split("\n").pop().trim().slice(0, 160)}`,
          );
        }
      }
    }
  }
} finally {
  server.close();
}

console.log(
  failures === 0
    ? "\nLighthouse thresholds met"
    : `\n${failures} Lighthouse threshold(s) not met`,
);
process.exit(failures === 0 ? 0 : 1);