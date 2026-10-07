// modules/read-model/step-detail.ts
//
// One step, opened: what each attempt cost and why it ended, what the chosen
// attempt was given and what it printed, and the artifacts it produced.
//
// The attempts come from the journal, not from `state.json`: the snapshot keeps
// only what a resume needs, and the journal is where every attempt is recorded
// once. The projection is the runner's own (`projectStepAttempts`), so the
// dashboard numbers attempts exactly as a resume would.
//
// This read is made when a reader opens a step, never by the item's poll: the
// whole journal is parsed, and a few hundred kilobytes per item per poll would be
// paid for a panel nobody opened.

import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PersistedAttempt } from "../../model/persisted.js";
import { projectStepAttempts } from "../../state/attempt-projection.js";
import type { ArtifactProvenance } from "../../state/provenance.js";
import { ATTEMPT_COMMAND_FILE } from "../../state/run-timeline.js";
import { FileRunEventStore } from "../../state/stores/file-run-event-store.js";
import { isPathWithin } from "../../state/stores/path-safety.js";
import { isSafeRelativePath, runTreePath } from "./explorer.js";
import type { ReadModelOptions } from "./projects.js";
import { type ResolvedRun, resolveRun } from "./runs.js";
import type { CoderSessionRead, StepAttemptStatus, StepAttemptView, StepDetail, TextExcerpt } from "./types.js";

/** Head of a prompt shown inline. A prompt embedding a whole plan can run to
 *  hundreds of kilobytes; the Files tab still opens the complete file. */
export const COMMAND_EXCERPT_BYTES = 32 * 1024;

/** Tail of an output shown inline: where an agent writes its verdict and a
 *  command its failure. */
export const OUTPUT_EXCERPT_BYTES = 8 * 1024;

const PROVENANCE_DIR = join("artifacts", ".provenance");

function statusOf(status: PersistedAttempt["status"]): StepAttemptStatus {
  switch (status) {
    case "running":
    case "done":
    case "failed":
    case "aborted":
      return status;
    default:
      // A status written by a newer runner reads as an attempt nobody closed.
      return "running";
  }
}

/** Run-relative log path of an attempt, when the journal gave one that stays in
 *  the run directory. */
function safeLogPath(attempt: PersistedAttempt): string | undefined {
  return attempt.log_path && isSafeRelativePath(attempt.log_path) ? attempt.log_path : undefined;
}

/** Dashboard view of one projected attempt, its log path made a tree path. */
export function attemptView(attempt: PersistedAttempt, treePathOf: (inRun: string) => string): StepAttemptView {
  const control = attempt.control;
  const logPath = safeLogPath(attempt);
  return {
    attempt: attempt.attempt,
    kind: attempt.kind === "fix" ? "fix" : "step",
    status: statusOf(attempt.status),
    ...(attempt.started_at ? { startedAt: attempt.started_at } : {}),
    ...(attempt.finished_at ? { finishedAt: attempt.finished_at } : {}),
    ...(typeof control?.duration_ms === "number" ? { durationMs: control.duration_ms } : {}),
    ...(typeof control?.total_cost_usd === "number" ? { costUsd: control.total_cost_usd } : {}),
    ...(control?.cost_estimated ? { costEstimated: true as const } : {}),
    ...(control?.cost_unknown ? { costUnknown: true as const } : {}),
    ...(control?.model ? { model: control.model } : {}),
    ...(attempt.errors ? { reason: attempt.errors } : {}),
    ...(logPath ? { logPath: treePathOf(logPath) } : {}),
    ...(resumableSession(attempt) ? { hasSession: true as const } : {}),
  };
}

function resumableSession(attempt: PersistedAttempt): PersistedAttempt["session"] {
  const session = attempt.session;
  return session?.resumable === true && session.id !== "" ? session : undefined;
}

/** At most `limit` bytes of a file, from its start or from its end. */
function excerpt(path: string, limit: number, from: "head" | "tail"): { text: string; truncated: boolean } | undefined {
  let fd: number | undefined;
  try {
    const size = statSync(path).size;
    const length = Math.min(size, limit);
    const buffer = Buffer.alloc(length);
    fd = openSync(path, "r");
    readSync(fd, buffer, 0, length, from === "head" ? 0 : size - length);
    // A cut can land inside a multi-byte character; the decoder replaces the
    // broken edge rather than failing the whole excerpt.
    return { text: buffer.toString("utf-8"), truncated: size > limit };
  } catch {
    // An attempt run before the runner kept its command, or a log removed by
    // `logs --clean`: nothing to show, which the panel says itself.
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Artifacts whose provenance record names `stepId` as their producer. Only a
 *  step declaring `input` gets such a record, so the list may be empty for a
 *  step that did write files. */
function producedBy(workItemDir: string, stepId: string): string[] {
  const dir = join(workItemDir, PROVENANCE_DIR);
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    // No provenance directory: no step of this work item declared input.
    return [];
  }
  const produced: string[] = [];
  for (const name of names.sort()) {
    const record = readProvenance(join(dir, name));
    const artifact = record?.producedBy === stepId ? record.artifact : undefined;
    if (typeof artifact === "string" && isSafeRelativePath(artifact)) produced.push(artifact);
  }
  return produced;
}

function readProvenance(path: string): Partial<ArtifactProvenance> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Partial<ArtifactProvenance>) : undefined;
  } catch {
    // A record being rewritten or edited by hand names no producer.
    return undefined;
  }
}

