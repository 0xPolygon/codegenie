// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import sitemap from '@astrojs/sitemap';

// https://astro.build/config
export default defineConfig({
  site: 'https://0xpolygon.github.io',
  base: '/codegenie',
  trailingSlash: 'ignore',
  integrations: [
    // `trailingSlash: 'ignore'` makes Astro emit the page both with and
    // without a trailing slash; keep only the canonical (slashed) form.
    sitemap({ filter: (page) => page.endsWith('/') }),
  ],
  vite: {
    plugins: [tailwindcss()],
  },
});