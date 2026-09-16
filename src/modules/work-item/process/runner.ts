// Thin adapter over the shared supervised-command runner (`exec/process-runner.ts`).
//
// The interface stays provider-facing: `code` is the shell convention consumed by
// the Jira adapter, where 127 means "binary not found" (see `jira/diagnostics.ts`).
import { runSupervisedCommand } from "../../../exec/process-runner.js";

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}
export interface ProcessRunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}
export type ProcessRunner = (cmd: string, args: string[], options?: ProcessRunOptions) => Promise<ProcessResult>;

export const nodeProcessRunner: ProcessRunner = async (cmd, args, options) => {
  const timeout = options?.timeoutMs;
  const result = await runSupervisedCommand(cmd, args, {
    // No caller-provided timeout means no timeout, not the supervisor's default.
    timeoutMs: timeout !== undefined && timeout > 0 ? timeout : null,
    signal: options?.signal,
  });
  return {
    code: result.spawnFailed ? 127 : result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(result.timedOut ? { timedOut: true } : {}),
  };
};