/** The attempts of step `stepId` in `resolved`, or `undefined` when the run has
 *  no such step: a step id travels from the browser, and only an id the
 *  snapshot lists is ever looked up in the journal. */
function attemptsOf(resolved: ResolvedRun, stepId: string): PersistedAttempt[] | undefined {
  const { runDir, state } = resolved.run;
  if (!state.steps.some((step) => step.id === stepId)) return undefined;
  return projectStepAttempts(new FileRunEventStore().readAt(runDir)).get(stepId) ?? [];
}

/**
 * Step `stepId` of the run `project/ticket` is currently about.
 *
 * `attempt` selects whose command and output are read; the last attempt by
 * default. Returns `undefined` when the run cannot be resolved or the run has no
 * such step.
 */
export function readStepDetail(
  projectName: string,
  ticket: string,
  stepId: string,
  attemptNumber: number | undefined,
  options: ReadModelOptions = {},
): StepDetail | undefined {
  const resolved = resolveRun(projectName, ticket, options);
  if (!resolved) return undefined;
  const attempts = attemptsOf(resolved, stepId);
  if (!attempts) return undefined;
  const { runDir, state, pipeline } = resolved.run;

  const treePathOf = (inRun: string): string => runTreePath(resolved.workItemDir, runDir, inRun);
  const selected =
    attemptNumber === undefined ? attempts.at(-1) : attempts.find((attempt) => attempt.attempt === attemptNumber);
  const logPath = selected ? safeLogPath(selected) : undefined;
  const firstLog = attempts.map(safeLogPath).find((path) => path !== undefined);

  return {
    pipeline,
    runId: state.runId ?? "",
    stepId,
    attempts: attempts.map((attempt) => attemptView(attempt, treePathOf)),
    ...(selected ? { attempt: selected.attempt } : {}),
    ...(logPath ? fileExcerpts(runDir, logPath, treePathOf) : {}),
    produced: producedBy(resolved.workItemDir, stepId),
    ...(firstLog ? { stepDir: treePathOf(dirname(dirname(firstLog))) } : {}),
  };
}

/**
 * The agent session attempt `attemptNumber` of step `stepId` left, or
 * `undefined` when there is no such run, step or attempt, or the attempt has no
 * session its provider can resume. An attempt still running has none yet: the
 * journal records its session when it finishes.
 */
export function readStepSession(
  projectName: string,
  ticket: string,
  stepId: string,
  attemptNumber: number,
  options: ReadModelOptions = {},
): CoderSessionRead | undefined {
  const resolved = resolveRun(projectName, ticket, options);
  if (!resolved) return undefined;
  const attempt = attemptsOf(resolved, stepId)?.find((entry) => entry.attempt === attemptNumber);
  const session = attempt ? resumableSession(attempt) : undefined;
  if (!session) return undefined;
  return {
    pipeline: resolved.run.pipeline,
    runId: resolved.run.state.runId ?? "",
    status: resolved.status,
    stepId,
    provider: session.provider,
    sessionId: session.id,
    cwd: resolved.cwd,
    worktree: resolved.run.state.worktree === true,
  };
}

function fileExcerpts(
  runDir: string,
  logPath: string,
  treePathOf: (inRun: string) => string,
): Pick<StepDetail, "command" | "output"> {
  const logFile = join(runDir, logPath);
  // The journal is trusted to name its own files, but a path is still checked
  // against the run before it is opened.
  if (!isPathWithin(runDir, logFile)) return {};
  const commandPath = join(dirname(logPath), ATTEMPT_COMMAND_FILE);
  const command = excerpt(join(runDir, commandPath), COMMAND_EXCERPT_BYTES, "head");
  const output = excerpt(logFile, OUTPUT_EXCERPT_BYTES, "tail");
  return {
    ...(command ? { command: { ...command, path: treePathOf(commandPath) } satisfies TextExcerpt } : {}),
    ...(output ? { output: { ...output, path: treePathOf(logPath) } satisfies TextExcerpt } : {}),
  };
}
