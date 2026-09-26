// modules/dashboard-home/json-file.ts
//
// JSON files of the dashboard, read leniently and written atomically.

import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

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

/** Write `value` as JSON, atomically. The temporary file sits in the destination
 *  directory so the `rename` stays on one filesystem, where it is atomic: a server
 *  killed mid-write leaves the previous file intact rather than a truncated one. */
export function writeJsonAtomic(path: string, value: unknown): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  try {
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}
