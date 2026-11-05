//
// JSON files of the dashboard, read leniently and written atomically.

import { readFileSync } from "node:fs";
import { writeFileAtomic } from "../../shared/lib/atomic-write.js";

/** Parsed content, or `undefined` when the file is absent or not JSON: every
 *  caller falls back to an empty value rather than the server refusing to start
 *  over one hand-edited file. */
export function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return undefined;
  }
}

/** Write `value` as JSON, atomically: a server killed mid-write leaves the
 *  previous file intact rather than a truncated one. */
export function writeJsonAtomic(path: string, value: unknown): void {
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}
