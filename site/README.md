# site

Static marketing site for codegenie. Astro 7, Tailwind v4, no client framework. Source lives here so the product repository can publish it with GitHub Pages.

Intended URL: **https://0xpolygon.github.io/codegenie/** (`base: '/codegenie'` in `astro.config.mjs`).

## Requirements

- Node `>= 22` (see `.nvmrc`)
- pnpm 10 (`packageManager` is pinned in `package.json`)

## Commands

```bash
# From this directory. Inside the codegenie checkout, add --ignore-workspace
# so pnpm does not attach this package to the CLI workspace.
pnpm install --ignore-workspace
pnpm dev              # local dev server
pnpm build            # astro check + static build into dist/
pnpm preview          # serve dist/ locally

pnpm verify           # build-output invariants (fast)
pnpm verify:full      # + page-completeness checks
pnpm test:browser     # Chrome checks: overflow, a11y, JS-off, reduced motion
pnpm lighthouse       # Lighthouse gates: perf >= 95, a11y/bp/seo == 100
pnpm test             # build + verify:full + test:browser + lighthouse  ← run before pushing
pnpm screenshots      # writes .screenshots/ at 375/768/1280/1920
pnpm og               # regenerate public/og.png from the inline template
```

`pnpm test:browser` and `pnpm lighthouse` drive the installed Google Chrome via Playwright, so they need Chrome present. CI runs the leaner `build + verify:full` pair.

## Where things live

| Path | Purpose |
|---|---|
| `src/data/site.ts` | Every URL, name, stat, and link. **Change the npm scope or Action ref here.** |
| `src/data/snippets.ts` | All commands and the GitHub Action YAML shown on the page |
| `src/data/features.ts`, `src/data/pipeline.ts` | Feature cards and the 11-stage pipeline |
| `src/components/` | One component per page section |
| `src/utils/url.ts` | Base-path aware URL joining |
| `scripts/` | Verification and asset generation |

Copy is lifted from the repository README. `pnpm verify:full` asserts the Action YAML on the page still matches `../README.md` byte-for-byte, so update both together.

## The base path

The site deploys under `/codegenie`, so `astro.config.mjs` sets `base: '/codegenie'`. Astro's `BASE_URL` has **no trailing slash**, which makes string concatenation produce broken URLs like `/codegeniefavicon.svg`. Always route internal paths through `withBase()` / `absoluteUrl()` from `src/utils/url.ts` — never hardcode `/`.

Verify base-path behaviour with `pnpm preview` (not `dev`), or rely on `pnpm verify`, which asserts every internal URL in `dist/` is prefixed.

## Deployment

`.github/workflows/pages.yml` builds this directory and publishes `dist/` with the official GitHub Pages actions. GitHub serves a project site from `https://<org>.github.io/<repo>/`, so the Astro `base` is `/codegenie`. A `docs/` folder would not work: GitHub Pages does not build Astro, and the repository root is the CLI, not a static site.

One-time setup: in this repository, Settings → Pages → Source = **GitHub Actions**. After that, a push to `master` that changes `site/**` deploys the site. `workflow_dispatch` can deploy without a site change.

A custom domain would mean dropping `base`, adding `public/CNAME`, and keeping the same Pages actions.

## Notes

- Styling is Tailwind v4 via `@tailwindcss/vite` (not `@astrojs/tailwind`, which is deprecated for v4). Design tokens live in `@theme` in `src/styles/global.css`.
- `astro check` requires TypeScript 6.x — TypeScript 7 does not yet expose the programmatic API it relies on.
- Fonts are self-hosted via `@fontsource-variable`, so the page makes zero third-party requests.
- The only client JavaScript is one inline script enabling copy buttons; they ship `hidden` and stay hidden without JS.
