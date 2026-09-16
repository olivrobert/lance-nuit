// modules/ui/store.ts
//
// The three files the dashboard owns, under `~/.lance-nuit/ui/`: `users.json`,
// `projects.json`, and (from ticket 06) `launches/`. Nothing here touches a
// project's `.lance-nuit/` — every write inside a project goes through the CLI.
//
// The read model owns READING `projects.json`, because that is what it needs to
// enumerate items; writing it is a dashboard concern and lives here. Both agree
// on the location through `uiDir()` / `projectsFile()`, so `PIPELINE_HOME` moves
// the reader and the writer together — which is what makes a test able to point
// the whole server at a disposable directory.
//
// Writes are atomic (temporary file, then `rename`), like the runner's: a server
// killed mid-write leaves the previous file intact rather than a truncated one
// that would read as "no projects".

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { projectsFile, uiDir } from "../read-model/index.js";

/** Display names accepted in `users.json` and in the identity cookie. The same
 *  shape the runner accepts for `LANCENUIT_ACTOR`, so a name chosen here can be
 *  handed to a launch unchanged (ticket 06). */
const USER_NAME = /^[\w .-]{1,64}$/;

export interface UiPaths {
  dir: string;
  users: string;
  projects: string;
  launches: string;
}

/** Where the dashboard's own files live, or `undefined` when no home directory is
 *  resolvable — the one case with nothing to read and nowhere to write. */
export function uiPaths(env: NodeJS.ProcessEnv = process.env): UiPaths | undefined {
  const dir = uiDir(env);
  const projects = projectsFile(env);
  if (!dir || !projects) return undefined;
  return { dir, users: join(dir, "users.json"), projects, launches: join(dir, "launches") };
}

/** Write `value` as JSON, atomically. The temporary file sits in the destination
 *  directory so the `rename` stays on one filesystem, where it is atomic. */
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

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    // Absent, or hand-edited into invalid JSON: the caller falls back to empty
    // rather than the server refusing to start over one file.
    return undefined;
  }
}

/**
 * Create the dashboard's directory and its two files, empty but valid, when they
 * are missing.
 *
 * Run once at startup so the first request never has to answer "the file does
 * not exist yet", and so a human editing `users.json` by hand (H2) finds a file
 * with the right shape instead of having to invent it. An existing file is never
 * rewritten — that would erase a name someone just added.
 */
export function ensureUiFiles(env: NodeJS.ProcessEnv = process.env): UiPaths | undefined {
  const paths = uiPaths(env);
  if (!paths) return undefined;
  mkdirSync(paths.dir, { recursive: true });
  if (readJson(paths.users) === undefined) writeJsonAtomic(paths.users, { users: [] });
  if (readJson(paths.projects) === undefined) writeJsonAtomic(paths.projects, { projects: [] });
  return paths;
}

export function isValidUserName(value: unknown): value is string {
  return typeof value === "string" && USER_NAME.test(value);
}

/**
 * Names allowed to use the dashboard, in file order.
 *
 * An empty list is a legitimate state, not an error: it means nobody has been
 * declared yet, and the choice page says so instead of the server failing.
 */
export function readUsers(env: NodeJS.ProcessEnv = process.env): string[] {
  const paths = uiPaths(env);
  if (!paths) return [];
  const parsed = readJson(paths.users);
  if (!parsed || typeof parsed !== "object") return [];
  const users = (parsed as { users?: unknown }).users;
  if (!Array.isArray(users)) return [];

  const names: string[] = [];
  for (const entry of users) {
    if (!isValidUserName(entry)) continue;
    if (!names.includes(entry)) names.push(entry);
  }
  return names;
}

/** True when `name` may act as an identity: declared, and shaped like a name. */
export function isKnownUser(name: string | undefined, env: NodeJS.ProcessEnv = process.env): name is string {
  return isValidUserName(name) && readUsers(env).includes(name);
}

/** Absolute project paths currently listed, in file order. Reading is done here
 *  rather than through the read model because adding and removing need the raw
 *  list, not the described projects. */
function listedProjectPaths(paths: UiPaths): string[] {
  const parsed = readJson(paths.projects);
  const entries = parsed && typeof parsed === "object" ? (parsed as { projects?: unknown }).projects : undefined;
  if (!Array.isArray(entries)) return [];

  const listed: string[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const path = (entry as { path?: unknown }).path;
    if (typeof path !== "string" || path.trim().length === 0) continue;
    const absolute = resolve(path.trim());
    if (!listed.includes(absolute)) listed.push(absolute);
  }
  return listed;
}

export type ProjectWrite = { status: "ok"; paths: string[] } | { status: "error"; reason: string };

/**
 * Add a project path to `projects.json`.
 *
 * The path is stored absolute and deduplicated. Whether it still exists is NOT
 * checked here: the read model already reports a vanished path as not found, and
 * the file is the list of projects the reader cares about, not a list of
 * directories that happen to exist right now. The caller decides whether to
 * refuse a path that is not a directory today.
 */
export function addProject(path: string, env: NodeJS.ProcessEnv = process.env): ProjectWrite {
  const paths = ensureUiFiles(env);
  if (!paths) return { status: "error", reason: "no home directory to store the dashboard files" };

  const absolute = resolve(path.trim());
  const listed = listedProjectPaths(paths);
  if (!listed.includes(absolute)) {
    listed.push(absolute);
    writeJsonAtomic(paths.projects, { projects: listed.map((entry) => ({ path: entry })) });
  }
  return { status: "ok", paths: listed };
}

/** Remove a project path. Removing one that is not listed is a no-op, so the
 *  same click twice does not become an error. */
export function removeProject(path: string, env: NodeJS.ProcessEnv = process.env): ProjectWrite {
  const paths = ensureUiFiles(env);
  if (!paths) return { status: "error", reason: "no home directory to store the dashboard files" };

  const absolute = resolve(path.trim());
  const listed = listedProjectPaths(paths);
  const kept = listed.filter((entry) => entry !== absolute);
  if (kept.length !== listed.length) {
    writeJsonAtomic(paths.projects, { projects: kept.map((entry) => ({ path: entry })) });
  }
  return { status: "ok", paths: kept };
}
