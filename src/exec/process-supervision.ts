//
// Shared primitives for supervising processes launched by the runner.
//
// Detached processes lead their own Unix process group. Keep the group identity
// after the direct child exits because a grandchild may still hold a port or pipe.

import type { ChildProcess } from "node:child_process";
import { isErrno } from "../lib/errors.js";

export const DEFAULT_KILL_GRACE_MS = 5_000;
export const DEFAULT_FORCE_WAIT_MS = 250;
export const DEFAULT_EXIT_DRAIN_MS = 1_000;
const POLL_INTERVAL_MS = 25;

export interface CapturedProcessOutput {
  stdout(): string;
  stderr(): string;
}

/** Collect a child's text pipes without duplicating stream wiring in callers. */
export function captureProcessOutput(child: ChildProcess): CapturedProcessOutput {
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  return { stdout: () => stdout, stderr: () => stderr };
}

export interface ProcessTrackingOptions {
  /** PID is the leader of a dedicated group (detached spawn). */
  group?: boolean;
}

interface TrackedProcess {
  readonly child: ChildProcess;
  readonly group: boolean;
  readonly pidAtTrack: number | undefined;
  errored: boolean;
}

/**
 * Complete an execution once the child has exited and its inherited pipes have
 * had a bounded opportunity to drain. A descendant can keep stdout/stderr open
 * after the direct child exits, so listening only for `close` can hang forever;
 * listening only for `exit` can truncate output.
 */
export function whenProcessSettled(
  child: ChildProcess,
  finish: (code: number | null) => void | Promise<void>,
  options: { drainMs?: number; onError?: (error: Error) => void | Promise<void> } = {},
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let drainTimer: NodeJS.Timeout | undefined;
    const complete = (code: number | null): void => {
      if (settled) return;
      settled = true;
      if (drainTimer) clearTimeout(drainTimer);
      // Keep finalizer failures on the returned promise. Callers own the
      // execution promise and can reject it instead of creating an unhandled
      // rejection from an ignored async callback.
      try {
        Promise.resolve(finish(code)).then(resolve, reject);
      } catch (error) {
        reject(error);
      }
    };

    child.once("error", (error) => {
      // Error reporting is observational; it must not prevent completion when
      // a host callback throws or returns a rejected promise.
      try {
        const result = options.onError?.(error);
        if (result) void Promise.resolve(result).catch(() => {});
      } catch {}
      complete(null);
    });
    child.once("close", (code) => complete(code));
    child.once("exit", (code) => {
      // `error`/`close` can settle a failed spawn before a late `exit` event.
      // Do not leave a fresh drain timer behind after that finalization.
      if (settled) return;
      drainTimer = setTimeout(() => complete(code), options.drainMs ?? DEFAULT_EXIT_DRAIN_MS);
      drainTimer.unref();
    });
  });
}

function childIsRunning(child: ChildProcess): boolean {
  // `child.killed` means a signal was requested, not that the process exited.
  // Only exitCode/signalCode tracks actual termination.
  return child.exitCode === null && child.signalCode === null;
}

/** Probe a PID or group without treating EPERM as a dead process. */
export function isProcessAlive(pid: number, group = false): boolean {
  try {
    process.kill(group ? -pid : pid, 0);
    return true;
  } catch (error) {
    return isErrno(error, "EPERM");
  }
}

function targetIsAlive(record: TrackedProcess): boolean {
  if (record.errored) return false;
  const pid = record.child.pid ?? record.pidAtTrack;
  if (pid == null) return childIsRunning(record.child);

  // The direct child may have exited while its group still contains a descendant;
  // child.exitCode cannot detect this case.
  if (record.group && isProcessAlive(pid, true)) return true;
  return childIsRunning(record.child);
}

function killTarget(record: TrackedProcess, signal: NodeJS.Signals): void {
  const pid = record.child.pid ?? record.pidAtTrack;
  if (pid == null) return;

  if (record.group) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // The group may have disappeared between the probe and the kill. The
      // fallback also covers platforms without POSIX groups.
    }
  }

  try {
    record.child.kill(signal);
  } catch {}
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Lifetime scope shared by runner spawns.
 *
 * A scope intentionally knows only about children, their optional groups, and
 * global shutdown, not pipeline business logic. The global scope is the default;
 * tests and integrators can create an isolated scope.
 */
export class ProcessScope {
  private readonly processes = new Set<TrackedProcess>();

  private readonly byChild = new WeakMap<ChildProcess, TrackedProcess>();

  private shutdownPromise: Promise<void> | undefined;

  private forceRequested = false;

  track(child: ChildProcess, options: ProcessTrackingOptions = {}): void {
    const existing = this.byChild.get(child);
    if (existing) return;

    const record: TrackedProcess = {
      child,
      group: options.group ?? false,
      pidAtTrack: child.pid ?? undefined,
      errored: false,
    };
    this.processes.add(record);
    this.byChild.set(child, record);

    // `error` covers a missing binary and spawn errors. `exit` is not enough
    // `exit` is not enough because pipes may remain open; `close` gives us a
    // second chance to remove a group that has already disappeared.
    child.once("error", () => {
      record.errored = true;
      this.prune(record);
    });
    child.once("exit", () => this.prune(record));
    child.once("close", () => this.prune(record));
  }

