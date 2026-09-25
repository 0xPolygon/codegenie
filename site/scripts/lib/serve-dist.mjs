/**
 * Minimal static server for dist/, mounted under the deploy base path the way
 * GitHub Pages will serve it.
 *
 * Astro 7's `preview` runs as a managed daemon, which is awkward to start and
 * tear down from a script; this keeps verification self-contained.
 */

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname } from "node:path";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".xml": "application/xml",
  ".txt": "text/plain",
  ".ico": "image/x-icon",
  ".json": "application/json",
};

export const BASE = "/codegenie";

/** Start a server for `distDir` and resolve once it is listening. */
export function serveDist(distDir, { port, base = BASE } = {}) {
  const server = createServer(async (req, res) => {
    let path = decodeURIComponent((req.url || "/").split("?")[0]);
    if (!path.startsWith(base)) {
      res.writeHead(404);
      return res.end("outside base");
    }
    path = path.slice(base.length) || "/";
    if (path.endsWith("/")) path += "index.html";
    let file = join(distDir, path);
    try {
      if ((await stat(file)).isDirectory()) file = join(file, "index.html");
      const body = await readFile(file);
      res.writeHead(200, {
        "content-type": MIME[extname(file)] ?? "application/octet-stream",
      });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  });
  return new Promise((resolve) =>
    server.listen(port, "127.0.0.1", () => resolve(server)),
  );
}

export function baseUrl(port, base = BASE) {
  return `http://localhost:${port}${base}/`;
}