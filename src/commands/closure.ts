// Closing a run by hand: the ticket was finished outside lance-nuit, so its last
// failed or stopped run should stop waiting on anybody.
//
// Like approval-only, these commands take neither the lock nor the git guard:
// they write one file beside the snapshot and never touch the snapshot itself.
// A run that moves afterwards invalidates the closure on its own (run-record/closure.ts).

import { dirname } from "node:path";
import type { RunnerArgs } from "../model/cli-options.js";
import type { PipelineContext } from "../model/context.js";
import { buildPipelineContext } from "../pipeline/context.js";
import { log } from "../runtime/logging.js";
import {
  awaitsHuman,
  closureOf,
  effectiveStatus,
  isRunHeld,
  latestRunFile,
  readClosureAt,
  readRunSnapshot,
  removeClosureAt,
  runsLocationOf,
  writeClosureAt,
} from "../run-record/index.js";
import { decisionActor } from "../work-item-store/index.js";
import { commandRegistries } from "./registries.js";
import type { RunnerCommand } from "./runner-command.js";
import { errorMessage, isValidTicket } from "./shared.js";

/** Options these commands read, out of the ones `RunnerArgs` carries. */
type ClosureArgs = Pick<RunnerArgs, "ticket" | "pipelinePath">;

export type ClosureResult = { ok: true; message: string } | { ok: false; message: string };

function contextFor(cwd: string, ticket: string): PipelineContext {
  return buildPipelineContext({ cwd, ticket, ...commandRegistries() });
}

/**
 * Close the latest run of `pipeline`. Refused on a run nobody waits on.
 *
 * The status is the one the dashboard shows: a snapshot left `RUNNING` by a
 * runner that died is an interrupted run, which waits on somebody like any other.
 */
export function closeLatestRun(cwd: string, ticket: string, pipeline: string, actor: string): ClosureResult {
  const context = contextFor(cwd, ticket);
  const file = latestRunFile(pipeline, ticket, context);
  const state = file ? readRunSnapshot(file) : null;
  if (!file || !state) return { ok: false, message: `No run of pipeline "${pipeline}" found for ${ticket}.` };
  const runDir = dirname(file);
  const { status } = effectiveStatus(state, () => isRunHeld(runDir, state, runsLocationOf(context)));
  if (!awaitsHuman(status)) {
    return {
      ok: false,
      message: `Run ${state.runId ?? runDir} is ${status}: only a failed or stopped run can be closed.`,
    };
  }
  writeClosureAt(runDir, closureOf(state, actor));
  return {
    ok: true,
    message: `Run ${state.runId ?? runDir} of ${ticket} closed by ${actor} (status kept: ${status}).`,
  };
}

/** Remove the closure of the latest run of `pipeline`, if it has one. */
export function reopenLatestRun(cwd: string, ticket: string, pipeline: string): ClosureResult {
  const file = latestRunFile(pipeline, ticket, contextFor(cwd, ticket));
  if (!file) return { ok: false, message: `No run of pipeline "${pipeline}" found for ${ticket}.` };
  const runDir = dirname(file);
  if (!readClosureAt(runDir)) return { ok: true, message: `Run of ${ticket} was not closed.` };
  removeClosureAt(runDir);
  return { ok: true, message: `Run of ${ticket} reopened.` };
}

function checkArgs(args: ClosureArgs, flag: string): { ticket: string; pipeline: string } | null {
  if (!isValidTicket(args.ticket)) {
    log(`${flag} requires a valid ticket.`);
    return null;
  }
  if (!args.pipelinePath) {
    log(`${flag} requires --pipeline <name>: a ticket keeps one latest run per pipeline.`);
    return null;
  }
  return { ticket: args.ticket, pipeline: args.pipelinePath };
}

function report(run: () => ClosureResult): number {
  try {
    const result = run();
    log(result.message);
    return result.ok ? 0 : 1;
  } catch (error) {
    log(errorMessage(error));
    return 1;
  }
}

export const closeCommand: RunnerCommand = {
  id: "close",
  flag: "--close",
  key: "close",
  desc: "Mark the latest failed or stopped run as closed by hand, keeping its status.",
  run(args: ClosureArgs): number {
    const target = checkArgs(args, "--close");
    if (!target) return 1;
    return report(() => closeLatestRun(process.cwd(), target.ticket, target.pipeline, decisionActor()));
  },
};

export const reopenCommand: RunnerCommand = {
  id: "reopen",
  flag: "--reopen",
  key: "reopen",
  desc: "Remove the closure of the latest run, so it waits for attention again.",
  run(args: ClosureArgs): number {
    const target = checkArgs(args, "--reopen");
    if (!target) return 1;
    return report(() => reopenLatestRun(process.cwd(), target.ticket, target.pipeline));
  },
};
