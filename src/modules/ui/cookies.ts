// modules/ui/cookies.ts
//
// `Cookie` parsing and `Set-Cookie` serialization, by hand.
//
// `node:http` hands over `req.headers.cookie` as one raw string and offers
// nothing to read it; a dashboard that needs exactly one cookie does not need a
// dependency for that. The identity cookie carries a display name, not a secret,
// so it is not signed: the trust boundary of `lancenuit ui` is the SSH tunnel,
// and a value that only names its own author has nothing to forge.

/** Identity cookie of the dashboard: the name chosen on the "who are you" page. */
export const USER_COOKIE = "lancenuit_ui_user";

/** One year (H3). Long enough that the choice is made once per machine. */
export const USER_COOKIE_MAX_AGE = 31_536_000;

export interface CookieAttributes {
  path?: string;
  httpOnly?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  /** Seconds. `0` expires the cookie immediately, which is how a name that left
   *  `users.json` is dropped rather than left to fail on every request. */
  maxAge?: number;
}

/**
 * Cookies of one request, by name.
 *
 * A malformed pair is skipped instead of failing the request: the header is
 * shared with every other cookie the browser holds for `127.0.0.1`, including
 * ones no part of this server wrote.
 */
export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) return cookies;

  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    if (name.length === 0) continue;
    let value = pair.slice(separator + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1);
    try {
      value = decodeURIComponent(value);
    } catch {
      // A value that is not valid percent-encoding is kept verbatim; refusing it
      // would drop a cookie the browser will keep sending anyway.
    }
    // First occurrence wins, which is what a browser sends for the most specific
    // path — the one this server set.
    if (!cookies.has(name)) cookies.set(name, value);
  }
  return cookies;
}

/** One `Set-Cookie` value. The name is written verbatim (this module owns it);
 *  the value is percent-encoded, so a display name with a space or an accent
 *  cannot break the header it travels in. */
export function serializeCookie(name: string, value: string, attributes: CookieAttributes = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (attributes.path) parts.push(`Path=${attributes.path}`);
  if (attributes.httpOnly) parts.push("HttpOnly");
  if (attributes.sameSite) parts.push(`SameSite=${attributes.sameSite}`);
  if (attributes.maxAge !== undefined) parts.push(`Max-Age=${Math.trunc(attributes.maxAge)}`);
  return parts.join("; ");
}

/**
 * The identity cookie for `user`.
 *
 * `HttpOnly` keeps it out of page scripts — the front end asks `/api/me`, it
 * never reads the cookie — and `SameSite=Strict` means a third-party page opened
 * in the same browser cannot make an authenticated request through the tunnel.
 */
export function userCookie(user: string): string {
  return serializeCookie(USER_COOKIE, user, {
    path: "/",
    httpOnly: true,
    sameSite: "Strict",
    maxAge: USER_COOKIE_MAX_AGE,
  });
}

/** The same cookie, expired: the browser drops it and the next request lands on
 *  the choice page. */
export function clearedUserCookie(): string {
  return serializeCookie(USER_COOKIE, "", { path: "/", httpOnly: true, sameSite: "Strict", maxAge: 0 });
}
