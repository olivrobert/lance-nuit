// modules/read-model/launches.ts
//
// Launches: the dashboard's own record of every verb it triggered, one JSON file
// per launch under `~/.lance-nuit/ui/launches/`. Writing one is the action
// layer's job (`src/modules/ui/actions.ts`); reading them is a read-model concern
// because an item's group depends on it — a work item whose runner was just
// spawned is "running" even before the runner has written a single byte of
// `state.json`.
//
// Liveness is derived, never trusted from the file: a launch without an exit code
// is alive only while its pid answers `kill(pid, 0)`. The server that spawned
// the process records the exit code when it sees it; if that server died first,
// the file keeps saying "no exit code yet" and the pid check is what tells the
// truth.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isErrno } from "../../lib/errors.js";
import { type ReadModelOptions, uiDir } from "./projects.js";
import type { Launch, LaunchRecord } from "./types.js";

/** Launch ids reach a file name; they are the timestamp, the ticket, and the verb. */
const LAUNCH_ID = /^[\w.-]+$/;

/** `~/.lance-nuit/ui/launches`, or `null` without a home directory. */
export function launchesDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const dir = uiDir(env);
  return dir ? join(dir, "launches") : null;
}

export function isValidLaunchId(value: unknown): value is string {
  return typeof value === "string" && LAUNCH_ID.test(value) && value !== "." && value !== "..";
}

/** Paths of one launch's two files. `null` when the id is malformed or there is
 *  no home directory. */
export function launchPaths(id: string, env: NodeJS.ProcessEnv = process.env): { json: string; log: string } | null {
  const dir = launchesDir(env);
  if (!dir || !isValidLaunchId(id)) return null;
  return { json: join(dir, `${id}.json`), log: join(dir, `${id}.log`) };
}

/**
 * Whether a process id is alive.
 *
 * Signal 0 probes without sending anything. `EPERM` means the process exists
 * but belongs to someone else, which for a runner spawned by this user cannot
 * happen — it is still reported alive, the honest reading of "not gone".
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrno(error, "EPERM");
  }
}

function isRecord(value: unknown): value is LaunchRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    isValidLaunchId(record.id) &&
    typeof record.at === "string" &&
    typeof record.by === "string" &&
    typeof record.project === "string" &&
    typeof record.ticket === "string" &&
    typeof record.verb === "string" &&
    Array.isArray(record.argv) &&
    typeof record.cwd === "string" &&
    typeof record.pid === "number"
  );
}

/** Read one launch file; `undefined` when absent or not a launch. */
export function readLaunchRecord(path: string): LaunchRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    // Absent, mid-write, or not JSON: not a launch to show.
    return undefined;
  }
  return isRecord(parsed) ? parsed : undefined;
}

/** A record as the dashboard shows it: alive while unfinished and its pid answers. */
export function describeLaunch(record: LaunchRecord): Launch {
  const finished = record.exitCode !== undefined || record.finishedAt !== undefined;
  return { ...record, alive: !finished && isPidAlive(record.pid) };
}

/** Every launch on disk, newest first. Files that are not launches are skipped. */
export function readLaunches(options: ReadModelOptions = {}): Launch[] {
  const dir = launchesDir(options.env ?? process.env);
  if (!dir) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    // No launch yet: the directory is created by the first action.
    return [];
  }

  const launches: Launch[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const record = readLaunchRecord(join(dir, name));
    if (record) launches.push(describeLaunch(record));
  }
  return launches.sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
}

/** Launches of one item, newest first. */
export function readLaunchesFor(projectName: string, ticket: string, options: ReadModelOptions = {}): Launch[] {
  return readLaunches(options).filter((launch) => launch.project === projectName && launch.ticket === ticket);
}

/** Latest launch per `project/ticket`, for one pass over the morning box. */
export function latestLaunchByItem(options: ReadModelOptions = {}): Map<string, Launch> {
  const latest = new Map<string, Launch>();
  // `readLaunches` is newest first, so the first one seen per key wins.
  for (const launch of readLaunches(options)) {
    const key = `${launch.project}/${launch.ticket}`;
    if (!latest.has(key)) latest.set(key, launch);
  }
  return latest;
}
