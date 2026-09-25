// Closing a run by hand: the ticket was finished outside lance-nuit, so its last
// failed or stopped run should stop waiting on anybody.
//
// Like approval-only, these commands take neither the lock nor the git guard:
// they write one file beside the snapshot and never touch the snapshot itself.
// A run that moves afterwards invalidates the closure on its own (state/closure.ts).

import { dirname } from "node:path";
import type { RunnerArgs } from "../model/cli-options.js";
import { buildPipelineContext } from "../pipeline/context.js";
import { log } from "../runtime/logging.js";
import { closureOf, isClosableStatus, readClosureAt, removeClosureAt, writeClosureAt } from "../state/closure.js";
import { decisionActor } from "../state/decisions.js";
import { readRunSnapshot } from "../state/run-snapshot.js";
import { latestRunFile } from "../state/stores/run-storage.js";
import { commandRegistries } from "./registries.js";
import type { RunnerCommand } from "./runner-command.js";
import { errorMessage, isValidTicket } from "./shared.js";

/** Options these commands read, out of the ones `RunnerArgs` carries. */
type ClosureArgs = Pick<RunnerArgs, "ticket" | "pipelinePath">;

export type ClosureResult = { ok: true; message: string } | { ok: false; message: string };

/** Snapshot path of the latest run of `pipeline` for `ticket`, or `null`. */
function latestSnapshot(cwd: string, ticket: string, pipeline: string): string | null {
  const context = buildPipelineContext({ cwd, ticket, ...commandRegistries() });
  return latestRunFile(pipeline, ticket, context);
}

/** Close the latest run of `pipeline`. Refused on a run nobody waits on. */
export function closeLatestRun(cwd: string, ticket: string, pipeline: string, actor: string): ClosureResult {
  const file = latestSnapshot(cwd, ticket, pipeline);
  const state = file ? readRunSnapshot(file) : null;
  if (!file || !state) return { ok: false, message: `No run of pipeline "${pipeline}" found for ${ticket}.` };
  if (!isClosableStatus(state.status)) {
    return {
      ok: false,
      message: `Run ${state.runId ?? dirname(file)} is ${state.status ?? "UNKNOWN"}: only a failed or stopped run can be closed.`,
    };
  }
  writeClosureAt(dirname(file), closureOf(state, actor));
  return {
    ok: true,
    message: `Run ${state.runId ?? dirname(file)} of ${ticket} closed by ${actor} (status kept: ${state.status}).`,
  };
}

/** Remove the closure of the latest run of `pipeline`, if it has one. */
export function reopenLatestRun(cwd: string, ticket: string, pipeline: string): ClosureResult {
  const file = latestSnapshot(cwd, ticket, pipeline);
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
