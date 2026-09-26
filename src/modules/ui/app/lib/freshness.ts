// How fresh the screen is: the banner's qualifier and its "Updated …" label.

import { fmtAge } from "./format.js";

/** How the banner qualifies what is on screen: `ok`, `stale` when no read
 *  landed for a while without any failing, `lost` when the last one failed. */
export type Freshness = "ok" | "stale" | "lost";

/** Past this age, a screen whose reads stopped landing is called stale. It is
 *  above the hidden-tab interval, so a tab coming back to the foreground is not
 *  flagged in the instant before its first read answers. */
export const STALE_AFTER_MS = 90_000;

export function freshnessOf(refreshedAt: number | null, refreshError: string | null, now: number): Freshness {
  if (refreshError !== null) return "lost";
  if (refreshedAt !== null && now - refreshedAt > STALE_AFTER_MS) return "stale";
  return "ok";
}

/** "Updated just now", "Updated 4m ago" — the age of what is on screen. */
export function updatedLabel(refreshedAt: number | null, now: number): string {
  if (refreshedAt === null) return "Not updated yet";
  if (now - refreshedAt < 60_000) return "Updated just now";
  return `Updated ${fmtAge(new Date(refreshedAt).toISOString(), now)}`;
}
