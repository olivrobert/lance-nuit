// runner/exec/process-runner.ts
//
// Low-level supervision shared by backends that launch detached CLIs.

import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { captureProcessOutput, defaultScope, type ProcessScope, whenProcessSettled } from "./process-supervision.js";

/** Default supervisor limit for agent and other detached CLI processes. */
export const DEFAULT_PROCESS_TIMEOUT_MS = 900_000;

export interface SupervisedSpawnOptions extends Omit<SpawnOptions, "signal"> {
  /** `null` disables the timeout; omission keeps the default. */
  timeoutMs?: number | null;
  /** Application signal; kills the tree using the timeout policy. */
  signal?: AbortSignal;
  /** Optional isolated scope for a subsystem or test. */
  scope?: ProcessScope;
  killGraceMs?: number;
}

export interface SupervisedProcess {
  readonly child: ChildProcess;
  readonly killed: boolean;
  readonly killReason: string;
  readonly killPromise: Promise<void> | undefined;
  isAlive(): boolean;
  kill(reason: string): void;
  waitForKill(): Promise<void>;
  clear(): void;
}

export interface SupervisedCommandResult {
  status: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  killed: boolean;
  /** Group cleaned up after normal child exit. */
  killedForCleanup: boolean;
  /** The binary could not be spawned (missing executable, permissions). */
  spawnFailed: boolean;
  killReason?: string;
}

export type SupervisedCommandOptions = Pick<SupervisedSpawnOptions, "cwd" | "env" | "timeoutMs" | "signal" | "stdio">;

/** Spawn a detached CLI while sharing timeout, kill state, and timer cleanup. */
export function spawnSupervisedProcess(
  command: string,
  args: readonly string[],
  options: SupervisedSpawnOptions = {},
): SupervisedProcess {
  const {
    timeoutMs = DEFAULT_PROCESS_TIMEOUT_MS,
    signal,
    scope = defaultScope(),
    killGraceMs,
    ...spawnOptions
  } = options;
  const child = spawn(command, [...args], spawnOptions);
  const group = spawnOptions.detached === true;
  scope.track(child, { group });

  let killed = false;
  let killReason = "";
  let killPromise: Promise<void> | undefined;
  const kill = (reason: string): void => {
    if (killed) return;
    killed = true;
    killReason = reason;
    killPromise = scope.gracefulKill(child, { group, graceMs: killGraceMs });
  };
  const timer =
    timeoutMs == null
      ? undefined
      : setTimeout(() => {
          kill(`timeout (${Math.round(timeoutMs / 1000)}s)`);
        }, timeoutMs);
  timer?.unref();

  const abort = (): void => kill("aborted");
  if (signal) {
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  }

  return {
    child,
    get killed() {
      return killed;
    },
    get killReason() {
      return killReason;
    },
    get killPromise() {
      return killPromise;
    },
    isAlive() {
      return scope.isLive(child);
    },
    kill,
    waitForKill() {
      return killPromise ?? Promise.resolve();
    },
    clear() {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    },
  };
}

/** Execute a binary with separate argv, capture output, and supervise its tree. */
export function runSupervisedCommand(
  command: string,
  args: readonly string[],
  options: SupervisedCommandOptions = {},
): Promise<SupervisedCommandResult> {
  const supervised = spawnSupervisedProcess(command, args, {
    ...options,
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const child = supervised.child;
  let spawnError = "";
  const output = captureProcessOutput(child);

  return new Promise<SupervisedCommandResult>((resolve, reject) => {
    let settled = false;
    let killedForCleanup = false;
    const finish = async (code: number | null): Promise<void> => {
      if (settled) return;
      settled = true;
      if (!supervised.killed && supervised.isAlive()) {
        killedForCleanup = true;
        supervised.kill("child exited with live descendants");
      }
      if (supervised.killed) await supervised.waitForKill();
      const killed = supervised.killed;
      const killedByPolicy = killed && !killedForCleanup;
      const timedOut = killedByPolicy && supervised.killReason.startsWith("timeout");
      const status = killedByPolicy ? 124 : (code ?? 1);
      // `exit` may have triggered this finalization before `close` because a
      // descendant may still hold a pipe open. The drain is complete, so do not
      // let the stream keep the runner alive after resolution.
      child.stdout?.destroy();
      child.stderr?.destroy();
      supervised.clear();
      resolve({
        status,
        stdout: output.stdout(),
        stderr: output.stderr() || spawnError,
        timedOut,
        killed: killedByPolicy,
        killedForCleanup,
        spawnFailed: spawnError !== "",
        ...(supervised.killReason ? { killReason: supervised.killReason } : {}),
      });
    };
    void whenProcessSettled(child, finish, {
      onError: (error) => {
        spawnError = `${command}: ${error.message}`;
      },
    }).catch(reject);
  });
}

/** Reason recorded when the group is cleaned after a normal child exit. It reaches
 *  the result as `killReason` next to `killedForCleanup`, never next to `killed`. */
const CLEANUP_KILL_REASON = "child exited with descendants still alive";

/** Resolve a caller timeout for the supervisor. An omitted or non-positive value
 *  yields `undefined`, which lets `spawnSupervisedProcess` apply its documented
 *  default rather than spawning without any deadline. */
export function supervisorTimeout(timeoutMs: number | null | undefined): number | undefined {
  return timeoutMs != null && timeoutMs > 0 ? timeoutMs : undefined;
}

export interface SupervisedStreamResult {
  output: string;
  code: number | null;
  /** Killed by policy: timeout, budget, or abort. */
  killed: boolean;
  /** The group still held a live descendant after a normal exit and was cleaned.
   *  Mutually exclusive with `killed`. Whether it should fail the step is the
   *  caller's call, and backends disagree: the Claude host tolerates a straggler
   *  and keeps the CLI's verdict, the codex and opencode hosts reject the run. */
  killedForCleanup: boolean;
  killReason?: string;
  durationMs: number;
}

/** Kill authority handed to the hooks. They observe and may kill the tree; they
 *  never own the child, the streams, or the teardown order. */
export interface SupervisedStreamControl {
  readonly killed: boolean;
  kill(reason: string): void;
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

export interface SupervisedStreamOptions extends SupervisedSpawnOptions {
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
export function runSupervisedStream(
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
      return supervised.killed;
    },
    kill: (reason) => supervised.kill(reason),
  });
  let output = "";

  return new Promise<SupervisedStreamResult>((resolve, reject) => {
    let finalized = false;
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

    const finish = async (code: number | null): Promise<void> => {
      if (finalized) return;
      finalized = true;
      // A normal exit can leave the group populated: the direct child is gone but
      // a grandchild still holds a pipe. Report that separately from a policy
      // kill so each backend keeps its own verdict for the case.
      let killedForCleanup = false;
      try {
        handlers.onFinalize?.(output);
      } finally {
        // A hook that throws must not leave the process group or the streams
        // behind: the cleanup runs whatever the hook did, then the throw rejects.
        if (!supervised.killed && supervised.isAlive()) {
          killedForCleanup = true;
          supervised.kill(CLEANUP_KILL_REASON);
        }
        if (supervised.killed) await supervised.waitForKill();
        supervised.clear();
        // The drain is complete; do not let a stream keep the runner alive past
        // resolution.
        child.stdout?.destroy();
        child.stderr?.destroy();
      }
      resolve({
        output,
        code,
        killed: supervised.killed && !killedForCleanup,
        killedForCleanup,
        ...(supervised.killReason ? { killReason: supervised.killReason } : {}),
        durationMs: Date.now() - started,
      });
    };
    void whenProcessSettled(child, finish, { drainMs }).catch(reject);
  });
}
