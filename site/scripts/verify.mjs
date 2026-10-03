#!/usr/bin/env node
/**
 * Build-output verification for the codegenie marketing site.
 *
 * Runs against dist/ (not src/), so it catches the failure modes that only
 * appear in the built artifact: base-path joins, escaped template literals,
 * and copy-payload drift from the codegenie README.
 *
 * Usage:
 *   node scripts/verify.mjs          # invariants only (fast, always must pass)
 *   node scripts/verify.mjs --full   # + page-completeness checks
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const BASE = "/codegenie";
const README = [
  join(root, "..", "README.md"),
  join(root, "..", "codegenie", "README.md"),
].find((path) => existsSync(path));

const full = process.argv.includes("--full");
const results = [];
let failures = 0;

function check(name, fn, { fullOnly = false } = {}) {
  if (fullOnly && !full) return;
  try {
    const detail = fn();
    results.push({ ok: true, name, detail });
  } catch (err) {
    failures++;
    results.push({ ok: false, name, detail: err.message });
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const indexPath = join(dist, "index.html");
assert(existsSync(indexPath), "dist/index.html not found — run `pnpm build` first");
const html = readFileSync(indexPath, "utf8");

/** Decode the entities Astro emits, for copy-text assertions. */
function decode(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Rendered text of the page: tags stripped, entities decoded, ws collapsed. */
const text = decode(html.replace(/<[^>]+>/g, " "))
  .replace(/\s+/g, " ")
  .trim();

/**
 * Match `<button ...>` tags with quote-aware scanning, so `>` inside an
 * attribute value (e.g. `# -> anthropic/...` in a copy payload) doesn't end
 * the tag early.
 */
const TAG_RE = /<button\b(?:[^>"']|"[^"]*"|'[^']*')*>/g;
const buttons = [...html.matchAll(TAG_RE)].map((m) => m[0]);

/* ------------------------------------------------------------------ *
 * Invariants
 * ------------------------------------------------------------------ */

check("every internal href/src is base-prefixed", () => {
  const attrs = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1]);
  const internal = attrs.filter(
    (u) =>
      !/^(https?:|mailto:|tel:|data:|#)/.test(u) &&
      u !== "" &&
      !u.startsWith("#"),
  );
  const bad = internal.filter((u) => !u.startsWith(BASE));
  assert(bad.length === 0, `unprefixed internal URLs: ${JSON.stringify(bad)}`);
  return `${internal.length} internal URLs ok`;
});

check("no root-relative favicon/asset leakage", () => {
  assert(!html.includes('href="/favicon'), "favicon missing base path");
  assert(!html.includes('content="https://0xpolygon.github.io/og.png"'), "og:image missing base path");
  return "favicon + og:image prefixed";
});

check("canonical URL is base-scoped", () => {
  const m = html.match(/<link rel="canonical" href="([^"]+)"/);
  assert(m, "no canonical link");
  assert(
    m[1] === "https://0xpolygon.github.io/codegenie/",
    `canonical is ${m[1]}`,
  );
  return m[1];
});

check("JSON-LD parses", () => {
  const m = html.match(
    /<script type="application\/ld\+json">([\s\S]*?)<\/script>/,
  );
  assert(m, "no JSON-LD block");
  const data = JSON.parse(m[1]);
  assert(data["@type"] === "SoftwareApplication", "wrong @type");
  return `${data.name} / ${data.license}`;
});

check("copy buttons ship hidden (JS-off safe)", () => {
  const copyButtons = buttons.filter((b) => b.includes("cg-copy"));
  assert(copyButtons.length > 0, "no copy buttons rendered");
  const notHidden = copyButtons.filter((b) => !/\shidden[\s>]/.test(b));
  assert(
    notHidden.length === 0,
    `${notHidden.length} copy button(s) rendered visible without JS`,
  );
  return `${copyButtons.length} button(s) progressively enhanced`;
});

check("install command copy payload is exact", () => {
  const m = [...html.matchAll(TAG_RE)]
    .map((x) => x[0])
    .map((tag) => tag.match(/data-copy="([^"]*)"/))
    .find((x) => x && x[1].includes("install -g"));
  assert(m, "install copy payload not found");
  const payload = decode(m[1]);
  assert(
    payload === "npm install -g @0xsequence/codegenie",
    `payload is ${JSON.stringify(payload)}`,
  );
  return payload;
});

check("Action YAML on page matches README byte-for-byte", () => {
  const m = [...html.matchAll(TAG_RE)]
    .map((x) => x[0])
    .map((tag) => tag.match(/data-copy="([^"]*)"/))
    .find((x) => x && x[1].startsWith("name: codegenie review"));
  assert(m, "Action YAML copy payload not found");
  const payload = decode(m[1]);
  assert(!payload.includes("\\$"), "escaped \\$ leaked into payload");

  assert(README, "codegenie README not found next to site/ or as a sibling checkout");
  assert(existsSync(README), `codegenie README not found at ${README}`);
  const readme = readFileSync(README, "utf8");
  const block = readme.match(/```yaml\n([\s\S]*?)```/);
  assert(block, "no yaml block in README");
  const expected = block[1].replace(/^# .*\n/, "").replace(/\n$/, "");
  assert(
    payload.replace(/\n$/, "") === expected,
    "Action YAML differs from README",
  );
  return `${expected.split("\n").length} lines match v0.5.1`;
});

check("no unresolved Astro/template artifacts", () => {
  assert(!html.includes("undefined"), "literal 'undefined' in output");
  assert(!html.includes("[object Object]"), "literal '[object Object]' in output");
  assert(!html.includes("NaN"), "literal 'NaN' in output");
  return "clean";
});

check("sitemap exists and is base-scoped", () => {
  const sitemap = join(dist, "sitemap-index.xml");
  assert(existsSync(sitemap), "sitemap-index.xml missing");
  const files = readdirSync(dist).filter((f) => f.startsWith("sitemap-"));
  const body = files.map((f) => readFileSync(join(dist, f), "utf8")).join("");
  assert(
    body.includes("https://0xpolygon.github.io/codegenie"),
    "sitemap missing base-scoped URL",
  );
  return files.join(", ");
});

check("sitemap lists each page once", () => {
  const body = readdirSync(dist)
    .filter((f) => f.startsWith("sitemap-"))
    .map((f) => readFileSync(join(dist, f), "utf8"))
    .join("");
  const locs = [...body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  const dupes = locs.filter((l, i) => locs.indexOf(l) !== i);
  assert(dupes.length === 0, `duplicate <loc> entries: ${dupes.join(", ")}`);
  return `${locs.length} unique URL(s)`;
});

check("og.png is a 1200x630 PNG", () => {
  const p = join(dist, "og.png");
  assert(existsSync(p), "og.png missing from dist");
  const buf = readFileSync(p);
  assert(
    buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    "not a PNG file",
  );
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  assert(width === 1200 && height === 630, `is ${width}x${height}, expected 1200x630`);
  return `${width}x${height}, ${(buf.length / 1024).toFixed(0)}KB`;
});

check("robots.txt points at the sitemap", () => {
  const p = join(dist, "robots.txt");
  assert(existsSync(p), "robots.txt missing from dist");
  const body = readFileSync(p, "utf8");
  assert(body.includes("User-agent: *"), "missing User-agent directive");
  assert(
    body.includes("https://0xpolygon.github.io/codegenie/sitemap-index.xml"),
    "missing base-scoped Sitemap directive",
  );
  return "allow all + sitemap";
});

/* ------------------------------------------------------------------ *
 * Page completeness (expected once all sections land)
 * ------------------------------------------------------------------ */

check(
  "required section anchors exist",
  () => {
    for (const id of ["quick-start", "how-it-works", "github-action"]) {
      assert(html.includes(`id="${id}"`), `missing section id="${id}"`);
    }
    return "quick-start, how-it-works, github-action";
  },
  { fullOnly: true },
);

check(
  "all eleven pipeline stages present",
  () => {
    const stages = [
      "Resolve input",
      "Parse & filter diff",
      "Classify files",
      "Index symbols",
      "Plan",
      "Build review packets",
      "Review packets",
      "Follow-up",
      "Verify",
      "Compose",
      "Publish",
    ];
    const missing = stages.filter((s) => !text.includes(s));
    assert(missing.length === 0, `missing stages: ${missing.join(", ")}`);
    return `${stages.length} stages`;
  },
  { fullOnly: true },
);

check(
  "key marketing copy present",
  () => {
    const required = [
      "prefers no comments over weak comments",
      "not a chatbot pointed at a diff",
      "Judgment in the model, invariants in the harness",
      "Skills travel with the repo",
      "High-signal AI code review",
      "Built by Polygon",
      "1,103",
      "37 providers",
    ];
    const missing = required.filter((s) => !text.includes(s));
    assert(missing.length === 0, `missing copy: ${missing.join(" | ")}`);
    return `${required.length} strings`;
  },
  { fullOnly: true },
);

check(
  "single-page: no client-side routing or extra pages",
  () => {
    const pages = readdirSync(dist).filter((f) => f.endsWith(".html"));
    assert(pages.length === 1, `expected 1 html page, found ${pages.length}`);
    return pages.join(", ");
  },
  { fullOnly: true },
);

/* ------------------------------------------------------------------ */

const pad = Math.max(...results.map((r) => r.name.length));
for (const r of results) {
  console.log(
    `${r.ok ? "  ok" : "FAIL"}  ${r.name.padEnd(pad)}  ${r.detail ?? ""}`,
  );
}

console.log(
  `\n${results.length - failures}/${results.length} checks passed` +
    (full ? " (full)" : " (invariants)") +
    (full ? "" : " — run with --full for page completeness"),
);

process.exit(failures === 0 ? 0 : 1);