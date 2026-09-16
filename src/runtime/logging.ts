// Progress messages go to stderr so they remain visible when stdout is piped.
//
// A repainting status line (output/status-line.ts) shares this stream: it must
// erase its line before anyone else writes, or its leftovers would corrupt the
// next message. Rather than making this module know about that renderer — which
// would create an import cycle — the renderer registers an interceptor here.

import type { RunnerMessageLevel } from "./events.js";

let beforeWrite: (() => void) | undefined;

/** Register a hook run before every stderr write. Passing `undefined` clears it. */
export function setLogInterceptor(fn: (() => void) | undefined): void {
  beforeWrite = fn;
}

/** Raw stderr write for callers that manage their own line endings. */
export function writeStderr(text: string): void {
  beforeWrite?.();
  process.stderr.write(text);
}

/**
 * The one place a severity becomes a glyph. Both writers of an execution message
 * share it: `log.warn`/`log.error` below, for the sites that hold no `RunOutput`,
 * and the console consumer of `runner.message` in `output/run-output.ts`. It sits
 * here rather than in the consumer because `output/` is above `runtime/` in the
 * layering, and a second copy of the table would let the two paths drift.
 *
 * Severity is not a verdict: `console-reporter.ts`'s `STATUS` table describes how
 * a run ended, which is a different dimension, and deliberately not reused here.
 *
 * `info` carries no glyph. The informational lines of the execution path already
 * spell their own prefix (`→` for a transition, `📄` for a log path), so adding
 * one would double it.
 */
const SEVERITY_GLYPH: Record<RunnerMessageLevel, string> = { info: "", warn: "⚠", error: "✗" };

/** Prefix `message` with the glyph of its level, after the whitespace the message
 *  opens with: indentation nests a line under its step and a leading newline
 *  separates a block from what precedes it. Both are part of what the line says,
 *  so the glyph goes where the text starts rather than in front of them. */
export function withSeverityGlyph(level: RunnerMessageLevel, message: string): string {
  const glyph = SEVERITY_GLYPH[level];
  if (!glyph) return message;
  const lead = /^\s*/.exec(message)?.[0] ?? "";
  return `${lead}${glyph} ${message.slice(lead.length)}`;
}

function logInfo(message: string): void {
  writeStderr(`${message}\n`);
}

/**
 * Execution and CLI prose on stderr, with the severity carried by the call and
 * not by a glyph typed into the string.
 *
 * `log.warn`/`log.error` are for the sites that have no `RunOutput` in scope
 * (boot, dispatch, entry before the fan-out is wired). A site that does hold one
 * emits `runner.message` instead, so a message never travels both paths and can
 * never be printed twice.
 */
export const log = Object.assign(logInfo, {
  warn(message: string): void {
    logInfo(withSeverityGlyph("warn", message));
  },
  error(message: string): void {
    logInfo(withSeverityGlyph("error", message));
  },
});
