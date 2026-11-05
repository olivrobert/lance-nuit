//
// The one way the runner starts a process: supervised for timeout, kill and
// shutdown, without the runner's own state in its environment, and torn down by a
// single finalization whatever way it is consumed.

import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { withoutRunnerState } from "../env/runner-env.js";
import { captureProcessOutput, defaultScope, type ProcessScope, whenProcessSettled } from "./process-supervision.js";

/** Default supervisor limit for agent and other detached CLI processes. */
export const DEFAULT_PROCESS_TIMEOUT_MS = 900_000;

/** Exit status reported for a process killed by policy, the `timeout(1)` convention. */
export const KILLED_BY_POLICY_STATUS = 124;

/** Why the supervisor killed a process. */
export type KillCause = "timeout" | "no-first-event" | "budget" | "cost-unaccounted" | "signal" | "cleanup";

/**
 * A kill and what its text needs. `cleanup` is the group cleaned after a normal
 * exit of the direct child, because a descendant was still alive; every other
 * cause is a kill by policy.
 */
export type ProcessKill =
  | { readonly cause: "timeout" | "no-first-event"; readonly afterMs: number }
  /** `detail` says what was spent, or what could not be priced. */
  | { readonly cause: "budget" | "cost-unaccounted"; readonly detail: string }
  | { readonly cause: "signal" | "cleanup" };

/** A kill by policy, as opposed to the cleanup of a group after a normal exit. */
export function killedByPolicy(kill: ProcessKill | undefined): boolean {
  return kill !== undefined && kill.cause !== "cleanup";
}

/** A deadline expired: the process ran too long, or never started speaking. */
export function killedByTimeout(kill: ProcessKill | undefined): boolean {
  return kill?.cause === "timeout" || kill?.cause === "no-first-event";
}

/** The text a log or a failure reason shows for `kill`. */
export function describeKill(kill: ProcessKill): string {
  switch (kill.cause) {
    case "timeout":
      return `timeout (${Math.round(kill.afterMs / 1000)}s)`;
    case "no-first-event":
      return `no first event within ${kill.afterMs}ms`;
    case "budget":
      return `budget exceeded (${kill.detail})`;
    case "cost-unaccounted":
      // Distinct from the budget text: the two stops send an operator to two
      // different flags, and `--budget` cannot price a closed attempt.
      return `cost unaccounted (${kill.detail}) — rerun with --allow-unmetered to authorize it`;
    case "signal":
      return "aborted";
    case "cleanup":
      return "child exited with descendants still alive";
  }
}

export interface SupervisedSpawnOptions extends Omit<SpawnOptions, "signal"> {
  /** Deadline in ms. `null` runs without one; absent, zero or negative means
   *  `DEFAULT_PROCESS_TIMEOUT_MS`. */
  timeoutMs?: number | null;
  /** Application signal; kills the tree like a timeout does. */
  signal?: AbortSignal;
  /** Optional isolated scope for a subsystem or test. */
  scope?: ProcessScope;
  /** Pass the runner's state variables through. Only a runner relaunching itself
   *  may; every other child gets the environment without them. */
  inheritRunnerState?: boolean;
}

/** How a supervised process ended. */
export interface ProcessEnd {
  code: number | null;
  kill?: ProcessKill;
  /** The binary could not be spawned (missing executable, permissions). */
  spawnError?: Error;
}

export interface SettleOptions {
  /** Bounded drain window after `exit`; omitted keeps the supervision default. */
  drainMs?: number;
  /** Runs once, before the teardown: flush line buffers, clear timers. A throw
   *  still tears the process down, then rejects. */
  beforeTeardown?(): void;
}

export interface SupervisedProcess {
  readonly child: ChildProcess;
  /** The kill applied so far, if any. */
  readonly kill: ProcessKill | undefined;
  /** Kill the tree. The first kill wins; later ones are ignored. */
  terminate(kill: ProcessKill): void;
  /** Wait for the end, clean a group a descendant kept alive, and release the
   *  timer, the signal listener and the streams. Call it once. */
  settle(options?: SettleOptions): Promise<ProcessEnd>;
}

function deadlineOf(timeoutMs: number | null | undefined): number | null {
  if (timeoutMs === null) return null;
  return timeoutMs !== undefined && timeoutMs > 0 ? timeoutMs : DEFAULT_PROCESS_TIMEOUT_MS;
}

/** Spawn a process under supervision. */
export function spawnSupervisedProcess(
  command: string,
  args: readonly string[],
  options: SupervisedSpawnOptions = {},
): SupervisedProcess {
  const { timeoutMs, signal, scope = defaultScope(), inheritRunnerState = false, ...spawnOptions } = options;
  const env = spawnOptions.env ?? process.env;
  const child = spawn(command, [...args], {
    ...spawnOptions,
    env: inheritRunnerState ? env : withoutRunnerState(env),
  });
  const group = spawnOptions.detached === true;
  scope.track(child, { group });

  let applied: ProcessKill | undefined;
  let killPromise: Promise<void> | undefined;
  const terminate = (kill: ProcessKill): void => {
    if (applied) return;
    applied = kill;
    killPromise = scope.gracefulKill(child, { group });
  };

  const deadline = deadlineOf(timeoutMs);
  const timer =
    deadline === null ? undefined : setTimeout(() => terminate({ cause: "timeout", afterMs: deadline }), deadline);
  timer?.unref();

  const abort = (): void => terminate({ cause: "signal" });
  if (signal) {
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  }

  const settle = (settleOptions: SettleOptions = {}): Promise<ProcessEnd> =>
    new Promise<ProcessEnd>((resolve, reject) => {
      let spawnError: Error | undefined;
      const finish = async (code: number | null): Promise<void> => {
        try {
          settleOptions.beforeTeardown?.();
        } finally {
          // A normal exit can leave the group populated: the direct child is gone
          // but a grandchild still holds a pipe or a port.
          if (!applied && scope.isLive(child)) terminate({ cause: "cleanup" });
          // A kill does not return until its escalation has finished: a
          // descendant that ignores TERM must not outlive the call.
          if (killPromise) await killPromise;
          if (timer) clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          // `exit` may have triggered this finalization before `close` because a
          // descendant may still hold a pipe open. The drain is complete, so do
          // not let a stream keep the runner alive after resolution.
          child.stdout?.destroy();
          child.stderr?.destroy();
        }
        resolve({ code, ...(applied ? { kill: applied } : {}), ...(spawnError ? { spawnError } : {}) });
      };
      void whenProcessSettled(child, finish, {
        drainMs: settleOptions.drainMs,
        onError: (error) => {
          spawnError = error;
        },
      }).catch(reject);
    });

  return {
    child,
    get kill() {
      return applied;
    },
    terminate,
    settle,
  };
}

