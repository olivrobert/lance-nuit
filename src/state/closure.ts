// runner/state/closure.ts
//
// A human closure of a run: "this ticket was finished by hand, stop showing it".
//
// It lives in its own file beside `state.json` rather than inside it, so the
// snapshot — the source of truth for resuming — keeps the status the runner gave
// it. A closure never turns a FAIL into a PASS; it only says nobody is waiting
// on that FAIL any more.
//
// A closure is bound to the snapshot it was taken on through `runUpdatedAt`: the
// moment the runner writes that snapshot again (a rerun, an approval and rerun),
// the closure no longer describes the run and readers ignore it. Nothing has to
// remember to delete it.

import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PersistedRun, RunStatus } from "../model/persisted.js";

export const CLOSURE_FILE = "closure.json";

export interface RunClosure {
  schemaVersion: 1;
  closedAt: string;
  /** Who closed it, as `decisionActor()` resolved it. */
  closedBy: string;
  /** `updatedAt` of the snapshot at closing time: the closure applies to that
   *  snapshot only. */
  runUpdatedAt: string;
}

/** Statuses a person may close: the ones that wait on somebody. */
const CLOSABLE: readonly RunStatus[] = ["FAIL", "STOPPED", "ABORTED"];

export function isClosableStatus(status: RunStatus | undefined): boolean {
  return status !== undefined && CLOSABLE.includes(status);
}

function isClosure(value: unknown): value is RunClosure {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.schemaVersion === 1 &&
    typeof record.closedAt === "string" &&
    typeof record.closedBy === "string" &&
    typeof record.runUpdatedAt === "string"
  );
}

/** The closure of a run directory; `undefined` when absent or unreadable. */
export function readClosureAt(runDir: string): RunClosure | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(runDir, CLOSURE_FILE), "utf-8"));
  } catch {
    // Absent or not JSON: the run is not closed.
    return undefined;
  }
  return isClosure(parsed) ? parsed : undefined;
}

/** True while the snapshot is still the one the closure was taken on. */
export function isClosureCurrent(closure: RunClosure, state: PersistedRun): boolean {
  return (state.updatedAt ?? state.createdAt) === closure.runUpdatedAt;
}

/** Build the closure of `state`, taken now by `actor`. */
export function closureOf(state: PersistedRun, actor: string, now: Date = new Date()): RunClosure {
  return {
    schemaVersion: 1,
    closedAt: now.toISOString(),
    closedBy: actor,
    runUpdatedAt: state.updatedAt ?? state.createdAt ?? "",
  };
}

export function writeClosureAt(runDir: string, closure: RunClosure): void {
  const path = join(runDir, CLOSURE_FILE);
  const temporary = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(closure, null, 2)}\n`, "utf-8");
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

export function removeClosureAt(runDir: string): void {
  rmSync(join(runDir, CLOSURE_FILE), { force: true });
}
