// modules/dashboard-home/launch-store.ts
//
// Launches: the dashboard's own record of every verb it triggered, two files per
// launch under `~/.lance-nuit/ui/launches/` — `<id>.json`, the record, and
// `<id>.log`, the runner's output. This store owns the whole lifecycle: create,
// close, reconcile at startup, purge, and read back.
//
// Liveness is derived, never trusted from the file: a launch without an exit code
// is alive only while its pid answers `kill(pid, 0)`. The server that spawned
// the process records the exit code when it sees it; if that server died first,
// the file keeps saying "no exit code yet" and the pid check is what tells the
// truth.

import { closeSync, mkdirSync, openSync, readdirSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { errorMessage, isErrno } from "../../lib/errors.js";
import type { DashboardPaths } from "./paths.js";
import { readJson, writeJsonAtomic } from "./json-file.js";

/** Dashboard record of one verb it triggered (spec 5.2). `exitCode` is `null`
 *  when the process ended without a code the server could observe — killed, or
 *  gone when the server restarted. */
export interface LaunchRecord {
  /** `<timestamp>-<ticket>-<verb>`. */
  id: string;
  at: string;
  /** Name from the identity cookie. */
  by: string;
  /** Project name, as `Item.project.name`. */
  project: string;
  ticket: string;
  verb: string;
  /** Exact arguments handed to `lancenuit`, without the executable. */
  argv: string[];
  cwd: string;
  pid: number;
  exitCode?: number | null;
  finishedAt?: string;
}

/** A launch as the dashboard shows it: the record plus whether its process still
 *  runs, derived from the pid rather than trusted from the file. */
export interface Launch extends LaunchRecord {
  alive: boolean;
}

export interface LaunchFiles {
  json: string;
  log: string;
}

export type LogTail = { status: "ok"; path: string; lines: string[]; truncated: boolean } | { status: "not-found" };

/** Launches older than this lose both their files at the next server start (H1). */
export const LAUNCH_RETENTION_DAYS = 30;

/** Bytes read from the end of a log to answer a tail request. */
const LOG_TAIL_BYTES = 64 * 1024;

/** Launch ids reach a file name; they are the timestamp, the ticket, and the verb. */
const LAUNCH_ID = /^[\w.-]+$/;

export function isValidLaunchId(value: unknown): value is string {
  return typeof value === "string" && LAUNCH_ID.test(value) && value !== "." && value !== "..";
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

/** A record as the dashboard shows it: alive while unfinished and its pid answers. */
export function describeLaunch(record: LaunchRecord): Launch {
  const finished = record.exitCode !== undefined || record.finishedAt !== undefined;
  return { ...record, alive: !finished && isPidAlive(record.pid) };
}

function appendLine(path: string, line: string): void {
  try {
    writeFileSync(path, `${line}\n`, { flag: "a" });
  } catch {
    // The log is a convenience; the record is what matters.
  }
}

export class FileLaunchStore {
  private readonly dir: string | null;

  constructor(paths: DashboardPaths | null) {
    this.dir = paths?.launches ?? null;
  }

  /** False when no home directory is resolvable: nothing can be recorded. */
  get available(): boolean {
    return this.dir !== null;
  }

  /** Paths of one launch's two files; `null` when the id is malformed or there
   *  is no home directory. */
  files(id: string): LaunchFiles | null {
    if (!this.dir || !isValidLaunchId(id)) return null;
    return { json: join(this.dir, `${id}.json`), log: join(this.dir, `${id}.log`) };
  }

  /** Create the launch directory and answer the files of `id`, ready to be
   *  written; `null` in the same cases as `files`. */
  prepare(id: string): LaunchFiles | null {
    if (!this.dir) return null;
    mkdirSync(this.dir, { recursive: true });
    return this.files(id);
  }

  /** One record; `undefined` when absent, mid-write, or not a launch. */
  read(id: string): LaunchRecord | undefined {
    const files = this.files(id);
    if (!files) return undefined;
    const parsed = readJson(files.json);
    return isRecord(parsed) ? parsed : undefined;
  }

  write(record: LaunchRecord): void {
    const files = this.files(record.id);
    if (!files) throw new Error(`launch id "${record.id}" is not a valid file name`);
    writeJsonAtomic(files.json, record);
  }

  /**
   * Record how a launch ended, once.
   *
   * Called from a child-process event, outside any HTTP route: a throw here
   * would be an uncaught exception and take the whole dashboard down, so every
   * failure lands in the log instead. A launch that stays open is closed by
   * `reconcile` at the next start.
   */
  close(fallback: LaunchRecord, exitCode: number | null, note?: string, now: Date = new Date()): void {
    const files = this.files(fallback.id);
    if (!files) return;
    if (note) appendLine(files.log, note);
    try {
      const current = this.read(fallback.id) ?? fallback;
      if (current.exitCode !== undefined) return;
      writeJsonAtomic(files.json, { ...current, exitCode, finishedAt: now.toISOString() });
    } catch (error) {
      appendLine(files.log, `launch record could not be closed: ${errorMessage(error)}`);
    }
  }

  /** Every launch on disk, newest first. Files that are not launches are skipped. */
  list(): Launch[] {
    const launches: Launch[] = [];
    for (const id of this.ids()) {
      const record = this.read(id);
      if (record) launches.push(describeLaunch(record));
    }
    return launches.sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
  }

  /**
   * Close the launches a previous server left open, and drop the old ones (H1).
   *
   * Called once at startup. A launch with no exit code whose pid is gone was ended
   * while no server was watching; it is closed with `exitCode: null` and the
   * current time, which is the most honest `finishedAt` available. Launches older
   * than the retention window lose both their files.
   */
  reconcile(now: Date = new Date()): void {
    const cutoff = now.getTime() - LAUNCH_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const id of this.ids()) {
      const files = this.files(id);
      const record = this.read(id);
      if (!files || !record) continue;

      const at = Date.parse(record.at);
      if (Number.isFinite(at) && at < cutoff) {
        rmSync(files.json, { force: true });
        rmSync(files.log, { force: true });
        continue;
      }
      if (record.exitCode === undefined && !describeLaunch(record).alive) {
        writeJsonAtomic(files.json, { ...record, exitCode: null, finishedAt: now.toISOString() });
      }
    }
  }

  /** The last `count` lines of a launch's log, read from its tail only. */
  logTail(id: string, count: number): LogTail {
    const files = this.files(id);
    if (!files) return { status: "not-found" };

    let text: string;
    let start: number;
    try {
      const size = statSync(files.log).size;
      start = Math.max(0, size - LOG_TAIL_BYTES);
      const fd = openSync(files.log, "r");
      try {
        const buffer = Buffer.alloc(size - start);
        const read = readSync(fd, buffer, 0, buffer.byteLength, start);
        text = buffer.subarray(0, read).toString("utf-8");
      } finally {
        closeSync(fd);
      }
    } catch {
      return { status: "not-found" };
    }
    const lines = text.split(/\r?\n/);
    if (lines.at(-1) === "") lines.pop();
    return {
      status: "ok",
      path: files.log,
      lines: lines.slice(-Math.max(1, count)),
      truncated: start > 0 || lines.length > count,
    };
  }

  /** Ids of the records on disk; none when the directory does not exist yet —
   *  it is created by the first action. */
  private ids(): string[] {
    if (!this.dir) return [];
    try {
      return readdirSync(this.dir)
        .filter((name) => name.endsWith(".json"))
        .map((name) => name.slice(0, -".json".length));
    } catch {
      return [];
    }
  }
}