export interface SupervisedCommandResult {
  /** Exit code; `KILLED_BY_POLICY_STATUS` when killed by policy, 1 when unknown. */
  status: number;
  stdout: string;
  /** `stdout` before UTF-8 decoding. */
  stdoutBytes: Buffer;
  stderr: string;
  kill?: ProcessKill;
  /** The binary could not be spawned (missing executable, permissions). */
  spawnFailed: boolean;
}

export type SupervisedCommandOptions = Pick<
  SupervisedSpawnOptions,
  "cwd" | "env" | "timeoutMs" | "signal" | "stdio" | "scope"
>;

/** Execute a binary with separate argv, capture output, and supervise its tree. */
export async function runSupervisedCommand(
  command: string,
  args: readonly string[],
  options: SupervisedCommandOptions = {},
): Promise<SupervisedCommandResult> {
  const supervised = spawnSupervisedProcess(command, args, {
    ...options,
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const output = captureProcessOutput(supervised.child);
  const end = await supervised.settle();
  const spawnError = end.spawnError ? `${command}: ${end.spawnError.message}` : "";
  return {
    status: killedByPolicy(end.kill) ? KILLED_BY_POLICY_STATUS : (end.code ?? 1),
    stdout: output.stdout(),
    stdoutBytes: output.stdoutBytes(),
    stderr: output.stderr() || spawnError,
    ...(end.kill ? { kill: end.kill } : {}),
    spawnFailed: spawnError !== "",
  };
}

export interface SupervisedStreamResult {
  output: string;
  code: number | null;
  /** Absent when the process ended on its own with no descendant left. A
   *  `cleanup` kill means the group still held a live descendant after a normal
   *  exit; whether it fails the step is the caller's call, and backends disagree:
   *  the Claude host tolerates a straggler and keeps the CLI's verdict, the codex
   *  and opencode hosts reject the run. */
  kill?: ProcessKill;
  durationMs: number;
}

/** Kill authority handed to the hooks. They observe and may kill the tree; they
 *  never own the child, the streams, or the teardown order. */
export interface SupervisedStreamControl {
  readonly killed: boolean;
  kill(kill: ProcessKill): void;
}

export interface SupervisedStreamHooks {
  /** One stdout chunk. `output` is the running total, `text` already appended. */
  onStdout?(text: string, output: string): void;
  /** One stderr chunk. Never called when stderr is not piped. */
  onStderr?(text: string): void;
  /** Once, at the top of finalization: flush line buffers, clear timers, write
   *  trailing logs. Runs before the teardown, while `output` is already final. */
  onFinalize?(output: string): void;
}

export interface SupervisedStreamOptions extends Omit<SupervisedSpawnOptions, "inheritRunnerState"> {
  /** Bounded drain window after `exit`; omitted keeps the supervision default. */
  drainMs?: number;
}

/**
 * Streaming sibling of `runSupervisedCommand`: same supervision and teardown, but
 * the caller parses stdout as it arrives instead of receiving one buffered string.
 *
 * `hooks` is a factory rather than a plain object because every caller needs the
 * kill authority to enforce a budget or a first-event deadline, and that authority
 * only exists once the process is spawned.
 */
export async function runSupervisedStream(
  command: string,
  args: readonly string[],
  options: SupervisedStreamOptions,
  hooks: (control: SupervisedStreamControl) => SupervisedStreamHooks,
): Promise<SupervisedStreamResult> {
  const started = Date.now();
  const { drainMs, ...spawnOptions } = options;
  const supervised = spawnSupervisedProcess(command, args, spawnOptions);
  const child = supervised.child;
  const handlers = hooks({
    get killed() {
      return supervised.kill !== undefined;
    },
    kill: (kill) => supervised.terminate(kill),
  });
  let output = "";
  // Decode through the stream so a multi-byte UTF-8 sequence split across two
  // chunks is reassembled instead of becoming U+FFFD (which would corrupt a
  // NDJSON line and lose its usage/cost record).
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (text: string) => {
    output += text;
    handlers.onStdout?.(text, output);
  });
  if (handlers.onStderr) {
    child.stderr?.on("data", (text: string) => handlers.onStderr?.(text));
  }

  const end = await supervised.settle({ drainMs, beforeTeardown: () => handlers.onFinalize?.(output) });
  return { output, code: end.code, ...(end.kill ? { kill: end.kill } : {}), durationMs: Date.now() - started };
}
