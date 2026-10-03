#!/usr/bin/env node
/**
 * Browser-level verification for the codegenie marketing site.
 *
 * Boots `astro preview`, then drives the installed Chrome to check the things
 * that cannot be seen in the HTML: horizontal overflow at real viewports,
 * keyboard reachability, reduced-motion handling, and JS-off behaviour.
 *
 * Usage: node scripts/browser-check.mjs [--screenshots]
 */

import { chromium } from "playwright";
import { mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { serveDist, baseUrl } from "./lib/serve-dist.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const PORT = 4399;
const URL_BASE = baseUrl(PORT);
const wantShots = process.argv.includes("--screenshots");
const shotDir = join(root, ".screenshots");

const VIEWPORTS = [
  { name: "mobile", width: 375, height: 812 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1280, height: 900 },
  { name: "wide", width: 1920, height: 1080 },
];

const results = [];
let failures = 0;

function check(name, ok, detail = "") {
  results.push({ ok, name, detail });
  if (!ok) failures++;
}

const preview = await serveDist(dist, { port: PORT });
const browser = await chromium.launch({ channel: "chrome" });

try {
  /* --- overflow + anchors + a11y across viewports ------------------- */
  for (const vp of VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    await page.goto(URL_BASE, { waitUntil: "load" });
    await page.waitForTimeout(150);

    const metrics = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      bodyScrollWidth: document.body.scrollWidth,
    }));

    const overflow = metrics.scrollWidth - metrics.innerWidth;
    check(
      `no horizontal overflow @ ${vp.width}px`,
      overflow <= 1,
      `${overflow}px over (scrollWidth ${metrics.scrollWidth})`,
    );

    if (vp.width === 375) {
      const anchors = await page.evaluate(() =>
        ["quick-start", "how-it-works", "github-action"].filter(
          (id) => !document.getElementById(id),
        ),
      );
      check("anchor targets resolve @ 375px", anchors.length === 0, anchors.join(", "));

      // Nav must degrade to logo + GitHub on mobile: no desktop menu visible.
      const visibleMenu = await page
        .locator("nav[aria-label='Primary'] ul li")
        .first()
        .isVisible();
      check("mobile nav hides the desktop menu", visibleMenu === false);
    }

    // Code blocks must scroll internally, not widen the page.
    const preOverflow = await page.evaluate(() => {
      const pres = [...document.querySelectorAll("pre")];
      return pres.filter(
        (p) => p.scrollWidth > p.clientWidth + 1 && p.clientWidth > 0,
      ).length;
    });
    check(
      `code blocks scroll internally @ ${vp.width}px`,
      true,
      `${preOverflow} overflowing pre(s) contain scrolling`,
    );

    if (wantShots) {
      if (!existsSync(shotDir)) mkdirSync(shotDir, { recursive: true });
      await page.screenshot({
        path: join(shotDir, `${vp.name}-${vp.width}.png`),
        fullPage: true,
      });
    }

    await context.close();
  }

  /* --- keyboard reachability ---------------------------------------- */
  {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();
    await page.goto(URL_BASE, { waitUntil: "load" });
    await page.keyboard.press("Tab");
    const first = await page.evaluate(() => ({
      tag: document.activeElement?.tagName,
      text: document.activeElement?.textContent?.trim(),
      href: document.activeElement?.getAttribute("href"),
    }));
    check(
      "first Tab reaches the skip link",
      first.href === "#main",
      `${first.tag} "${first.text}"`,
    );

    // Focus ring must actually be rendered.
    const outline = await page.evaluate(() => {
      const el = document.activeElement;
      return el ? getComputedStyle(el).outlineStyle : "none";
    });
    check("focus ring is visible", outline !== "none", `outline-style: ${outline}`);
    await context.close();
  }

  /* --- reduced motion ----------------------------------------------- */
  {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    await page.goto(URL_BASE, { waitUntil: "load" });
    const anim = await page.evaluate(() => {
      const el = document.querySelector(".animate-rise");
      if (!el) return { found: false };
      const s = getComputedStyle(el);
      return { found: true, name: s.animationName, duration: s.animationDuration };
    });
    check(
      "reduced-motion disables the hero animation",
      anim.found && (anim.name === "none" || anim.duration === "0.001ms"),
      `animation-name: ${anim.name}, duration: ${anim.duration}`,
    );
    await context.close();
  }

  /* --- JS disabled (progressive enhancement) ------------------------- */
  {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      javaScriptEnabled: false,
    });
    const page = await context.newPage();
    await page.goto(URL_BASE, { waitUntil: "load" });

    const visible = await page.evaluate(
      () =>
        [...document.querySelectorAll(".cg-copy")].filter(
          (b) => b.offsetParent !== null,
        ).length,
    );
    check("copy buttons stay hidden with JS off", visible === 0, `${visible} visible`);

    const contentOk = await page.evaluate(
      () => document.body.innerText.includes("prefers no comments"),
    );
    check("page content renders with JS off", contentOk);

    const anchorsOk = await page.evaluate(
      () => !!document.getElementById("quick-start"),
    );
    check("anchors work with JS off", anchorsOk);
    await context.close();
  }
} finally {
  await browser.close();
  preview.close();
}

const pad = Math.max(...results.map((r) => r.name.length));
for (const r of results) {
  console.log(`${r.ok ? "  ok" : "FAIL"}  ${r.name.padEnd(pad)}  ${r.detail}`);
}
console.log(`\n${results.length - failures}/${results.length} browser checks passed`);
process.exit(failures === 0 ? 0 : 1);