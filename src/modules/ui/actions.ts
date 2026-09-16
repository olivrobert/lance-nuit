// modules/ui/actions.ts
//
// The verbs: the closed set of things the dashboard can make the runner do, each
// one exactly one existing `lancenuit` invocation (spec 5.1).
//
// Three rules shape this module.
//
// First, the server builds `argv` itself. A request names a verb and an item; it
// never carries an argument that reaches the command line as typed. The subject
// must be the one the run is stopped on, the pipeline is the run's, the worktree
// mode is the run's, and the budget is a bounded number the server formats.
//
// Second, the runner is spawned DETACHED, with an argv array and no shell, its
// output going to the launch's log file. The dashboard may be stopped and
// restarted while a run keeps going; nothing here holds the child's lifetime.
//
// Third, every action leaves a launch record — who, when, what, pid, exit code —
// which is the only state the dashboard owns besides its two lists. The read
// model reads those records back to show an item as running and to attribute
// the click.

import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { errorMessage } from "../../lib/errors.js";
import {
  describeLaunch,
  type Item,
  isValidLaunchId,
  type Launch,
  type LaunchRecord,
  launchesDir,
  launchPaths,
  readLaunchRecord,
} from "../read-model/index.js";

export const VERBS = ["approve-and-rerun", "approve", "rerun", "fresh", "budget"] as const;
export type Verb = (typeof VERBS)[number];

export function isVerb(value: unknown): value is Verb {
  return typeof value === "string" && (VERBS as readonly string[]).includes(value);
}

/** Highest cost ceiling the dashboard will approve in one click, in USD. */
export const MAX_BUDGET_USD = 1000;

/** Launches older than this are purged when the server starts (H1). */
export const LAUNCH_RETENTION_DAYS = 30;

/** Bytes read from the end of a log to show its last lines. */
const LOG_TAIL_BYTES = 64 * 1024;

/** Inputs a request may carry beside the verb and the item. */
export interface ActionInput {
  subject?: unknown;
  budget?: unknown;
}

export type ArgvResult = { ok: true; argv: string[] } | { ok: false; status: number; reason: string };

/** An item on which nothing may be launched right now: the runner is running, or
 *  a launch of ours is still alive. */
export function isBusy(item: Item): boolean {
  return item.status === "RUNNING" || item.launch?.alive === true;
}

/** Format a validated budget the way the CLI parses it: a positive decimal. */
function formatBudget(value: unknown): string | undefined {
  const amount = typeof value === "string" ? Number(value.trim()) : value;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0 || amount > MAX_BUDGET_USD)
    return undefined;
  // Validate what the CLI will actually receive: 0.001 is positive but rounds
  // to "0", which the CLI would refuse or, worse, read as no budget at all.
  const cents = Math.round(amount * 100) / 100;
  if (cents <= 0) return undefined;
  return String(cents);
}

/**
 * Arguments of one verb on one item, or the refusal.
 *
 * Each verb is admitted only in the situation of spec 5.1 — an approval on a run
 * that is not stopped at a gate is refused, not attempted — and every value on
 * the command line comes from the item the read model built, never from the
 * request, except the budget, which is parsed and formatted here.
 */
export function buildArgv(item: Item, verb: Verb, input: ActionInput = {}): ArgvResult {
  if (isBusy(item)) return { ok: false, status: 409, reason: "a run is already in progress for this item" };

  const worktree = item.worktree ? ["--worktree"] : [];
  const run = ["run", item.ticket, "--pipeline", item.pipeline];
  const gate = item.status === "STOPPED" ? item.stop?.subject : undefined;

  switch (verb) {
    case "approve-and-rerun":
    case "approve": {
      if (!gate) return { ok: false, status: 409, reason: "this run is not stopped at a gate with a subject" };
      if (typeof input.subject !== "string" || input.subject !== gate) {
        return { ok: false, status: 400, reason: `subject must be the pending gate "${gate}"` };
      }
      if (!/^[\w-]+$/.test(gate)) return { ok: false, status: 409, reason: "the pending subject is not a valid token" };
      if (verb === "approve") {
        return { ok: true, argv: ["approve", item.ticket, gate, "--pipeline", item.pipeline, ...worktree] };
      }
      return { ok: true, argv: [...run, "--approve", gate, ...worktree] };
    }
    case "rerun": {
      const blocked = item.status === "STOPPED" && !gate;
      const failed = item.status === "FAIL" || item.status === "ABORTED";
      if (!blocked && !failed) return { ok: false, status: 409, reason: "only a blocked or failed run can be resumed" };
      return { ok: true, argv: [...run, ...worktree] };
    }
    case "budget": {
      if (!item.budgetExceeded) return { ok: false, status: 409, reason: "this run was not stopped by its budget" };
      const budget = formatBudget(input.budget);
      if (!budget) {
        return { ok: false, status: 400, reason: `budget must be a positive amount of at most ${MAX_BUDGET_USD} USD` };
      }
      return { ok: true, argv: [...run, "--budget", budget, ...worktree] };
    }
    case "fresh":
      return { ok: true, argv: [...run, "--fresh", ...worktree] };
  }
}

/** The `lancenuit` wrapper shipped with this installation, next to `src/` or
 *  `dist/`. Tests substitute an executable of their own. */
export function defaultLauncher(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "bin", "lancenuit");
}

