// modules/ui/static-files.ts
//
// The dashboard's own assets: `index.html`, `app.js`, `app.css`.
//
// Node ships no static handler, so this is the whole of one: a hand-written
// extension-to-MIME table, containment under the asset directory, and
// revalidation caching.
//
// Caching is `no-cache` plus an `ETag`, NOT a long `max-age`: the assets are
// served from a directory that changes whenever the runner is updated, and the
// browser's heuristic cache (roughly a tenth of the file's age, applied when
// nothing says otherwise) would otherwise pin a stale dashboard for hours. With
// `no-cache` the browser always asks, and gets a 304 with no body when nothing
// moved — the bandwidth of a long cache without its staleness.

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Hand-written table (MDN's common types). Nothing outside it is served: an
 *  unknown extension in this directory is a mistake, not a file to guess at. */
const MIME_BY_EXTENSION: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/vnd.microsoft.icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

/** Directory holding the assets, beside this module in both the TypeScript
 *  sources and the compiled `dist/` tree — the build copies it verbatim. */
export function staticDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "static");
}

export function mimeTypeOf(path: string): string | undefined {
  return MIME_BY_EXTENSION[extname(path).toLowerCase()];
}

export interface StaticAsset {
  path: string;
  body: Buffer;
  contentType: string;
  /** Strong validator over the bytes served. Content-based rather than
   *  mtime-based: a rebuild that rewrites an unchanged file keeps the same tag,
   *  and a file restored from a backup does not keep an older one. */
  etag: string;
}

/** Requests with no path of their own get the dashboard itself. */
const INDEX = "index.html";

/**
 * Resolve one request path to an asset, or `undefined`.
 *
 * A URL path never becomes a filesystem path directly: each segment is checked
 * on its own, and the result is checked against the asset directory again after
 * resolution. `..`, an absolute path, and a NUL byte are all refused before any
 * filesystem call.
 */
export function readStaticAsset(urlPath: string): StaticAsset | undefined {
  const root = staticDir();
  const requested = urlPath === "/" || urlPath === "" ? INDEX : urlPath.replace(/^\/+/, "");
  if (requested.length === 0 || requested.includes("\0")) return undefined;

  const segments = requested.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) return undefined;

  const candidate = resolve(root, ...segments);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) return undefined;

  const contentType = mimeTypeOf(candidate);
  if (!contentType) return undefined;

  try {
    if (!statSync(candidate).isFile()) return undefined;
    const body = readFileSync(candidate);
    const digest = createHash("sha256").update(body).digest("hex");
    return { path: candidate, body, contentType, etag: `"${digest}"` };
  } catch {
    // Absent or unreadable: a 404 either way, which is what `undefined` means to
    // the caller.
    return undefined;
  }
}

/**
 * True when the client already holds this exact representation.
 *
 * `If-None-Match` may list several tags, and `*` matches any existing one. Weak
 * comparison (`W/` prefix ignored) is what the specification asks for on a
 * conditional GET.
 */
export function matchesEtag(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  const normalize = (tag: string): string => tag.trim().replace(/^W\//, "");
  const wanted = normalize(etag);
  return header.split(",").some((tag) => {
    const candidate = normalize(tag);
    return candidate === "*" || candidate === wanted;
  });
}
