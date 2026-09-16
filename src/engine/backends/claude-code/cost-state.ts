// Session-cumulative figures reported by the Claude CLI.
//
// A `--resume` process restores the session ledger before it starts, so the
// `result` event it emits reports the WHOLE session — cost, API duration and turn
// count — not the work this process did. Charging that number as an attempt cost
// bills every earlier generation again: a fix loop resuming the coder session
// repays the coder on each pass, and a transport retry repays the attempt it
// replaces.
//
// The CLI persists that ledger in the session transcript as a `cost-state` record.
// Reading the last one immediately before a resume spawn gives exactly the
// baseline the CLI is about to restore, so the attempt can be charged by
// difference — the same reconciliation the orchestrator applies to child runs.

import { closeSync, openSync, readSync, statSync } from "node:fs";
import type { ClaudeResumeBaseline } from "../../../contracts/backends/claude-code.js";
import { asFiniteNumber as num, asRecord as rec } from "../../../lib/json-values.js";
import { findSessionFile } from "./session.js";

export type { ClaudeResumeBaseline } from "../../../contracts/backends/claude-code.js";

/** Locates the transcript of a session; overridden by the backend host and tests. */
export type SessionFileLocator = (sessionId: string) => string | null;

/**
 * Bytes read from the END of the transcript. `cost-state` is written when the
 * process exits, so it sits among the last records; a transcript can otherwise
 * reach tens of megabytes and must not be loaded whole on every resume.
 */
const TAIL_BYTES = 2 * 1024 * 1024;

function readTail(path: string): string {
  const { size } = statSync(path);
  const start = Math.max(0, size - TAIL_BYTES);
  const length = size - start;
  if (length <= 0) return "";
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const chunk = readSync(fd, buffer, read, length - read, start + read);
      if (chunk <= 0) break;
      read += chunk;
    }
    return buffer.subarray(0, read).toString("utf-8");
  } finally {
    closeSync(fd);
  }
}

/**
 * Last `cost-state` record of a session, or null when the transcript is missing or
 * carries none (an unfinished or pre-2.1 session). A missing baseline means the
 * attempt is charged in full: over-counting a resume is wrong, but inventing a
 * baseline would silently under-charge a real spend.
 */
export function readSessionCostBaseline(
  sessionId: string,
  locate: SessionFileLocator = findSessionFile,
): ClaudeResumeBaseline | null {
  const path = locate(sessionId);
  if (!path) return null;
  let tail: string;
  try {
    tail = readTail(path);
  } catch {
    return null;
  }
  const lines = tail.split("\n");
  // Scan backwards: the newest record wins, and the first line of the tail may be
  // a truncated fragment that simply fails to parse.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line?.includes('"cost-state"')) continue;
    let record: Record<string, unknown> | undefined;
    try {
      record = rec(JSON.parse(line));
    } catch {
      continue;
    }
    if (record?.type !== "cost-state") continue;
    const costUsd = num(record.totalCostUSD);
    if (costUsd == null || costUsd < 0) continue;
    const apiDurationMs = num(record.totalAPIDuration);
    return {
      costUsd,
      ...(apiDurationMs != null && apiDurationMs >= 0 ? { apiDurationMs } : {}),
    };
  }
  return null;
}

/**
 * A session-cumulative figure charged by difference. A reported value BELOW the
 * baseline means the figure was not cumulative after all (a fresh session reusing
 * the id, or a CLI that stopped restoring the ledger): trust the report rather
 * than clamp a real spend to zero.
 */
export function netCumulative(reported: number, baseline: number): number {
  return reported >= baseline ? reported - baseline : reported;
}
