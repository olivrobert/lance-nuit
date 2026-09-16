// Commands outside a run: they take neither the lock nor the git guard.

import { buildPipelineContext } from "../pipeline/context.js";
import type { RunnerArgs } from "../model/cli-options.js";
import { log } from "../runtime/logging.js";
import { cleanLogs, inspectTicket, logsForTicket } from "../state/diagnostics.js";
import { FileRunLogStore } from "../state/stores/file-run-log-store.js";
import { FileRunStateStore } from "../state/stores/file-run-state-store.js";
import type { RunnerCommand } from "./runner-command.js";
import { commandRegistries } from "./registries.js";
import { isValidTicket } from "./shared.js";

/** Options each diagnostic command reads, out of the 35 `RunnerArgs` carries. */
type InspectArgs = Pick<RunnerArgs, "ticket" | "runId">;
type LogsArgs = Pick<RunnerArgs, "ticket" | "runId" | "step">;
type CleanArgs = Pick<RunnerArgs, "ticket" | "logsOnly" | "olderThan" | "keepFailed">;

function contextFor(ticket?: string) {
  return buildPipelineContext({ cwd: process.cwd(), ticket, ...commandRegistries() });
}

function storesFor(context: ReturnType<typeof contextFor>, ticket?: string) {
  return {
    stateStore: new FileRunStateStore({ context, ticket }),
    logStore: new FileRunLogStore({ context, ticket }),
  };
}

export const inspectCommand: RunnerCommand = {
  id: "inspect",
  flag: "--inspect",
  key: "inspect",
  desc: "Display a ticket's run state and steps.",
  run(args: InspectArgs): number {
    if (!isValidTicket(args.ticket)) {
      log("--inspect requires a valid ticket.");
      return 1;
    }
    const context = contextFor(args.ticket);
    process.stdout.write(`${inspectTicket(context, args.ticket, args.runId, storesFor(context, args.ticket))}\n`);
    return 0;
  },
};

export const logsCommand: RunnerCommand = {
  id: "logs",
  flag: "--logs",
  key: "logs",
  desc: "Display a ticket's attempt logs.",
  run(args: LogsArgs): number {
    if (!isValidTicket(args.ticket)) {
      log("--logs requires a valid ticket.");
      return 1;
    }
    const context = contextFor(args.ticket);
    process.stdout.write(
      `${logsForTicket(context, args.ticket, args.step, args.runId, storesFor(context, args.ticket))}\n`,
    );
    return 0;
  },
};

export const cleanCommand: RunnerCommand = {
  id: "clean",
  flag: "--clean",
  key: "clean",
  desc: "Remove old step logs without touching snapshots or pipeline-history.",
  run(args: CleanArgs): number {
    if (!args.logsOnly) {
      log("--clean requires --logs-only: snapshots and pipeline-history are preserved.");
      return 1;
    }
    if (args.ticket && !isValidTicket(args.ticket)) {
      log("--clean: invalid ticket.");
      return 1;
    }
    const context = contextFor(args.ticket);
    const result = cleanLogs(context, args.ticket, args.olderThan, args.keepFailed);
    log(`Cleaned ${result.files} log file(s) in ${result.runs} run(s). pipeline-history unchanged.`);
    return 0;
  },
};
