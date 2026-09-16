// runner/exec/bash-runner.ts
//
// Bash execution, progress-bar filtering, and live streaming.

import { spawn } from "node:child_process";
import { closeSync, openSync, writeSync } from "node:fs";
import type { RunnerResult } from "../contracts/backends.js";
import { liveFeedFilePath } from "../runtime/live-feed.js";
import { spawnSupervisedProcess } from "./process-runner.js";
import {
  captureProcessOutput,
  gracefulKill,
  isProcessAlive,
  trackChild,
  whenProcessSettled,
} from "./process-supervision.js";

/** Documented default timeout for Bash steps. */
export const DEFAULT_BASH_TIMEOUT_MS = 600_000;

/** Separator `runBashAsync` writes between stdout and stderr in `output`. */
export const STDERR_MARKER = "--- stderr ---";

function combineShellOutput(stdout: string, stderr: string): string {
  return stderr ? `${stdout}${stdout && !stdout.endsWith("\n") ? "\n" : ""}${STDERR_MARKER}\n${stderr}` : stdout;
}

/** The combined output without the marker line: stdout and stderr text, in order. */
export function stripStderrMarker(output: string): string {
  return output.replace(new RegExp(`^${STDERR_MARKER}\\n?`, "m"), "");
}

const FAIL_REASON_STDERR_LINES = 5;
const FAIL_REASON_MAX_CHARS = 400;

/**
 * Failure reason of a command that exited non-zero. The bare `exit code N` was
 * all a diagnosis had for a `git checkout` whose two `fatal:` lines sat in the
 * log nobody opens; the tail of stderr is what names the cause, so it rides along.
 */
export function exitCodeFailReason(code: number | null, stderr: string): string {
  const head = `exit code ${code ?? "unknown"}`;
  const lines = stderr
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "");
  if (lines.length === 0) return head;
  const tail = lines.slice(-FAIL_REASON_STDERR_LINES).join("\n");
  const clipped = tail.length > FAIL_REASON_MAX_CHARS ? `…${tail.slice(-FAIL_REASON_MAX_CHARS)}` : tail;
  return `${head}\n${clipped}`;
}

export interface AsyncBashOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Asynchronous supervised bash for admissions and preflight: the runner keeps
 * handling signals during execution and kills the whole group on timeout.
 */
export function runBashAsync(command: string, opts: AsyncBashOptions = {}): Promise<RunnerResult> {
  const supervised = spawnSupervisedProcess("bash", ["-c", command], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
  });
  const child = supervised.child;

  return new Promise<RunnerResult>((resolve, reject) => {
    let finalized = false;
    let killedForCleanup = false;
    const captured = captureProcessOutput(child);

    const finish = async (code: number | null): Promise<void> => {
      if (finalized) return;
      finalized = true;
      if (!supervised.killed && supervised.isAlive()) {
        killedForCleanup = true;
        supervised.kill("child exited with live descendants");
      }
      if (supervised.killed) await supervised.waitForKill();
      const stdout = captured.stdout();
      const stderr = captured.stderr();
      if (stderr) process.stderr.write(stderr);
      const output = combineShellOutput(stdout, stderr);
      const killedByPolicy = supervised.killed && !killedForCleanup;
      const timedOut = killedByPolicy && supervised.killReason.startsWith("timeout");
      const ok = !killedByPolicy && code === 0;
      child.stdout?.destroy();
      child.stderr?.destroy();
      supervised.clear();
      resolve({
        output,
        ok,
        ...(timedOut ? { timedOut: true } : {}),
        ...(!ok
          ? {
              failReason: killedByPolicy
                ? `process killed: ${supervised.killReason}`
                : exitCodeFailReason(code, stderr),
            }
          : {}),
      });
    };

    // A descendant may keep stdout/stderr open after bash exits. The shared
    // supervisor allows a brief output drain, then cleans up the group even if
    // `close` never arrives.
    void whenProcessSettled(child, finish).catch(reject);
  });
}

// In non-TTY mode, some tools print one line per progress-bar tick.
// (rather than a single-line \r redraw in a TTY). Captured verbatim, this spams
// logs and the live feed. Remove those lines while retaining errors and metrics.
const PROGRESS_PATTERNS: RegExp[] = [
  /^\s*\d+\s+\[[->\s]*\]\s+(?:<\s*\d+\s*m?s|\d+\s*m?s)\b/,
  /^\s*\d+\/\d+\s+\[[^\]]*\]\s*\d+\s*%/,
  /^\s*Processing source code files:\s*\d+\/\d+/,
  /^[.AMUEXTSI\s]*\(\s*\d+\s*\/\s*\d+\s*\)\s*$/,
];

/** Keep only the segment after the last \r (final progress redraw state). */
function collapseCR(line: string): string {
  const i = line.lastIndexOf("\r");
  return i === -1 ? line : line.slice(i + 1);
}

function isProgressLine(line: string): boolean {
  return PROGRESS_PATTERNS.some((re) => re.test(line));
}

/**
 * Remove progress-bar lines from multiline text. Pure and testable.
 * First collapse \r redraws, then drop lines matching a progress pattern.
 */
export function stripProgressNoise(text: string): string {
  return text
    .split("\n")
    .map(collapseCR)
    .filter((line) => !isProgressLine(line))
    .join("\n");
}

