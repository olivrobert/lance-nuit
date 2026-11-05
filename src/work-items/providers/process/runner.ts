// Thin adapter over the shared supervised-command runner (`shared/process/process-runner.ts`).
//
// The interface stays provider-facing: `code` is the shell convention consumed by
// the Jira adapter, where 127 means "binary not found" (see `jira/diagnostics.ts`).
import { killedByTimeout, runSupervisedCommand } from "../../../shared/process/process-runner.js";

/**
 * Deadline of one tracker CLI call (`acli`, `gh`). A call answers in seconds; one
 * that waits for credentials, a prompt or a dead network must not freeze a scan
 * or a step forever. Two minutes leaves a slow search room, like the runner's own
 * `git` calls.
 */
export const TRACKER_COMMAND_TIMEOUT_MS = 120_000;

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}
export interface ProcessRunOptions {
  /** Defaults to `TRACKER_COMMAND_TIMEOUT_MS`. */
  timeoutMs?: number;
  signal?: AbortSignal;
}
export type ProcessRunner = (cmd: string, args: string[], options?: ProcessRunOptions) => Promise<ProcessResult>;

export const nodeProcessRunner: ProcessRunner = async (cmd, args, options) => {
  const timeoutMs = options?.timeoutMs ?? TRACKER_COMMAND_TIMEOUT_MS;
  const result = await runSupervisedCommand(cmd, args, { timeoutMs, signal: options?.signal });
  const timedOut = killedByTimeout(result.kill);
  return {
    code: result.spawnFailed ? 127 : result.status,
    stdout: result.stdout,
    // The adapters quote stderr in their errors; a killed CLI often printed nothing.
    stderr: timedOut && !result.stderr ? `${cmd} timed out after ${Math.round(timeoutMs / 1000)}s` : result.stderr,
    ...(timedOut ? { timedOut: true } : {}),
  };
};
