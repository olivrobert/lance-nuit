// modules/ui/http/guards.ts
//
// Request checks that do not depend on a route: where the request comes from,
// and whether its path can be trusted segment by segment.

import type { IncomingMessage } from "node:http";

/**
 * Cross-origin guard for every state-changing request.
 *
 * `SameSite=Strict` already stops a third-party page from sending the identity
 * cookie, but the tunnel makes `127.0.0.1:<port>` reachable from any page the
 * browser happens to have open, so the request itself is refused too. Both
 * headers are optional in a non-browser client (curl, a test), and absent is
 * treated as same-origin: the check exists to stop a browser being used as a
 * confused deputy, not to authenticate.
 */
export function isSameOrigin(req: IncomingMessage, host: string, port: number): boolean {
  const site = req.headers["sec-fetch-site"];
  if (typeof site === "string" && site !== "same-origin" && site !== "none") return false;

  const origin = req.headers.origin;
  if (typeof origin !== "string" || origin.length === 0 || origin === "null") return true;
  return [`http://${host}:${port}`, `http://localhost:${port}`].includes(origin);
}

/**
 * DNS-rebinding guard for every `/api/*` request.
 *
 * A page on `evil.example` whose name was rebound to 127.0.0.1 reaches this
 * server as same-origin for the browser, and the terminal routes are a shell.
 * What the browser cannot forge is the `Host` header, which still names the
 * attacker's domain: only the two names this server is reached by are accepted.
 */
export function isExpectedHost(req: IncomingMessage, host: string, port: number): boolean {
  const header = req.headers.host;
  return typeof header === "string" && [`${host}:${port}`, `localhost:${port}`].includes(header.toLowerCase());
}

/** Split a URL path into decoded segments; `undefined` when a segment is not
 *  valid percent-encoding or hides a separator or a NUL byte. */
export function pathSegments(pathname: string): string[] | undefined {
  const segments: string[] = [];
  for (const segment of pathname.split("/").filter((part) => part.length > 0)) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return undefined;
    }
    if (decoded.includes("\0") || decoded.includes("/") || decoded.includes("\\")) return undefined;
    segments.push(decoded);
  }
  return segments;
}