  untrack(child: ChildProcess): void {
    const record = this.byChild.get(child);
    if (!record) return;
    this.processes.delete(record);
    this.byChild.delete(child);
  }

  private prune(record: TrackedProcess): void {
    if (!targetIsAlive(record)) this.untrack(record.child);
  }

  private recordFor(child: ChildProcess): TrackedProcess | undefined {
    return this.byChild.get(child);
  }

  private pruneAll(): void {
    for (const record of [...this.processes]) this.prune(record);
  }

  getLiveChildren(): ChildProcess[] {
    this.pruneAll();
    return [...this.processes].map((record) => record.child);
  }

  hasLiveChildren(): boolean {
    this.pruneAll();
    return this.processes.size > 0;
  }

  /** Effective child state, including its group when detached. */
  isLive(child: ChildProcess): boolean {
    const record = this.recordFor(child);
    if (!record) return childIsRunning(child);
    this.prune(record);
    return this.processes.has(record);
  }

  private killAll(signal: NodeJS.Signals): void {
    this.pruneAll();
    for (const record of this.processes) killTarget(record, signal);
  }

  /** Send a signal to all children and their known groups. */
  killAllChildren(signal: NodeJS.Signals = "SIGTERM"): void {
    this.killAll(signal);
  }

  /** Second signal: skip the grace period immediately. */
  forceKillAll(): void {
    this.forceRequested = true;
    this.killAll("SIGKILL");
  }

  private async waitForChild(child: ChildProcess, graceMs: number, forceWaitMs: number): Promise<void> {
    const record = this.recordFor(child);
    const alive = (): boolean => {
      if (record) {
        this.prune(record);
        return this.processes.has(record);
      }
      return childIsRunning(child);
    };

    const waitUntil = async (timeoutMs: number): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      while (alive() && Date.now() < deadline) await sleep(POLL_INTERVAL_MS);
    };

    await waitUntil(graceMs);
    if (alive()) {
      if (record) killTarget(record, "SIGKILL");
      else {
        try {
          child.kill("SIGKILL");
        } catch {}
      }
      await waitUntil(forceWaitMs);
    }
  }

  /**
   * Idempotent global shutdown: TERM, bounded grace period, then KILL surviving
   * groups. Concurrent calls share the same promise.
   */
  shutdown(options: { graceMs?: number; forceWaitMs?: number } = {}): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;

    const graceMs = options.graceMs ?? DEFAULT_KILL_GRACE_MS;
    const forceWaitMs = options.forceWaitMs ?? DEFAULT_FORCE_WAIT_MS;
    this.forceRequested = false;
    this.killAll("SIGTERM");

    const run = (async () => {
      const deadline = Date.now() + graceMs;
      while (this.hasLiveChildren() && !this.forceRequested && Date.now() < deadline) {
        await sleep(POLL_INTERVAL_MS);
      }
      if (this.hasLiveChildren()) this.killAll("SIGKILL");

      const forceDeadline = Date.now() + forceWaitMs;
      while (this.hasLiveChildren() && Date.now() < forceDeadline) {
        await sleep(POLL_INTERVAL_MS);
      }
    })();

    this.shutdownPromise = run.finally(() => {
      // Allow a new shutdown scope when an integrator reuses this object after a
      // complete shutdown; concurrent calls remain idempotent.
      this.shutdownPromise = undefined;
      this.forceRequested = false;
    });
    return this.shutdownPromise;
  }

  /** Kill a child, then wait for its group to exit, escalating if needed. */
  gracefulKill(
    child: ChildProcess,
    options: { graceMs?: number; forceWaitMs?: number; group?: boolean } = {},
  ): Promise<void> {
    let record = this.recordFor(child);
    if (!record) {
      this.track(child, { group: options.group ?? true });
      record = this.recordFor(child);
    }
    if (record) killTarget(record, "SIGTERM");
    return this.waitForChild(
      child,
      options.graceMs ?? DEFAULT_KILL_GRACE_MS,
      options.forceWaitMs ?? DEFAULT_FORCE_WAIT_MS,
    );
  }
}

const defaultProcessScope = new ProcessScope();

export function defaultScope(): ProcessScope {
  return defaultProcessScope;
}

export function trackChild(child: ChildProcess, options: ProcessTrackingOptions = {}): void {
  defaultProcessScope.track(child, options);
}

export function untrackChild(child: ChildProcess): void {
  defaultProcessScope.untrack(child);
}

/**
 * Kill every active child tree. TERM remains the default signal for regular
 * callers; the `exit` handler explicitly uses KILL.
 */
export function killAllChildren(signal: NodeJS.Signals = "SIGTERM"): void {
  defaultProcessScope.killAllChildren(signal);
}

export function forceKillAllChildren(): void {
  defaultProcessScope.forceKillAll();
}

export function shutdownAllChildren(options: { graceMs?: number; forceWaitMs?: number } = {}): Promise<void> {
  return defaultProcessScope.shutdown(options);
}

/**
 * Stop a detached child. Return the promise so streaming runners can wait for
 * descendants to disappear before returning; older callers may ignore it.
 */
export function gracefulKill(
  child: ChildProcess,
  options: { graceMs?: number; forceWaitMs?: number; group?: boolean } = {},
): Promise<void> {
  return defaultProcessScope.gracefulKill(child, options);
}