/**
 * Streaming bash execution for bash STEPS: async spawn, push stdout/stderr to
 * the live feed (events {type:"bash-output"}) and the step log as output arrives.
 * Used by executeStep; admissions use runBashAsync.
 */
export function runBashStreaming(
  command: string,
  opts: { timeoutMs?: number; stepLogPath?: string } = {},
): Promise<RunnerResult> {
  return new Promise((resolve, reject) => {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_BASH_TIMEOUT_MS;
    let liveFd: number | undefined;
    try {
      liveFd = openSync(liveFeedFilePath(), "a");
    } catch {}
    const stepLogFd = opts.stepLogPath ? openSync(opts.stepLogPath, "a") : undefined;
    // Detached bash becomes its group leader, so gracefulKill also kills its
    // descendants (see killTree). Tradeoff: terminal SIGINT no longer applies;
    // hence the liveChildren registry.
    const child = spawn("bash", ["-c", command], { stdio: ["pipe", "pipe", "pipe"], detached: true });
    trackChild(child, { group: true });

    let output = "";
    let killed = false;
    let killedForCleanup = false;
    let timedOut = false;
    let killReason = "";
    // Partial-line buffers per stream: filter progress bars
    // line by line, so wait for a complete line (\n) before emitting.
    let outBuf = "";
    let errBuf = "";
    // stderr alone, for the failure reason: bounded, since only its tail is read.
    let stderrTail = "";
    let killPromise: Promise<void> | undefined;
    const timer = timeoutMs
      ? setTimeout(() => {
          killed = true;
          timedOut = true;
          killReason = `timeout (${Math.round(timeoutMs / 1000)}s)`;
          killPromise = gracefulKill(child, { group: true });
        }, timeoutMs)
      : undefined;
    timer?.unref();

    const emit = (clean: string, isErr: boolean) => {
      if (!clean) return;
      output += clean;
      if (isErr) {
        process.stderr.write(clean);
        stderrTail = (stderrTail + clean).slice(-4096);
      }
      if (liveFd !== undefined) {
        try {
          const event = JSON.stringify({
            ts: new Date().toISOString(),
            type: "bash-output",
            stderr: isErr,
            chunk: clean,
          });
          writeSync(liveFd, `${event}\n`);
        } catch {}
      }
      if (stepLogFd !== undefined) {
        try {
          writeSync(stepLogFd, clean);
        } catch {}
      }
    };

    // Accumulate through the last complete line, filter progress bars, and emit
    // the rest; keep a partial line buffered (collapse \r to bound its size).
    const pump = (incoming: string, isErr: boolean) => {
      const combined = (isErr ? errBuf : outBuf) + incoming;
      const nl = combined.lastIndexOf("\n");
      if (nl === -1) {
        const buf = collapseCR(combined);
        if (isErr) errBuf = buf;
        else outBuf = buf;
        return;
      }
      const complete = combined.slice(0, nl + 1);
      const rest = collapseCR(combined.slice(nl + 1));
      if (isErr) errBuf = rest;
      else outBuf = rest;
      emit(stripProgressNoise(complete), isErr);
    };

    // Flush the remaining partial line (without a final \n) when the process ends.
    const flush = (isErr: boolean) => {
      const leftover = collapseCR(isErr ? errBuf : outBuf);
      if (isErr) errBuf = "";
      else outBuf = "";
      if (leftover && !isProgressLine(leftover)) emit(leftover, isErr);
    };

    // Decode through the stream so a multi-byte UTF-8 sequence split across two
    // chunks is reassembled instead of becoming U+FFFD.
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (text: string) => pump(text, false));
    child.stderr?.on("data", (text: string) => pump(text, true));

    let finalized = false;
    const finalize = async (code: number | null) => {
      if (finalized) return;
      finalized = true;
      if (!killed && child.pid != null && isProcessAlive(child.pid, true)) {
        killedForCleanup = true;
        killReason = "child exited with live descendants";
        killPromise = gracefulKill(child, { group: true });
      }
      if (timer) clearTimeout(timer);
      // A timeout does not return until kill escalation has finished: a
      // descendant that ignores TERM must not contaminate the next step.
      if (killPromise) await killPromise;
      flush(false);
      flush(true);
      if (timedOut) {
        // Trace visible in the step log / stepOutput of fix prompts. Live observers
        // and error extractors must not neutralize this failure (see runner.ts).
        output += `\n[runner] step killed: timeout (${Math.round(timeoutMs / 1000)}s)\n`;
      }
      if (liveFd !== undefined) {
        try {
          closeSync(liveFd);
        } catch {}
      }
      if (stepLogFd !== undefined) {
        try {
          closeSync(stepLogFd);
        } catch {}
      }
      child.stdout?.destroy();
      child.stderr?.destroy();
      const killedByPolicy = killed && !killedForCleanup;
      const ok = !killedByPolicy && code === 0;
      resolve({
        output,
        ok,
        timedOut,
        ...(!ok
          ? {
              failReason:
                timedOut || killedByPolicy ? `process killed: ${killReason}` : exitCodeFailReason(code, stderrTail),
            }
          : {}),
      });
    };

    // `close` waits for stdout/stderr pipes to close; stubborn grandchildren
    // can keep them open indefinitely. The shared supervisor bounds the residual
    // drain while preserving all complete output.
    void whenProcessSettled(child, finalize).catch(reject);
  });
}
