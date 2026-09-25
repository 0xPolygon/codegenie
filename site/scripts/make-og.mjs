#!/usr/bin/env node
/**
 * Generate public/og.png (1200x630) from an inline HTML template.
 *
 * The rendered PNG is committed, so this only needs to run when the OG design
 * or copy changes:  pnpm og
 *
 * Uses the installed Chrome via Playwright — no extra image tooling.
 */

import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "public", "og.png");
const mark = readFileSync(join(root, "public", "mark.png")).toString("base64");
const lockup = readFileSync(join(root, "public", "lockup.png")).toString("base64");

const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{
    width:1200px;height:630px;background:#0b0b10;color:#e7e7ee;overflow:hidden;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    display:flex;flex-direction:column;justify-content:flex-start;gap:36px;
    padding:64px 72px;position:relative;
  }
  .glow{
    position:absolute;top:-260px;left:50%;transform:translateX(-50%);
    width:1100px;height:640px;border-radius:9999px;filter:blur(90px);opacity:.42;
    background:radial-gradient(closest-side,#6d28d9 0%,rgba(11,11,16,0) 100%);
  }
  .mascot{
    position:absolute;right:8px;bottom:8px;height:500px;width:auto;
    pointer-events:none;
  }
  .lockup{height:56px;width:auto;align-self:flex-start;flex:none}
  .eyebrow{
    display:inline-flex;align-items:center;gap:10px;position:relative;
    border:1px solid #23232e;background:#13131a;border-radius:9999px;
    padding:8px 16px;font-size:17px;color:#9a9aab;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
  }
  .dot{width:8px;height:8px;border-radius:9999px;background:#8b5cf6}
  h1{
    position:relative;font-size:66px;line-height:1.05;letter-spacing:-.03em;
    font-weight:700;max-width:720px;
  }
  h1 em{color:#a78bfa;font-style:normal}
  .bottom{position:relative;align-self:flex-start}
  .cmd{
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:21px;
    color:#9a9aab;border:1px solid #23232e;background:#13131a;
    border-radius:14px;padding:18px 24px;
  }
  .cmd b{color:#e7e7ee;font-weight:400}
  .stats{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:18px;color:#85859a;text-align:right}
  .stats span{color:#9a9aab}
</style></head>
<body>
  <div class="glow"></div>
  <img class="mascot" src="data:image/png;base64,${mark}" alt="" />
  <img class="lockup" src="data:image/png;base64,${lockup}" alt="codegenie" />
  <div>
    <div class="eyebrow"><span class="dot"></span>Open source · MIT · CLI + GitHub Action</div>
    <h1 style="margin-top:28px">AI code review that <em>prefers no comments</em> over weak comments.</h1>
  </div>
  <div class="bottom">
    <div class="cmd"><b>npm install -g</b> @0xsequence/codegenie</div>
  </div>
</body></html>`;

const browser = await chromium.launch({ channel: "chrome" });
try {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 630 },
    deviceScaleFactor: 1,
  });
  await page.setContent(html, { waitUntil: "load" });
  await page.screenshot({ path: out });
  console.log(`wrote ${out}`);
} finally {
  await browser.close();
}