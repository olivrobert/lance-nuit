//
// Which browser origins may read the read API, and nothing else.
//
// The read API answers any client that reaches the loopback port; a browser
// only lets a page of another origin READ the answer when the server says so.
// Saying so for every origin (`*`) would let any site the user has open read
// ticket titles and failure reasons off 127.0.0.1, so the server says it only
// for the origins listed at start-up, only under `/api/v1/`, and never with
// credentials: the dashboard's identity cookie must not ride along with a
// request another origin makes. `/api/*` keeps no CORS header at all.

import type { IncomingMessage, ServerResponse } from "node:http";
import { sendError } from "./respond.js";

/** `scheme://host[:port]`, nothing after it: what a browser sends as `Origin`. */
const ORIGIN = /^https?:\/\/(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*|\[[0-9a-f:]+\])(?::\d{1,5})?$/;

/** How long a browser may reuse a preflight answer, in seconds. */
const PREFLIGHT_MAX_AGE_S = "600";

/**
 * The allowed origins, normalized the way a browser spells them.
 *
 * Throws on a value that is not one origin: `*` and `null` are refused by name,
 * and a path or a trailing slash would never match what a browser sends, so it
 * is refused rather than silently ignored.
 */
export function parseCorsOrigins(values: readonly string[]): string[] {
  const origins = new Set<string>();
  for (const raw of values) {
    const value = raw.trim().toLowerCase();
    if (value.length === 0) continue;
    if (value === "*" || value === "null" || !ORIGIN.test(value)) {
      throw new Error(
        `Invalid --cors-origin value "${raw}": expected one origin such as http://localhost:3000 (no "*", no path).`,
      );
    }
    origins.add(value);
  }
  return [...origins];
}

/** The `Origin` header of `req`, when it is one of `allowed`. */
function allowedOrigin(req: IncomingMessage, allowed: readonly string[]): string | undefined {
  const origin = req.headers.origin;
  if (typeof origin !== "string") return undefined;
  const normalized = origin.toLowerCase();
  return allowed.includes(normalized) ? normalized : undefined;
}

/**
 * Headers of a read API answer. The answer itself does not depend on the
 * origin — a refused origin still gets it, its browser just keeps it from the
 * page — but the headers do, hence `Vary`.
 */
export function corsHeadersFor(req: IncomingMessage, allowed: readonly string[]): Record<string, string> {
  const origin = allowedOrigin(req, allowed);
  return origin ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : { Vary: "Origin" };
}

/** Answer a browser's preflight for the read API: 204 for an allowed origin,
 *  403 for any other. Only `GET` is ever allowed. */
export function answerPreflight(req: IncomingMessage, res: ServerResponse, allowed: readonly string[]): void {
  const origin = allowedOrigin(req, allowed);
  if (!origin) {
    sendError(res, 403, "origin not allowed to read this API");
    return;
  }
  res.writeHead(204, {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET",
    "Access-Control-Allow-Headers": "Accept, Content-Type",
    "Access-Control-Max-Age": PREFLIGHT_MAX_AGE_S,
    Vary: "Origin",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end();
}
