/**
 * Base-path aware URL joining.
 *
 * `import.meta.env.BASE_URL` is `/codegenie` (no trailing slash), so naive
 * string concatenation yields `/codegeniefavicon.svg`. Always route internal
 * hrefs/srcs through here instead of hardcoding `/`.
 */

const BASE = import.meta.env.BASE_URL.replace(/\/+$/, "");

/** Join a site-relative path onto the deploy base, e.g. `/codegenie/favicon.svg`. */
export function withBase(path = ""): string {
  const clean = path.replace(/^\/+/, "");
  return clean ? `${BASE}/${clean}` : `${BASE}/`;
}

/** Absolute URL for a site-relative path, for canonical/OG tags and sitemaps. */
export function absoluteUrl(path = "", origin: URL): string {
  return new URL(withBase(path), origin).href;
}