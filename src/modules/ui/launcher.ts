// modules/ui/launcher.ts
//
// Spawning the runner for one verb.
//
// Two rules shape this module.
//
// First, the runner is spawned DETACHED, with an argv array and no shell, its
// output going to the launch's log file. The dashboard may be stopped and
// restarted while a run keeps going; nothing here holds the child's lifetime.
//
// Second, every action leaves a launch record — who, when, what, pid, exit code —
// in the launch store, which is the only state the dashboard owns besides its
// two lists. The read model reads those records back to show an item as running
// and to attribute the click.

import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { errorMessage } from "../../lib/errors.js";
import { describeLaunch, type FileLaunchStore, type Launch, type LaunchRecord } from "../dashboard-home/index.js";
import type { Item } from "../read-model/index.js";
import type { Verb } from "./verbs.js";

/** The `lancenuit` wrapper shipped with this installation, next to `src/` or
 *  `dist/`. Tests substitute an executable of their own. */
export function defaultLauncher(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "bin", "lancenuit");
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
  now?: Date;
}

export type LaunchResult = { ok: true; launch: Launch } | { ok: false; status: number; reason: string };

export interface VerbLauncherOptions {
  launches: FileLaunchStore;
  /** Environment handed to the runner, with `LANCENUIT_ACTOR` added. */
  env: NodeJS.ProcessEnv;
  /** Executable to spawn; defaults to this installation's `bin/lancenuit`. */
  executable?: string;
}

/** Spawns the runner for one verb and records the launch. */
export class VerbLauncher {
  private readonly executable: string;

  constructor(private readonly options: VerbLauncherOptions) {
    this.executable = options.executable ?? defaultLauncher();
  }

  /**
   * Spawn the runner and record the launch.
   *
   * The record is written BEFORE the process is observed: a server killed a
   * millisecond after `spawn` still leaves the pid on disk, and the next start
   * reconciles it. The child is detached and unreferenced, so the dashboard never
   * waits for it and Ctrl+C on the dashboard does not reach it; its output goes to
   * the launch's log, which is also where a failure before any run (lock held,
   * `bun` missing) ends up.
   */
  launch(request: LaunchRequest): LaunchResult {
    const { launches, env } = this.options;
    const now = request.now ?? new Date();
    const id = `${stamp(now)}-${request.item.ticket}-${request.verb}`;
    if (!launches.available) return { ok: false, status: 500, reason: "no home directory to record launches" };
    const files = launches.prepare(id);
    if (!files) return { ok: false, status: 500, reason: `launch id "${id}" is not a valid file name` };

    const cwd = request.item.project.cwd;
    const logFd = openSync(files.log, "a");
    let child: ChildProcess;
    try {
      child = spawn(this.executable, request.argv, {
        cwd,
        env: { ...env, LANCENUIT_ACTOR: request.by },
        detached: true,
        stdio: ["ignore", logFd, logFd],
      });
    } catch (error) {
      closeSync(logFd);
      return { ok: false, status: 500, reason: `could not spawn ${this.executable}: ${errorMessage(error)}` };
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
    launches.write(record);

    // `error` fires when the executable cannot be started at all (ENOENT, EACCES):
    // there is no process, so the launch is closed with no exit code and the
    // reason lands in the log, where the reader looks for a failure before run.
    child.once("error", (error) => launches.close(record, null, `lancenuit could not be started: ${error.message}`));
    child.once("exit", (code) => launches.close(record, code));
    child.unref();

    return { ok: true, launch: describeLaunch(record) };
  }
}