function writeJsonAtomic(path: string, value: unknown): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  try {
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/** `2026-09-05T08:15:00.123Z` → `20260905T081500123Z`: sortable, one token. */
function stamp(date: Date): string {
  return date.toISOString().replace(/[-:.]/g, "");
}

export interface LaunchRequest {
  item: Item;
  verb: Verb;
  argv: string[];
  /** Name from the identity cookie. */
  by: string;
  /** Executable to spawn; defaults to this installation's `bin/lancenuit`. */
  launcher?: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}

export type LaunchResult = { ok: true; launch: Launch } | { ok: false; status: number; reason: string };

/**
 * Spawn the runner for one verb and record the launch.
 *
 * The record is written BEFORE the process is observed: a server killed a
 * millisecond after `spawn` still leaves the pid on disk, and the next start
 * reconciles it. The child is detached and unreferenced, so the dashboard never
 * waits for it and Ctrl+C on the dashboard does not reach it; its output goes to
 * the launch's log, which is also where a failure before any run (lock held,
 * `bun` missing) ends up.
 */
export function launchVerb(request: LaunchRequest): LaunchResult {
  const env = request.env ?? process.env;
  const dir = launchesDir(env);
  if (!dir) return { ok: false, status: 500, reason: "no home directory to record launches" };
  mkdirSync(dir, { recursive: true });

  const now = request.now ?? new Date();
  const id = `${stamp(now)}-${request.item.ticket}-${request.verb}`;
  const paths = launchPaths(id, env);
  if (!paths) return { ok: false, status: 500, reason: `launch id "${id}" is not a valid file name` };

  const launcher = request.launcher ?? defaultLauncher();
  const cwd = request.item.project.cwd;
  const logFd = openSync(paths.log, "a");
  let child: ChildProcess;
  try {
    child = spawn(launcher, request.argv, {
      cwd,
      env: { ...env, LANCENUIT_ACTOR: request.by },
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
  } catch (error) {
    closeSync(logFd);
    return { ok: false, status: 500, reason: `could not spawn ${launcher}: ${errorMessage(error)}` };
  }
  closeSync(logFd);

  const record: LaunchRecord = {
    id,
    at: now.toISOString(),
    by: request.by,
    project: request.item.project.name,
    ticket: request.item.ticket,
    verb: request.verb,
    argv: request.argv,
    cwd,
    pid: child.pid ?? -1,
  };
  writeJsonAtomic(paths.json, record);

  const finish = (exitCode: number | null, note?: string): void => {
    if (note) {
      try {
        writeFileSync(paths.log, `${note}\n`, { flag: "a" });
      } catch {
        // The log is a convenience; the record below is what matters.
      }
    }
    // This runs from a child-process event, outside any HTTP route: a throw here
    // would be an uncaught exception and take the whole dashboard down. The
    // launch then stays open and `reconcileLaunches` closes it at next start.
    try {
      const current = readLaunchRecord(paths.json) ?? record;
      if (current.exitCode !== undefined) return;
      writeJsonAtomic(paths.json, { ...current, exitCode, finishedAt: new Date().toISOString() });
    } catch (error) {
      try {
        writeFileSync(paths.log, `launch record could not be closed: ${errorMessage(error)}\n`, { flag: "a" });
      } catch {
        // Nothing left to write to.
      }
    }
  };
  // `error` fires when the executable cannot be started at all (ENOENT, EACCES):
  // there is no process, so the launch is closed with no exit code and the
  // reason lands in the log, where the reader looks for a failure before run.
  child.once("error", (error) => finish(null, `lancenuit could not be started: ${error.message}`));
  child.once("exit", (code) => finish(code));
  child.unref();

  return { ok: true, launch: describeLaunch(record) };
}

/**
 * Close the launches a previous server left open, and drop the old ones (H1).
 *
 * Called once at startup. A launch with no exit code whose pid is gone was ended
 * while no server was watching; it is closed with `exitCode: null` and the
 * current time, which is the most honest `finishedAt` available. Launches older
 * than the retention window lose both their files.
 */
export function reconcileLaunches(env: NodeJS.ProcessEnv = process.env, now: Date = new Date()): void {
  const dir = launchesDir(env);
  if (!dir) return;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }

  const cutoff = now.getTime() - LAUNCH_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -".json".length);
    const paths = launchPaths(id, env);
    if (!paths) continue;
    const record = readLaunchRecord(paths.json);
    if (!record) continue;

    const at = Date.parse(record.at);
    if (Number.isFinite(at) && at < cutoff) {
      rmSync(paths.json, { force: true });
      rmSync(paths.log, { force: true });
      continue;
    }
    const launch = describeLaunch(record);
    if (record.exitCode === undefined && !launch.alive) {
      writeJsonAtomic(paths.json, { ...record, exitCode: null, finishedAt: now.toISOString() });
    }
  }
}

export type LogTail = { status: "ok"; path: string; lines: string[]; truncated: boolean } | { status: "not-found" };

/** The last `count` lines of a launch's log, read from its tail only. */
export function readLaunchLogTail(id: string, count: number, env: NodeJS.ProcessEnv = process.env): LogTail {
  if (!isValidLaunchId(id)) return { status: "not-found" };
  const paths = launchPaths(id, env);
  if (!paths) return { status: "not-found" };

  let size: number;
  try {
    size = statSync(paths.log).size;
  } catch {
    return { status: "not-found" };
  }
  const start = Math.max(0, size - LOG_TAIL_BYTES);
  let text: string;
  try {
    const fd = openSync(paths.log, "r");
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
    path: paths.log,
    lines: lines.slice(-Math.max(1, count)),
    truncated: start > 0 || lines.length > count,
  };
}
